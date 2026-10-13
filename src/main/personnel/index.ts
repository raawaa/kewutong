/**
 * 人员管理命令层（tickets #17 / #19 / #22）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/commands/personnel.rs` 的语义：
 * - `sub_team.name` 全局 UNIQUE
 * - `person (sub_team_id, name)` UNIQUE（同子组不重名，跨组允许）
 * - 必填字符串 `length(trim(col)) > 0`
 * - 删非空子组 → 明确中文提示；不静默、不级联
 *
 * 所有命令入参与返回都是稳定 DTO，不透传行结构。
 */

import type { DatabaseSync } from "node:sqlite";

import { AppError } from "../error.js";
import type { AppState } from "../state.js";
import { escapeLike } from "../util/sql.js";
import { requireNonBlank, trimToOption } from "../util/strings.js";
import { ensureSubTeamExists } from "../util/fk.js";
import type {
  AssigneeCandidate,
  CreatePersonArgs,
  CreateSubTeamArgs,
  DeleteSubTeamArgs,
  ListAssigneeCandidatesArgs,
  ListPeopleArgs,
  PersonnelMatrix,
  PersonnelMatrixArgs,
  PersonnelMatrixPerson,
  PersonnelMatrixSegment,
  Person,
  PersonDetail,
  PersonDetailInFlight,
  PersonIdArgs,
  ReorderSubTeamsArgs,
  SubTeam,
  Task,
  UpdatePersonArgs,
  UpdateSubTeamArgs,
} from "../types.js";
import {
  TASK_COLUMNS,
  fetchInFlightTasksForPerson,
  inFlightTaskOrderBy,
  rowToTask,
  type TaskRow,
} from "../task/index.js";
import { listProjectsForOwner } from "../project/index.js";
import { listTemplatesForSubTeam } from "../recurring_template/index.js";
import { withTx } from "../sqlite.js";

/** `@` 下拉里最多显示几条。原型下拉高度 6 行；封顶在命令层。 */
const ASSIGNEE_CANDIDATE_LIMIT = 6;

// ---------------------------------------------------------------------------
// 行 → DTO 映射
// ---------------------------------------------------------------------------

interface SubTeamRow {
  id: number;
  name: string;
  description: string | null;
  sort_order: number;
  created_at: string;
}

interface PersonRow {
  id: number;
  name: string;
  sub_team_id: number;
  contact: string;
  deactivated_at: string | null;
  created_at: string;
}

function rowToSubTeam(row: SubTeamRow): SubTeam {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

function rowToPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    subTeamId: row.sub_team_id,
    contact: row.contact,
    deactivatedAt: row.deactivated_at,
    createdAt: row.created_at,
  };
}

function fetchSubTeam(db: DatabaseSync, id: number): SubTeam | null {
  const row = db
    .prepare<[number], SubTeamRow>(
      "SELECT id, name, description, sort_order, created_at FROM sub_team WHERE id = ?",
    )
    .get(id);
  return row ? rowToSubTeam(row) : null;
}

function fetchPerson(db: DatabaseSync, id: number): Person | null {
  const row = db
    .prepare<[number], PersonRow>(
      "SELECT id, name, sub_team_id, contact, deactivated_at, created_at FROM person WHERE id = ?",
    )
    .get(id);
  return row ? rowToPerson(row) : null;
}

// ---------------------------------------------------------------------------
// 入参校验与字符串处理（已上提到 util/strings.ts）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 子组命令
// ---------------------------------------------------------------------------

/** 列出全部子组，按 `(sort_order, id)` 稳定排序。 */
export function listSubTeams(state: AppState): SubTeam[] {
  const rows = state.db
    .prepare<[], SubTeamRow>(
      "SELECT id, name, description, sort_order, created_at FROM sub_team ORDER BY sort_order ASC, id ASC",
    )
    .all();
  return rows.map(rowToSubTeam);
}

/** 新增子组。`sort_order` 默认追加到当前最大值之后；空库时为 0。 */
export function createSubTeam(state: AppState, args: CreateSubTeamArgs): SubTeam {
  const name = requireNonBlank(args.name, "子组名不能为空。");
  const description = trimToOption(args.description);

  ensureSubTeamNameAvailable(state.db, name, null);

  const maxRow = state.db
    .prepare<[], { next: number }>(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM sub_team",
    )
    .get();
  const nextSort = maxRow?.next ?? 0;

  withTx(state.db, () => {
    state.db
      .prepare("INSERT INTO sub_team (name, description, sort_order) VALUES (?, ?, ?)")
      .run(name, description, nextSort);
  });

  const id = state.db.prepare<[], { id: number }>("SELECT last_insert_rowid() AS id").get()?.id;
  if (id === undefined) throw AppError.internal("刚插入的子组立即查不到 id");
  const subTeam = fetchSubTeam(state.db, id);
  if (!subTeam) throw AppError.internal(`刚插入的子组 id=${id} 立即查不到,数据库状态异常`);
  return subTeam;
}

