/**
 * 实例动作命令层（tickets #26 / #49）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/commands/instance.rs` 的语义：
 * 1. **手工改期** [`rescheduleInstance`]：原 instance → `Cancelled` +
 *    新 instance `Open`，`rescheduled_from_id` 指向原，`original_scheduled_at`
 *    保留模板原定时间。**与 SHIFT 路径共用同一段 INSERT 体** ——见
 *    [`insertRescheduledInstance`]，两条路径产出的数据形状一致（issue
 *    #26 AC 验收）。
 *
 * 2. **覆盖单 instance 时间** [`overrideInstanceScheduledAt`]：仅
 *    UPDATE 一行的 `scheduled_at`，**不**创建新 instance，
 *    `rescheduled_from_id` 保持 NULL。出差场景：业务周期不变，仅本次
 *    会议时间微调。
 *
 * 3. **改期溯源** [`instanceRescheduleChain`]：沿 `rescheduled_from_id`
 *    一路递归回溯，返回整条链（含自身）。科长时间轴 UI 据此显示
 *    "改期自 X" 链。
 *
 * 状态机 / Skip / Mark Done 不在本文件 —— 改 Done / Cancelled 走
 * [`setTaskStatus`]（全 app 唯一入口，ADR 0003 §D6）。`Skip` = 设
 * `Cancelled`，UI 端根据 `recurring_template_id IS NOT NULL && status='Cancelled'`
 * 判定"已跳过"标签（issue #26 AC #2）。
 *
 * 模板级时区整体修改走 [`updateRecurringTemplateZone`]。
 *
 * ## 改期路径的「状态变更」入口选择
 *
 * `rescheduleInstance` 走 `setTaskStatus` 把原 instance 标 Cancelled,
 * **不**直接 UPDATE `status`——理由：保持 ADR 0003 §D6 「状态机唯一入口」
 * 的不变量（`blocked_at` / `blocked_reason` / `waiting_on_person_id` 联动
 * 重置都集中在那里）。代价：`setTaskStatus` 单独事务提交，后续 INSERT
 * 新 instance 是第二个事务——若两步之间崩溃，用户看到一条 Cancelled 没
 * 替代，但这是幂等的可恢复态（用户重新改期即可）。与 SHIFT 路径的 1 步
 * INSERT 行为不完全对称，但 SHIFT 是物化层原子扫描循环的一部分，不在
 * 此权衡范围内。
 */

import type Database from "better-sqlite3";

import { AppError } from "../error.js";
import {
  insertRescheduledInstance,
  resolveOwner,
  type TemplateMaterializeInput,
} from "../materialization/index.js";
import { fetchTemplate } from "../recurring_template/index.js";
import { setTaskStatus, fetchTask as fetchTaskInternal } from "../task/index.js";
import type { AppState } from "../state.js";
import type {
  InstanceIdArgs,
  OverrideInstanceScheduledAtArgs,
  RecurringTemplate,
  RescheduleInstanceArgs,
  Task,
  TaskStatus,
  UpdateTemplateZoneArgs,
} from "../types.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 改期溯源链深度上限——防环路（自指改期已被前置校验拦掉，但跨用户的
 * Syncthing 同步漂移可能引入环路；32 步已远超正常改期深度）。
 */
export const RESCHEDULE_CHAIN_MAX_DEPTH = 32;

/** 入库格式 UTC 时间戳文本正则——`'%Y-%m-%d %H:%M:%S'`。 */
const TS_REGEX = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/**
 * 手工改期单次 instance。
 *
 * 数据形态与 SHIFT 路径（[`materializeTemplate`] 里的 `Shift { original,
 * target }` 分支）一致：原 instance → `Cancelled` + 新 instance → `Open`，
 * `rescheduled_from_id` 指向原 instance，`original_scheduled_at` 保留
 * **模板原定时间**（SHIFT 路径与本函数同走 [`insertRescheduledInstance`]，
 * 验收点 #26 AC）。
 *
 * 改期**不**触碰 `recurring_template` 表——下周 / 下下周仍按原规则走。
 */
