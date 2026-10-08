/**
 * ⌘K 全局命令面板（ticket #50 · 平迁自 ticket #28）。
 *
 * 一条命令拉回三类目标的命中：人员 / 项目 / 任务。**所有匹配逻辑在命令层**——
 * 前端只渲染命令层返回的列表与方向,不在 TS 里再做筛选 / 排序 / 截断。
 *
 * 三类目标各自的默认上限封顶在命令层,前端照搬 [`WayfinderSearchResults`]
 * 字段渲染,不要再自己 `slice`。这是命令面板"候选列表是什么"的唯一权威。
 *
 * 任务命中走 ticket #27 / #45 已落地的 `searchTasksBlocking`(FTS5 trigram +
 * LIKE 短查询兜底),共享同一份语义。人员 / 项目命中走 LIKE 子串匹配——
 * 中文场景下"小"命中"张小五"得靠子串,前缀匹配太窄。
 *
 * 入参 query 为空时三类都返回**默认顺序**的前 N 条,作为空查询时的"最近
 * 出现的候选",而不是空列表——空面板没意义。
 *
 * 与 Rust 端的关键差异（deadlock 警告承 ticket #28）：
 * - Rust 端用 std Mutex 包裹 db 连接,std Mutex 不可重入,三类查询各自
 *   acquire / release 避免 self-deadlock。
 * - TS 端 `node:sqlite` 是**同步** API,且 DB 由 `AppState` 持有——
 *   不存在 Mutex 互斥问题,各 sub-query 同步串行执行即可。
 *   实现上仍然每类一次 `state.db.prepare(...).all(...)`,各自一次往返,
 *   与 Rust 端"先持有锁再去嵌套锁会自死锁"的反例同形——保留结构对位便于
 *   阅读与回归追踪。
 */

import type { DatabaseSync } from "node:sqlite";

import { deriveStatusSqlFragment } from "../project/index.js";
import type { AppState } from "../state.js";
import {
  TASK_COLUMNS_WITH_T,
  inFlightTaskOrderBy,
  rowToTask,
  searchTasksBlocking,
} from "../task/index.js";
import { escapeLike } from "../util/sql.js";
import type {
  Task,
  WayfinderMatchKind,
  WayfinderPersonHit,
  WayfinderProjectHit,
  WayfinderSearchArgs,
  WayfinderSearchResults,
} from "../types.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 人员候选默认封顶——前端按这个数字决定面板高度。 */
export const PEOPLE_LIMIT_DEFAULT = 6;

/** 项目候选默认封顶。 */
export const PROJECTS_LIMIT_DEFAULT = 6;

/** 任务候选默认封顶。 */
export const TASKS_LIMIT_DEFAULT = 12;

// ---------------------------------------------------------------------------
// 行类型
// ---------------------------------------------------------------------------

interface PersonHitRow {
  id: number;
  name: string;
  sub_team_id: number;
  sub_team_name: string;
}

interface ProjectHitRow {
  id: number;
  name: string;
  sub_team_id: number;
  sub_team_name: string;
  derived_status: string;
}

// ---------------------------------------------------------------------------
// 主命令
// ---------------------------------------------------------------------------

/**
 * ⌘K 命令面板搜索。
 *
 * 三类目标**独立查询、各自封顶、各自排序**——不在命令层跨类打乱顺序。
 * 面板扁平列表的全局索引由前端在内存里算（命令层给三个 Vec,
 * 前端 concat 后用 keyboard 索引走）。这是命令层与渲染层职责的边界。
 */
export function wayfinderSearch(
  state: AppState,
  args: WayfinderSearchArgs,
): WayfinderSearchResults {
  const peopleLimit = args.peopleLimit ?? PEOPLE_LIMIT_DEFAULT;
  const projectsLimit = args.projectsLimit ?? PROJECTS_LIMIT_DEFAULT;
  const tasksLimit = args.tasksLimit ?? TASKS_LIMIT_DEFAULT;
  const includeCancelledTasks = args.includeCancelledTasks ?? false;
  const includeDeactivatedPeople = args.includeDeactivatedPeople ?? false;

  // 三类查询各自走一次 db（承 ticket #28 Rust 端"不在外层先取一次连接"
  // 的反例同形——node:sqlite 同步 API 不需要 Mutex,但保留结构对位便于
  // 阅读与回归追踪）。
  const people = searchPeople(
    state.db,
    args.query,
    peopleLimit,
    includeDeactivatedPeople,
  );
  const projects = searchProjects(state.db, args.query, projectsLimit);
  const tasks = searchTasks(
    state,
    args.query,
    tasksLimit,
    includeCancelledTasks,
    includeDeactivatedPeople,
  );

  return { people, projects, tasks };
}

