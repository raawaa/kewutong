/**
 * Task 命令层（tickets #43 / #44）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/commands/task.rs` 的语义：
 * - `task.status` 6 值枚举（PascalCase 字面量与 DB / TS / 前端三者一致）
 * - `Blocked` / `Waiting-on` 状态 `blocked_reason` 必填且长度 ≤ 500
 * - `waiting_on_person_id` 仅在 `Waiting-on` 下允许非空（允许自反）
 * - 阻塞三列的派生（`blocked_at` 刷新 / 切出清空 / 反复切换不累计）由
 *   [`setTaskStatus`] 作为**全 app 唯一状态变更入口**在事务内统一维护
 *
 * 所有命令入参与返回都是稳定 DTO（camelCase），不透传行结构。
 */

import type Database from "better-sqlite3";

import { AppError } from "../error.js";
import { parseSqlDate, toSqlDate } from "../clock.js";
import type { AppState } from "../state.js";
import type {
  CreateTaskArgs,
  DueDateChip,
  DueDateOption,
  ListTasksArgs,
  ListTasksFilteredArgs,
  SetTaskStatusArgs,
  Task,
  TaskStatus,
  TodayWeek,
  UpdateTaskArgs,
} from "../types.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 任务的 6 个状态——与 `src/lib/ipc.ts` 一一对应。 */
export const TASK_STATUSES: readonly TaskStatus[] = [
  "Open",
  "In-progress",
  "Blocked",
  "Waiting-on",
  "Done",
  "Cancelled",
];

/** 在飞 = 排除 Done / Cancelled。 */
const IN_FLIGHT_STATUSES: readonly TaskStatus[] = [
  "Open",
  "In-progress",
  "Blocked",
  "Waiting-on",
];

/** 阻塞 / 等待三态——瓦片「Blocked」用。 */
const BLOCKED_STATUSES: readonly TaskStatus[] = ["Blocked", "Waiting-on"];

/** 命令面板搜索默认上限。封顶在命令层，前端按这个数字决定下拉高度。 */
export const SEARCH_TASKS_LIMIT = 50;

/** 物化窗口的天数（12 周）。与原 Rust 端 `materialization::MATERIALIZATION_WINDOW_DAYS` 对齐。 */
const MATERIALIZATION_WINDOW_DAYS = 12 * 7;

/**
 * `Task` 行的 SELECT 列清单——单点改：所有读 `task` 的命令都从这里
 * 拼 SQL，新增/删列只改一处。
 *
 * 与 Rust 端 `TASK_COLUMNS` 一一对应；instance 走 `COALESCE(due_date,
 * date(scheduled_at, '+8 hours'))`（Asia/Shanghai +8h 固定偏移）。
 */
export const TASK_COLUMNS =
  "id, title, description, status, owner_person_id, project_id, due_date, " +
  "created_at, updated_at, blocked_at, blocked_reason, " +
  "recurring_template_id, scheduled_at, original_scheduled_at, rescheduled_from_id, " +
  "COALESCE(due_date, date(scheduled_at, '+8 hours')) AS effective_date, " +
  "waiting_on_person_id";

/**
 * 带 `t.` 前缀的 `task` 列清单——`JOIN` 其它表时（`JOIN person p`
 * 或 `JOIN task_fts`）避免 `id` 列歧义。
 *
 * 与 Rust 端 `TASK_COLUMNS_WITH_T` 一一对应。
 */
export const TASK_COLUMNS_WITH_T =
  "t.id, t.title, t.description, t.status, t.owner_person_id, t.project_id, t.due_date, " +
  "t.created_at, t.updated_at, t.blocked_at, t.blocked_reason, " +
  "t.recurring_template_id, t.scheduled_at, t.original_scheduled_at, t.rescheduled_from_id, " +
  "COALESCE(t.due_date, date(t.scheduled_at, '+8 hours')) AS effective_date, " +
  "t.waiting_on_person_id";