export function rescheduleInstance(
  state: AppState,
  args: RescheduleInstanceArgs,
): Task {
  parseSqlTimestamp(args.newScheduledAt);

  // 第一段：读 instance 行 + 模板，做预校验。
  const { template, originalScheduledAt, status } = loadInstanceRow(
    state.db,
    args.taskId,
  );
  if (status === "Cancelled") {
    throw AppError.invalid(
      "已取消的 instance 无法再改期,可考虑新建一条一次性任务。",
    );
  }
  if (status === "Done") {
    throw AppError.invalid(
      "已完成的 instance 不能再改期——若需回顾当日工作,请新建一次性任务。",
    );
  }
  if (args.newScheduledAt === originalScheduledAt) {
    throw AppError.invalid(
      "改期目标时间与原时间相同,请换一个时间或直接改状态。",
    );
  }
  const collide = state.db
    .prepare<[number, string, number], { id: number }>(
      "SELECT id FROM task " +
        " WHERE recurring_template_id = ? AND scheduled_at = ? AND id != ?",
    )
    .get(template.id, args.newScheduledAt, args.taskId);
  if (collide) {
    throw AppError.invalid(
      "目标时间已被同模板的另一个 instance 占用,请换一个时间或先改那条。",
    );
  }

  // 第二段：走 setTaskStatus 把原 instance 标 Cancelled——保持
  // ADR 0003 §D6「状态机唯一入口」不变量（自动重置 blocked_* 三列）。
  setTaskStatus(state, {
    taskId: args.taskId,
    status: "Cancelled",
    blockedReason: null,
    waitingOnPersonId: null,
  });

  // 第三段：写新 instance——走共享 INSERT 体，与 SHIFT 路径同 INSERT 体
  //（issue #26 AC #5）。若此处崩溃，用户看到一条已 Cancelled 的原
  // instance，无替代——可恢复（用户重试改期即可）。
  //
  // `rescheduled_from_id` 写在**新 instance** 行上，指向原 instance——
  // 与 SHIFT 路径（`materializeTemplate`）语义一致。
  const newTitle = `${template.name} @ ${originalScheduledAtLocal(originalScheduledAt)}`;
  let newId = 0;
  state.db.transaction(() => {
    newId = insertRescheduledInstance(
      state.db,
      template,
      args.newScheduledAt,
      originalScheduledAt,
      newTitle,
    );
    state.db
      .prepare("UPDATE task SET rescheduled_from_id = ? WHERE id = ?")
      .run(args.taskId, newId);
  })();

  const newTask = fetchTaskById(state.db, newId);
  if (newTask === null) {
    throw AppError.internal(`改期后的 instance id=${newId} 查不到`);
  }
  return newTask;
}

/**
 * 仅覆盖单 instance 的 `scheduled_at`，**不**取消原 instance,**不**挂
 * `rescheduled_from_id`——这是"出差调时区"场景的轻量手势：业务周期
 * 不变，仅本次会议时间微调，不想看到多一条 Cancelled 行。
 */
export function overrideInstanceScheduledAt(
  state: AppState,
  args: OverrideInstanceScheduledAtArgs,
): Task {
  parseSqlTimestamp(args.newScheduledAt);

  const { template, originalScheduledAt, status } = loadInstanceRow(
    state.db,
    args.taskId,
  );
  if (status === "Cancelled") {
    throw AppError.invalid("已取消的 instance 无法再覆盖时间。");
  }
  if (args.newScheduledAt === originalScheduledAt) {
    throw AppError.invalid(
      "覆盖目标时间与原时间相同,请换一个时间或直接保存。",
    );
  }
  // 预先拦同 template 占用，给科长友好提示——与 `rescheduleInstance` 行为对齐。
  const collide = state.db
    .prepare<[number, string, number], { id: number }>(
      "SELECT id FROM task " +
        " WHERE recurring_template_id = ? AND scheduled_at = ? AND id != ?",
    )
    .get(template.id, args.newScheduledAt, args.taskId);
  if (collide) {
    throw AppError.invalid(
      "目标时间已被同模板的另一个 instance 占用,请换一个时间或先改那条。",
    );
  }

  const now = state.clock.nowSql();
  const result = state.db
    .prepare(
      "UPDATE task " +
        "   SET scheduled_at = ?, updated_at = ? " +
        " WHERE id = ? AND recurring_template_id = ?",
    )
    .run(args.newScheduledAt, now, args.taskId, template.id);
  if (result.changes === 0) {
    throw AppError.invalid("任务不存在或已被删除。");
  }

  const updated = fetchTaskById(state.db, args.taskId);
  if (updated === null) {
    throw AppError.internal(`覆盖后的 instance id=${args.taskId} 查不到`);
  }
  return updated;
}

