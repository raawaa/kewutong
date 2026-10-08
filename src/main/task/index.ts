/**
 * Task 模块的占位实现（承接 personnel 矩阵查询的最小依赖）。
 *
 * 完整平迁见 tickets #43（CRUD + view queries）、#44（status）、#45（FTS5
 * 搜索）。本文件目前只暴露 personnel 矩阵需要的 `fetchInFlightTasksForPerson`。
 */

import type Database from "better-sqlite3";
import type { Task, TaskStatus } from "../types.js";

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
const IN_FLIGHT_STATUSES = new Set<TaskStatus>(["Open", "In-progress", "Blocked", "Waiting-on"]);

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
}

/** task 行 → DTO（占位实现：instance 字段全部归零，effectiveDate 按 due_date 算）。 */
function rowToTask(row: TaskRow): Task {
  const isRecurring = row.recurring_template_id !== null;
  const effectiveDate = row.due_date; // 占位：M2 #43 阶段按 scheduled_at / due_date 算
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
    isRecurring,
    effectiveDate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blockedAt: row.blocked_at,
    blockedReason: row.blocked_reason,
    waitingOnPersonId: row.waiting_on_person_id,
  };
}

/** 取出该人员的在飞任务（排除 Done / Cancelled），按「状态优先级 + due_date」排序。 */
export function fetchInFlightTasksForPerson(
  db: Database.Database,
  ownerPersonId: number,
): Task[] {
  const placeholders = Array.from(IN_FLIGHT_STATUSES, () => "?").join(",");
  const rows = db
    .prepare<unknown[], TaskRow>(
      `SELECT id, title, description, status, owner_person_id, project_id,
              due_date, recurring_template_id, scheduled_at, original_scheduled_at,
              rescheduled_from_id, created_at, updated_at,
              blocked_at, blocked_reason, waiting_on_person_id
         FROM task
        WHERE owner_person_id = ?
          AND status IN (${placeholders})
        ORDER BY
          CASE status
            WHEN 'Blocked' THEN 0
            WHEN 'Waiting-on' THEN 1
            WHEN 'In-progress' THEN 2
            WHEN 'Open' THEN 3
          END ASC,
          due_date ASC NULLS LAST,
          id ASC`,
    )
    .all(ownerPersonId, ...IN_FLIGHT_STATUSES);
  return rows.map(rowToTask);
}