// ---------------------------------------------------------------------------
// 行 → DTO 映射
// ---------------------------------------------------------------------------

interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  owner_person_id: number;
  project_id: number | null;
  due_date: string | null;
  recurring_template_id: number | null;
  scheduled_at: string | null;
  original_scheduled_at: string | null;
  rescheduled_from_id: number | null;
  created_at: string;
  updated_at: string;
  blocked_at: string | null;
  blocked_reason: string | null;
  waiting_on_person_id: number | null;
  effective_date: string | null;
}

/** task 行 → DTO。`isRecurring` 由 `recurring_template_id IS NOT NULL` 派生。 */
export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    ownerPersonId: row.owner_person_id,
    projectId: row.project_id,
    dueDate: row.due_date,
    recurringTemplateId: row.recurring_template_id,
    scheduledAt: row.scheduled_at,
    originalScheduledAt: row.original_scheduled_at,
    rescheduledFromId: row.rescheduled_from_id,
    isRecurring: row.recurring_template_id !== null,
    effectiveDate: row.effective_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blockedAt: row.blocked_at,
    blockedReason: row.blocked_reason,
    waitingOnPersonId: row.waiting_on_person_id,
  };
}

// ---------------------------------------------------------------------------
// 入参校验与字符串处理
// ---------------------------------------------------------------------------

function requireNonBlank(value: string | null | undefined, message: string): string {
  if (value === null || value === undefined) {
    throw AppError.invalid(message);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) throw AppError.invalid(message);
  return trimmed;
}

