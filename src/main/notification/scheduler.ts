/**
 * 通知调度引擎（ticket #56）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/notifications.rs`（ticket #30）的语义：
 *
 * 1. **payload 形状单源**：[`NotificationPayload`] 是带 `kind` 标签的
 *    判别联合（discriminated union），与 `notification_log.kind` 列字面
 *    量同源；序列化 → 落库 → 读回 三处共享同一份 JSON 形状。
 *
 * 2. **三条规则的纯查询**：每个规则跑"取行 → 去重 → 写日志"三步；
 *    不碰 OS 通知 UI、不碰前端 IPC——OS 通知由调用方在拿到返回值后
 *    走 `tauri_plugin_notification` / Electron Notification 的 emit 路径。
 *
 * 3. **dedup 单源**：去重完全走 `notification_log` 表 ——
 *    `WHERE kind = ? AND related_task_id = ?`（due_24h / blocked_3d）
 *    或 `WHERE kind = ? AND triggered_at LIKE ?`（weekly_digest）。
 *    同一规则对同一对象不反复轰炸。
 *
 * `Clock` 通过 `state.clock` 注入，测试可以把"现在"钉到任意时刻；
 * 周报"周一 08:00"窗口与节假日联动都走这条路径。
 *
 * 调度由 `src/main/index.ts` 触发（materialize 共用 tick 后顺带跑一遍
 * 三个规则，条件不满足 noop），不再单独起一个 interval。
 *
 * 设计要点：
 * - 命令层 (`notification/index.ts`) 与本调度层共享行映射助手 —
 *   `NotificationTableRow` / `rowToNotification` / `fetchNotification`
 *   / `parsePayload` —— 落库与读回两端的列名约定一致，避免漂移。
 */

import type Database from "better-sqlite3";

import { AppError } from "../error.js";
import { formatLocalDate } from "../clock.js";
import { BLOCKED_STATUSES, IN_FLIGHT_STATUSES } from "../task/index.js";
import type { AppState } from "../state.js";

// ---------------------------------------------------------------------------
// 通知行 DTO（DB → 前端）—— 命令层与调度层共用
// ---------------------------------------------------------------------------

/** `notification_log.kind` 列字面量——DB `CHECK` 一一对齐。 */
export type NotificationKind = "due_24h" | "blocked_3d" | "weekly_digest";

/** 一条通知行（DB → 前端）。 */
export interface NotificationRow {
  id: number;
  triggeredAt: string;
  kind: NotificationKind;
  relatedTaskId: number | null;
  relatedTemplateId: number | null;
  /** JSON 文本解析后的对象；前端按 `payload.kind` 分支渲染。 */
  payload: Record<string, unknown>;
  viewedAt: string | null;
}

// ---------------------------------------------------------------------------
// Payload 形状单源（DB `notification_log.kind` 列字面量 ↔ TS 判别联合）
// ---------------------------------------------------------------------------

/**
 * 通知 payload 形状单源——`kind` 字段是判别符，与 `notification_log.kind`
 * 列字面量同源。
 *
 * 序列化形状（JSON）：
 * - `due_24h`: `{ "kind": "due_24h", "task_id": ..., "title": ..., "due_date": ..., "owner_person_id": ..., "owner_name": ... }`
 * - `blocked_3d`: `{ "kind": "blocked_3d", "task_id": ..., "title": ..., "blocked_at": ..., "days_blocked": ..., "blocked_reason": ..., "owner_person_id": ..., "owner_name": ... }`
 * - `weekly_digest`: `{ "kind": "weekly_digest", "week_start": ..., "week_end": ..., "overdue_count": ..., "due_today_count": ..., "due_tomorrow_count": ..., "blocked_count": ... }`
 */