// ---------------------------------------------------------------------------
// 人员
// ---------------------------------------------------------------------------

/**
 * 人员候选查询。query 非空时按"姓名 OR 子组名 LIKE"过滤；query 为空时
 * 走默认排序（子组 sort_order → 段内在岗优先 → id 升序）。离岗过滤是
 * 默认行为——命令面板不该把已经请假的人推上前几位。
 */
function searchPeople(
  db: DatabaseSync,
  query: string,
  limit: number,
  includeDeactivated: boolean,
): WayfinderPersonHit[] {
  const trimmed = query.trim();

  // query 非空 → LIKE 子串匹配（中英文 / 数字都行）；`%` / `_` /
  // 反斜杠由 [`escapeLike`] 兜底——不转义的话用户打 `%` 就把全员刷出来。
  //
  // 两处 LIKE（人名 / 子组名）共用同一 pattern——bind 时 pattern 重复传
  // 一次（`all(pattern, pattern, limit)`）,让 SQL 里 `?` 出现次数与
  // bind 参数数量严格相等。空 query 走默认排序,没有 LIKE 占位,只剩 LIMIT。
  let sql = `
    SELECT p.id, p.name, p.sub_team_id, st.name AS sub_team_name
      FROM person p
      JOIN sub_team st ON st.id = p.sub_team_id`;
  const where: string[] = [];
  const pattern = buildLikeClause(trimmed);
  if (pattern !== null) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR st.name LIKE ? ESCAPE '\\')");
  }
  if (!includeDeactivated) {
    where.push("p.deactivated_at IS NULL");
  }
  if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
  sql += `
    ORDER BY st.sort_order ASC, st.id ASC,
             CASE WHEN p.deactivated_at IS NULL THEN 0 ELSE 1 END ASC,
             p.id ASC
    LIMIT ?`;

  const rows = pattern === null
    ? db.prepare<[number], PersonHitRow>(sql).all(limit)
    : db.prepare<[string, string, number], PersonHitRow>(sql).all(pattern, pattern, limit);

  return rows.map((row) => ({
    personId: row.id,
    name: row.name,
    subTeamId: row.sub_team_id,
    subTeamName: row.sub_team_name,
    matchKind: classifyMatch(trimmed, row.name, row.sub_team_name),
  }));
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

/**
 * 项目候选查询——排除 Done / Cancelled（命令面板是"在飞"视角），`status`
 * 沿用视图层的派生逻辑（[`deriveStatusSqlFragment`]）。
 */
function searchProjects(
  db: DatabaseSync,
  query: string,
  limit: number,
): WayfinderProjectHit[] {
  const trimmed = query.trim();
  const derivedStatusExpr = deriveStatusSqlFragment("p");

  let sql = `
    SELECT p.id, p.name, p.sub_team_id, st.name AS sub_team_name,
           (${derivedStatusExpr}) AS derived_status
      FROM project p
      JOIN sub_team st ON st.id = p.sub_team_id`;
  const where: string[] = [];
  const pattern = buildLikeClause(trimmed);
  if (pattern !== null) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR st.name LIKE ? ESCAPE '\\')");
  }
  where.push(`(${derivedStatusExpr}) NOT IN ('Done','Cancelled')`);
  sql += ` WHERE ${where.join(" AND ")}`;
  sql += `
    ORDER BY CASE WHEN p.due_date IS NULL THEN 1 ELSE 0 END ASC,
             p.due_date ASC,
             p.created_at ASC,
             p.id ASC
    LIMIT ?`;

  const rows = pattern === null
    ? db.prepare<[number], ProjectHitRow>(sql).all(limit)
    : db.prepare<[string, string, number], ProjectHitRow>(sql).all(pattern, pattern, limit);

  return rows.map((row) => ({
    projectId: row.id,
    name: row.name,
    subTeamId: row.sub_team_id,
    subTeamName: row.sub_team_name,
    status: row.derived_status,
    matchKind: classifyMatch(trimmed, row.name, row.sub_team_name),
  }));
}

