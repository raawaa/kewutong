//! 全 app 统一的错误类型。
//!
//! 命令层只向前端抛这一个类型：机器可读的 `code` + 面向科长的中文 `message`
//! + 给维护者看的英文 `detail`。前端只负责展示，不解析 detail。
//!
//! 同一个错误有两个面向，形状不同是有意的：
//! - `Serialize`（给前端）把中文与技术细节拆成 `message` / `detail` 两个字段，
//!   界面只显示前者；
//! - `Display`（给日志）把两者拼成一行，方便 `RUST_LOG` 里一眼看全。

use serde::{Serialize, Serializer};

/// 命令层与仓储层统一的 `Result`。
pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// SQLite 读写出错。
    #[error("{}：{}", AppError::DATABASE_MESSAGE, .0)]
    Database(#[from] rusqlite::Error),

    /// 迁移执行失败（建库或升级）。
    #[error("{}：{}", AppError::MIGRATION_MESSAGE, .0)]
    Migration(#[from] refinery::Error),

    /// 数据文件所在目录读写失败。
    #[error("{}：{}", AppError::IO_MESSAGE, .0)]
    Io(#[from] std::io::Error),

    /// 持有连接的线程 panic 过，`Mutex` 已被污染。
    #[error("{}：{}", AppError::INTERNAL_MESSAGE, .0)]
    Internal(String),

    /// 入参不合法。`message` 就是给科长看的中文提示。
    #[error("{message}")]
    InvalidArgument { message: String },
}

impl AppError {
    const DATABASE_MESSAGE: &'static str = "数据库读写失败，请稍后重试；若反复出现请联系维护者。";
    const MIGRATION_MESSAGE: &'static str = "数据库升级失败，请联系维护者。";
    const IO_MESSAGE: &'static str = "读写数据文件失败，请检查磁盘空间与目录权限。";
    const INTERNAL_MESSAGE: &'static str = "应用内部状态异常，请重启应用。";

    /// 入参不合法，`message` 必须是能直接展示给科长的中文。
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidArgument {
            message: message.into(),
        }
    }

    /// 机器可读的错误码，前端据此分支。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Database(_) => "DATABASE",
            Self::Migration(_) => "MIGRATION",
            Self::Io(_) => "IO",
            Self::Internal(_) => "INTERNAL",
            Self::InvalidArgument { .. } => "INVALID_ARGUMENT",
        }
    }

    /// 面向科长的中文消息。
    pub fn message(&self) -> &str {
        match self {
            Self::Database(_) => Self::DATABASE_MESSAGE,
            Self::Migration(_) => Self::MIGRATION_MESSAGE,
            Self::Io(_) => Self::IO_MESSAGE,
            Self::Internal(_) => Self::INTERNAL_MESSAGE,
            Self::InvalidArgument { message } => message,
        }
    }

    /// 给维护者排查用的技术细节；`InvalidArgument` 没有细节可给。
    pub fn detail(&self) -> Option<String> {
        match self {
            Self::Database(source) => Some(source.to_string()),
            Self::Migration(source) => Some(source.to_string()),
            Self::Io(source) => Some(source.to_string()),
            Self::Internal(detail) => Some(detail.clone()),
            Self::InvalidArgument { .. } => None,
        }
    }
}

/// 前端实际看到的形状，同时也是 `AppError` 的序列化契约。
#[derive(Debug, Serialize)]
struct ErrorPayload<'a> {
    code: &'a str,
    message: &'a str,
    detail: Option<String>,
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        ErrorPayload {
            code: self.code(),
            message: self.message(),
            detail: self.detail(),
        }
        .serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 入参错误序列化成中文消息且没有技术细节() {
        let error = AppError::invalid("回声内容不能为空。");

        let json = serde_json::to_value(&error).unwrap();

        assert_eq!(
            json,
            serde_json::json!({
                "code": "INVALID_ARGUMENT",
                "message": "回声内容不能为空。",
                "detail": null,
            })
        );
    }

    #[test]
    fn 数据库错误对科长说中文_对维护者留英文细节() {
        let error: AppError = rusqlite::Error::QueryReturnedNoRows.into();

        let json = serde_json::to_value(&error).unwrap();

        assert_eq!(json["code"], "DATABASE");
        assert_eq!(json["message"], AppError::DATABASE_MESSAGE);
        assert_eq!(
            json["detail"],
            rusqlite::Error::QueryReturnedNoRows.to_string()
        );
    }
}