/** 编辑子组名 / 描述。允许改名（仍是 UNIQUE，重复名走中文错误）。 */
export function updateSubTeam(state: AppState, args: UpdateSubTeamArgs): SubTeam {
  const name = requireNonBlank(args.name, "子组名不能为空。");
  const description = trimToOption(args.description);

  ensureSubTeamNameAvailable(state.db, name, args.id);

  const result = state.db
    .prepare("UPDATE sub_team SET name = ?, description = ? WHERE id = ?")
    .run(name, description, args.id);

  if (result.changes === 0) {
    throw AppError.invalid("子组不存在或已被删除。");
  }
  const subTeam = fetchSubTeam(state.db, args.id);
  if (!subTeam) throw AppError.internal(`子组 id=${args.id} 查询不一致`);
  return subTeam;
}

/** 删除子组。**非空子组拒绝**：下辖任何人员（含离岗）均视为非空。 */
export function deleteSubTeam(state: AppState, args: DeleteSubTeamArgs): void {
  const memberCount = state.db
    .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM person WHERE sub_team_id = ?")
    .get(args.id)?.c ?? 0;

  if (memberCount > 0) {
    throw AppError.invalid(
      `该子组下还有 ${memberCount} 名人员,请先调岗或删除人员后再删除子组。`,
    );
  }

  const result = state.db.prepare("DELETE FROM sub_team WHERE id = ?").run(args.id);
  if (result.changes === 0) throw AppError.invalid("子组不存在或已被删除。");
}

/** 拖拽重排子组：按传入 id 顺序写回 `sort_order = 索引`。 */
export function reorderSubTeams(state: AppState, args: ReorderSubTeamsArgs): void {
  const existing = state.db
    .prepare<[], { id: number }>("SELECT id FROM sub_team ORDER BY id ASC")
    .all()
    .map((r) => r.id);

  const incomingSorted = [...args.orderedIds].sort((a, b) => a - b);
  const existingSorted = [...existing].sort((a, b) => a - b);

  if (
    incomingSorted.length !== existingSorted.length ||
    incomingSorted.some((id, i) => id !== existingSorted[i])
  ) {
    throw AppError.invalid("子组列表与数据库不一致,请刷新后重试。");
  }

  withTx(state.db, () => {
    const stmt = state.db.prepare("UPDATE sub_team SET sort_order = ? WHERE id = ?");
    args.orderedIds.forEach((id, index) => stmt.run(index, id));
  });
}

// ---------------------------------------------------------------------------
// 人员命令
// ---------------------------------------------------------------------------

/** 花名册查询。 */
export function listPeople(state: AppState, args: ListPeopleArgs): Person[] {
  const where: string[] = [];
  if (args.subTeamId !== undefined && args.subTeamId !== null) where.push("sub_team_id = ?");
  if (!args.includeDeactivated) where.push("deactivated_at IS NULL");

  const whereClause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
  const orderClause = args.includeDeactivated
    ? " ORDER BY sub_team_id ASC, CASE WHEN deactivated_at IS NULL THEN 0 ELSE 1 END ASC, id ASC"
    : " ORDER BY sub_team_id ASC, id ASC";

  const sql = `SELECT id, name, sub_team_id, contact, deactivated_at, created_at FROM person${whereClause}${orderClause}`;

  if (args.subTeamId !== undefined && args.subTeamId !== null) {
    const rows = state.db.prepare<[number], PersonRow>(sql).all(args.subTeamId);
    return rows.map(rowToPerson);
  }
  const rows = state.db.prepare<[], PersonRow>(sql).all();
  return rows.map(rowToPerson);
}

