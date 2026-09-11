//! 任务命令层（tickets #18 / #19 / #21）。
//!
//! 覆盖一次性任务的创建、状态变更与列表查询,以及「今日 / 本周」视图查询。
//!
//! 约束（取自 ADR 0001 §3.5 + ADR 0003）：
//! - `status` 6 值枚举：`Open`/`In-progress`/`Blocked`/`Waiting-on`/`Done`/`Cancelled`
//! - `Blocked` / `Waiting-on` 状态 `blocked_reason` 必填且长度 ≤ 500
//! - `waiting_on_person_id` 仅在 `Waiting-on` 下允许非空（允许自反）
//! - 一次性 / instance 互斥（`recurring_template_id` 与 `scheduled_at` 同生同灭）——本票不直接消费,FK 列已就位
//! - 阻塞三列的派生（`blocked_at` 刷新 / 切出清空 / 反复切换不累计）由
//!   [`set_task_status`] 作为**全 app 唯一状态变更入口**在事务内统一维护
//!
//! 所有命令入参与返回都是稳定 DTO（camelCase），不透传行结构。
//! 时间戳统一用 UTC 入库格式 `"%Y-%m-%d %H:%M:%S"`，由 [`crate::clock`] 渲染。

use crate::clock::{parse_sql_date, to_sql_date};
use crate::commands::validation::{ensure_row_exists, require_non_blank, trim_to_option};
use crate::error::{AppError, Result};
use crate::state::AppState;
use chrono::{Days, Datelike, NaiveDate};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// 任务 6 状态。状态机唯一入口是 [`set_task_status`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    Open,
    #[serde(rename = "In-progress")]
    InProgress,
    Blocked,
    #[serde(rename = "Waiting-on")]
    WaitingOn,
    Done,
    Cancelled,
}

impl TaskStatus {
    /// DB 入库的字符串字面量（与 `V001__initial.sql` 的 CHECK 枚举一致）。
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "Open",
            Self::InProgress => "In-progress",
            Self::Blocked => "Blocked",
            Self::WaitingOn => "Waiting-on",
            Self::Done => "Done",
            Self::Cancelled => "Cancelled",
        }
    }
}

/// 任务 DTO。`blocked_*` 与 `waiting_on_person_id` 在非阻塞态均为 `None`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub owner_person_id: i64,
    pub project_id: Option<i64>,
    pub due_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub blocked_at: Option<String>,
    pub blocked_reason: Option<String>,
    pub waiting_on_person_id: Option<i64>,
}

/// 新建任务的入参。一次性任务的最小字段集：标题 + 负责人 + 可选项目 / 截止日。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskArgs {
    pub title: String,
    pub description: Option<String>,
    pub owner_person_id: i64,
    pub project_id: Option<i64>,
    pub due_date: Option<String>,
}

/// 状态变更入参——全 app 唯一的状态变更手势。
///
/// `blocked_reason`：
/// - 切到 Blocked / Waiting-on：必填（trim 后长度 ≥ 1 且 ≤ 500）
/// - 其它状态：忽略（即便传了也不会写入）
///
/// `waiting_on_person_id`：
/// - 切到 Waiting-on：可选（允许为空,如"等系统自动恢复"无需指人）
/// - 其它状态：忽略
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTaskStatusArgs {
    pub task_id: i64,
    pub status: TaskStatus,
    pub blocked_reason: Option<String>,
    pub waiting_on_person_id: Option<i64>,
}

/// 任务查询过滤条件。
/// - `include_cancelled = false`（默认）：默认在飞列表,过滤掉 Cancelled；
///   Done 状态保留（"今天做完了"仍要看见）。
/// - `include_cancelled = true`：历史视图,含 Cancelled。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksArgs {
    pub include_cancelled: bool,
    pub owner_person_id: Option<i64>,
    pub project_id: Option<i64>,
}

/// 编辑态保存的入参（ticket #19「编辑即详情」）。
///
/// 字段集与新建一致——点开已有任务看到的就是同一套表单。**不含 `status`
/// 与阻塞三列**：状态机的唯一入口仍是 [`set_task_status`]，编辑保存不得
/// 成为第二个入口（ADR 0003 §D6）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskArgs {
    pub id: i64,
    pub title: String,
    pub description: Option<String>,
    pub owner_person_id: i64,
    pub project_id: Option<i64>,
    pub due_date: Option<String>,
}

