//! 项目命令层（ticket #20）。
//!
//! 覆盖项目 CRUD、按状态汇总的列表查询、`#` 内联选项目的候选查询。
//!
//! 约束（取自 ADR 0001 §3.3 / §索引策略 #7 + ticket #20）：
//! - `project` 表全列（除 `status`，由视图层从 `task.status` 聚合）
//! - `idx_project_sub_team_due_date` 已建
//! - 删除项目：**项目下任务的 `project_id` 置 NULL**（事务内 UPDATE + DELETE
//!   协同），不留悬空 FK。task.project_id 列允许 NULL（ADR 0001 §3.5）。
//!
//! 所有命令入参与返回都是稳定 DTO（camelCase），不透传行结构。

use crate::clock::parse_sql_date;
use crate::commands::validation::{
    ensure_row_exists, escape_like, require_non_blank, trim_to_option,
};
use crate::error::{AppError, Result};
use crate::state::AppState;
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// 项目状态——视图层由 `task.status` 聚合派生（ticket #20 验收点）。
///
/// 派生规则：
/// - 项目名下**没有任何 task** → `Active`（刚建还没接活，不是 Done / Cancelled）
/// - 全部 task 的 `status` 都是 `Cancelled` → `Cancelled`
/// - 全部 task 的 `status` 都是 `Done` → `Done`
/// - 其它（任意 task 处于在飞：Open / In-progress / Blocked / Waiting-on，
///   或在飞 + Done 混存）→ `Active`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectStatus {
    Active,
    Done,
    Cancelled,
}

/// 项目 DTO。`status` 由视图层从 task 聚合，不入库。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub owner_person_id: i64,
    pub sub_team_id: i64,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub status: ProjectStatus,
}

/// 新建项目的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectArgs {
    pub name: String,
    pub owner_person_id: i64,
    pub sub_team_id: i64,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub notes: Option<String>,
}

/// 编辑项目的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectArgs {
    pub id: i64,
    pub name: String,
    pub owner_person_id: i64,
    pub sub_team_id: i64,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub notes: Option<String>,
}

/// 删除项目的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectArgs {
    pub id: i64,
}

/// `list_projects` 的入参（未来扩展用——目前只列全部）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectsArgs {
    /// `true` = 含已 Done / Cancelled 的项目；`false`（默认）= 只看在飞。
    pub include_done: bool,
}

/// `#` 内联选项目的候选查询入参（ticket #20）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectCandidatesArgs {
    /// `#` 后面已经打出的部分；空白或缺省 = 不过滤。
    pub query: Option<String>,
}

/// `#` 下拉里的一条候选。
///
/// `sub_team_name` 是下拉右侧的副行——跨子组同名是可能的（不像同子组内
/// UNIQUE），只给名字科长选不准。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCandidate {
    pub project_id: i64,
    pub name: String,
    pub sub_team_name: String,
}

/// `#` 下拉最多显示几条。与 `@` 的 [`ASSIGNEE_CANDIDATE_LIMIT`] 对齐：
/// 原型下拉高度就是 6 行；封顶在命令层而不是前端。
const PROJECT_CANDIDATE_LIMIT: usize = 6;

// ---------------------------------------------------------------------------
// 项目 status 派生 SQL
// ---------------------------------------------------------------------------

/// `project.status` 视图层聚合的 CASE 表达式。
///
/// 用作 [`derive_status_sql_fragment`] 拼装的子句——三处共用同一份逻辑
/// （`list_projects` / `list_project_candidates` / `fetch_project`），避免
/// 派生规则在多处漂移。`{project_alias}` 由调用方填入,默认 `p`。
fn derive_status_sql_fragment(project_alias: &str) -> String {
    let p = project_alias;
    format!(
        "CASE \
            WHEN NOT EXISTS(SELECT 1 FROM task t WHERE t.project_id = {p}.id) THEN 'Active' \
            WHEN NOT EXISTS(\
              SELECT 1 FROM task t \
               WHERE t.project_id = {p}.id \
                 AND t.status NOT IN ('Cancelled')\
            ) THEN 'Cancelled' \
            WHEN NOT EXISTS(\
              SELECT 1 FROM task t \
               WHERE t.project_id = {p}.id \
                 AND t.status NOT IN ('Done','Cancelled')\
            ) THEN 'Done' \
            ELSE 'Active' \
          END"
    )
}