/** `@` 内联选人的候选——只给在岗的，按 query 子串匹配，封顶 N 条。 */
export function listAssigneeCandidates(
  state: AppState,
  args: ListAssigneeCandidatesArgs,
): AssigneeCandidate[] {
  const query = trimToOption(args.query);
  const pattern = query === null ? "%" : `%${escapeLike(query)}%`;

  const rows = state.db
    .prepare<[string, number], { id: number; name: string; sub_team_name: string }>(
      `SELECT p.id, p.name, st.name AS sub_team_name
         FROM person p
         JOIN sub_team st ON st.id = p.sub_team_id
        WHERE p.deactivated_at IS NULL
          AND p.name LIKE ? ESCAPE '\\'
        ORDER BY st.sort_order ASC, st.id ASC, p.id ASC
        LIMIT ?`,
    )
    .all(pattern, ASSIGNEE_CANDIDATE_LIMIT);

  return rows.map((r) => ({
    personId: r.id,
    name: r.name,
    subTeamName: r.sub_team_name,
  }));
}

/** 新增人员。 */
export function createPerson(state: AppState, args: CreatePersonArgs): Person {
  const name = requireNonBlank(args.name, "姓名不能为空。");
  const contact = requireNonBlank(args.contact, "联系方式不能为空。");

  ensureSubTeamExists(state.db, args.subTeamId);
  ensurePersonNameAvailable(state.db, args.subTeamId, name, null);

  withTx(state.db, () => {
    state.db
      .prepare("INSERT INTO person (name, sub_team_id, contact) VALUES (?, ?, ?)")
      .run(name, args.subTeamId, contact);
  });

  const id = state.db.prepare<[], { id: number }>("SELECT last_insert_rowid() AS id").get()?.id;
  if (id === undefined) throw AppError.internal("刚插入的人员立即查不到 id");
  const person = fetchPerson(state.db, id);
  if (!person) throw AppError.internal(`刚插入的人员 id=${id} 立即查不到,数据库状态异常`);
  return person;
}

/** 编辑人员信息（含调岗）。 */
export function updatePerson(state: AppState, args: UpdatePersonArgs): Person {
  const name = requireNonBlank(args.name, "姓名不能为空。");
  const contact = requireNonBlank(args.contact, "联系方式不能为空。");

  ensureSubTeamExists(state.db, args.subTeamId);
  ensurePersonNameAvailable(state.db, args.subTeamId, name, args.id);

  const result = state.db
    .prepare("UPDATE person SET name = ?, sub_team_id = ?, contact = ? WHERE id = ?")
    .run(name, args.subTeamId, contact, args.id);

  if (result.changes === 0) throw AppError.invalid("人员不存在或已被删除。");
  const person = fetchPerson(state.db, args.id);
  if (!person) throw AppError.internal(`人员 id=${args.id} 查询不一致`);
  return person;
}

/** 标记离岗。`deactivated_at` 用可注入时钟的「现在」。 */
export function deactivatePerson(state: AppState, args: PersonIdArgs): Person {
  const now = state.clock.nowSql();
  const result = state.db
    .prepare("UPDATE person SET deactivated_at = ? WHERE id = ? AND deactivated_at IS NULL")
    .run(now, args.id);

  if (result.changes === 0) {
    const existing = fetchPerson(state.db, args.id);
    if (existing) throw AppError.invalid("该人员已是离岗状态,无需重复操作。");
    throw AppError.invalid("人员不存在或已被删除。");
  }
  const person = fetchPerson(state.db, args.id);
  if (!person) throw AppError.internal(`人员 id=${args.id} 查询不一致`);
  return person;
}

/** 复岗：清掉 `deactivated_at`。 */
export function reactivatePerson(state: AppState, args: PersonIdArgs): Person {
  const result = state.db
    .prepare("UPDATE person SET deactivated_at = NULL WHERE id = ? AND deactivated_at IS NOT NULL")
    .run(args.id);

  if (result.changes === 0) {
    const existing = fetchPerson(state.db, args.id);
    if (existing) throw AppError.invalid("该人员已是在岗状态,无需重复操作。");
    throw AppError.invalid("人员不存在或已被删除。");
  }
  const person = fetchPerson(state.db, args.id);
  if (!person) throw AppError.internal(`人员 id=${args.id} 查询不一致`);
  return person;
}

