//! 任务命令层（ticket #18）。
//!
//! 覆盖一次性任务的创建、状态变更与列表查询。
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

use crate::error::{AppError, Result};
use crate::state::AppState;
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
    let due_date = trim_to_option(args.due_date);

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

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

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

/// `value` 经 `trim()` 后空串视为缺失,返回面向科长的中文 `AppError`。
fn require_non_blank(value: String, message: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid(message));
    }
    Ok(trimmed.to_string())
}

/// 字符串字段 trim 后空串折叠为 `None`,非空则保留 trim 后的值。
fn trim_to_option(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// 预检查：人员存在；用于 `create_task` 的 FK 兜底。
fn ensure_person_exists(conn: &rusqlite::Connection, id: i64) -> Result<()> {
    ensure_row_exists(conn, "person", id, "负责人不存在,请先在人员管理里录入。")
}

/// 预检查：项目存在；用于 `create_task` 的 FK 兜底。`project` 表是 #21 的
/// 占位骨架,目前只能命中已建（罕见）的项目——多数情况下 FK 错误由 DB 兜。
fn ensure_project_exists(conn: &rusqlite::Connection, id: i64) -> Result<()> {
    ensure_row_exists(conn, "project", id, "所属项目不存在。")
}

/// 通用「指定表里 id 存在否」预检查——把 `ensure_sub_team_exists`
/// (personnel.rs) / `ensure_person_exists` / `ensure_project_exists` 三个
/// 同形状助手合并成一处。表名走参数传入,SQL 仍按白名单写法写死,杜绝注入。
fn ensure_row_exists(
    conn: &rusqlite::Connection,
    table: &'static str,
    id: i64,
    message: &'static str,
) -> Result<()> {
    let sql = format!("SELECT id FROM {table} WHERE id = ?1");
    let exists: Option<i64> = conn
        .query_row(&sql, params![id], |row| row.get(0))
        .optional()?;
    if exists.is_none() {
        return Err(AppError::invalid(message));
    }
    Ok(())
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
}