/// 列表用 SELECT 列。给 `list_projects` / `list_project_candidates` 共用。
fn project_select_columns(alias: &str, include_derived_status: bool) -> String {
    let p = alias;
    let mut cols = format!(
        "{p}.id, {p}.name, {p}.owner_person_id, {p}.sub_team_id, \
         {p}.start_date, {p}.due_date, {p}.notes, {p}.created_at",
    );
    if include_derived_status {
        cols.push_str(", ");
        cols.push_str(&derive_status_sql_fragment(alias));
        cols.push_str(" AS derived_status");
    }
    cols
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 列出全部项目，`status` 由视图层聚合（ticket #20 验收点）。
///
/// 排序：先看 `due_date`（`NULL` 置后），再看 `created_at` 兜底避免抖动。
/// `include_done = false` 时过滤掉 `Done` / `Cancelled` 的项目。
#[tauri::command]
pub fn list_projects(
    state: State<'_, AppState>,
    args: ListProjectsArgs,
) -> Result<Vec<Project>> {
    let conn = state.db()?;

    let sql = format!(
        "SELECT {cols} \
           FROM project p \
          ORDER BY CASE WHEN p.due_date IS NULL THEN 1 ELSE 0 END ASC, \
                   p.due_date ASC, \
                   p.created_at ASC, \
                   p.id ASC",
        cols = project_select_columns("p", true),
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_project_with_status)?;
    let mut projects: Vec<Project> = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)?;

    if !args.include_done {
        projects.retain(|p| p.status != ProjectStatus::Done && p.status != ProjectStatus::Cancelled);
    }

    Ok(projects)
}

/// `#` 内联选项目的候选（ticket #20）。
///
/// - 排除 Done / Cancelled 的项目（在飞视图下选不到历史项目，避免误指）
/// - 按 `query` 做**子串**匹配（与 `@` 一致：「综合」能命中「综合楼改造」）
/// - 条数封顶 [`PROJECT_CANDIDATE_LIMIT`]
/// - 顺序沿用 `list_projects` 的默认排序
///
/// 前端只渲染返回的列表，不再自己过滤一遍。
#[tauri::command]
pub fn list_project_candidates(
    state: State<'_, AppState>,
    args: ListProjectCandidatesArgs,
) -> Result<Vec<ProjectCandidate>> {
    let conn = state.db()?;

    let pattern = match trim_to_option(args.query) {
        Some(query) => format!("%{}%", escape_like(&query)),
        None => "%".to_string(),
    };

    let derived = derive_status_sql_fragment("p");
    let sql = format!(
        "SELECT p.id, p.name, st.name \
           FROM project p \
           JOIN sub_team st ON st.id = p.sub_team_id \
          WHERE p.name LIKE ?1 ESCAPE '\\' \
            AND ({derived}) NOT IN ('Done','Cancelled') \
          ORDER BY CASE WHEN p.due_date IS NULL THEN 1 ELSE 0 END ASC, \
                   p.due_date ASC, \
                   p.created_at ASC, \
                   p.id ASC \
          LIMIT ?2",
        derived = derived,
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        params![pattern, PROJECT_CANDIDATE_LIMIT as i64],
        |row| {
            Ok(ProjectCandidate {
                project_id: row.get(0)?,
                name: row.get(1)?,
                sub_team_name: row.get(2)?,
            })
        },
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

/// 新建项目。
#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    args: CreateProjectArgs,
) -> Result<Project> {
    let name = require_non_blank(args.name, "项目名不能为空。")?;
    let start_date = parse_optional_date(args.start_date, "开始日")?;
    let due_date = parse_optional_date(args.due_date, "截止日")?;
    let notes = trim_to_option(args.notes);

    let conn = state.db()?;
    ensure_person_exists(&conn, args.owner_person_id)?;
    ensure_sub_team_exists(&conn, args.sub_team_id)?;

    let result = conn.execute(
        "INSERT INTO project
           (name, owner_person_id, sub_team_id, start_date, due_date, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![name, args.owner_person_id, args.sub_team_id, start_date, due_date, notes],
    );

    if let Err(err) = result {
        return Err(err.into());
    }

    let id = conn.last_insert_rowid();
    fetch_project(&conn, id)?.ok_or_else(|| {
        AppError::Internal(format!("刚插入的项目 id={id} 立即查不到,数据库状态异常"))
    })
}

/// 编辑项目（不改 status——status 仍由视图层聚合）。
#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    args: UpdateProjectArgs,
) -> Result<Project> {
    let name = require_non_blank(args.name, "项目名不能为空。")?;
    let start_date = parse_optional_date(args.start_date, "开始日")?;
    let due_date = parse_optional_date(args.due_date, "截止日")?;
    let notes = trim_to_option(args.notes);

    let conn = state.db()?;
    ensure_person_exists(&conn, args.owner_person_id)?;
    ensure_sub_team_exists(&conn, args.sub_team_id)?;

    let affected = conn.execute(
        "UPDATE project
            SET name            = ?1,
                owner_person_id = ?2,
                sub_team_id     = ?3,
                start_date      = ?4,
                due_date        = ?5,
                notes           = ?6
          WHERE id = ?7",
        params![
            name,
            args.owner_person_id,
            args.sub_team_id,
            start_date,
            due_date,
            notes,
            args.id,
        ],
    )?;

    if affected == 0 {
        return Err(AppError::invalid("项目不存在或已被删除。"));
    }

    fetch_project(&conn, args.id)?
        .ok_or_else(|| AppError::Internal(format!("项目 id={} 查询不一致", args.id)))
}

/// 删除项目。项目下任务的 `project_id` 置 NULL（不留悬空 FK）。
///
/// FK 默认 `NO ACTION`——直接 `DELETE FROM project WHERE id = ?` 在有任务的
/// 情况下会被 DB 拒掉。事务内先 UPDATE 任务，再 DELETE 项目，两步必须在
/// 同一事务内：跨机同步漂移时不能让中间状态被看到。
#[tauri::command]
pub fn delete_project(
    state: State<'_, AppState>,
    args: DeleteProjectArgs,
) -> Result<()> {
    let conn = state.db()?;
    let tx = conn.unchecked_transaction()?;

    // 把名下任务的 project_id 置 NULL——不管任务当前是 Open / Done / Cancelled,
    // 项目删了之后它们都属于「无项目」状态。owner_person_id 等其余字段不动。
    tx.execute(
        "UPDATE task SET project_id = NULL WHERE project_id = ?1",
        params![args.id],
    )?;

    let affected = tx.execute("DELETE FROM project WHERE id = ?1", params![args.id])?;
    if affected == 0 {
        return Err(AppError::invalid("项目不存在或已被删除。"));
    }
    tx.commit().map_err(AppError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/// 行转 DTO。`status` 由 SQL 的派生列直接给出，落到枚举上。
fn row_to_project_with_status(row: &Row<'_>) -> rusqlite::Result<Project> {
    let status_text: String = row.get(8)?;
    let status = parse_project_status(&status_text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(
            8,
            "project.derived_status".into(),
            rusqlite::types::Type::Text,
        )
    })?;
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        owner_person_id: row.get(2)?,
        sub_team_id: row.get(3)?,
        start_date: row.get(4)?,
        due_date: row.get(5)?,
        notes: row.get(6)?,
        created_at: row.get(7)?,
        status,
    })
}

