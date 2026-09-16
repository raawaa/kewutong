//! 通知命令层（ticket #30）。
//!
//! 暴露未读面板查询、标记已读、单条查询（点 OS 通知跳转用）。OS 通知
//! 的 emit 由调度器（[`crate::notifications::run_all`]）在拿到
//! [`crate::notifications::NotificationRow`] 后调用
//! `tauri-plugin-notification` 完成——命令层不替它写 emit。
//!
//! 错误一律 [`crate::error::AppError`]，前端只负责展示。

use crate::error::{AppError, Result};
use crate::notifications::{self, NotificationRow};
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;

/// 历史通知查询上限——防 IPC 一次性塞回几千条。
const LIST_HISTORY_LIMIT: usize = 200;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// `mark_notification_read` 入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkReadArgs {
    pub id: i64,
}

/// `get_notification` 入参——点 OS 通知跳任务时,前端用 payload.task_id 定位。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNotificationArgs {
    pub id: i64,
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 未读通知列表——按触发时间倒序。
///
/// 未读面板的数据源;UI 拉一次就够了,无需分页。
#[tauri::command]
pub fn list_unread_notifications(state: State<'_, AppState>) -> Result<Vec<NotificationRow>> {
    notifications::list_unread(state.inner())
}

/// 历史通知（含已读）—— UI「通知中心」历史 tab 走这条;默认只看未读。
#[tauri::command]
pub fn list_notifications(state: State<'_, AppState>) -> Result<Vec<NotificationRow>> {
    notifications::list_all(state.inner(), LIST_HISTORY_LIMIT)
}

/// 标记单条已读。幂等——重复调不会报错;返回 `true` 表示本次写了,
/// `false` 表示已是已读(no-op)。
#[tauri::command]
pub fn mark_notification_read(state: State<'_, AppState>, args: MarkReadArgs) -> Result<bool> {
    notifications::mark_read(state.inner(), args.id)
}

/// 标记全部未读已读——UI「全部已读」按钮走这条。
#[tauri::command]
pub fn mark_all_notifications_read(state: State<'_, AppState>) -> Result<usize> {
    notifications::mark_all_read(state.inner())
}

/// 取单条通知——点 OS 通知跳任务时调用,前端用 `payload.task_id` 定位
/// 跳转目标。
#[tauri::command]
pub fn get_notification(
    state: State<'_, AppState>,
    args: GetNotificationArgs,
) -> Result<NotificationRow> {
    notifications::get(state.inner(), args.id)?
        .ok_or_else(|| AppError::invalid("通知不存在或已被删除。"))
}