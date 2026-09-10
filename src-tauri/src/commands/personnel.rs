//! 人员管理命令层（ticket #17）。
//!
//! 覆盖子组 / 人员 CRUD、调岗、离岗 / 复岗、子组排序、删除空子组。
//!
//! 约束（取自 ticket #17 + ADR 0001 §3.1 / §3.2 / §索引策略 #6）：
//! - `sub_team.name` 全局 UNIQUE
//! - `person (sub_team_id, name)` UNIQUE（同子组不重名，跨组允许）
//! - 必填字符串 `length(trim(col)) > 0`
//! - `person(sub_team_id, deactivated_at)` 索引由 migration 建
//! - 删非空子组 → 明确中文提示；不静默、不级联
//!
//! 所有命令入参与返回都是稳定 DTO（camelCase），不透传行结构。
//! 时间戳统一用 UTC 入库格式 `"%Y-%m-%d %H:%M:%S"`，由 [`crate::clock`] 渲染。

use crate::error::{AppError, Result};
use crate::state::AppState;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// 子组 DTO。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubTeam {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
}

/// 人员 DTO。`deactivated_at` 为 `None` 表示在岗。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: i64,
    pub name: String,
    pub sub_team_id: i64,
    pub contact: String,
    pub deactivated_at: Option<String>,
    pub created_at: String,
}

/// 新增子组的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSubTeamArgs {
    pub name: String,
    pub description: Option<String>,
}

/// 编辑子组的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSubTeamArgs {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
}

/// 删除子组的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSubTeamArgs {
    pub id: i64,
}

/// 重排子组的入参：`ordered_ids` 即新的展示顺序。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderSubTeamsArgs {
    pub ordered_ids: Vec<i64>,
}

/// 人员查询过滤条件。
/// - `include_deactivated = true`（UI 默认）：人员管理界面要看到所有人
///   才能复岗、编辑、调岗；
/// - `include_deactivated = false`：指派候选筛选（issue #18 将消费），
///   离岗人员不再出现在指派列表里。
///
/// `sub_team_id` 给定则只返回该子组。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPeopleArgs {
    pub include_deactivated: bool,
    pub sub_team_id: Option<i64>,
}

/// 新增人员的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePersonArgs {
    pub name: String,
    pub sub_team_id: i64,
    pub contact: String,
}

/// 编辑人员的入参（含调岗：换 `sub_team_id`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePersonArgs {
    pub id: i64,
    pub name: String,
    pub sub_team_id: i64,
    pub contact: String,
}

/// 用 id 寻址单条人员的命令入参（删除 / 离岗 / 复岗 共用）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonIdArgs {
    pub id: i64,
}

// ---------------------------------------------------------------------------
// 子组命令
// ---------------------------------------------------------------------------

/// 列出全部子组，按 `(sort_order, id)` 稳定排序——同一 sort_order 内按
/// id 兜底，避免 UI 上偶发的顺序抖动。
#[tauri::command]
pub fn list_sub_teams(state: State<'_, AppState>) -> Result<Vec<SubTeam>> {
    let conn = state.db()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, description, sort_order, created_at
           FROM sub_team
          ORDER BY sort_order ASC, id ASC",
    )?;
    let rows = stmt.query_map([], row_to_sub_team)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

/// 新增子组。`sort_order` 默认追加到当前最大值之后；空库时为 0。
#[tauri::command]
pub fn create_sub_team(
    state: State<'_, AppState>,
    args: CreateSubTeamArgs,
) -> Result<SubTeam> {
    let name = require_non_blank(args.name, "子组名不能为空。")?;
    let description = trim_to_option(args.description);

    let conn = state.db()?;
    ensure_sub_team_name_available(&conn, &name, None)?;
    let next_sort: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM sub_team",
            [],
            |row| row.get(0),
        )
        .map_err(AppError::from)?;

    let result = conn.execute(
        "INSERT INTO sub_team (name, description, sort_order) VALUES (?1, ?2, ?3)",
        params![name, description, next_sort],
    );

    if let Err(err) = result {
        return Err(err.into());
    }

    let id = conn.last_insert_rowid();
    fetch_sub_team(&conn, id)?.ok_or_else(|| {
        AppError::Internal(format!(
            "刚插入的子组 id={id} 立即查不到,数据库状态异常"
        ))
    })
}