export type NotificationPayload =
  | {
      kind: "due_24h";
      task_id: number;
      title: string;
      /** YYYY-MM-DD 本地日历日。 */
      due_date: string;
      owner_person_id: number;
      owner_name: string;
    }
  | {
      kind: "blocked_3d";
      task_id: number;
      title: string;
      /** UTC 时间戳（SQL `datetime('now')` 格式）。 */
      blocked_at: string;
      /** 整数天（向下取整）。 */
      days_blocked: number;
      blocked_reason: string;
      owner_person_id: number;
      owner_name: string;
    }
  | {
      kind: "weekly_digest";
      /** 本周一（YYYY-MM-DD，本地日历）。 */
      week_start: string;
      /** 本周日（YYYY-MM-DD，本地日历）。 */
      week_end: string;
      overdue_count: number;
      due_today_count: number;
      due_tomorrow_count: number;
      blocked_count: number;
    };

/** `NotificationPayload` 的 `kind` 字面量提取。 */
function payloadKind(payload: NotificationPayload): NotificationKind {
  return payload.kind;
}

/** 取出 payload 的 `task_id` 字段；weekly_digest 没有，返回 `null`。 */
function payloadTaskId(payload: NotificationPayload): number | null {
  if (payload.kind === "weekly_digest") return null;
  return payload.task_id;
}

// ---------------------------------------------------------------------------
// 行 → DTO 映射（与 `notification/index.ts` 共用，避免漂移）
// ---------------------------------------------------------------------------

/** `notification_log` 行的 snake_case 字段集合。 */
export interface NotificationTableRow {
  id: number;
  triggered_at: string;
  kind: string;
  related_task_id: number | null;
  related_template_id: number | null;
  payload: string;
  viewed_at: string | null;
}

/** 行 → DTO：把 payload 文本解析成对象，前端按 `payload.kind` 分支渲染。 */
export function rowToNotification(row: NotificationTableRow): NotificationRow {
  const payload = parsePayload(row.payload);
  return {
    id: row.id,
    triggeredAt: row.triggered_at,
    kind: row.kind as NotificationKind,
    relatedTaskId: row.related_task_id,
    relatedTemplateId: row.related_template_id,
    payload,
    viewedAt: row.viewed_at,
  };
}

