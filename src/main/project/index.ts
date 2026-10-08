/**
 * 项目命令层（ticket #20）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/commands/project.rs` 的语义：
 * - `project` 表全列（除 `status`，由视图层从 task 聚合）
 * - 删除项目：**项目下任务的 `project_id` 置 NULL**（事务内 UPDATE + DELETE
 *   协同），不留悬空 FK
 *
 * 所有命令入参与返回都是稳定 DTO，不透传行结构。
 */

import type { DatabaseSync } from "node:sqlite";

import { AppError } from "../error.js";
import { parseSqlDate } from "../clock.js";
import type { AppState } from "../state.js";
import { escapeLike } from "../util/sql.js";
import { requireNonBlank, trimToOption } from "../util/strings.js";
import { ensurePersonExists, ensureSubTeamExists } from "../util/fk.js";
import type {
  CreateProjectArgs,
  DeleteProjectArgs,
  ListProjectCandidatesArgs,
  ListProjectsArgs,
  Project,
  ProjectCandidate,
  ProjectStatus,
  UpdateProjectArgs,
} from "../types.js";
import { withTx } from "../sqlite.js";

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

interface ProjectRowWithStatus {
  id: number;
  name: string;
  owner_person_id: number;
  sub_team_id: number;
  start_date: string | null;
  due_date: string | null;
  notes: string | null;
  created_at: string;
  derived_status: ProjectStatus;
}

interface ProjectCandidateRow {
  id: number;
  name: string;
  sub_team_name: string;
}

/** `#` 下拉最多显示几条——与 `@` 的封顶对齐。 */
const PROJECT_CANDIDATE_LIMIT = 6;

// ---------------------------------------------------------------------------
// status 派生 SQL 片段
// ---------------------------------------------------------------------------

/**
 * `project.status` 视图层聚合的 CASE 表达式。
 *
 * 三处共用同一份逻辑（`listProjects` / `listProjectCandidates` / `fetchProject`），
 * 派生规则不会漂移。ticket #28 `wayfinder_search` 也复用。
 */
export function deriveStatusSqlFragment(projectAlias: string): string {
  const p = projectAlias;
  return `
    CASE
      WHEN NOT EXISTS(SELECT 1 FROM task t WHERE t.project_id = ${p}.id) THEN 'Active'
      WHEN NOT EXISTS(
        SELECT 1 FROM task t
        WHERE t.project_id = ${p}.id
          AND t.status NOT IN ('Cancelled')
      ) THEN 'Cancelled'
      WHEN NOT EXISTS(
        SELECT 1 FROM task t
        WHERE t.project_id = ${p}.id
          AND t.status NOT IN ('Done','Cancelled')
      ) THEN 'Done'
      ELSE 'Active'
    END`;
}

function projectSelectColumns(includeDerivedStatus: boolean): string {
  const cols =
    "p.id, p.name, p.owner_person_id, p.sub_team_id, p.start_date, p.due_date, p.notes, p.created_at";
  if (!includeDerivedStatus) return cols;
  return `${cols}, ${deriveStatusSqlFragment("p")} AS derived_status`;
}

// ---------------------------------------------------------------------------
// 行 → DTO
// ---------------------------------------------------------------------------

function rowToProject(row: ProjectRowWithStatus): Project {
  return {
    id: row.id,
    name: row.name,
    ownerPersonId: row.owner_person_id,
    subTeamId: row.sub_team_id,
    startDate: row.start_date,
    dueDate: row.due_date,
    notes: row.notes,
    createdAt: row.created_at,
    status: row.derived_status,
  };
}

function fetchProject(db: DatabaseSync, id: number): Project | null {
  const sql = `SELECT ${projectSelectColumns(true)} FROM project p WHERE p.id = ?`;
  const row = db.prepare<[number], ProjectRowWithStatus>(sql).get(id);
  return row ? rowToProject(row) : null;
}

// ---------------------------------------------------------------------------
// 入参校验（已上提到 util/strings.ts）
// ---------------------------------------------------------------------------