/// 截止 chip 行的一格（ticket #19）。
///
/// 「无」这一格的 `due_date` 是 `None`——它不是某个日期，而是"不设截止"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DueDateChip {
    Today,
    Tomorrow,
    NextWeek,
    None,
}

/// 截止 chip 行的一格连同它此刻代表的日期。
///
/// `label` 一并由命令层给出：界面纯中文硬编码、无 i18n 层（spec #15），
/// 前端照着渲染即可，不自己拼文案，也不自己算日期。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueDateOption {
    pub chip: DueDateChip,
    pub label: String,
    pub due_date: Option<String>,
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 新建一次性任务。状态默认 `Open`；`blocked_at` / `blocked_reason` /
/// `waiting_on_person_id` 不在新建入口设置——任何进入阻塞态都得走
/// [`set_task_status`]。
#[tauri::command]
pub fn create_task(state: State<'_, AppState>, args: CreateTaskArgs) -> Result<Task> {
    let title = require_non_blank(args.title, "任务标题不能为空。")?;
    let description = trim_to_option(args.description);
    let due_date = parse_due_date(args.due_date)?;

    let conn = state.db()?;
    ensure_person_exists(&conn, args.owner_person_id)?;
    if let Some(project_id) = args.project_id {
        ensure_project_exists(&conn, project_id)?;
    }

    let now = state.now_sql();
    let result = conn.execute(
        "INSERT INTO task
           (title, description, status, owner_person_id, project_id, due_date,
            created_at, updated_at)
         VALUES (?1, ?2, 'Open', ?3, ?4, ?5, ?6, ?6)",
        params![title, description, args.owner_person_id, args.project_id, due_date, now],
    );

    if let Err(err) = result {
        return Err(err.into());
    }

    let id = conn.last_insert_rowid();
    fetch_task(&conn, id)?.ok_or_else(|| {
        AppError::Internal(format!("刚插入的任务 id={id} 立即查不到,数据库状态异常"))
    })
}

/// 编辑态保存（ticket #19「编辑即详情」）。
///
/// 改写标题 / 描述 / 负责人 / 所属项目 / 截止日五个字段 + `updated_at`。
/// **刻意不碰** `status` 与阻塞三列——那是 [`set_task_status`] 的专属职责，
/// 两个入口都能写状态就等于没有唯一入口。
#[tauri::command]
pub fn update_task(state: State<'_, AppState>, args: UpdateTaskArgs) -> Result<Task> {
    let title = require_non_blank(args.title, "任务标题不能为空。")?;
    let description = trim_to_option(args.description);
    let due_date = parse_due_date(args.due_date)?;

    let conn = state.db()?;
    ensure_person_exists(&conn, args.owner_person_id)?;
    if let Some(project_id) = args.project_id {
        ensure_project_exists(&conn, project_id)?;
    }

    let now = state.now_sql();
    let affected = conn.execute(
        "UPDATE task
            SET title           = ?1,
                description     = ?2,
                owner_person_id = ?3,
                project_id      = ?4,
                due_date        = ?5,
                updated_at      = ?6
          WHERE id = ?7",
        params![
            title,
            description,
            args.owner_person_id,
            args.project_id,
            due_date,
            now,
            args.id,
        ],
    )?;

    if affected == 0 {
        return Err(AppError::invalid("任务不存在或已被删除。"));
    }

    fetch_task(&conn, args.id)?
        .ok_or_else(|| AppError::Internal(format!("任务 id={} 查询不一致", args.id)))
}

/// 截止 chip 行此刻的取值（ticket #19）。
///
/// 「今天 / 明天 / 一周后」是相对**科长本地日历日**的，随时钟走；chip 有哪
/// 几格、什么文案、什么顺序，也都在这里定死。前端拿到就渲染，不自己算日期
/// ——否则同一个「今天」会在 Rust 与 TS 两处各算一遍，迟早在时区上分叉。
#[tauri::command]
pub fn list_due_date_options(state: State<'_, AppState>) -> Result<Vec<DueDateOption>> {
    Ok(due_date_options(state.today()))
}