/** 删除人员（物理删除）。 */
export function deletePerson(state: AppState, args: PersonIdArgs): void {
  const result = state.db.prepare("DELETE FROM person WHERE id = ?").run(args.id);
  if (result.changes === 0) throw AppError.invalid("人员不存在或已被删除。");
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

function ensureSubTeamNameAvailable(
  db: DatabaseSync,
  name: string,
  excludeId: number | null,
): void {
  const taken = excludeId !== null
    ? db
        .prepare<[string, number], { id: number }>(
          "SELECT id FROM sub_team WHERE name = ? AND id != ?",
        )
        .get(name, excludeId)
    : db
        .prepare<[string], { id: number }>("SELECT id FROM sub_team WHERE name = ?")
        .get(name);
  if (taken) throw AppError.invalid("已存在同名子组。");
}

function ensurePersonNameAvailable(
  db: DatabaseSync,
  subTeamId: number,
  name: string,
  excludeId: number | null,
): void {
  const taken = excludeId !== null
    ? db
        .prepare<[number, string, number], { id: number }>(
          "SELECT id FROM person WHERE sub_team_id = ? AND name = ? AND id != ?",
        )
        .get(subTeamId, name, excludeId)
    : db
        .prepare<[number, string], { id: number }>(
          "SELECT id FROM person WHERE sub_team_id = ? AND name = ?",
        )
        .get(subTeamId, name);
  if (taken) throw AppError.invalid("同子组内已存在同名人员。");
}

// ---------------------------------------------------------------------------
// 人员矩阵视图（ticket #22）
// ---------------------------------------------------------------------------

/** 「人员矩阵」视图查询。 */
export function personnelMatrix(
  state: AppState,
  args: PersonnelMatrixArgs,
): PersonnelMatrix {
  // 1) 段头：按 sort_order 升序拉全部子组。
  const segments = state.db
    .prepare<[], SubTeamRow>(
      "SELECT id, name, description, sort_order, created_at FROM sub_team ORDER BY sort_order ASC, id ASC",
    )
    .all()
    .map(rowToSubTeam);

  // 2) 段内人员：复用 list_people 的「子组内顺序」约定。
  const peopleStmt = state.db.prepare<[number], PersonRow>(
    `SELECT id, name, sub_team_id, contact, deactivated_at, created_at
       FROM person
      WHERE sub_team_id = ?
      ORDER BY CASE WHEN deactivated_at IS NULL THEN 0 ELSE 1 END ASC, id ASC`,
  );

  const result: PersonnelMatrixSegment[] = [];
  for (const team of segments) {
    const allPeople = peopleStmt.all(team.id).map(rowToPerson);
    const filtered = args.includeDeactivated
      ? allPeople
      : allPeople.filter((p) => p.deactivatedAt === null);
    if (filtered.length === 0) continue;

    const people: PersonnelMatrixPerson[] = filtered.map((person) => {
      const tasks = fetchInFlightTasksForPerson(state.db, person.id);
      const inFlightCount = tasks.length;
      const blockedCount = tasks.filter(
        (t) => t.status === "Blocked" || t.status === "Waiting-on",
      ).length;
      return { person, inFlightCount, blockedCount, tasks };
    });

    result.push({ subTeam: team, people });
  }

  return { segments: result };
}

// ---------------------------------------------------------------------------
// 人员详情（ticket #80 / #81 T1）
// ---------------------------------------------------------------------------

/**
 * 拉取 owner = 本人 的所有任务（不限状态）——6 状态分桶的源数据。
 *
 * 单条 SQL 把 6 状态全捞出来,再在 TS 里按 `status` 分桶——避免在 SQL
 * 端打 6 个 `IN (...)` 拼装。每条仍走 [`TASK_COLUMNS`] + [`rowToTask`]
 * 的同源 mapping,与 [`fetchInFlightTasksForPerson`] 共用 DTO 形状。
 *
 * 排序：与 [`inFlightTaskOrderBy`] 同样的"在飞优先 + due_date + id"兜
 * 底；调用方按 status 分桶后,各桶内顺序已对齐段内排序（Open / In-
 * progress 看 due_date;Blocked / Waiting-on 看 blocked_at;Done /
 * Cancelled 看 updated_at）。具体段内排序在 T2 票落实,本命令只保证
 * 「拿到完整列表」,段内排序由分桶后置入。
 */
function fetchAllTasksForPerson(
  db: DatabaseSync,
  ownerPersonId: number,
): Task[] {
  const rows = db
    .prepare<[number], TaskRow>(
      `SELECT ${TASK_COLUMNS}
         FROM task
        WHERE owner_person_id = ?
        ORDER BY ${inFlightTaskOrderBy("")}`,
    )
    .all(ownerPersonId);
  return rows.map(rowToTask);
}

/**
 * 拉取 `task.waiting_on_person_id = 本人` 的任务——「别人等的任务由本人推动」。
 *
 * 显式加 `status = 'Waiting-on'` 兜底——DB CHECK 强制 `waiting_on_
 * person_id IS NULL OR status = 'Waiting-on'`,理论上走 `WHERE
 * waiting_on_person_id = ?` 已足以,但显式 status 让 invariant 不再
 *  load-bearing 在 DDL 上。排序按 `blocked_at` 升序,卡最久的在前——
 * 与段 2 的 Blocked / Waiting-on 段同语义（longest-stuck first）。
 */
function fetchWaitingOnTasksForPerson(
  db: DatabaseSync,
  waitingOnPersonId: number,
): Task[] {
  const rows = db
    .prepare<[number], TaskRow>(
      `SELECT ${TASK_COLUMNS}
         FROM task
        WHERE waiting_on_person_id = ?
           AND status = 'Waiting-on'
        ORDER BY blocked_at ASC, id ASC`,
    )
    .all(waitingOnPersonId);
  return rows.map(rowToTask);
}

/**
 * 任务按 6 状态分桶——把一条 task 放到对应桶里。
 *
 * `waitingOn` 桶额外过滤 `waiting_on_person_id != 本人` ——「本人在等别人」
 * 与「本人在等自己」（自反,DB 允许）的拆分：自反等待不进 waitingOn 桶,
 * 因为语义是"卡在某处等审批",不是"等别人推动"。原 spec 写的是
 * 「owner=本人 且 waiting_on_person_id 是别人」,这里精确还原。
 */
function bucketByStatus(
  tasks: Task[],
  ownerPersonId: number,
): PersonDetailInFlight {
  const buckets: PersonDetailInFlight = {
    open: [],
    inProgress: [],
    blocked: [],
    waitingOn: [],
    done: [],
    cancelled: [],
  };
  for (const task of tasks) {
    switch (task.status) {
      case "Open":
        buckets.open.push(task);
        break;
      case "In-progress":
        buckets.inProgress.push(task);
        break;
      case "Blocked":
        buckets.blocked.push(task);
        break;
      case "Waiting-on":
        if (
          task.waitingOnPersonId !== null &&
          task.waitingOnPersonId !== ownerPersonId
        ) {
          buckets.waitingOn.push(task);
        }
        break;
      case "Done":
        buckets.done.push(task);
        break;
      case "Cancelled":
        buckets.cancelled.push(task);
        break;
    }
  }
  return buckets;
}

/**
 * 人员详情聚合（ticket #80 / #81 T1）。
 *
 * 单次命令一次拉回 5 段 DTO,前端不查多表、不重排、不二次聚合：
 * 1. `person` ——人员档案；
 * 2. `inFlight` ——owner 是本人的任务按 6 状态分桶；
 * 3. `ownedProjects` ——本人负责的项目（跨组也算）；
 * 4. `waitingOnTasks` ——`waiting_on_person_id = 本人` 的任务；
 * 5. `subTeamTemplates` ——所属子组的模板。
 *
 * 人员不存在 → `AppError.invalid("人员不存在或已被删除。")`,与既有
 * 写命令（`updatePerson` / `deactivatePerson` 等）的语义一致——
 * 「找不到」=「入参无效」,前端拿到就展示中文错误。
 *
 * 离岗人员**也正常返回**——`person.deactivatedAt` 字段就是「档案里的
 * 离岗时间」,详情视图要据此给个徽章（user story #15）。不再单独
 * 走「`include_deactivated`」开关,详情页只可能查一个具体 id。
 */
export function getPersonDetail(state: AppState, args: PersonIdArgs): PersonDetail {
  const person = fetchPerson(state.db, args.id);
  if (!person) {
    throw AppError.invalid("人员不存在或已被删除。");
  }

  // 段 2 + 段 4：owner = 本人 拉一次,wantingOnPersonId = 本人 拉一次,
  // 不合并——两条 SQL 各自只走 owner_person_id 或 waiting_on_person_id
  // 单列索引(若有),合一条会让 where 同时卡两列,触发 table scan。
  const ownedTasks = fetchAllTasksForPerson(state.db, person.id);
  const waitingOnTasks = fetchWaitingOnTasksForPerson(state.db, person.id);

  // 段 3：跨组也算 owner 关系；`listProjectsForOwner` 已按 due_date / id 排序。
  const ownedProjects = listProjectsForOwner(state.db, person.id);

  // 段 5：所属子组的模板。`person.sub_team_id` 必非空（DB NOT NULL），
  // 子组被物理删除时 FK RESTRICT 兜底——不会出现「人还在但子组没了」。
  const subTeamTemplates = listTemplatesForSubTeam(state.db, person.subTeamId);

  return {
    person,
    inFlight: bucketByStatus(ownedTasks, person.id),
    ownedProjects,
    waitingOnTasks,
    subTeamTemplates,
  };
}