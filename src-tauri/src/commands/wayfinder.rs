//! ⌘K 全局命令面板命令层（ticket #28）。
//!
//! 一条命令拉回三类目标的命中：人员 / 项目 / 任务。**所有匹配逻辑在命令层**——
//! 前端只渲染命令层返回的列表与方向,不在 TS 里再做筛选 / 排序 / 截断。
//!
//! 三类目标各自的默认上限封顶在命令层,前端照搬 [`WayfinderSearchResults`]
//! 字段渲染,不要再自己 `slice`。这是命令面板"候选列表是什么"的唯一权威。
//!
//! 任务命中走 ticket #27 已落地的 `search_tasks_blocking`(FTS5 trigram +
//! LIKE 短查询兜底),共享同一份语义。人员 / 项目命中走 LIKE 子串匹配——
//! 中文场景下"小"命中"张小五"得靠子串,前缀匹配太窄。
//!
//! 入参 query 为空时三类都返回**默认顺序**的前 N 条,作为空查询时的"最近
//! 出现的候选",而不是空列表——空面板没意义。

use crate::commands::task::{search_tasks_blocking, Task};
use crate::commands::validation::escape_like;
use crate::error::Result;
use crate::state::{AppState, AppStateInner};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// ⌘K 命令面板搜索入参。
///
/// `query` 是命令面板输入框里的当前文本——前端把这个文本直接落进来即可。
/// 空字符串 = "无搜索,给我默认候选"。
///
/// 默认过滤：不含 Cancelled 任务 / 不含离岗人员 / 不含 Done / Cancelled 项
/// 目——与 `list_tasks_filtered` / `list_assignee_candidates` 的语义对齐。
/// 命令面板是"在飞 + 在岗"视角的全局入口,不该给已经收尾的实体加重。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WayfinderSearchArgs {
    pub query: String,
    /// 人员候选封顶;`None` = [`PEOPLE_LIMIT_DEFAULT`]。
    pub people_limit: Option<usize>,
    /// 项目候选封顶;`None` = [`PROJECTS_LIMIT_DEFAULT`]。
    pub projects_limit: Option<usize>,
    /// 任务候选封顶;`None` = [`TASKS_LIMIT_DEFAULT`]。
    pub tasks_limit: Option<usize>,
    /// 默认 false 过滤 Cancelled 任务。
    pub include_cancelled_tasks: bool,
    /// 默认 false 过滤离岗人员。
    pub include_deactivated_people: bool,
}

/// ⌘K 命令面板一次性返回三类候选。
///
/// 顺序：人员 → 项目 → 任务,各自**已封顶、已排序、已过滤**。前端不再
/// 做任何二次加工,直接渲染并按全局导航上下移动。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WayfinderSearchResults {
    pub people: Vec<WayfinderPersonHit>,
    pub projects: Vec<WayfinderProjectHit>,
    pub tasks: Vec<Task>,
}

/// 人员候选。`match_kind` 告诉前端"匹配落在名字上 / 子组名上 / 都中"——
/// 决定副行(子组名)要不要高亮那段匹配字符。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WayfinderPersonHit {
    pub person_id: i64,
    pub name: String,
    pub sub_team_name: String,
    pub sub_team_id: i64,
    pub match_kind: WayfinderMatchKind,
}

/// 项目候选。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WayfinderProjectHit {
    pub project_id: i64,
    pub name: String,
    pub sub_team_name: String,
    pub sub_team_id: i64,
    /// `status` 跟着 [`crate::commands::project::ProjectStatus`] 三值走。
    pub status: String,
    pub match_kind: WayfinderMatchKind,
}

/// 匹配来源——前端用这个决定高亮哪一行。
///
/// `Both` 表示人名 / 子组名都中了——前端可以整条加粗。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WayfinderMatchKind {
    Name,
    SubTeam,
    Both,
}