// ---------------------------------------------------------------------------
// 任务——薄包装 ticket #27 / #45 的 searchTasksBlocking
// ---------------------------------------------------------------------------

/**
 * 任务候选——直接调 [`searchTasksBlocking`] 复用 FTS5 trigram + LIKE 兜底路径。
 * query 走它已经处理过的清洗（FTS5 特殊字符替换 → 短查询降级）。空 query
 * 走默认排序前 N 条。
 */
function searchTasks(
  state: AppState,
  query: string,
  limit: number,
  includeCancelled: boolean,
  includeDeactivatedOwners: boolean,
): Task[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    // 空 query 不走 searchTasks——它会因空关键词被拒。直接列在飞任务
    // 前 N 条,排序沿用 listTasks 的"在飞优先 + due_date + id"约定。
    return fetchTopTasks(state.db, limit, includeCancelled, includeDeactivatedOwners);
  }
  return searchTasksBlocking(state, trimmed, includeCancelled, includeDeactivatedOwners, limit);
}

/**
 * 空 query 时拉默认排序前 N 条——命令面板打开后第一眼不是空的。
 *
 * 排序走 [`inFlightTaskOrderBy`] 共用片段, 不重复"在飞优先 + due_date +
 * created_at + id"这一份 SQL——`listTasks` / `listTasksFiltered` / 这里共用同一份。
 */
function fetchTopTasks(
  db: DatabaseSync,
  limit: number,
  includeCancelled: boolean,
  includeDeactivatedOwners: boolean,
): Task[] {
  const where: string[] = [];
  if (!includeCancelled) where.push("t.status != 'Cancelled'");
  if (!includeDeactivatedOwners) where.push("p.deactivated_at IS NULL");

  let sql = `SELECT ${TASK_COLUMNS_WITH_T} FROM task t`;
  if (!includeDeactivatedOwners) {
    sql += " JOIN person p ON p.id = t.owner_person_id";
  }
  if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
  sql += ` ORDER BY ${inFlightTaskOrderBy("t.")} LIMIT ?`;

  const rows = db
    .prepare<[number], Parameters<typeof rowToTask>[0]>(sql)
    .all(limit);
  // 复用 task 模块的 rowToTask——同源避免行 → DTO 漂移
  return rows.map(rowToTask);
}

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

/**
 * 把用户 query 拼成 LIKE 子串模板（`%query%`）。query 空白折叠为 `null`——
 * 调用方按"不过滤"路径走。`%` / `_` / 反斜杠由 [`escapeLike`] 转义。
 *
 * 单元测试覆盖：trim、空串、`%` / `_` / `\\` 转义、中文直接拼接。
 */
export function buildLikeClause(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  return `%${escapeLike(trimmed)}%`;
}

/**
 * 决定匹配落在名字 / 子组名 / 都中——前端据此决定高亮哪一段。
 *
 * `query` 为空时返回 `WayfinderMatchKind::Name`, 纯默认值, 前端不去高亮。
 *
 * 大小写不敏感——中文场景无大小写概念,英文 / 混合场景走 `toLowerCase()`
 * 双方归一。`hit_name` 与 `hit_team` 任一为真时返回对应 kind;两者皆否
 * （不该走到——上游 LIKE 已过滤）兜底 `name`,不影响前端默认不高亮渲染。
 */
export function classifyMatch(
  query: string,
  name: string,
  subTeamName: string,
): WayfinderMatchKind {
  if (query.length === 0) return "name";
  const needle = query.toLowerCase();
  const hitName = name.toLowerCase().includes(needle);
  const hitTeam = subTeamName.toLowerCase().includes(needle);
  if (hitName && hitTeam) return "both";
  if (hitName) return "name";
  if (hitTeam) return "sub-team";
  return "name";
}

/**
 * LIKE 元字符（`%` / `_` / 反斜杠本身）转义由 [`../util/sql.ts`] 单源提供——
 * 原 wayfinder 模块内一份拷贝是为维持模块独立性,统一抽到 util 后不再保留。
 */