fn parse_project_status(text: &str) -> Option<ProjectStatus> {
    match text {
        "Active" => Some(ProjectStatus::Active),
        "Done" => Some(ProjectStatus::Done),
        "Cancelled" => Some(ProjectStatus::Cancelled),
        _ => None,
    }
}

fn fetch_project(conn: &rusqlite::Connection, id: i64) -> Result<Option<Project>> {
    let sql = format!(
        "SELECT {cols} FROM project p WHERE p.id = ?1",
        cols = project_select_columns("p", true),
    );
    conn.query_row(&sql, params![id], row_to_project_with_status)
        .optional()
        .map_err(Into::into)
}

/// 把「可选日期字段」做 trim→None / 严格 YYYY-MM-DD 校验，与 task 的
/// 截止日路径一致。
fn parse_optional_date(value: Option<String>, label: &str) -> Result<Option<String>> {
    let Some(text) = trim_to_option(value) else {
        return Ok(None);
    };
    match parse_sql_date(&text) {
        Some(date) => Ok(Some(date.format("%Y-%m-%d").to_string())),
        None => Err(AppError::invalid(format!(
            "{label}格式不对,应形如 2026-09-10。"
        ))),
    }
}

fn ensure_person_exists(conn: &rusqlite::Connection, id: i64) -> Result<()> {
    ensure_row_exists(conn, "person", id, "项目负责人不存在,请先在人员管理里录入。")
}

fn ensure_sub_team_exists(conn: &rusqlite::Connection, id: i64) -> Result<()> {
    ensure_row_exists(conn, "sub_team", id, "所属子组不存在。")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_project_status_三值枚举对齐() {
        for (text, status) in [
            ("Active", ProjectStatus::Active),
            ("Done", ProjectStatus::Done),
            ("Cancelled", ProjectStatus::Cancelled),
        ] {
            assert_eq!(parse_project_status(text), Some(status));
        }
        assert!(parse_project_status("active").is_none()); // 大小写敏感
        assert!(parse_project_status("").is_none());
    }

    #[test]
    fn parse_optional_date_空白折叠为_none() {
        let none: Option<String> = None;
        assert_eq!(
            parse_optional_date(none, "开始日").expect("None 应当通过"),
            None
        );
        assert_eq!(
            parse_optional_date(Some("   ".into()), "开始日").expect("空白应当折叠"),
            None
        );
        assert_eq!(
            parse_optional_date(Some("2026-09-10".into()), "开始日")
                .expect("合法日期应当通过"),
            Some("2026-09-10".into())
        );
    }

    #[test]
    fn parse_optional_date_非法格式给中文提示_且带字段名() {
        for bad in ["2026/09/10", "10-01", "2026-13-01", "明天"] {
            let err = parse_optional_date(Some(bad.into()), "截止日")
                .expect_err("非法日期应当被拒");
            assert_eq!(err.code(), "INVALID_ARGUMENT");
            assert!(
                err.message().contains("截止日"),
                "bad={bad:?} message={}",
                err.message()
            );
        }
    }

    #[test]
    fn derive_status_sql_fragment_包含_四种边界判定() {
        let fragment = derive_status_sql_fragment("p");
        // 四条边界都必须出现——避免有人把派生规则"简化"掉一条
        assert!(fragment.contains("NOT EXISTS"), "空项目判定");
        assert!(fragment.contains("'Cancelled'"), "Cancelled 边界");
        assert!(fragment.contains("'Done','Cancelled'"), "Done 边界");
        assert!(fragment.contains("'Active'"), "Active 兜底");
    }
}