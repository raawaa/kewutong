//! 命令层：前端能触发的一切都从这里进出。
//!
//! 约定（后续每个领域模块照此办理）：
//! - 一个领域一个子模块（`diagnostics` / `personnel` / 后续的 `task` ……），命令函数 `pub`，
//!   在 [`crate::run`] 的 `generate_handler!` 里按 `commands::<领域>::<命令>` 登记。
//! - 入参与返回值都是稳定 DTO（`serde` 结构，`camelCase` 上线），不透传行结构。
//! - 错误一律 [`crate::error::AppError`]，前端只负责展示。
//! - 「现在」只从 [`crate::state::AppState::now`] 取，不直接读宿主时间。

pub mod diagnostics;
pub mod holiday;
pub mod personnel;
pub mod project;
pub mod task;
pub mod validation;