/// 编辑子组名 / 描述。允许改名（仍是 UNIQUE，重复名走中文错误）。
#[tauri::command]
pub fn update_sub_team(
    state: State<'_, AppState>,
    args: UpdateSubTeamArgs,
) -> Result<SubTeam> {
    let name = require_non_blank(args.name, "子组名不能为空。")?;
    let description = trim_to_option(args.description);

    let conn = state.db()?;
    ensure_sub_team_name_available(&conn, &name, Some(args.id))?;
    let result = conn.execute(
        "UPDATE sub_team SET name = ?1, description = ?2 WHERE id = ?3",
        params![name, description, args.id],
    );

    match result {
        Ok(0) => Err(AppError::invalid("子组不存在或已被删除。")),
        Ok(_) => fetch_sub_team(&conn, args.id)?
            .ok_or_else(|| AppError::Internal(format!("子组 id={} 查询不一致", args.id))),
        Err(err) => Err(err.into()),
    }
}

/// 删除子组。**非空子组拒绝**：下辖任何人员（含离岗）均视为非空，
/// 给科长留一条明确的中文提示，让其先调岗或删除人员。
#[tauri::command]
pub fn delete_sub_team(
    state: State<'_, AppState>,
    args: DeleteSubTeamArgs,
) -> Result<()> {
    let conn = state.db()?;

    let member_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM person WHERE sub_team_id = ?1",
            params![args.id],
            |row| row.get(0),
        )
        .map_err(AppError::from)?;

    if member_count > 0 {
        return Err(AppError::invalid(format!(
            "该子组下还有 {member_count} 名人员,请先调岗或删除人员后再删除子组。"
        )));
    }

    let affected = conn.execute("DELETE FROM sub_team WHERE id = ?1", params![args.id])?;
    if affected == 0 {
        return Err(AppError::invalid("子组不存在或已被删除。"));
    }
    Ok(())
}

/// 拖拽重排子组：按传入 id 顺序写回 `sort_order = 索引`。
/// 传入的 id 集合必须 == 当前所有子组 id；不一致则拒绝并要求刷新。
#[tauri::command]
pub fn reorder_sub_teams(
    state: State<'_, AppState>,
    args: ReorderSubTeamsArgs,
) -> Result<()> {
    let conn = state.db()?;

    let existing_ids: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM sub_team ORDER BY id ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(AppError::from)?
    };

    let mut incoming: Vec<i64> = args.ordered_ids.clone();
    incoming.sort_unstable();
    let mut sorted_existing = existing_ids.clone();
    sorted_existing.sort_unstable();

    if incoming != sorted_existing {
        return Err(AppError::invalid(
            "子组列表与数据库不一致,请刷新后重试。",
        ));
    }

    let tx = conn.unchecked_transaction()?;
    for (index, id) in args.ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE sub_team SET sort_order = ?1 WHERE id = ?2",
            params![index as i32, id],
        )
        .map_err(AppError::from)?;
    }
    tx.commit().map_err(AppError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 人员命令
// ---------------------------------------------------------------------------

/// 花名册查询。默认 `include_deactivated = true`（人员管理界面要看见离岗
/// 的人）；指派候选场景（issue #18）传 `false` 把离岗的人过滤掉。
///
/// 排序：`include_deactivated = true` 时把离岗的人放到各自子组的末尾；
/// 都按 `sub_team_id, id` 兜底避免抖动。
#[tauri::command]
pub fn list_people(state: State<'_, AppState>, args: ListPeopleArgs) -> Result<Vec<Person>> {
    let conn = state.db()?;

    let mut sql = String::from(
        "SELECT id, name, sub_team_id, contact, deactivated_at, created_at
           FROM person",
    );
    let mut where_clauses: Vec<&str> = Vec::new();
    if args.sub_team_id.is_some() {
        where_clauses.push("sub_team_id = ?");
    }
    if !args.include_deactivated {
        where_clauses.push("deactivated_at IS NULL");
    }
    if !where_clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clauses.join(" AND "));
    }
    sql.push_str(if args.include_deactivated {
        // 在岗的在前,离岗的紧随其后,各自内部按 id 排序稳定呈现。
        " ORDER BY sub_team_id ASC, CASE WHEN deactivated_at IS NULL THEN 0 ELSE 1 END ASC, id ASC"
    } else {
        " ORDER BY sub_team_id ASC, id ASC"
    });

    let mut stmt = conn.prepare(&sql)?;
    // 参数数量必须与 SQL 中的 `?` 数量一致——按需拼成 0/1 元素迭代器。
    let param: Option<i64> = args.sub_team_id;
    let rows = stmt.query_map(rusqlite::params_from_iter(param), row_to_person)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

