//! 科室任务管理——桌面 app 的 Rust 端。

pub mod clock;
pub mod commands;
pub mod db;
pub mod error;
pub mod state;
pub mod testing;

use state::AppState;
use tauri::Manager;

/// 数据库文件名；落在系统的 app data 目录下，由 Syncthing 做文件夹级同步。
const DB_FILE_NAME: &str = "kewutong.db";

/// 登记全部命令。正式入口与测试脚手架共用这一处，两边的命令清单不会漂移。
pub fn register_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![commands::diagnostics::ping])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // single-instance 必须是第一个注册的插件：插件按注册顺序初始化，晚于其它插件注册
    // 时，第二个实例可能在主进程还没准备好之前就被放行。
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 重复启动 = 把已有窗口唤回前台，而不是再开一份
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    register_commands(builder)
        .setup(|app| {
            let db_path = app.path().app_data_dir()?.join(DB_FILE_NAME);
            app.manage(AppState::with_system_clock(db::open(&db_path)?));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("科室任务管理启动失败");
}