/**
 * 整体修改模板的 `iana_zone`。`upsertRecurringTemplate` 已能改
 * `iana_zone`（连同其它规则一起重写），但用户场景"出差切时区"经常只想
 * 动一个字段，不想被"重写规则"覆盖到 ends / byday 等；本命令走最窄
 * 入口。
 *
 * 不动 `rrule_text`——RRULE 字符串不含 iana_zone（见 [`recurring_template`]
 * 文档）。
 */
export function updateRecurringTemplateZone(
  state: AppState,
  args: UpdateTemplateZoneArgs,
): RecurringTemplate {
  // IANA zone 校验：v1 不引 chrono-tz，只允许 Asia/Shanghai。
  if (args.ianaZone.trim().length === 0) {
    throw AppError.invalid("时区不能为空。");
  }
  if (args.ianaZone !== "Asia/Shanghai") {
    throw AppError.invalid(
      "本票仅支持 Asia/Shanghai 时区,跨时区场景归后续票。",
    );
  }

  const result = state.db
    .prepare("UPDATE recurring_template SET iana_zone = ? WHERE id = ?")
    .run(args.ianaZone, args.templateId);
  if (result.changes === 0) {
    throw AppError.invalid("模板不存在或已被删除。");
  }
  const fetched = fetchTemplate(state.db, args.templateId);
  if (fetched === null) {
    throw AppError.internal(`模板 id=${args.templateId} 查不到`);
  }
  return fetched;
}

/**
 * 沿 `rescheduled_from_id` 一路回溯，返回整条链（含自身，自身在最前）。
 *
 * 深度上限 [`RESCHEDULE_CHAIN_MAX_DEPTH`]——防环路（自指改期已被前置校验
 * 拦掉，但跨用户的 Syncthing 同步漂移可能引入环路；32 步已远超正常改期
 * 深度）。
 */