/// **全 app 唯一**的状态变更入口（ADR 0003 §D6）。
///
/// 在单个事务内统一维护 `status` / `blocked_at` / `blocked_reason` /
/// `waiting_on_person_id` 四列与 `updated_at`：
/// - 进入 Blocked / Waiting-on：`blocked_at = now`（覆盖——反复切换不累计）
/// - 切出到 Open / In-progress / Done / Cancelled：清空 `blocked_at` /
///   `blocked_reason` / `waiting_on_person_id`
/// - DB CHECK `length(trim(blocked_reason)) >= 1` 由 App 层预检保证
///   "Blocked / Waiting-on 下 reason 必填"——提前给出面向科长的中文错误,
///   而不是让 DB 抛 SQLITE_CONSTRAINT 给前端翻译
#[tauri::command]
pub fn set_task_status(
    state: State<'_, AppState>,
    args: SetTaskStatusArgs,
) -> Result<Task> {
    let now = state.now_sql();
    let new_status = args.status;

    // 计算三列的目标值——单一来源,事务内直接写入。
    // `blocked_at` 由本函数在进入阻塞态时设为 Some(&now),切出时清空。
    let (blocked_at, blocked_reason, waiting_on_person_id) =
        derive_block_columns(new_status, args.blocked_reason, args.waiting_on_person_id, &now)?;

    let conn = state.db()?;
    let tx = conn.unchecked_transaction()?;

    let affected = tx.execute(
        "UPDATE task
            SET status               = ?1,
                blocked_at           = ?2,
                blocked_reason       = ?3,
                waiting_on_person_id = ?4,
                updated_at           = ?5
          WHERE id = ?6",
        params![
            new_status.as_str(),
            blocked_at,
            blocked_reason,
            waiting_on_person_id,
            now,
            args.task_id,
        ],
    )?;

    if affected == 0 {
        return Err(AppError::invalid("任务不存在或已被删除。"));
    }

    // 事务内先读到最新行,再 commit——`Transaction` 借走所有权,
    // `commit` 后无法再 borrow。
    let updated = fetch_task(&tx, args.task_id)?.ok_or_else(|| {
        AppError::Internal(format!("任务 id={} 查询不一致", args.task_id))
    })?;
    tx.commit().map_err(AppError::from)?;
    Ok(updated)
}

/// 列出任务。`include_cancelled = false`（默认）过滤掉 Cancelled（ADR 0001
/// §3.5「Cancelled 充当 task 层软删」），其余 5 状态全在；Done 也保留——
///
/// `owner_person_id` / `project_id` 给定则仅返回该范围。
#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>, args: ListTasksArgs) -> Result<Vec<Task>> {
    let conn = state.db()?;

    let mut sql = String::from(
        "SELECT id, title, description, status, owner_person_id, project_id, due_date,
                created_at, updated_at, blocked_at, blocked_reason, waiting_on_person_id
           FROM task",
    );
    let mut where_clauses: Vec<&str> = Vec::new();
    if !args.include_cancelled {
        where_clauses.push("status != 'Cancelled'");
    }
    if args.owner_person_id.is_some() {
        where_clauses.push("owner_person_id = ?");
    }
    if args.project_id.is_some() {
        where_clauses.push("project_id = ?");
    }
    if !where_clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clauses.join(" AND "));
    }
    // 在飞优先；非在飞（Cancelled 已被前面滤掉,只剩 Done）置后；
    // 各自内部按到期日 / 创建时间兜底避免抖动。
    sql.push_str(" ORDER BY CASE WHEN status IN (");
    let in_flight: Vec<String> = [
        TaskStatus::Open,
        TaskStatus::InProgress,
        TaskStatus::Blocked,
        TaskStatus::WaitingOn,
    ]
    .iter()
    .map(|s| format!("'{}'", s.as_str()))
    .collect();
    sql.push_str(&in_flight.join(","));
    sql.push_str(") THEN 0 ELSE 1 END ASC, due_date ASC, created_at ASC, id ASC");

    let mut stmt = conn.prepare(&sql)?;
    // 把两个可选 FK 串成一个 0–2 元素的 `Option<i64>` 迭代器,与 SQL 中
    // `?` 的数量一致（按 `args` 拼装的顺序）。
    let params_iter: Vec<Option<i64>> = args
        .owner_person_id
        .into_iter()
        .chain(args.project_id)
        .map(Some)
        .collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(params_iter), row_to_task)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

/// 「今日 / 本周」视图（ticket #21）的计数瓦片。
///
/// 三个数字都是**全库范围**的——不限于本周；瓦片要回答"全局是什么状态"，
/// 四列才回答"这周到期的有哪些"。两类语义刻意分开。
///
/// `active_people`：花名册里 `deactivated_at IS NULL` 的行数。
/// `in_progress`：状态 = 'In-progress' 的任务数（不限截止日）。
/// `blocked`：状态 ∈ {Blocked, Waiting-on} 的任务数（不限截止日）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayWeekCounts {
    pub active_people: i64,
    pub in_progress: i64,
    pub blocked: i64,
}

