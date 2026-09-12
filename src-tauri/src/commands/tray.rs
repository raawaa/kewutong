//! 托盘状态命令（ticket #29）。
//!
//! 前端启动时拉一次 `tray_status` 决定要不要展示「托盘不可用」banner；后续
//! 托盘状态变化由 Rust 端 emit 事件推给前端（后续 ticket 接事件总线时
//! 再加,本期只暴露查询入口）。
//!
//! DTO 字段是 camelCase：与命令层其它模块对齐,前端直接吃。

use crate::state::{AppState, TrayStatus};
use serde::Serialize;
use tauri::State;

/// 托盘状态 DTO。
///
/// - `available = true` 时 `reason` 必须是空串（前端会一起清掉 banner）。
/// - `available = false` 时 `reason` 是面向科长的中文短句,前端原样展示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayStatusDto {
    pub available: bool,
    pub reason: String,
}

/// 取托盘可达性。
#[tauri::command]
pub fn tray_status(state: State<'_, AppState>) -> crate::error::Result<TrayStatusDto> {
    let dto = match state.tray_status() {
        TrayStatus::Available => TrayStatusDto {
            available: true,
            reason: String::new(),
        },
        TrayStatus::Unavailable { reason } => TrayStatusDto {
            available: false,
            reason,
        },
    };
    Ok(dto)
}
