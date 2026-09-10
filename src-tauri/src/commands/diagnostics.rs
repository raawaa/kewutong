//! 最小命令 `ping`：把 IPC 往返、DTO 序列化、错误映射这条链路走通。

use crate::db;
use crate::error::{AppError, Result};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// `ping` 的返回 DTO。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingReply {
    /// 固定 `"pong"`，前端据此确认命令层活着。
    pub message: String,
    /// 服务端的「现在」，UTC 入库格式。
    pub now: String,
    /// 已应用的最高迁移版本；空库为 `None`。
    pub schema_version: Option<u32>,
    /// 原样带回的回声内容。
    pub echo: Option<String>,
}

/// 探活：确认命令层、数据库、时钟三者都接好了。
#[tauri::command]
pub fn ping(state: State<'_, AppState>, echo: Option<String>) -> Result<PingReply> {
    if echo.as_ref().is_some_and(|text| text.trim().is_empty()) {
        return Err(AppError::invalid("回声内容不能为空。"));
    }

    let conn = state.db()?;
    let schema_version = db::schema_version(&conn)?;

    Ok(PingReply {
        message: "pong".into(),
        now: state.now_sql(),
        schema_version,
        echo,
    })
}