/// 新增人员。
#[tauri::command]
pub fn create_person(
    state: State<'_, AppState>,
    args: CreatePersonArgs,
) -> Result<Person> {
    let name = require_non_blank(args.name, "姓名不能为空。")?;
    let contact = require_non_blank(args.contact, "联系方式不能为空。")?;

    let conn = state.db()?;
    ensure_sub_team_exists(&conn, args.sub_team_id)?;
    ensure_person_name_available(&conn, args.sub_team_id, &name, None)?;

    let result = conn.execute(
        "INSERT INTO person (name, sub_team_id, contact) VALUES (?1, ?2, ?3)",
        params![name, args.sub_team_id, contact],
    );

    if let Err(err) = result {
        return Err(err.into());
    }

    let id = conn.last_insert_rowid();
    fetch_person(&conn, id)?.ok_or_else(|| {
        AppError::Internal(format!("刚插入的人员 id={id} 立即查不到,数据库状态异常"))
    })
}

/// 编辑人员信息（含调岗：`sub_team_id` 变更）。
#[tauri::command]
pub fn update_person(
    state: State<'_, AppState>,
    args: UpdatePersonArgs,
) -> Result<Person> {
    let name = require_non_blank(args.name, "姓名不能为空。")?;
    let contact = require_non_blank(args.contact, "联系方式不能为空。")?;

    let conn = state.db()?;
    ensure_sub_team_exists(&conn, args.sub_team_id)?;
    ensure_person_name_available(&conn, args.sub_team_id, &name, Some(args.id))?;

    let result = conn.execute(
        "UPDATE person SET name = ?1, sub_team_id = ?2, contact = ?3 WHERE id = ?4",
        params![name, args.sub_team_id, contact, args.id],
    );

    match result {
        Ok(0) => Err(AppError::invalid("人员不存在或已被删除。")),
        Ok(_) => fetch_person(&conn, args.id)?
            .ok_or_else(|| AppError::Internal(format!("人员 id={} 查询不一致", args.id))),
        Err(err) => Err(err.into()),
    }
}

/// 标记离岗。`deactivated_at` 用可注入时钟的「现在」——科室想知道是哪
/// 天开始请假的。
#[tauri::command]
pub fn deactivate_person(
    state: State<'_, AppState>,
    args: PersonIdArgs,
) -> Result<Person> {
    let now = state.now_sql();
    let conn = state.db()?;
    let result = conn.execute(
        "UPDATE person SET deactivated_at = ?1 WHERE id = ?2 AND deactivated_at IS NULL",
        params![now, args.id],
    );
    match result {
        Ok(0) => match fetch_person(&conn, args.id)? {
            // 存在但已经是离岗状态——告知科长原因,而不是抛"找不到"
            Some(_) => Err(AppError::invalid("该人员已是离岗状态,无需重复操作。")),
            None => Err(AppError::invalid("人员不存在或已被删除。")),
        },
        Ok(_) => fetch_person(&conn, args.id)?
            .ok_or_else(|| AppError::Internal(format!("人员 id={} 查询不一致", args.id))),
        Err(err) => Err(err.into()),
    }
}