/// 四列时间轴各自的桶（ticket #21）。
///
/// **只看在飞任务**：Done / Cancelled 不进任何桶（Cancelled 在 task 层
/// 充当软删，Done 不需要"按紧迫度读"）。无 `due_date` 也不进桶——
/// 视图是按截止日分桶的时间轴,没截止日的任务归「任务列表」等其它视图。
///
/// 排序：各桶内部 `due_date ASC, id ASC`，避免同日期内 UI 抖动。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayWeekBuckets {
    /// `due_date < today` 的在飞任务。
    pub overdue: Vec<Task>,
    /// `due_date == today` 的在飞任务。
    pub today: Vec<Task>,
    /// `due_date == today + 1` 的在飞任务。
    pub tomorrow: Vec<Task>,
    /// `today + 2 <= due_date <= 本周日` 的在飞任务。
    ///
    /// 末列止于**本周日**：周一到周六时为"今天 + 2 ~ 本周日"；
    /// 周日当天时为空（再往后就是下周）。不外扩——跨度由 [`week_end`] 单点定。
    pub this_week_rest: Vec<Task>,
}

/// 「今日 / 本周」视图的 DTO。
///
/// 瓦片数 + 四列桶，一次 RPC 拉完整张看板。命令层负责：
/// - 从可注入 [`Clock`] 取「今天」（已带本地时区换算）
/// - 算「本周日」边界
/// - 按桶跑 4 次 SELECT,各自命中 `(due_date) WHERE due_date IS NOT NULL` 部分索引
/// - 跑 3 次 COUNT 算瓦片数
///
/// 前端不自己算日期、不自己分桶——业务逻辑零在 TS 里。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayWeek {
    pub counts: TodayWeekCounts,
    pub buckets: TodayWeekBuckets,
}

/// 「今日 / 本周」视图查询（ticket #21 默认落地页）。
///
/// 与「人员矩阵」「项目看板」平级为顶层 tab。本命令是该视图唯一的数据
/// 入口,前端不再调 `list_tasks` 自己分桶。
///
/// 边界规则：
/// - 桶的"今天"由 [`AppState::today`]（→ [`crate::clock::Clock::today`]）给出，
///   已按科长本地时区换算,UTC 夜跨过来后桶跟着挪。
/// - 「本周日」= 当前所在周（周一~周日）的周日；周日当天桶为空,
///   周一当天桶跨到周日。详见 [`week_end`] 的单元测试。
/// - 每个桶 SQL 形如：
///   `WHERE due_date IS NOT NULL AND due_date < ?1 AND status NOT IN ('Done','Cancelled')`
///   命中 `idx_task_due_date` partial index（验收 AC）。
#[tauri::command]
pub fn today_week(state: State<'_, AppState>) -> Result<TodayWeek> {
    let conn = state.db()?;
    let today = state.today();
    let tomorrow = today
        .checked_add_days(Days::new(1))
        .ok_or_else(|| AppError::Internal("today+1 越界,日期不合理".into()))?;
    let rest_start = tomorrow
        .checked_add_days(Days::new(1))
        .ok_or_else(|| AppError::Internal("today+2 越界,日期不合理".into()))?;
    let week_end = week_end(today);

    let active_people = count_active_people(&conn)?;
    let in_progress = count_tasks_with_status(&conn, "In-progress")?;
    let blocked = count_tasks_with_status_in(&conn, &["Blocked", "Waiting-on"])?;

    let overdue = fetch_bucket(&conn, BucketBound::StrictlyBefore(today))?;
    let today_bucket = fetch_bucket(&conn, BucketBound::OnDay(today))?;
    let tomorrow_bucket = fetch_bucket(&conn, BucketBound::OnDay(tomorrow))?;
    let this_week_rest = fetch_bucket(&conn, BucketBound::Between(rest_start, week_end))?;

    Ok(TodayWeek {
        counts: TodayWeekCounts {
            active_people,
            in_progress,
            blocked,
        },
        buckets: TodayWeekBuckets {
            overdue,
            today: today_bucket,
            tomorrow: tomorrow_bucket,
            this_week_rest,
        },
    })
}

