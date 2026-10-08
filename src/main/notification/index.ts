/**
 * 通知命令层（ticket #51）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/commands/notification.rs` 的语义：
 * - `notification_log.kind` 列字面量：`due_24h` / `blocked_3d` / `weekly_digest`
 * - `payload` 是 JSON 文本（DB 层 `CHECK (json_valid(payload))`），前端按
 *   `payload.kind` 分支渲染
 * - 未读面板数据源：`viewed_at IS NULL`（命中 partial index）
 * - 历史封顶 200 条（防 IPC 一次性塞回几千条）
 *
 * 标记已读走「id + viewed_at IS NULL」——重复调不报错、不更新，返回
 * `false` 表示本次没写。
 *
 * 命令层不负责写入 `notification_log`——那是通知引擎
 * [`./scheduler.ts`]（due_24h / blocked_3d / weekly_digest 三规则）的
 * 事。本文件只承接读路径 + 标记已读。
 *
 * 行映射助手（`rowToNotification` / `fetchNotification` / `parsePayload`）
 * 与调度引擎共享——两端的列名约定一致，避免漂移。
 */

import { AppError } from "../error.js";
import type { AppState } from "../state.js";
import {
  fetchNotification,
  rowToNotification,
  type NotificationRow,
  type NotificationTableRow,
} from "./scheduler.js";

// 类型从 scheduler 转发——单一权威源；外部模块仍可从 `./index.js` import。
export type { NotificationKind, NotificationRow } from "./scheduler.js";

/** `mark_notification_read` 入参。 */
export interface MarkReadArgs {
  id: number;
}

/** `get_notification` 入参——点 OS 通知跳任务时,前端用 `payload.task_id` 定位。 */
export interface GetNotificationArgs {
  id: number;
}

/** 历史通知查询上限——防 IPC 一次性塞回几千条。 */
const LIST_HISTORY_LIMIT = 200;

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/**
 * 未读通知列表——按触发时间倒序。
 *
 * 未读面板的数据源；UI 拉一次就够了,无需分页。
 */
export function listUnreadNotifications(state: AppState): NotificationRow[] {
  const rows = state.db
    .prepare<[], NotificationTableRow>(
      `SELECT id, triggered_at, kind, related_task_id, related_template_id,
              payload, viewed_at
         FROM notification_log
        WHERE viewed_at IS NULL
        ORDER BY triggered_at DESC, id DESC`,
    )
    .all();
  return rows.map(rowToNotification);
}

/**
 * 历史通知（含已读）—— UI「通知中心」历史 tab 走这条。
 *
 * 默认只看未读；走 listUnreadNotifications。含已读的全量走本命令，默认限封 200。
 */
export function listNotifications(state: AppState): NotificationRow[] {
  const rows = state.db
    .prepare<[number], NotificationTableRow>(
      `SELECT id, triggered_at, kind, related_task_id, related_template_id,
              payload, viewed_at
         FROM notification_log
        ORDER BY triggered_at DESC, id DESC
        LIMIT ?`,
    )
    .all(LIST_HISTORY_LIMIT);
  return rows.map(rowToNotification);
}

/**
 * 标记单条已读。幂等——重复调不会报错；返回 `true` 表示本次写了,
 * `false` 表示已是已读(no-op)。
 */
export function markNotificationRead(state: AppState, args: MarkReadArgs): boolean {
  const now = state.clock.nowSql();
  const result = state.db
    .prepare(
      `UPDATE notification_log
          SET viewed_at = ?
        WHERE id = ? AND viewed_at IS NULL`,
    )
    .run(now, args.id);
  return result.changes > 0;
}

/** 标记全部未读已读——UI「全部已读」按钮走这条。返回本次实际标记的条数。 */
export function markAllNotificationsRead(state: AppState): number {
  const now = state.clock.nowSql();
  const result = state.db
    .prepare(`UPDATE notification_log SET viewed_at = ? WHERE viewed_at IS NULL`)
    .run(now);
  return result.changes;
}

/**
 * 取单条通知——点 OS 通知跳任务时调用,前端用 `payload.task_id` 定位
 * 跳转目标。找不到时抛中文 `InvalidArgument`。
 */
export function getNotification(state: AppState, args: GetNotificationArgs): NotificationRow {
  const notif = fetchNotification(state.db, args.id);
  if (!notif) throw AppError.invalid("通知不存在或已被删除。");
  return notif;
}