/** `notification_log.payload` 解析——非合法 JSON 对象时抛中文 `INTERNAL`。 */
export function parsePayload(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw AppError.internal(`notification_log.payload 解析失败：${detail}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw AppError.internal("notification_log.payload 不是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/** 取一条通知行；不存在则返回 `null`。 */
export function fetchNotification(
  db: Database.Database,
  id: number,
): NotificationRow | null {
  const row = db
    .prepare<[number], NotificationTableRow>(
      `SELECT id, triggered_at, kind, related_task_id, related_template_id,
              payload, viewed_at
         FROM notification_log
        WHERE id = ?`,
    )
    .get(id);
  return row ? rowToNotification(row) : null;
}

// ---------------------------------------------------------------------------
// 在飞 / 阻塞 状态字面量由 [`../task/index.js`] 单源导出
// (IN_FLIGHT_STATUSES / BLOCKED_STATUSES / TASK_STATUSES)——不再在调度
// 层留私有副本,避免类型从 TaskStatus[] 漂成 readonly string[]。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 三条规则
// ---------------------------------------------------------------------------

/**
 * due_24h：扫描「今天 + 明天」截止的一次性任务，按 task 去重。
 *
 * 只扫**一次性 task**（`recurring_template_id IS NULL` + `due_date`
 * 非空 + 状态在飞）——instance 由物化层管 due 语义，不进通知。
 * 去重键：`(kind='due_24h', related_task_id)`。
 *
 * 返回本次新插入的 rows；调用方对每行 emit OS 通知。
 */
export function runDue24h(state: AppState): NotificationRow[] {
  const today = state.clock.today();
  const tomorrow = addDaysLocal(today, 1, "today+1 越界,日期不合理");
  const todayStr = formatLocalDate(today);
  const tomorrowStr = formatLocalDate(tomorrow);

  const conn = state.db;
  const inFlight = IN_FLIGHT_STATUSES.map(() => "?").join(",");
  const rows = conn
    .prepare<unknown[], Due24hCandidateRow>(
      `SELECT t.id, t.title, t.due_date, t.owner_person_id, p.name
         FROM task t
         JOIN person p ON p.id = t.owner_person_id
        WHERE t.recurring_template_id IS NULL
          AND t.due_date IS NOT NULL
          AND t.due_date IN (?, ?)
          AND t.status IN (${inFlight})
        ORDER BY t.due_date ASC, t.id ASC`,
    )
    .all(todayStr, tomorrowStr, ...IN_FLIGHT_STATUSES);

  const inserted: NotificationRow[] = [];
  const now = state.clock.nowSql();
  for (const cand of rows) {
    const payload: NotificationPayload = {
      kind: "due_24h",
      task_id: cand.id,
      title: cand.title,
      due_date: cand.due_date,
      owner_person_id: cand.owner_person_id,
      owner_name: cand.name,
    };
    const notif = dedupInsert(conn, payload, now);
    if (notif !== null) inserted.push(notif);
  }
  return inserted;
}

interface Due24hCandidateRow {
  id: number;
  title: string;
  due_date: string;
  owner_person_id: number;
  name: string;
}

/**
 * blocked_3d：扫描 Blocked / Waiting-on 超 3 天的任务，按 task 去重。
 *
 * 阈值用 SQL 算：`blocked_at < datetime('now', '-3 days')`。
 * `now` 由 AppState 时钟给定的 UTC 文本注入——测试时钟可控，避免
 * SQLite 默认时钟与 `state.today()` 不一致。
 *
 * 去重键：`(kind='blocked_3d', related_task_id)`。
 */
export function runBlocked3d(state: AppState): NotificationRow[] {
  const now = state.clock.nowSql(); // UTC, '%Y-%m-%d %H:%M:%S'
  const conn = state.db;

  const blockedPlaceholders = BLOCKED_STATUSES.map(() => "?").join(",");
  const rows = conn
    .prepare<unknown[], Blocked3dCandidateRow>(
      `SELECT t.id, t.title, t.blocked_at, t.blocked_reason, t.owner_person_id,
              p.name,
              CAST(julianday(?) - julianday(t.blocked_at) AS INTEGER) AS days_blocked
         FROM task t
         JOIN person p ON p.id = t.owner_person_id
        WHERE t.status IN (${blockedPlaceholders})
          AND t.blocked_at IS NOT NULL
          AND t.blocked_at < datetime(?, '-3 days')
        ORDER BY t.blocked_at ASC, t.id ASC`,
    )
    .all(now, ...BLOCKED_STATUSES, now);

  const inserted: NotificationRow[] = [];
  for (const cand of rows) {
    const payload: NotificationPayload = {
      kind: "blocked_3d",
      task_id: cand.id,
      title: cand.title,
      blocked_at: cand.blocked_at,
      days_blocked: cand.days_blocked,
      blocked_reason: cand.blocked_reason,
      owner_person_id: cand.owner_person_id,
      owner_name: cand.name,
    };
    const notif = dedupInsert(conn, payload, now);
    if (notif !== null) inserted.push(notif);
  }
  return inserted;
}

interface Blocked3dCandidateRow {
  id: number;
  title: string;
  blocked_at: string;
  blocked_reason: string;
  owner_person_id: number;
  name: string;
  days_blocked: number;
}

/**
 * weekly_digest：周一 08:00（科长本地时区）发一次。
 *
 * 触发条件（**全部**满足才发）：
 * 1. 今天是周一（本地日历）
 * 2. 当前墙钟小时 == 8（本地）
 * 3. 今天不是 holiday（种子 / override 都算）且不是默认周末
 *
 * 去重键：`(kind='weekly_digest', triggered_at LIKE 'YYYY-MM-W%')`
 * ——同一周一条,周一任意 8:xx 触发都归到同一条。
 *
 * `week_start` / `week_end` 是本周一/本周日（YYYY-MM-DD,本地日历）。
 * `overdue_count` 等计数是当前快照——前端可读 payload 直接展示,也
 * 可以无视计数自己重新拉今日/本周视图。
 */
export function runWeeklyDigest(state: AppState): NotificationRow[] {
  const today = state.clock.today();
  const nowUtc = state.clock.now(); // UTC Date
  // UTC+8 固定偏移（中国自 1991 起不实行夏令时，与 IANA 等价）。
  const localHour = new Date(nowUtc.getTime() + SHANGHAI_OFFSET_MS).getUTCHours();

  // 条件 1：周一
  if (!isMondayLocal(today)) {
    return [];
  }
  // 条件 2：本地 8 点窗口
  if (localHour !== 8) {
    return [];
  }
  // 条件 3：今天不是 holiday（默认 weekend 已被 weekday == Mon 排除）
  if (state.calendar.kindOf(formatLocalDate(today)) === "holiday") {
    return [];
  }

  const conn = state.db;
  const weekStart = formatLocalDate(today); // 周一 YYYY-MM-DD
  const weekEndDate = addDaysLocal(today, 6, "today+6 越界,日期不合理");
  const weekEnd = formatLocalDate(weekEndDate);
  const tomorrowDate = addDaysLocal(today, 1, "today+1 越界");
  const todayStr = weekStart;
  const tomorrowStr = formatLocalDate(tomorrowDate);

  // 同周已有 weekly_digest 记录?返回最早一条（读回给调用方），不
  // 再写新行——去重落库 + 不重复 emit。
  const existing = findWeeklyDigestThisWeek(conn, weekStart);
  if (existing !== null) return [existing];

  // 4 个计数——独立 SQL，各自走对应 partial index。
  const overdueCount = countOverdue(conn, todayStr);
  const dueTodayCount = countDueOn(conn, todayStr);
  const dueTomorrowCount = countDueOn(conn, tomorrowStr);
  const blockedCount = countBlocked(conn);

  const payload: NotificationPayload = {
    kind: "weekly_digest",
    week_start: weekStart,
    week_end: weekEnd,
    overdue_count: overdueCount,
    due_today_count: dueTodayCount,
    due_tomorrow_count: dueTomorrowCount,
    blocked_count: blockedCount,
  };

  const now = state.clock.nowSql();
  const inserted = insertWeeklyDigest(conn, payload, now);
  return inserted === null ? [] : [inserted];
}

/** `today`（本地日历日 `Date`）是否周一。 */
function isMondayLocal(today: Date): boolean {
  // JS `getUTCDay()`：Sun=0..Sat=6。
  // `state.clock.today()` 返回的 Date 其 UTC 分量即本地分量（+8h 偏移后
  // 取 UTC 分量 = 本地日历日）。
  return today.getUTCDay() === 1;
}

/**
 * 「已逾期」任务数（状态在飞 + `due_date < today`）。
 *
 * 命中 `idx_task_due_date` partial（`WHERE due_date IS NOT NULL`）+
 * `idx_task_in_flight_status` partial（在飞四态）。
 */
function countOverdue(conn: Database.Database, todayStr: string): number {
  const inFlight = IN_FLIGHT_STATUSES.map(() => "?").join(",");
  const row = conn
    .prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM task
        WHERE status IN (${inFlight})
          AND due_date IS NOT NULL AND due_date < ?`,
    )
    .get(...IN_FLIGHT_STATUSES, todayStr);
  return row?.c ?? 0;
}

