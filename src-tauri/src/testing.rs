//! 测试 fixture。
//!
//! 编进正式构建（而不是藏在 `#[cfg(test)]` 后面），因为 `tests/` 下的集成测试只能
//! 看见 crate 的公开 API；本项目的主测试缝就在命令层集成测试上。

use crate::clock::{Clock, SystemClock};
use crate::db;
use crate::state::AppState;
use std::path::Path;
use std::sync::Arc;

/// 一行拿到可注入 `tauri::State` 的测试库：内存库 + 真实 migrations + 运行时 PRAGMA。
pub fn fresh_db() -> AppState {
    fresh_db_with_clock(Arc::new(SystemClock))
}

/// 同 [`fresh_db`]，另把「现在」交给调用方控制。
pub fn fresh_db_with_clock(clock: Arc<dyn Clock>) -> AppState {
    let conn = db::open_in_memory().expect("内存库应当能建起来");
    AppState::new(conn, clock)
}

/// 文件库版本：断言 WAL 这类只在真实文件上成立的行为时用。
///
/// # Panics
/// 建库失败时 panic——fixture 起不来就该当场炸，而不是把 `Result` 摊给每个测试。
pub fn fresh_db_file(path: &Path) -> AppState {
    AppState::with_system_clock(db::open(path).expect("文件库应当能建起来"))
}