/// 桶边界。三个变体合在一起描述 4 个桶的 WHERE 拼装——避免 4 处拼 SQL 漂移。
#[derive(Debug, Clone, Copy)]
enum BucketBound {
    /// `due_date < day`（已逾期）
    StrictlyBefore(NaiveDate),
    /// `due_date == day`（今天 / 明天复用）
    OnDay(NaiveDate),
    /// `lo <= due_date <= hi`，含两端——本周剩余。
    ///
    /// 调用方传 `lo = tomorrow`、`hi = week_end`；语义上"明天到本周日"。
    Between(NaiveDate, NaiveDate),
}

impl BucketBound {
    /// 写出这一桶的 WHERE 片段（不含公共的 `due_date IS NOT NULL` 与
    /// `status NOT IN (...)`，由 [`fetch_bucket`] 一并拼上）。
    fn to_sql(self) -> &'static str {
        match self {
            Self::StrictlyBefore(_) => "due_date < ?1",
            Self::OnDay(_) => "due_date = ?1",
            Self::Between(_, _) => "due_date >= ?1 AND due_date <= ?2",
        }
    }

    /// 这一桶要 bind 几个参数,顺序与 SQL 中 `?` 一致。
    fn bind_params(self) -> Vec<String> {
        match self {
            Self::StrictlyBefore(day) | Self::OnDay(day) => vec![to_sql_date(day)],
            Self::Between(lo, hi) => vec![to_sql_date(lo), to_sql_date(hi)],
        }
    }
}

/// 取一桶的任务。
///
/// 共用 SELECT 列与排序,只在 WHERE 上按 [`BucketBound`] 区分。
/// 命中 `idx_task_due_date` partial index——WHERE 起手就是
/// `due_date IS NOT NULL AND due_date < / = / BETWEEN ...`,
/// partial index 把 `due_date IS NOT NULL` 那部分预筛掉。
fn fetch_bucket(
    conn: &rusqlite::Connection,
    bound: BucketBound,
) -> Result<Vec<Task>> {
    let sql = format!(
        "SELECT id, title, description, status, owner_person_id, project_id, due_date, \
                created_at, updated_at, blocked_at, blocked_reason, waiting_on_person_id \
           FROM task \
          WHERE due_date IS NOT NULL \
            AND status NOT IN ('Done','Cancelled') \
            AND {bound_sql} \
          ORDER BY due_date ASC, id ASC",
        bound_sql = bound.to_sql(),
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_iter = bound.bind_params();
    let rows = stmt.query_map(rusqlite::params_from_iter(params_iter), row_to_task)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

/// 在岗人数：`person.deactivated_at IS NULL` 的行数。
///
/// 不传子组过滤——"全局在岗人数"是瓦片的语义,不是"某子组在岗人数"。
fn count_active_people(conn: &rusqlite::Connection) -> Result<i64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM person WHERE deactivated_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    Ok(n)
}

/// `status = ?` 的任务数（不限截止日、不限在飞——瓦片要"全局"语义）。
fn count_tasks_with_status(conn: &rusqlite::Connection, status: &str) -> Result<i64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task WHERE status = ?1",
        params![status],
        |row| row.get(0),
    )?;
    Ok(n)
}

/// `status IN (...)` 的任务数。
///
/// 不让 `params_from_iter` 拼 IN 列表——`sqlite3_bind` 不支持动态列数；
/// 数量很小（2 个），直接展开即可。
fn count_tasks_with_status_in(conn: &rusqlite::Connection, statuses: &[&str]) -> Result<i64> {
    let placeholders = vec!["?"; statuses.len()].join(",");
    let sql = format!("SELECT COUNT(*) FROM task WHERE status IN ({placeholders})");
    let mut stmt = conn.prepare(&sql)?;
    let n: i64 = stmt.query_row(rusqlite::params_from_iter(statuses), |row| row.get(0))?;
    Ok(n)
}