/// 默认封顶——三类各给一份"看得见就够了"的数字。前端按这些值决定面板高度。
const PEOPLE_LIMIT_DEFAULT: usize = 6;
const PROJECTS_LIMIT_DEFAULT: usize = 6;
const TASKS_LIMIT_DEFAULT: usize = 12;

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// ⌘K 命令面板搜索。
///
/// 三类目标**独立查询、各自封顶、各自排序**——不在 Rust 端跨类打乱顺序。
/// 面板扁平列表的全局索引由前端在内存里算(command layer 给三个 Vec,
/// 前端 concat 后用 keyboard 索引走)。这是命令层与渲染层职责的边界。
///
/// **不在外层先取一次连接**:三类查询各自 acquire / release,std Mutex
/// 不可重入,先持有锁再去嵌套锁会自死锁(测试套件里就是这么炸的——
/// wayfinder_search 持锁调 search_tasks,后者内部又 `state.db()` 取锁,
/// 永久等待)。每个子查询独立 borrow state,各取各的锁。
#[tauri::command]
pub fn wayfinder_search(
    state: State<'_, AppState>,
    args: WayfinderSearchArgs,
) -> Result<WayfinderSearchResults> {
    let people_limit = args.people_limit.unwrap_or(PEOPLE_LIMIT_DEFAULT);
    let projects_limit = args.projects_limit.unwrap_or(PROJECTS_LIMIT_DEFAULT);
    let tasks_limit = args.tasks_limit.unwrap_or(TASKS_LIMIT_DEFAULT);

    let people = {
        let conn = state.db()?;
        search_people(
            &conn,
            &args.query,
            people_limit,
            args.include_deactivated_people,
        )?
    };
    let projects = {
        let conn = state.db()?;
        search_projects(&conn, &args.query, projects_limit)?
    };
    let tasks = {
        let inner = state.inner().clone();
        search_tasks(
            &inner,
            &args.query,
            tasks_limit,
            args.include_cancelled_tasks,
            args.include_deactivated_people,
        )?
    };

    Ok(WayfinderSearchResults {
        people,
        projects,
        tasks,
    })
}

// ---------------------------------------------------------------------------
// 人员
// ---------------------------------------------------------------------------