function parseOptionalDate(value: string | null, label: string): string | null {
  const text = trimToOption(value);
  if (text === null) return null;
  const date = parseSqlDate(text);
  if (date === null) {
    throw AppError.invalid(`${label}格式不对,应形如 2026-09-10。`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/**
 * 列出全部项目，`status` 由视图层聚合（ticket #20 验收点）。
 *
 * 排序：先看 `due_date`（`NULL` 置后），再看 `created_at` 兜底避免抖动。
 * `includeDone = false` 时过滤掉 `Done` / `Cancelled` 的项目。
 */
export function listProjects(state: AppState, args: ListProjectsArgs): Project[] {
  const sql = `
    SELECT ${projectSelectColumns(true)}
      FROM project p
     ORDER BY
       CASE WHEN p.due_date IS NULL THEN 1 ELSE 0 END ASC,
       p.due_date ASC,
       p.created_at ASC,
       p.id ASC`;
  const rows = state.db.prepare<[], ProjectRowWithStatus>(sql).all();
  const projects = rows.map(rowToProject);
  if (!args.includeDone) {
    return projects.filter((p) => p.status !== "Done" && p.status !== "Cancelled");
  }
  return projects;
}

/** `#` 内联选项目的候选——排除 Done / Cancelled，按 query 子串匹配，封顶 6 条。 */
export function listProjectCandidates(
  state: AppState,
  args: ListProjectCandidatesArgs,
): ProjectCandidate[] {
  const query = trimToOption(args.query);
  const pattern = query === null ? "%" : `%${escapeLike(query)}%`;

  const sql = `
    SELECT p.id, p.name, st.name AS sub_team_name
      FROM project p
      JOIN sub_team st ON st.id = p.sub_team_id
     WHERE p.name LIKE ? ESCAPE '\\'
       AND (${deriveStatusSqlFragment("p")}) NOT IN ('Done','Cancelled')
     ORDER BY
       CASE WHEN p.due_date IS NULL THEN 1 ELSE 0 END ASC,
       p.due_date ASC,
       p.created_at ASC,
       p.id ASC
     LIMIT ?`;

  const rows = state.db
    .prepare<[string, number], ProjectCandidateRow>(sql)
    .all(pattern, PROJECT_CANDIDATE_LIMIT);
  return rows.map((r) => ({
    projectId: r.id,
    name: r.name,
    subTeamName: r.sub_team_name,
  }));
}

/** 新建项目。 */
export function createProject(state: AppState, args: CreateProjectArgs): Project {
  const name = requireNonBlank(args.name, "项目名不能为空。");
  const startDate = parseOptionalDate(args.startDate ?? null, "开始日");
  const dueDate = parseOptionalDate(args.dueDate ?? null, "截止日");
  const notes = trimToOption(args.notes);

  ensurePersonExists(state.db, args.ownerPersonId);
  ensureSubTeamExists(state.db, args.subTeamId);

  withTx(state.db, () => {
    state.db
      .prepare(
        `INSERT INTO project
           (name, owner_person_id, sub_team_id, start_date, due_date, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, args.ownerPersonId, args.subTeamId, startDate, dueDate, notes);
  });

  const id = state.db.prepare<[], { id: number }>("SELECT last_insert_rowid() AS id").get()?.id;
  if (id === undefined) throw AppError.internal("刚插入的项目立即查不到 id");
  const project = fetchProject(state.db, id);
  if (!project) throw AppError.internal(`刚插入的项目 id=${id} 立即查不到,数据库状态异常`);
  return project;
}

/** 编辑项目（不改 status——status 仍由视图层聚合）。 */
export function updateProject(state: AppState, args: UpdateProjectArgs): Project {
  const name = requireNonBlank(args.name, "项目名不能为空。");
  const startDate = parseOptionalDate(args.startDate ?? null, "开始日");
  const dueDate = parseOptionalDate(args.dueDate ?? null, "截止日");
  const notes = trimToOption(args.notes);

  ensurePersonExists(state.db, args.ownerPersonId);
  ensureSubTeamExists(state.db, args.subTeamId);

  const result = state.db
    .prepare(
      `UPDATE project
          SET name = ?, owner_person_id = ?, sub_team_id = ?,
              start_date = ?, due_date = ?, notes = ?
        WHERE id = ?`,
    )
    .run(name, args.ownerPersonId, args.subTeamId, startDate, dueDate, notes, args.id);

  if (result.changes === 0) throw AppError.invalid("项目不存在或已被删除。");
  const project = fetchProject(state.db, args.id);
  if (!project) throw AppError.internal(`项目 id=${args.id} 查询不一致`);
  return project;
}

/**
 * 删除项目。项目下任务的 `project_id` 置 NULL（不留悬空 FK）。
 *
 * 事务内先 UPDATE 任务，再 DELETE 项目——两步必须在同一事务内。
 */
export function deleteProject(state: AppState, args: DeleteProjectArgs): void {
  withTx(state.db, () => {
    state.db.prepare("UPDATE task SET project_id = NULL WHERE project_id = ?").run(args.id);
    const result = state.db.prepare("DELETE FROM project WHERE id = ?").run(args.id);
    if (result.changes === 0) throw AppError.invalid("项目不存在或已被删除。");
  });
}