/// 复岗：清掉 `deactivated_at`。
#[tauri::command]
pub fn reactivate_person(
    state: State<'_, AppState>,
    args: PersonIdArgs,
) -> Result<Person> {
    let conn = state.db()?;
    let result = conn.execute(
        "UPDATE person SET deactivated_at = NULL WHERE id = ?1 AND deactivated_at IS NOT NULL",
        params![args.id],
    );
    match result {
        Ok(0) => match fetch_person(&conn, args.id)? {
            Some(_) => Err(AppError::invalid("该人员已是在岗状态,无需重复操作。")),
            None => Err(AppError::invalid("人员不存在或已被删除。")),
        },
        Ok(_) => fetch_person(&conn, args.id)?
            .ok_or_else(|| AppError::Internal(format!("人员 id={} 查询不一致", args.id))),
        Err(err) => Err(err.into()),
    }
}

/// 删除人员（物理删除，与 ADR 0001 §命名与公共约定的软删策略一致）。
#[tauri::command]
pub fn delete_person(
    state: State<'_, AppState>,
    args: PersonIdArgs,
) -> Result<()> {
    let conn = state.db()?;
    let affected = conn.execute("DELETE FROM person WHERE id = ?1", params![args.id])?;
    if affected == 0 {
        return Err(AppError::invalid("人员不存在或已被删除。"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

fn row_to_sub_team(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubTeam> {
    Ok(SubTeam {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn row_to_person(row: &rusqlite::Row<'_>) -> rusqlite::Result<Person> {
    Ok(Person {
        id: row.get(0)?,
        name: row.get(1)?,
        sub_team_id: row.get(2)?,
        contact: row.get(3)?,
        deactivated_at: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn fetch_sub_team(conn: &rusqlite::Connection, id: i64) -> Result<Option<SubTeam>> {
    conn.query_row(
        "SELECT id, name, description, sort_order, created_at
           FROM sub_team WHERE id = ?1",
        params![id],
        row_to_sub_team,
    )
    .optional()
    .map_err(Into::into)
}

fn fetch_person(conn: &rusqlite::Connection, id: i64) -> Result<Option<Person>> {
    conn.query_row(
        "SELECT id, name, sub_team_id, contact, deactivated_at, created_at
           FROM person WHERE id = ?1",
        params![id],
        row_to_person,
    )
    .optional()
    .map_err(Into::into)
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
/// 主要用于 description（可空、空白不写入）。
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

/// 预检查：子组名在「另一条记录」上已被占用则拒绝。
/// `exclude_id` 用于编辑场景：排除自己。
fn ensure_sub_team_name_available(
    conn: &rusqlite::Connection,
    name: &str,
    exclude_id: Option<i64>,
) -> Result<()> {
    let taken: Option<i64> = match exclude_id {
        Some(id) => conn
            .query_row(
                "SELECT id FROM sub_team WHERE name = ?1 AND id != ?2",
                params![name, id],
                |row| row.get(0),
            )
            .optional()?,
        None => conn
            .query_row(
                "SELECT id FROM sub_team WHERE name = ?1",
                params![name],
                |row| row.get(0),
            )
            .optional()?,
    };
    if taken.is_some() {
        return Err(AppError::invalid("已存在同名子组。"));
    }
    Ok(())
}

/// 预检查：人员姓名在同子组的「另一条记录」上已被占用则拒绝。
/// `exclude_id` 用于编辑场景：排除自己。
fn ensure_person_name_available(
    conn: &rusqlite::Connection,
    sub_team_id: i64,
    name: &str,
    exclude_id: Option<i64>,
) -> Result<()> {
    let taken: Option<i64> = match exclude_id {
        Some(id) => conn
            .query_row(
                "SELECT id FROM person WHERE sub_team_id = ?1 AND name = ?2 AND id != ?3",
                params![sub_team_id, name, id],
                |row| row.get(0),
            )
            .optional()?,
        None => conn
            .query_row(
                "SELECT id FROM person WHERE sub_team_id = ?1 AND name = ?2",
                params![sub_team_id, name],
                |row| row.get(0),
            )
            .optional()?,
    };
    if taken.is_some() {
        return Err(AppError::invalid("同子组内已存在同名人员。"));
    }
    Ok(())
}

/// 预检查：子组存在；用于 create_person / update_person 的 FK 兜底。
fn ensure_sub_team_exists(conn: &rusqlite::Connection, id: i64) -> Result<()> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT id FROM sub_team WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::invalid("所属子组不存在。"));
    }
    Ok(())
}