/// 人员候选查询。query 非空时按"姓名 OR 子组名 LIKE"过滤;query 为空时
/// 走默认排序(子组 sort_order → 段内在岗优先 → id 升序)。离岗过滤是
/// 默认行为——命令面板不该把已经请假的人推上前几位。
fn search_people(
    conn: &Connection,
    query: &str,
    limit: usize,
    include_deactivated: bool,
) -> Result<Vec<WayfinderPersonHit>> {
    let trimmed = query.trim();

    // query 非空 → LIKE 子串匹配(中英文 / 数字都行);`%` / `_` /
    // 反斜杠由 `escape_like` 兜底——不转义的话用户打 `%` 就把全员刷出来。
    let mut sql = String::from(
        "SELECT p.id, p.name, p.sub_team_id, st.name \
           FROM person p \
           JOIN sub_team st ON st.id = p.sub_team_id",
    );
    let mut where_clauses: Vec<String> = Vec::new();
    if build_like_clause(trimmed).is_some() {
        where_clauses.push("(p.name LIKE ?1 ESCAPE '\\' OR st.name LIKE ?1 ESCAPE '\\')".into());
    }
    if !include_deactivated {
        where_clauses.push("p.deactivated_at IS NULL".into());
    }
    if !where_clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clauses.join(" AND "));
    }
    sql.push_str(
        " ORDER BY st.sort_order ASC, st.id ASC, \
                  CASE WHEN p.deactivated_at IS NULL THEN 0 ELSE 1 END ASC, \
                  p.id ASC \
          LIMIT ?2",
    );

    let mut stmt = conn.prepare(&sql)?;
    let pattern = match build_like_clause(trimmed) {
        Some(p) => p,
        None => "%".to_string(),
    };
    let rows = stmt.query_map(
        params![pattern, limit as i64],
        |row| {
            let name: String = row.get(1)?;
            let sub_team_name: String = row.get(3)?;
            let match_kind = classify_match(trimmed, &name, &sub_team_name);
            Ok(WayfinderPersonHit {
                person_id: row.get(0)?,
                name,
                sub_team_name,
                sub_team_id: row.get(2)?,
                match_kind,
            })
        },
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

/// 项目候选查询——排除 Done / Cancelled(命令面板是"在飞"视角),`status`
/// 沿用视图层的派生逻辑(`derive_status_sql_fragment`)。
fn search_projects(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<WayfinderProjectHit>> {
    let trimmed = query.trim();
    let derived_status_expr = crate::commands::project::derive_status_sql_fragment("p");

    let mut sql = format!(
        "SELECT p.id, p.name, p.sub_team_id, st.name, ({derived_status_expr}) AS derived_status \
           FROM project p \
           JOIN sub_team st ON st.id = p.sub_team_id",
    );
    let mut where_clauses: Vec<String> = Vec::new();
    if build_like_clause(trimmed).is_some() {
        where_clauses.push("(p.name LIKE ?1 ESCAPE '\\' OR st.name LIKE ?1 ESCAPE '\\')".into());
    }
    where_clauses.push(format!("({derived_status_expr}) NOT IN ('Done','Cancelled')"));

    sql.push_str(" WHERE ");
    sql.push_str(&where_clauses.join(" AND "));
    sql.push_str(
        " ORDER BY CASE WHEN p.due_date IS NULL THEN 1 ELSE 0 END ASC, \
                  p.due_date ASC, p.created_at ASC, p.id ASC \
          LIMIT ?2",
    );

    let mut stmt = conn.prepare(&sql)?;
    let pattern = match build_like_clause(trimmed) {
        Some(p) => p,
        None => "%".to_string(),
    };
    let rows = stmt.query_map(params![pattern, limit as i64], |row| {
        let name: String = row.get(1)?;
        let sub_team_name: String = row.get(3)?;
        let match_kind = classify_match(trimmed, &name, &sub_team_name);
        Ok(WayfinderProjectHit {
            project_id: row.get(0)?,
            name,
            sub_team_name,
            sub_team_id: row.get(2)?,
            status: row.get(4)?,
            match_kind,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

// ---------------------------------------------------------------------------
// 任务——薄包装 ticket #27 的 search_tasks_blocking
// ---------------------------------------------------------------------------

/// 任务候选——直接调 [`search_tasks_blocking`](crate::commands::task::search_tasks_blocking)
/// 复用 ticket #27 的 FTS5 trigram + LIKE 兜底路径。query 走它已经处理过
/// 的清洗(FTS5 特殊字符替换 → 短查询降级)。空 query 走默认排序前 N 条。
fn search_tasks(
    state: &Arc<AppStateInner>,
    query: &str,
    limit: usize,
    include_cancelled: bool,
    include_deactivated_owners: bool,
) -> Result<Vec<Task>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        // 空 query 不走 search_tasks——它会因空关键词被拒。直接列在飞任务
        // 前 N 条,排序沿用 list_tasks 的"在飞优先 + due_date + id"约定。
        return fetch_top_tasks(state, limit, include_cancelled, include_deactivated_owners);
    }
    search_tasks_blocking(
        state,
        trimmed,
        include_cancelled,
        include_deactivated_owners,
        limit,
    )
}

/// 空 query 时拉默认排序前 N 条——命令面板打开后第一眼不是空的。
///
/// 排序走 [`crate::commands::task::in_flight_task_order_by`] 共用片段,
/// 不重复"在飞优先 + due_date + created_at + id"这一份 SQL——ticket
/// #28 评审时这里与 `list_tasks` / `list_tasks_filtered` 是第三份复制,
/// 抽到 `task.rs` 之后只剩一处权威。
fn fetch_top_tasks(
    state: &AppState,
    limit: usize,
    include_cancelled: bool,
    include_deactivated_owners: bool,
) -> Result<Vec<Task>> {
    use crate::commands::task::{in_flight_task_order_by, TASK_COLUMNS_WITH_T};
    let conn = state.db()?;

    let mut where_clauses: Vec<String> = Vec::new();
    if !include_cancelled {
        where_clauses.push("t.status != 'Cancelled'".into());
    }
    if !include_deactivated_owners {
        where_clauses.push("p.deactivated_at IS NULL".into());
    }

    let mut sql = format!("SELECT {TASK_COLUMNS_WITH_T} FROM task t");
    if !include_deactivated_owners {
        sql.push_str(" JOIN person p ON p.id = t.owner_person_id");
    }
    if !where_clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY ");
    sql.push_str(&in_flight_task_order_by("t."));
    sql.push_str(" LIMIT ?1");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit as i64], crate::commands::task::row_to_task)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

/// 把用户 query 拼成 LIKE 子串模板（`%query%`）。query 空白折叠为 `None`——
/// 调用方按"不过滤"路径走。`%` / `_` / 反斜杠由 [`escape_like`] 转义。
fn build_like_clause(query: &str) -> Option<String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(format!("%{}%", escape_like(trimmed)))
}

/// 决定匹配落在名字 / 子组名 / 都中——前端据此决定高亮哪一段。
///
/// `query` 为空时返回 `WayfinderMatchKind::Name`,纯默认值,前端不去高亮。
fn classify_match(query: &str, name: &str, sub_team_name: &str) -> WayfinderMatchKind {
    if query.is_empty() {
        return WayfinderMatchKind::Name;
    }
    let needle = query.to_lowercase();
    let hit_name = name.to_lowercase().contains(&needle);
    let hit_team = sub_team_name.to_lowercase().contains(&needle);
    match (hit_name, hit_team) {
        (true, true) => WayfinderMatchKind::Both,
        (true, false) => WayfinderMatchKind::Name,
        (false, true) => WayfinderMatchKind::SubTeam,
        // 没命中——不应该走到这(上游 LIKE 已过滤),兜底 Name 不影响
        // 前端渲染(默认不高亮)。
        (false, false) => WayfinderMatchKind::Name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_like_clause_query为空返回_none() {
        assert!(build_like_clause("").is_none());
        assert!(build_like_clause("   ").is_none()); // trim 后空
    }

    #[test]
    fn build_like_clause_query为中文_拼成_子串模板() {
        assert_eq!(build_like_clause("合同"), Some("%合同%".into()));
        assert_eq!(build_like_clause("小"), Some("%小%".into()));
    }

    #[test]
    fn build_like_clause_百分号被转义() {
        // 用户打一个 %：不能把全员 / 全项目刷出来
        assert_eq!(build_like_clause("%"), Some("%\\%%".into()));
    }

    #[test]
    fn classify_match_空_query_返回_name() {
        assert_eq!(
            classify_match("", "张小五", "暖通"),
            WayfinderMatchKind::Name
        );
    }

    #[test]
    fn classify_match_名字命中() {
        assert_eq!(
            classify_match("小五", "张小五", "暖通"),
            WayfinderMatchKind::Name
        );
    }

    #[test]
    fn classify_match_子组命中() {
        assert_eq!(
            classify_match("暖通", "张小五", "暖通组"),
            WayfinderMatchKind::SubTeam
        );
    }

    #[test]
    fn classify_match_两边都中() {
        assert_eq!(
            classify_match("暖", "暖通甲", "暖通组"),
            WayfinderMatchKind::Both
        );
    }

    #[test]
    fn classify_match_大小写不敏感() {
        assert_eq!(
            classify_match("ZHANG", "Zhang San", "暖通"),
            WayfinderMatchKind::Name
        );
    }
}