export function instanceRescheduleChain(
  state: AppState,
  args: InstanceIdArgs,
): Task[] {
  const chain: Task[] = [];
  let currentId: number = args.taskId;
  const seen = new Set<number>();

  for (let i = 0; i < RESCHEDULE_CHAIN_MAX_DEPTH; i += 1) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const task = fetchTaskById(state.db, currentId);
    if (task === null) break;
    chain.push(task);
    const parent = task.rescheduledFromId;
    if (parent === null) break;
    currentId = parent;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// 内部 helper
// ---------------------------------------------------------------------------

/**
 * 把 `task` 行 + 模板转成 instance 命令层用的结构——`rescheduleInstance`
 * / `overrideInstanceScheduledAt` 共用。
 *
 * `recurring_template_id` 为 `null` 表示一次性 task，两条命令都拒。
 */
function loadInstanceRow(
  db: Database.Database,
  taskId: number,
): {
  template: TemplateMaterializeInput;
  originalScheduledAt: string;
  status: TaskStatus;
} {
  const row = db
    .prepare<[number], {
      recurring_template_id: number | null;
      scheduled_at: string | null;
      status: string;
    }>(
      "SELECT recurring_template_id, scheduled_at, status " +
        " FROM task WHERE id = ?",
    )
    .get(taskId);
  if (row === undefined) {
    throw AppError.invalid("任务不存在或已被删除。");
  }
  const templateId = row.recurring_template_id;
  if (templateId === null) {
    throw AppError.invalid(
      "只有周期性 instance 可以改期/覆盖时间,一次性任务请用截止日手势。",
    );
  }
  const scheduledAt = row.scheduled_at;
  if (scheduledAt === null) {
    throw AppError.internal(
      `task.id=${taskId} 是 instance 但 scheduled_at IS NULL,数据漂移`,
    );
  }
  const status = parseStatus(row.status);
  const template = loadTemplateMaterializeInput(db, templateId);
  return { template, originalScheduledAt: scheduledAt, status };
}

/**
 * 把 `RecurringTemplate` 转成物化层期望的 [`TemplateMaterializeInput`]——
 * 物化层期望的最小字段集。结构化字段已在 DTO 层校验过，这里直接搬，
 * 不重复 match。
 */
function loadTemplateMaterializeInput(
  db: Database.Database,
  templateId: number,
): TemplateMaterializeInput {
  const tmpl = fetchTemplate(db, templateId);
  if (tmpl === null) {
    throw AppError.internal(`模板 id=${templateId} 查不到`);
  }
  const ownerPersonId = resolveOwner(db, tmpl.projectId, tmpl.subTeamId);
  return {
    id: tmpl.id,
    name: tmpl.name,
    rule: {
      freq: tmpl.freq,
      bydayMask: tmpl.bydayMask,
      bymonthday: tmpl.bymonthday,
      bymonth: tmpl.bymonth,
      byhour: tmpl.byhour,
      byminute: tmpl.byminute,
      ianaZone: tmpl.ianaZone,
      ends: tmpl.ends,
      holidayBehavior: tmpl.holidayBehavior,
    },
    ownerPersonId,
    projectId: tmpl.projectId,
    subTeamId: tmpl.subTeamId,
  };
}

/** `task.status` DB 字面量 → 强类型 6 值枚举。 */
function parseStatus(text: string): TaskStatus {
  switch (text) {
    case "Open":
      return "Open";
    case "In-progress":
      return "In-progress";
    case "Blocked":
      return "Blocked";
    case "Waiting-on":
      return "Waiting-on";
    case "Done":
      return "Done";
    case "Cancelled":
      return "Cancelled";
    default:
      throw AppError.internal(
        `task.status 未知字面量 ${JSON.stringify(text)}——schema CHECK 应已拦掉`,
      );
  }
}

/** 解析入库格式 UTC 时间戳——格式不对直接给科长中文提示。 */
function parseSqlTimestamp(value: string): void {
  if (!TS_REGEX.test(value)) {
    throw AppError.invalid(
      "时间格式不对,应形如 2026-09-16 14:00:00(UTC)。",
    );
  }
}

/**
 * 把原 instance 的 UTC 时间戳转成 Asia/Shanghai 本地日期，作为新 instance
 * 标题的 "@ YYYY-MM-DD" 后缀——与 SHIFT 路径同取值规则（都用「原定
 * 日期」，不用「改期后的日期」，让 cancelled 与 shifted 两行标题对齐）。
 */
function originalScheduledAtLocal(utcSql: string): string {
  const match = TS_REGEX.exec(utcSql);
  if (match === null) return utcSql;
  const [, y, mo, d, h, mi, s] = match;
  const utc = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  );
  if (Number.isNaN(utc.getTime())) return utcSql;
  // Asia/Shanghai 固定偏移 + 8h（不引 chrono-tz：中国自 1991 年起不实行
  // 夏令时，固定偏移与 IANA 规则等价）。
  const local = new Date(utc.getTime() + 8 * 3600 * 1000);
  return local.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** 取一条 task + 映射成 DTO；不存在则 `null`。委托给 [`task.fetchTask`]
 *  ——共享 SELECT 列清单与 `TASK_COLUMNS` 派生字段，避免漂移。 */
function fetchTaskById(db: Database.Database, id: number): Task | null {
  return fetchTaskInternal(db, id);
}