function trimToOption(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 阻塞 / 等待原因长度上限 500 字符（ADR 0003 §D3）。注意用 `chars().count()` 风格
 *  按码点计数——汉字算 1 个字符。 */
const MAX_BLOCKED_REASON_CHARS = 500;

function ensureReasonLength(reason: string): void {
  if ([...reason].length > MAX_BLOCKED_REASON_CHARS) {
    throw AppError.invalid("阻塞原因不能超过 500 个字符。");
  }
}

/**
 * 截止日入库前的校验：空白折叠为「无截止」，非空必须是合法的 `YYYY-MM-DD`。
 *
 * 严格到底而不宽松兜底——日历精确选日与 chip 行走同一条路，一旦放进
 * `2026-13-01` 这种值，后面按 `due_date` 排序与分桶的三视图会静默错位。
 */
function parseDueDate(value: string | null | undefined): string | null {
  const text = trimToOption(value);
  if (text === null) return null;
  const date = parseSqlDate(text);
  if (date === null) {
    throw AppError.invalid("截止日格式不对,应形如 2026-09-10。");
  }
  return toSqlDate(date);
}

/**
 * 筛选条件的可选日期校验（`listTasksFiltered` 用）。
 *
 * 与 `parseDueDate` 同语义但接受 `Option<&str>` 直接传 `args` 字
 * 段、不强求 owned——筛选条件不进库，只参与 WHERE 拼装。字段名透传给中文错
 * 误，让科长知道是起/止哪一端坏了。
 */
function parseOptionalFilterDate(
  value: string | null | undefined,
  label: string,
): string | null {
  const text = trimToOption(value);
  if (text === null) return null;
  const date = parseSqlDate(text);
  if (date === null) {
    throw AppError.invalid(`${label}格式不对,应形如 2026-09-10。`);
  }
  return toSqlDate(date);
}

// ---------------------------------------------------------------------------
// 行查询助手
// ---------------------------------------------------------------------------

/** 取一条 task 行；不存在则返回 `null`。 */
export function fetchTask(db: Database.Database, id: number): Task | null {
  const row = db
    .prepare<[number], TaskRow>(`SELECT ${TASK_COLUMNS} FROM task WHERE id = ?`)
    .get(id);
  return row ? rowToTask(row) : null;
}

/** 取一名人员的**在飞**任务列表（ticket #22 · 人员矩阵）。 */
export function fetchInFlightTasksForPerson(
  db: Database.Database,
  ownerPersonId: number,
): Task[] {
  const placeholders = IN_FLIGHT_STATUSES.map(() => "?").join(",");
  const rows = db
    .prepare<unknown[], TaskRow>(
      `SELECT ${TASK_COLUMNS}
         FROM task
        WHERE owner_person_id = ?
          AND status IN (${placeholders})
        ORDER BY CASE status
                   WHEN 'Open'        THEN 0
                   WHEN 'In-progress' THEN 1
                   WHEN 'Blocked'     THEN 2
                   WHEN 'Waiting-on'  THEN 3
                 END ASC,
                 effective_date ASC,
                 id ASC`,
    )
    .all(ownerPersonId, ...IN_FLIGHT_STATUSES);
  return rows.map(rowToTask);
}

// ---------------------------------------------------------------------------
// 预检查助手
// ---------------------------------------------------------------------------

function ensurePersonExists(db: Database.Database, id: number): void {
  const row = db
    .prepare<[number], { id: number }>("SELECT id FROM person WHERE id = ?")
    .get(id);
  if (!row) throw AppError.invalid("负责人不存在,请先在人员管理里录入。");
}

function ensureProjectExists(db: Database.Database, id: number): void {
  const row = db
    .prepare<[number], { id: number }>("SELECT id FROM project WHERE id = ?")
    .get(id);
  if (!row) throw AppError.invalid("所属项目不存在。");
}

// ---------------------------------------------------------------------------
// 在飞排序片段（pub(crate) 等价）
// ---------------------------------------------------------------------------

/**
 * 「在飞任务优先 + due_date + created_at + id」排序的 SQL 片段。
 *
 * 在飞四态（`Open` / `In-progress` / `Blocked` / `Waiting-on`）排前，
 * `Done` / `Cancelled` 排后，各自内部按到期日 / 创建时间 / id 兜底避免
 * 抖动。这是 `listTasks` / `listTasksFiltered` / ticket #45 ⌘K `searchTasks` 共用的
 * 「任务在飞列表怎么排序」约定——单点改，避免三处漂移。`columnPrefix` 是
 * SQL 别名（`""` 或 `"t."`），`columnPrefix` 后的列名按所在 SQL 上下文确定。
 */
export function inFlightTaskOrderBy(columnPrefix: string): string {
  const p = columnPrefix;
  return [
    `CASE WHEN ${p}status IN ('Open','In-progress','Blocked','Waiting-on') THEN 0 ELSE 1 END ASC`,
    `${p}due_date ASC`,
    `${p}created_at ASC`,
    `${p}id ASC`,
  ].join(", ");
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

/**
 * 新建一次性任务。状态默认 `Open`；`blocked_at` / `blocked_reason` /
 * `waiting_on_person_id` 不在新建入口设置——任何进入阻塞态都得走
 * [`setTaskStatus`]。
 */
export function createTask(state: AppState, args: CreateTaskArgs): Task {
  const title = requireNonBlank(args.title, "任务标题不能为空。");
  const description = trimToOption(args.description);
  const dueDate = parseDueDate(args.dueDate ?? null);

  ensurePersonExists(state.db, args.ownerPersonId);
  if (args.projectId !== null && args.projectId !== undefined) {
    ensureProjectExists(state.db, args.projectId);
  }

  const now = state.clock.nowSql();
  let id: number | undefined;
  state.db.transaction(() => {
    const info = state.db
      .prepare(
        `INSERT INTO task
           (title, description, status, owner_person_id, project_id, due_date,
            created_at, updated_at)
         VALUES (?, ?, 'Open', ?, ?, ?, ?, ?)`,
      )
      .run(title, description, args.ownerPersonId, args.projectId ?? null, dueDate, now, now);
    id = Number(info.lastInsertRowid);
  })();

  if (id === undefined) throw AppError.internal("刚插入的任务立即查不到 id");
  const task = fetchTask(state.db, id);
  if (!task) {
    throw AppError.internal(
      `刚插入的任务 id=${id} 立即查不到,数据库状态异常`,
    );
  }
  return task;
}

/**
 * 编辑态保存（ticket #19「编辑即详情」）。
 *
 * 改写标题 / 描述 / 负责人 / 所属项目 / 截止日五个字段 + `updated_at`。
 * **刻意不碰** `status` 与阻塞三列——那是 [`setTaskStatus`] 的专属职责，
 * 两个入口都能写状态就等于没有唯一入口。
 */
export function updateTask(state: AppState, args: UpdateTaskArgs): Task {
  const title = requireNonBlank(args.title, "任务标题不能为空。");
  const description = trimToOption(args.description);
  const dueDate = parseDueDate(args.dueDate ?? null);

  ensurePersonExists(state.db, args.ownerPersonId);
  if (args.projectId !== null && args.projectId !== undefined) {
    ensureProjectExists(state.db, args.projectId);
  }

  const now = state.clock.nowSql();
  const result = state.db
    .prepare(
      `UPDATE task
          SET title           = ?,
              description     = ?,
              owner_person_id = ?,
              project_id      = ?,
              due_date        = ?,
              updated_at      = ?
        WHERE id = ?`,
    )
    .run(title, description, args.ownerPersonId, args.projectId ?? null, dueDate, now, args.id);

  if (result.changes === 0) {
    throw AppError.invalid("任务不存在或已被删除。");
  }
  const task = fetchTask(state.db, args.id);
  if (!task) throw AppError.internal(`任务 id=${args.id} 查询不一致`);
  return task;
}

/**
 * **全 app 唯一**的状态变更入口（ADR 0003 §D6）。
 *
 * 在单个事务内统一维护 `status` / `blocked_at` / `blocked_reason` /
 * `waiting_on_person_id` 四列与 `updated_at`：
 * - 进入 Blocked / Waiting-on：`blocked_at = now`（覆盖——反复切换不累计）
 * - 切出到 Open / In-progress / Done / Cancelled：清空 `blocked_at` /
 *   `blocked_reason` / `waiting_on_person_id`
 * - DB CHECK `length(trim(blocked_reason)) >= 1` 由 App 层预检保证
 *   "Blocked / Waiting-on 下 reason 必填"——提前给出面向科长的中文错误,
 *   而不是让 DB 抛 SQLITE_CONSTRAINT 给前端翻译
 */
export function setTaskStatus(state: AppState, args: SetTaskStatusArgs): Task {
  const now = state.clock.nowSql();
  const newStatus = args.status;

  // 计算三列的目标值——单一来源，事务内直接写入。
  // `blocked_at` 由本函数在进入阻塞态时设为 now，切出时清空。
  const { blockedAt, blockedReason, waitingOnPersonId } = deriveBlockColumns(
    newStatus,
    args.blockedReason ?? null,
    args.waitingOnPersonId ?? null,
    now,
  );

  state.db.transaction(() => {
    const result = state.db
      .prepare(
        `UPDATE task
            SET status               = ?,
                blocked_at           = ?,
                blocked_reason       = ?,
                waiting_on_person_id = ?,
                updated_at           = ?
          WHERE id = ?`,
      )
      .run(
        newStatus,
        blockedAt,
        blockedReason,
        waitingOnPersonId,
        now,
        args.taskId,
      );
    if (result.changes === 0) {
      throw AppError.invalid("任务不存在或已被删除。");
    }
  })();

  const task = fetchTask(state.db, args.taskId);
  if (!task) throw AppError.internal(`任务 id=${args.taskId} 查询不一致`);
  return task;
}

/**
 * 状态变更时计算 `blocked_at` / `blocked_reason` / `waiting_on_person_id`
 * 三列的目标值。规则承接 ADR 0003 §D2 / §D3 / §D4：
 * - 进入 Blocked / Waiting-on：`blocked_at = now`（覆盖——反复切换不累计）；
 *   `blocked_reason` trim 后必填且长度 ≤ 500；`waiting_on_person_id` 在
 *   Waiting-on 下可选，Blocked 下强制 null（DB CHECK 不允许）。
 * - 切出到其它状态：三列均为 `null`。
 */
export function deriveBlockColumns(
  newStatus: TaskStatus,
  rawReason: string | null,
  waitingOnPersonId: number | null,
  now: string,
): { blockedAt: string | null; blockedReason: string | null; waitingOnPersonId: number | null } {
  if (newStatus === "Blocked") {
    const reason = requireNonBlank(rawReason, "阻塞原因不能为空,请填写卡在何处。");
    ensureReasonLength(reason);
    // Blocked 状态下不允许 waiting_on_person_id——它只对 Waiting-on 有定义
    // (DB CHECK `waiting_on_person_id IS NULL OR status = 'Waiting-on'`)。
    return { blockedAt: now, blockedReason: reason, waitingOnPersonId: null };
  }
  if (newStatus === "Waiting-on") {
    const reason = requireNonBlank(rawReason, "等待原因不能为空,请填写在等什么。");
    ensureReasonLength(reason);
    return { blockedAt: now, blockedReason: reason, waitingOnPersonId };
  }
  return { blockedAt: null, blockedReason: null, waitingOnPersonId: null };
}

// ---------------------------------------------------------------------------
// 列表 / 视图查询
// ---------------------------------------------------------------------------

/**
 * 列出任务。`includeCancelled = false`（默认）过滤掉 Cancelled（ADR 0001
 * §3.5「Cancelled 充当 task 层软删」），其余 5 状态全在；Done 也保留——
 *
 * `ownerPersonId` / `projectId` 给定则仅返回该范围。
 */
export function listTasks(state: AppState, args: ListTasksArgs): Task[] {
  const where: string[] = [];
  if (!args.includeCancelled) where.push("status != 'Cancelled'");
  if (args.ownerPersonId !== null && args.ownerPersonId !== undefined) {
    where.push("owner_person_id = ?");
  }
  if (args.projectId !== null && args.projectId !== undefined) {
    where.push("project_id = ?");
  }

  const whereClause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;

  // 在飞优先；非在飞（Cancelled 已被前面滤掉，只剩 Done）置后；
  // 各自内部按到期日 / 创建时间兜底避免抖动。
  const orderClause = ` ORDER BY ${inFlightTaskOrderBy("")}`;

  const sql = `SELECT ${TASK_COLUMNS} FROM task${whereClause}${orderClause}`;

  // 把两个可选 FK 串成一个 0–2 元素的 `number | null` 数组，与 SQL 中 `?` 的
  // 数量一致（按 args 拼装的顺序）。
  const params: Array<number | null> = [];
  if (args.ownerPersonId !== null && args.ownerPersonId !== undefined) {
    params.push(args.ownerPersonId);
  }
  if (args.projectId !== null && args.projectId !== undefined) {
    params.push(args.projectId);
  }

  const rows = state.db.prepare<unknown[], TaskRow>(sql).all(...params);
  return rows.map(rowToTask);
}

/**
 * 复合筛选任务列表（ticket #27）。
 *
 * 状态 × 人员 × 项目 × 到期日区间任意组合 + 是否含 Cancelled / 是否含
 * 离岗人员负责的任务。
 *
 * 与 [`listTasks`] 平行存在，**不替换**——`listTasks` 是历史入口，UI
 * 上若干"无筛选只看"路径仍走它；本命令是 ⌘K 命令面板 / 高级筛选的入口，
 * 字段集显式、避免旧调用方的隐式默认值漂移。
 *
 * 离岗过滤通过 `JOIN person p` + `p.deactivated_at IS NULL` 表达——避免
 * 在 task 层冗余存"负责人是否离岗"（那是 person 的语义，跨表保持权威）。
 */
export function listTasksFiltered(
  state: AppState,
  args: ListTasksFilteredArgs,
): Task[] {
  // 入参预检：截止日区间两端若有，必须是 YYYY-MM-DD——与 `createTask`
  // / `parseOptionalFilterDate` 的语义一致，避免脏日期混进 SQL 字符串。
  const dueDateFrom = parseOptionalFilterDate(args.dueDateFrom ?? null, "截止日起");
  const dueDateTo = parseOptionalFilterDate(args.dueDateTo ?? null, "截止日止");

  // 拼 WHERE：每个维度的占位符按可读顺序固定，绑参顺序跟着走。
  // 固定顺序的好处：加新维度时只动这一处，rowToTask 不感知 SQL 漂移。
  const where: string[] = [];
  if (!args.includeCancelled) where.push("t.status != 'Cancelled'");
  if (args.statuses.length > 0) {
    // 状态枚举数量很小，直接展开 `IN (?, ?, ...)`。
    const placeholders = new Array(args.statuses.length).fill("?").join(",");
    where.push(`t.status IN (${placeholders})`);
  }
  if (args.ownerPersonId !== null && args.ownerPersonId !== undefined) {
    where.push("t.owner_person_id = ?");
  }
  if (args.projectId !== null && args.projectId !== undefined) {
    where.push("t.project_id = ?");
  }
  if (dueDateFrom !== null) where.push("t.due_date >= ?");
  if (dueDateTo !== null) where.push("t.due_date <= ?");
  if (!args.includeDeactivatedOwners) where.push("p.deactivated_at IS NULL");

  // JOIN person 仅在需要离岗过滤时引入——`includeDeactivatedOwners`
  // 不需要 person 的任何列，平白 JOIN 会拖一个 nested loop。其它维度
  // （状态 / owner / project / due_date）都只读 `task` 表。
  let sql = `SELECT ${TASK_COLUMNS_WITH_T} FROM task t`;
  if (!args.includeDeactivatedOwners) {
    sql += " JOIN person p ON p.id = t.owner_person_id";
  }
  if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
  // 与 `listTasks` 同序——在飞优先 + due_date + created_at + id 兜底。
  sql += ` ORDER BY ${inFlightTaskOrderBy("t.")}`;

  // 参数顺序与 WHERE 拼装顺序一一对应。
  const params: Array<string | number> = [];
  for (const s of args.statuses) params.push(s);
  if (args.ownerPersonId !== null && args.ownerPersonId !== undefined) {
    params.push(args.ownerPersonId);
  }
  if (args.projectId !== null && args.projectId !== undefined) {
    params.push(args.projectId);
  }
  if (dueDateFrom !== null) params.push(dueDateFrom);
  if (dueDateTo !== null) params.push(dueDateTo);

  const rows = state.db.prepare<unknown[], TaskRow>(sql).all(...params);
  return rows.map(rowToTask);
}

// ---------------------------------------------------------------------------
// 「今日 / 本周」视图（ticket #21）
// ---------------------------------------------------------------------------

/**
 * 桶边界——三个变体合在一起描述 4 个桶的 WHERE 拼装，避免 4 处拼 SQL 漂移。
 *
 * `toSql(column)` 写出这一桶在指定日期列上的 WHERE 片段——`column` 是
 * SQL 表达式（一次性走 `due_date`，instance 走
 * `date(scheduled_at, '+8 hours')`，Asia/Shanghai 固定 +8h）。`?` 索引
 * 在两段 SQL 间共用，所以参数直接复用 [`bucketBindParams`]。
 */
enum BucketBoundKind {
  StrictlyBefore,
  OnDay,
  Between,
}

interface BucketBound {
  kind: BucketBoundKind;
  lo: Date;
  hi: Date;
}

function bucketBoundStrictlyBefore(day: Date): BucketBound {
  return { kind: BucketBoundKind.StrictlyBefore, lo: day, hi: day };
}

function bucketBoundOnDay(day: Date): BucketBound {
  return { kind: BucketBoundKind.OnDay, lo: day, hi: day };
}

function bucketBoundBetween(lo: Date, hi: Date): BucketBound {
  return { kind: BucketBoundKind.Between, lo, hi };
}

/**
 * 写出这一桶在指定日期列上的 WHERE 片段。两段分支（due_date / instance）
 * 必须用不同的匿名 `?` 占位——同一 `?` 在 SQL 中多次出现会与 better-sqlite3
 * 的绑定计数不兼容（见 `fetchBucket`）。
 */
function bucketBoundToSql(bound: BucketBound, column: string): string {
  if (bound.kind === BucketBoundKind.StrictlyBefore) {
    return `${column} < ?`;
  }
  if (bound.kind === BucketBoundKind.OnDay) {
    return `${column} = ?`;
  }
  return `${column} >= ? AND ${column} <= ?`;
}

/**
 * 这一桶要 bind 几个参数，顺序与 SQL 中 `?` 一致。
 *
 * 返回 2-4 个：`[due_lo, due_hi?, inst_lo, inst_hi?]`——单值桶只给 lo。
 */
function bucketBindParams(bound: BucketBound): string[] {
  const lo = toSqlDate(bound.lo);
  const hi = toSqlDate(bound.hi);
  if (bound.kind === BucketBoundKind.Between) {
    return [lo, hi, lo, hi];
  }
  return [lo, lo];
}

/**
 * 「今日 / 本周」视图（ticket #21）。
 *
 * 边界规则：
 * - 桶的"今天"由 `state.clock.today()`（已带本地时区换算）给出，
 *   UTC 夜跨过来后桶跟着挪。
 * - 「本周日」= 当前所在周（周一~周日）的周日；周日当天桶为空，
 *   周一当天桶跨到周日。详见 [`weekEnd`] 的单元测试。
 * - 每个桶 SQL 形如：
 *   `WHERE status NOT IN ('Done','Cancelled') AND (due_date ...)`
 *   命中 `idx_task_due_date` partial index（验收 AC）。
 */
export function todayWeek(state: AppState): TodayWeek {
  const today = state.clock.today();
  const tomorrow = addDays(today, 1, "today+1 越界,日期不合理");
  const restStart = addDays(tomorrow, 1, "today+2 越界,日期不合理");
  const weekEndDate = weekEnd(today);

  const activePeople = (
    state.db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM person WHERE deactivated_at IS NULL",
      )
      .get()?.c ?? 0
  );
  const inProgress = (
    state.db
      .prepare<[string], { c: number }>(
        "SELECT COUNT(*) AS c FROM task WHERE status = ?",
      )
      .get("In-progress")?.c ?? 0
  );
  const blockedPlaceholders = BLOCKED_STATUSES.map(() => "?").join(",");
  const blockedStmt = state.db.prepare<unknown[], { c: number }>(
    `SELECT COUNT(*) AS c FROM task WHERE status IN (${blockedPlaceholders})`,
  );
  const blocked = blockedStmt.get(...BLOCKED_STATUSES)?.c ?? 0;

  const overdue = fetchBucket(state.db, bucketBoundStrictlyBefore(today));
  const todayBucket = fetchBucket(state.db, bucketBoundOnDay(today));
  const tomorrowBucket = fetchBucket(state.db, bucketBoundOnDay(tomorrow));
  const thisWeekRest = fetchBucket(
    state.db,
    bucketBoundBetween(restStart, weekEndDate),
  );

  const materializationWindowEndDate = addDays(
    today,
    MATERIALIZATION_WINDOW_DAYS,
    "today+12 周越界",
  );

  return {
    counts: {
      activePeople,
      inProgress,
      blocked,
    },
    buckets: {
      overdue,
      today: todayBucket,
      tomorrow: tomorrowBucket,
      thisWeekRest,
    },
    materializationWindowEnd: toSqlDate(materializationWindowEndDate),
  };
}

/**
 * 取一桶的任务——共用 SELECT 列与排序，只在 WHERE 上按桶边界区分。
 *
 * 一次性走 `due_date`，instance 走 `date(scheduled_at, '+8 hours')`——
 * 两条路径在 SQL 端用 OR union-all，各自带 `IS NOT NULL` 守护。两段共用
 * 同一组 `?1` / `?2`（SQLite 允许同一条 SQL 里 `?` 被多处引用）。
 */
function fetchBucket(db: Database.Database, bound: BucketBound): Task[] {
  const sqlDue = bucketBoundToSql(bound, "due_date");
  const sqlInst = bucketBoundToSql(bound, "date(scheduled_at, '+8 hours')");
  const sql = `
    SELECT ${TASK_COLUMNS}
       FROM task
      WHERE status NOT IN ('Done','Cancelled')
        AND (
            (due_date IS NOT NULL AND ${sqlDue})
         OR (recurring_template_id IS NOT NULL
             AND scheduled_at IS NOT NULL
             AND ${sqlInst})
        )
      ORDER BY effective_date ASC, id ASC`;
  const params = bucketBindParams(bound);
  const rows = db.prepare<unknown[], TaskRow>(sql).all(...params);
  return rows.map(rowToTask);
}

/**
 * 「本周剩余」桶的右边界——本周日（周一~周日）。
 *
 * 中国习惯周一到周日，所以"本周"=[周一, 周日]。
 * - 周日当天 → `today`（再往后就是下周，本周已结束）
 * - 周一~周六 → `today + (7 - weekday)` 天到周日
 *
 * 用 JS Date 计算：`weekday` 取 Mon=0..Sun=6 的整数。
 */
export function weekEnd(today: Date): Date {
  // JS `getUTCDay()`：Sun=0..Sat=6；转 Mon=0..Sun=6。
  const weekday = (today.getUTCDay() + 6) % 7;
  const offset = 7 - weekday - 1;
  return addDays(today, offset, "week_end 最多 +6 天");
}

/** 在 `Date` 上加 `days` 天。失败时抛 `AppError.internal`。 */
function addDays(today: Date, days: number, errMessage: string): Date {
  const next = new Date(today.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  if (Number.isNaN(next.getTime())) {
    throw AppError.internal(errMessage);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 截止 chip 行
// ---------------------------------------------------------------------------

/**
 * 截止 chip 行此刻的取值（ticket #19）。
 *
 * 「今天 / 明天 / 一周后」是相对**科长本地日历日**的，随时钟走；chip 有哪
 * 几格、什么文案、什么顺序，也都在这里定死。前端拿到就渲染，不自己算日期
 * ——否则同一个「今天」会在 Rust 与 TS 两处各算一遍，迟早在时区上分叉。
 */
export function listDueDateOptions(state: AppState): DueDateOption[] {
  return dueDateOptions(state.clock.today());
}

/**
 * `due_date_options` 的纯函数版本——便于测试。
 *
 * 「一周后」= 今天 + 7 天，走日历加法而不是裸算术，跨月跨年由 `Date` 兜。
 * 理论上 `addDays` 只在逼近 `Date.MAX_SAFE_INTEGER` 时返回无效日期；
 * 真到了那天，不如没有这一格，也好过整行 chip 取不出来。
 */
export function dueDateOptions(today: Date): DueDateOption[] {
  const offsetOption = (
    chip: DueDateChip,
    label: string,
    days: number,
  ): DueDateOption => {
    let dueDate: string | null = null;
    try {
      const next = addDays(today, days, "chip 日期越界");
      dueDate = toSqlDate(next);
    } catch {
      dueDate = null;
    }
    return { chip, label, dueDate };
  };
  return [
    offsetOption("today", "今天", 0),
    offsetOption("tomorrow", "明天", 1),
    offsetOption("next-week", "一周后", 7),
    { chip: "none", label: "无", dueDate: null },
  ];
}