/// 「本周剩余」桶的右边界——本周日（周一~周日）。
///
/// 中国习惯周一到周日,所以"本周"=[周一, 周日]。
/// - 周日当天 → `today`（再往后就是下周,本周已结束）
/// - 周一~周六 → `today + (7 - weekday)` 天到周日
///
/// `chrono::Weekday::num_days_from_monday()` 已给周一=0,周日=6,正好对齐。
fn week_end(today: NaiveDate) -> NaiveDate {
    let offset = 7 - today.weekday().num_days_from_monday() - 1;
    // offset ∈ [0, 6]：
    // - 周日(weekday=6): offset = 7 - 6 - 1 = 0 → today
    // - 周一(weekday=0): offset = 7 - 0 - 1 = 6 → today+6
    // - 周六(weekday=5): offset = 7 - 5 - 1 = 1 → today+1
    today
        .checked_add_days(Days::new(offset as u64))
        .expect("week_end 最多 +6 天,远未逼近 NaiveDate::MAX")
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/// 截止 chip 行的取值表——chip 集合、文案、顺序、日期算法的单一来源。
///
/// 「一周后」= 今天 + 7 天，走日历加法而不是裸算术，跨月跨年由 `chrono` 兜。
/// 理论上 `checked_add_days` 只在逼近 `NaiveDate::MAX`（约公元 26 万年）时
/// 返回 `None`；真到了那天，不如没有这一格，也好过整行 chip 取不出来。
fn due_date_options(today: NaiveDate) -> Vec<DueDateOption> {
    let offset_option = |chip, label: &str, days: u64| DueDateOption {
        chip,
        label: label.to_string(),
        due_date: today.checked_add_days(Days::new(days)).map(to_sql_date),
    };
    vec![
        offset_option(DueDateChip::Today, "今天", 0),
        offset_option(DueDateChip::Tomorrow, "明天", 1),
        offset_option(DueDateChip::NextWeek, "一周后", 7),
        DueDateOption {
            chip: DueDateChip::None,
            label: "无".to_string(),
            due_date: Option::None,
        },
    ]
}

/// 截止日入库前的校验：空白折叠为「无截止」，非空必须是合法的 `YYYY-MM-DD`。
///
/// 严格到底而不宽松兜底——日历精确选日与 chip 行走同一条路，一旦放进
/// `2026-13-01` 这种值，后面按 `due_date` 排序与分桶的三视图会静默错位。
fn parse_due_date(value: Option<String>) -> Result<Option<String>> {
    let Some(text) = trim_to_option(value) else {
        return Ok(None);
    };
    match parse_sql_date(&text) {
        Some(date) => Ok(Some(to_sql_date(date))),
        None => Err(AppError::invalid("截止日格式不对,应形如 2026-09-10。")),
    }
}

/// 状态变更时计算 `blocked_at` / `blocked_reason` / `waiting_on_person_id`
/// 三列的目标值。规则承接 ADR 0003 §D2 / §D3 / §D4：
/// - 进入 Blocked / Waiting-on：`blocked_at = now`（覆盖——反复切换不累计）；
///   `blocked_reason` trim 后必填且长度 ≤ 500；`waiting_on_person_id` 在
///   Waiting-on 下可选,Blocked 下强制 None（DB CHECK 不允许）。
/// - 切出到其它状态：三列均为 `None`。
fn derive_block_columns(
    new_status: TaskStatus,
    raw_reason: Option<String>,
    waiting_on_person_id: Option<i64>,
    now: &str,
) -> Result<(Option<String>, Option<String>, Option<i64>)> {
    match new_status {
        TaskStatus::Blocked => {
            let reason = require_non_blank(
                raw_reason.unwrap_or_default(),
                "阻塞原因不能为空,请填写卡在何处。",
            )?;
            ensure_reason_length(&reason)?;
            // Blocked 状态下不允许 waiting_on_person_id——它只对 Waiting-on 有定义
            // (DB CHECK `waiting_on_person_id IS NULL OR status = 'Waiting-on'`)。
            Ok((Some(now.to_string()), Some(reason), None))
        }
        TaskStatus::WaitingOn => {
            let reason = require_non_blank(
                raw_reason.unwrap_or_default(),
                "等待原因不能为空,请填写在等什么。",
            )?;
            ensure_reason_length(&reason)?;
            Ok((Some(now.to_string()), Some(reason), waiting_on_person_id))
        }
        _ => Ok((None, None, None)),
    }
}

/// 阻塞 / 等待原因长度上限 500 字符（ADR 0003 §D3）。注意用 `chars().count()`
/// 而不是 `len()`——汉字算 1 个字符,科室场景下中文是常态。
fn ensure_reason_length(reason: &str) -> Result<()> {
    if reason.chars().count() > 500 {
        return Err(AppError::invalid("阻塞原因不能超过 500 个字符。"));
    }
    Ok(())
}

fn row_to_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    let status_text: String = row.get(3)?;
    let status = parse_status(&status_text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(
            3,
            "task.status".into(),
            rusqlite::types::Type::Text,
        )
    })?;
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        status,
        owner_person_id: row.get(4)?,
        project_id: row.get(5)?,
        due_date: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        blocked_at: row.get(9)?,
        blocked_reason: row.get(10)?,
        waiting_on_person_id: row.get(11)?,
    })
}

