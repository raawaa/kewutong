//! 测试 fixture。
//!
//! 编进正式构建（而不是藏在 `#[cfg(test)]` 后面），因为 `tests/` 下的集成测试只能
//! 看见 crate 的公开 API；本项目的主测试缝就在命令层集成测试上。

use crate::clock::{Clock, SystemClock};
use crate::db;
use crate::state::{self, AppState};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 一行拿到可注入 `tauri::State` 的测试库：内存库 + 真实 migrations + 运行时 PRAGMA。
///
/// **自动清空 V007 示例数据**——大多数历史测试假定空库起手,看到示例行
/// 就会断言失败。fixture 帮它们把示例数据挪走,留下空 schema。需要看
/// 示例数据的测试(本 ticket 的 `tests/sample.rs`)走 [`fresh_db_with_seed`]
/// 拿到含示例 + 真实数据的库。
pub fn fresh_db() -> AppState {
    fresh_db_with_clock(Arc::new(SystemClock))
}

/// 同 [`fresh_db`]，另把「现在」交给调用方控制。
pub fn fresh_db_with_clock(clock: Arc<dyn Clock>) -> AppState {
    let conn = db::open_in_memory().expect("内存库应当能建起来");
    let state = state::new_app_state(conn, clock);
    clear_seed_data(&state);
    state
}

/// 含 V007 示例数据的 fixture——ticket #31 的 sample / export 测试专用。
///
/// 直接打开内存库跑迁移(V007 会自动 seed 示例数据),再调
/// `seed_real_teams_via_state` 灌入真实 4 子组 / 20 人。两者共同填充
/// 一份「首启时的真实状态」。
///
/// 不复用 [`fresh_db()`]——后者会自动清空 V007 seed,与本 fixture 的
/// 语义相反。
pub fn fresh_db_with_seed() -> AppState {
    let conn = db::open_in_memory().expect("内存库应当能建起来");
    let state = state::new_app_state(conn, Arc::new(SystemClock));
    crate::commands::sample::seed_real_teams_via_state(&state)
        .expect("首启 seed 真实数据应当成功");
    state
}

/// 文件库版本：断言 WAL 这类只在真实文件上成立的行为时用。
///
/// # Panics
/// 建库失败时 panic——fixture 起不来就该当场炸，而不是把 `Result` 摊给每个测试。
pub fn fresh_db_file(path: &Path) -> AppState {
    let path_buf = PathBuf::from(path);
    let state =
        state::compat::with_system_clock(db::open(path).expect("文件库应当能建起来"));
    state.set_db_path(path_buf);
    clear_seed_data(&state);
    state
}

/// 清掉 V007 在 migration 阶段灌入的示例数据,以及 V008 灌入的真实子组。
/// 让测试 fixture 起手是空 schema(只有表与索引,没有任何业务行)。
fn clear_seed_data(state: &AppState) {
    let conn = match state.db() {
        Ok(c) => c,
        Err(_) => return,
    };
    // V007 的示例数据:任务 / 模板 / 项目 / 人员 / 子组(均带 is_sample=1)。
    // V008 不再自动 seed,无需清"真实"行——但若某次 setup 漏掉了也要兜底。
    let _ = conn.execute_batch(
        "DELETE FROM notification_log; \
         DELETE FROM task; \
         DELETE FROM recurring_template; \
         DELETE FROM project; \
         DELETE FROM person; \
         DELETE FROM sub_team;",
    );
}