/** 「指定日到期」任务数（状态在飞 + `due_date = day`）。 */
function countDueOn(conn: Database.Database, dayStr: string): number {
  const inFlight = IN_FLIGHT_STATUSES.map(() => "?").join(",");
  const row = conn
    .prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM task
        WHERE status IN (${inFlight})
          AND due_date IS NOT NULL AND due_date = ?`,
    )
    .get(...IN_FLIGHT_STATUSES, dayStr);
  return row?.c ?? 0;
}

/** 当前阻塞任务数（`status IN ('Blocked','Waiting-on')`）。 */
function countBlocked(conn: Database.Database): number {
  const blocked = BLOCKED_STATUSES.map(() => "?").join(",");
  const row = conn
    .prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM task WHERE status IN (${blocked})`,
    )
    .get(...BLOCKED_STATUSES);
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// 三规则统一入口
// ---------------------------------------------------------------------------

/** 三规则各自的产出——调度器拿到后各自 emit OS 通知。 */
export interface NotificationRunSummary {
  due24h: NotificationRow[];
  blocked3d: NotificationRow[];
  weeklyDigest: NotificationRow[];
}

/**
 * 三规则统一入口——由调度器（materialize tick 共用触发器）调用。
 *
 * 各自独立：任何一个抛错不影响其它的写入（partial success）。错误累
 * 积后调用方决定怎么走（建议 `console.error` 不 panic，通知是后台能力）。
 *
 * 由 (rule_name, runner) 元组驱动——避免每条规则写一份重复 try/catch。
 */