fn fetch_task(conn: &rusqlite::Connection, id: i64) -> Result<Option<Task>> {
    conn.query_row(
        "SELECT id, title, description, status, owner_person_id, project_id, due_date,
                created_at, updated_at, blocked_at, blocked_reason, waiting_on_person_id
           FROM task WHERE id = ?1",
        params![id],
        row_to_task,
    )
    .optional()
    .map_err(Into::into)
}

/// 取一名人员的**在飞**任务列表（ticket #22 · 人员矩阵）。
///
/// 公开入口:`personnel.rs` 在每位人员身上各调用一次。命中
/// `idx_task_owner_status_due`（前两列 `owner_person_id` + `status` 都进了
/// WHERE / ORDER BY 表达式）。排序与 [`personnel_matrix`] 视图保持一致:
/// 状态优先级 + due_date 升序 + id 兜底。
///
/// 不在签名上暴露 `Connection` 的借用给其它命令模块,避免 row mapper 等
/// 内部细节外泄——调用方拿到的是 `Vec<Task>`。
pub fn fetch_in_flight_tasks_for_person(
    conn: &rusqlite::Connection,
    owner_person_id: i64,
) -> Result<Vec<Task>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, description, status, owner_person_id, project_id, due_date, \
                created_at, updated_at, blocked_at, blocked_reason, waiting_on_person_id \
           FROM task \
          WHERE owner_person_id = ?1 \
            AND status IN ('Open','In-progress','Blocked','Waiting-on') \
          ORDER BY CASE status \
                     WHEN 'Open'        THEN 0 \
                     WHEN 'In-progress' THEN 1 \
                     WHEN 'Blocked'     THEN 2 \
                     WHEN 'Waiting-on'  THEN 3 \
                   END ASC, \
                   CASE WHEN due_date IS NULL THEN 1 ELSE 0 END ASC, \
                   due_date ASC, \
                   id ASC",
    )?;
    let rows = stmt.query_map(params![owner_person_id], row_to_task)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

fn parse_status(text: &str) -> Option<TaskStatus> {
    match text {
        "Open" => Some(TaskStatus::Open),
        "In-progress" => Some(TaskStatus::InProgress),
        "Blocked" => Some(TaskStatus::Blocked),
        "Waiting-on" => Some(TaskStatus::WaitingOn),
        "Done" => Some(TaskStatus::Done),
        "Cancelled" => Some(TaskStatus::Cancelled),
        _ => None,
    }
}

/// 预检查：人员存在；用于 `create_task` 的 FK 兜底。
fn ensure_person_exists(conn: &rusqlite::Connection, id: i64) -> Result<()> {
    ensure_row_exists(conn, "person", id, "负责人不存在,请先在人员管理里录入。")
}

