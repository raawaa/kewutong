/**
 * 在飞任务排序（ticket #92 · Status 作为领域概念集中化）。
 *
 * 主进程唯一权威：长 stuck / due date / updated at 三类 per-status 排序。
 * `comparatorFor(status)` 暴露单一入口，`bucketByStatus` 调用之，不再
 * 在调用方手写「哪两个 status 共用同一 comparator」。
 *
 * 可空列（null 排末）与 NOT NULL 列（invariant violation）的区分：
 * - `due_date` 业务上可空，「null 排末」是正确语义；
 * - `blocked_at` 仅在 Blocked / Waiting-on 下非空（DB CHECK），null 是 schema 违反；
 * - `updated_at` 任何写入都 set，任何 null 都是 schema 违反。
 */

import { AppError } from "../error.js";
import type { Task, TaskStatus } from "../types.js";

export type Comparator<T> = (a: T, b: T) => number;

/** `due_date` 升序，NULL 排末 —— Open / In-progress 共用。 */
export function compareByDueDateAscNullLast(a: Task, b: Task): number {
  if (a.dueDate === null && b.dueDate === null) return a.id - b.id;
  if (a.dueDate === null) return 1;
  if (b.dueDate === null) return -1;
  if (a.dueDate < b.dueDate) return -1;
  if (a.dueDate > b.dueDate) return 1;
  return a.id - b.id;
}

/** `blocked_at` 升序 —— Blocked / Waiting-on 共用（longest-stuck first）。 */
export function compareByBlockedAtAsc(a: Task, b: Task): number {
  const aAt = a.blockedAt;
  const bAt = b.blockedAt;
  if (aAt === null) {
    throw AppError.internal(
      `Blocked / Waiting-on 任务的 blocked_at 为 null，违反 DB NOT NULL 约束。taskId=${a.id} status=${a.status}`,
    );
  }
  if (bAt === null) {
    throw AppError.internal(
      `Blocked / Waiting-on 任务的 blocked_at 为 null，违反 DB NOT NULL 约束。taskId=${b.id} status=${b.status}`,
    );
  }
  if (aAt < bAt) return -1;
  if (aAt > bAt) return 1;
  return a.id - b.id;
}

/** `updated_at` 降序 —— Done / Cancelled 共用（最近完成先看）。 */
export function compareByUpdatedAtDesc(a: Task, b: Task): number {
  if (a.updatedAt === null) {
    throw AppError.internal(
      `Done / Cancelled 任务的 updated_at 为 null，违反 DB NOT NULL 约束。taskId=${a.id} status=${a.status}`,
    );
  }
  if (b.updatedAt === null) {
    throw AppError.internal(
      `Done / Cancelled 任务的 updated_at 为 null，违反 DB NOT NULL 约束。taskId=${b.id} status=${b.status}`,
    );
  }
  if (a.updatedAt > b.updatedAt) return -1;
  if (a.updatedAt < b.updatedAt) return 1;
  return b.id - a.id;
}

const COMPARATORS: Record<TaskStatus, Comparator<Task>> = {
  Open: compareByDueDateAscNullLast,
  "In-progress": compareByDueDateAscNullLast,
  Blocked: compareByBlockedAtAsc,
  "Waiting-on": compareByBlockedAtAsc,
  Done: compareByUpdatedAtDesc,
  Cancelled: compareByUpdatedAtDesc,
};

/**
 * 给定 status，返回对应的排序函数。
 *
 * 调用方（`bucketByStatus` / 未来其它聚合器）按 status 调度，不再手工配对。
 * 新增 status 时，`Record<TaskStatus, Comparator>` 缺键会在编译期拦下。
 */
export function comparatorFor(status: TaskStatus): Comparator<Task> {
  return COMPARATORS[status];
}