export function runAll(state: AppState): NotificationRunSummary {
  const rules: ReadonlyArray<readonly [string, (s: AppState) => NotificationRow[]]> = [
    ["due24h", runDue24h],
    ["blocked3d", runBlocked3d],
    ["weeklyDigest", runWeeklyDigest],
  ];
  const summary = {
    due24h: [] as NotificationRow[],
    blocked3d: [] as NotificationRow[],
    weeklyDigest: [] as NotificationRow[],
  };
  for (const [name, runner] of rules) {
    try {
      const rows = runner(state);
      // 把键名映射回 summary 字段（rule 名 == summary 字段名）。
      (summary as Record<string, NotificationRow[]>)[name] = rows;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      console.error(`[notification] ${name} 失败：${detail}`);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// dedup：单源去重入口
// ---------------------------------------------------------------------------

/**
 * 写 `notification_log`，同 `(kind, related_task_id)` 已存在则跳过。
 *
 * `related_task_id IS NULL` 的 kind（当前仅 `weekly_digest`）走另一条
 * 路径 [`insertWeeklyDigest`]，不去重 lookup。
 *
 * `triggered_at` 由调用方通过 `state.clock.nowSql()` 显式写入,不走
 * SQLite 的 `datetime('now')`——后者是宿主 wall-clock，测试注入
 * [`FixedClock`] 时会与 `state.today()` 不一致，导致 weekly_digest
 * 的"同周"判定走偏。
 */
function dedupInsert(
  conn: Database.Database,
  payload: NotificationPayload,
  triggeredAt: string,
): NotificationRow | null {
  const taskId = payloadTaskId(payload);
  if (taskId === null) {
    throw AppError.internal("dedupInsert 收到 weekly_digest payload");
  }
  const kind = payloadKind(payload);

  const exists = conn
    .prepare<[string, number], { id: number }>(
      `SELECT id FROM notification_log
        WHERE kind = ? AND related_task_id = ? LIMIT 1`,
    )
    .get(kind, taskId);
  if (exists !== undefined) return null;

  const payloadText = serializePayload(payload);
  const result = conn
    .prepare(
      `INSERT INTO notification_log
         (triggered_at, kind, related_task_id, payload)
       VALUES (?, ?, ?, ?)`,
    )
    .run(triggeredAt, kind, taskId, payloadText);
  const id = Number(result.lastInsertRowid);
  const fetched = fetchNotification(conn, id);
  if (fetched === null) {
    throw AppError.internal(
      `刚插入的 notification_log id=${id} 立即查不到`,
    );
  }
  return fetched;
}

/**
 * weekly_digest 专用：单纯 INSERT，不查 dedup——周报的 dedup 由调用方
 * [`runWeeklyDigest`] 通过 [`findWeeklyDigestThisWeek`] 完成。
 *
 * 周报的去重键是 `triggered_at LIKE 'YYYY-MM-DD%'`，不挂 task；另开
 * 一条路径免得 [`dedupInsert`] 的"必填 related_task_id"语义膨胀。
 * `triggered_at` 从 app clock 取，不走 SQLite 默认——见 [`dedupInsert`]
 * 注释。
 */
function insertWeeklyDigest(
  conn: Database.Database,
  payload: NotificationPayload,
  triggeredAt: string,
): NotificationRow | null {
  if (payload.kind !== "weekly_digest") {
    throw AppError.internal("insertWeeklyDigest 收到非 weekly_digest payload");
  }
  const kind = payloadKind(payload);
  const payloadText = serializePayload(payload);

  const result = conn
    .prepare(
      `INSERT INTO notification_log (triggered_at, kind, payload) VALUES (?, ?, ?)`,
    )
    .run(triggeredAt, kind, payloadText);
  const id = Number(result.lastInsertRowid);
  const fetched = fetchNotification(conn, id);
  if (fetched === null) {
    throw AppError.internal(
      `刚插入的 notification_log id=${id} 立即查不到`,
    );
  }
  return fetched;
}

/**
 * 同周已有 weekly_digest 记录?——按 `triggered_at LIKE 'YYYY-MM-DD%'`
 * 兜底；当前 ISO 周起点 = 本周一，字符串前缀 `YYYY-MM-DD`，能唯一定位。
 */
function findWeeklyDigestThisWeek(
  conn: Database.Database,
  weekStart: string,
): NotificationRow | null {
  const prefix = `${weekStart}%`;
  const row = conn
    .prepare<unknown[], NotificationTableRow>(
      `SELECT id, triggered_at, kind, related_task_id, related_template_id,
              payload, viewed_at
         FROM notification_log
        WHERE kind = ? AND triggered_at LIKE ?
        ORDER BY id ASC LIMIT 1`,
    )
    .get("weekly_digest", prefix);
  return row ? rowToNotification(row) : null;
}

// ---------------------------------------------------------------------------
// 渲染（中文硬编码，spec #15）
// ---------------------------------------------------------------------------

/**
 * 渲染 OS 通知的标题 + 正文（中文硬编码，无 i18n）。
 *
 * 暴露成 `pub` 是为 IPC 层可能需要单独 emit 时复用——主流程一般走
 * `runAll()` 拿到所有 rows 后再循环 emit。
 */
export function renderMessage(payload: NotificationPayload): { title: string; body: string } {
  if (payload.kind === "due_24h") {
    return {
      title: "任务即将到期",
      body: `${payload.owner_name} 的「${payload.title}」将于 ${payload.due_date} 到期`,
    };
  }
  if (payload.kind === "blocked_3d") {
    return {
      title: `任务阻塞 ${payload.days_blocked} 天`,
      body: `${payload.owner_name} 的「${payload.title}」：${payload.blocked_reason}`,
    };
  }
  return {
    title: `周报摘要（${payload.week_start} ~ ${payload.week_end}）`,
    body: `已逾期 ${payload.overdue_count} 条,今日到期 ${payload.due_today_count} 条,明日到期 ${payload.due_tomorrow_count} 条,阻塞中 ${payload.blocked_count} 条`,
  };
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 把 payload 序列化成 JSON 文本。序列化失败抛中文 `INTERNAL`。 */
function serializePayload(payload: NotificationPayload): string {
  try {
    return JSON.stringify(payload);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw AppError.internal(`序列化 payload 失败：${detail}`);
  }
}

/** UTC+8 偏移毫秒。 */
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

/** 加 1 天到本地日历日（用 UTC 分量计算，不走夏令时）。 */
function addDaysLocal(date: Date, days: number, errMessage: string): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  if (Number.isNaN(next.getTime())) {
    throw AppError.internal(errMessage);
  }
  return next;
}