/// 预检查：项目存在；用于 `create_task` 的 FK 兜底。
fn ensure_project_exists(conn: &rusqlite::Connection, id: i64) -> Result<()> {
    ensure_row_exists(conn, "project", id, "所属项目不存在。")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_六值枚举与_db_字面量对齐() {
        for (text, status) in [
            ("Open", TaskStatus::Open),
            ("In-progress", TaskStatus::InProgress),
            ("Blocked", TaskStatus::Blocked),
            ("Waiting-on", TaskStatus::WaitingOn),
            ("Done", TaskStatus::Done),
            ("Cancelled", TaskStatus::Cancelled),
        ] {
            assert_eq!(parse_status(text), Some(status));
            assert_eq!(status.as_str(), text);
        }
    }

    #[test]
    fn parse_status_非法字面量返回_none() {
        assert!(parse_status("open").is_none()); // 大小写敏感
        assert!(parse_status("InProgress").is_none()); // 拼写
        assert!(parse_status("").is_none());
    }

    #[test]
    fn derive_block_columns_进_blocked_要求_reason_且清空_waiting_on() {
        let (at, reason, waiting) = derive_block_columns(
            TaskStatus::Blocked,
            Some("等外委回函".into()),
            Some(7),
            "2026-09-10 08:00:00",
        )
        .expect("填了 reason 应当通过");
        assert_eq!(at.as_deref(), Some("2026-09-10 08:00:00"));
        assert_eq!(reason.as_deref(), Some("等外委回函"));
        assert_eq!(waiting, None, "Blocked 下 waiting_on_person_id 必须为 None");
    }

    #[test]
    fn derive_block_columns_进_blocked_缺_reason_被拒_且有中文消息() {
        let err = derive_block_columns(TaskStatus::Blocked, Some("   ".into()), None, "now")
            .expect_err("空白 reason 应当被拒");
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert!(err.message().contains("阻塞原因不能为空"));
    }

    #[test]
    fn derive_block_columns_进_waiting_on_要求_reason_且允许_waiting_on() {
        let (at, reason, waiting) = derive_block_columns(
            TaskStatus::WaitingOn,
            Some("等分管领导批示".into()),
            Some(42),
            "2026-09-10 08:00:00",
        )
        .expect("填了 reason + waiting_on 应当通过");
        assert_eq!(at.as_deref(), Some("2026-09-10 08:00:00"));
        assert_eq!(reason.as_deref(), Some("等分管领导批示"));
        assert_eq!(waiting, Some(42));
    }

    #[test]
    fn derive_block_columns_进_waiting_on_缺_reason_被拒() {
        let err = derive_block_columns(TaskStatus::WaitingOn, None, Some(1), "now")
            .expect_err("缺 reason 应当被拒");
        assert!(err.message().contains("等待原因不能为空"));
    }

    #[test]
    fn derive_block_columns_reason_超过_500_字符被拒() {
        let too_long: String = "啊".repeat(501);
        let err = derive_block_columns(TaskStatus::Blocked, Some(too_long), None, "now")
            .expect_err(">500 字符应当被拒");
        assert!(err.message().contains("500"));
    }

    #[test]
    fn derive_block_columns_切出到_open_三列全部清空() {
        let (at, reason, waiting) =
            derive_block_columns(TaskStatus::Open, Some("应被忽略".into()), Some(99), "now")
                .expect("切出到 Open 不应拒绝任何参数");
        assert_eq!(at, None);
        assert_eq!(reason, None);
        assert_eq!(waiting, None);
    }

    // ----- 「今日 / 本周」视图的边界算法 -----

    /// 锁死「本周日」= 周一+6 / 周日+0 的边界。
    #[test]
    fn week_end_周一到周日分别是_6_到_0_天后() {
        // 2026-09-07 = Mon,2026-09-13 = Sun——这两天的 day-of-week
        // 已由 _check_dates 测试钉死,这里只钉算式。
        for (date, expected) in [
            ("2026-09-07", "2026-09-13"), // Mon → +6 → Sun
            ("2026-09-08", "2026-09-13"), // Tue → +5 → Sun
            ("2026-09-09", "2026-09-13"), // Wed → +4
            ("2026-09-10", "2026-09-13"), // Thu → +3
            ("2026-09-11", "2026-09-13"), // Fri → +2
            ("2026-09-12", "2026-09-13"), // Sat → +1
            ("2026-09-13", "2026-09-13"), // Sun → +0(再往后就是下周)
        ] {
            let today = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
            assert_eq!(
                to_sql_date(week_end(today)),
                expected,
                "date={date}"
            );
        }
    }

    /// `BucketBound` 的 SQL 与 bind 数量必须一致——否则 `?` 与参数对不上,
    /// 会越界 panic 或静默错位。
    #[test]
    fn bucket_bound_sql_与_bind_params_一一对应() {
        use BucketBound::*;

        let day = NaiveDate::parse_from_str("2026-09-10", "%Y-%m-%d").unwrap();
        let day2 = NaiveDate::parse_from_str("2026-09-13", "%Y-%m-%d").unwrap();

        for (bound, expected_sql, expected_params) in [
            (StrictlyBefore(day), "due_date < ?1", vec!["2026-09-10"]),
            (OnDay(day), "due_date = ?1", vec!["2026-09-10"]),
            (
                Between(day, day2),
                "due_date >= ?1 AND due_date <= ?2",
                vec!["2026-09-10", "2026-09-13"],
            ),
        ] {
            assert_eq!(bound.to_sql(), expected_sql);
            assert_eq!(bound.bind_params(), expected_params);
        }
    }
}
