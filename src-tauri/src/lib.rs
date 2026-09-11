//! 科室任务管理——桌面 app 的 Rust 端。

pub mod clock;
pub mod commands;
pub mod db;
pub mod error;
pub mod holiday;
pub mod recurring;
pub mod state;
pub mod testing;

use chrono::Datelike;
use state::AppState;
use tauri::Manager;

/// 数据库文件名；落在系统的 app data 目录下，由 Syncthing 做文件夹级同步。
const DB_FILE_NAME: &str = "kewutong.db";

/// 登记全部命令。正式入口与测试脚手架共用这一处，两边的命令清单不会漂移。
pub fn register_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        commands::diagnostics::ping,
        // —— 人员管理（ticket #17）——
        commands::personnel::list_sub_teams,
        commands::personnel::create_sub_team,
        commands::personnel::update_sub_team,
        commands::personnel::delete_sub_team,
        commands::personnel::reorder_sub_teams,
        commands::personnel::list_people,
        commands::personnel::create_person,
        commands::personnel::update_person,
        commands::personnel::deactivate_person,
        commands::personnel::reactivate_person,
        commands::personnel::delete_person,
        // —— 任务管理（ticket #18）——
        commands::task::create_task,
        commands::task::set_task_status,
        commands::task::list_tasks,
        // —— 今日 / 本周视图（ticket #21）——
        commands::task::today_week,
        // —— 全局新建 / 编辑任务弹窗（ticket #19）——
        commands::personnel::list_assignee_candidates,
        commands::task::list_due_date_options,
        commands::task::update_task,
        // —— 项目看板（ticket #20）——
        commands::project::list_projects,
        commands::project::list_project_candidates,
        commands::project::create_project,
        commands::project::update_project,
        commands::project::delete_project,
        // —— 人员矩阵视图（ticket #22）——
        commands::personnel::personnel_matrix,
        // —— 节假日数据层与日历视图（ticket #23）——
        commands::holiday::holiday_calendar,
        commands::holiday::set_holiday_override,
        commands::holiday::clear_holiday_override,
        // —— 周期性模板与规则编辑器（ticket #24）——
        commands::recurring_template::upsert_recurring_template,
        commands::recurring_template::list_recurring_templates,
        commands::recurring_template::set_recurring_template_enabled,
    ])
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
            let state = AppState::with_system_clock(db::open(&db_path)?);
            install_holiday_calendar(app.handle(), &state)?;
            app.manage(state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("科室任务管理启动失败");
}

/// 启动时合并打包 `holidays/cn-<year>.json` 与 SQLite `holiday_override`
/// 表,装进 [`AppState`]。两年都缺文件时降级为空日历——年末过渡场景。
///
/// 资源目录由 [`tauri::Manager::path`] 的 `resource_dir()` 给出（开发模式
/// 指向 `target/debug` 下的 Tauri 资源根,发布模式指向 app bundle）。
fn install_holiday_calendar<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
) -> tauri::Result<()> {
    use tauri::Manager;
    let resource_dir = app.path().resource_dir()?;
    let conn = state.db().map_err(app_error_to_tauri)?;
    let today = state.today();
    let calendar = holiday::HolidayCalendar::load(&resource_dir, today.year(), &conn)
        .map_err(app_error_to_tauri)?;
    state.install_calendar(calendar);
    Ok(())
}

/// `AppError` → `tauri::Error`：Tauri 没有给 `AppError` 实现 `From`,在
/// setup 钩子边界手动包一次。给科长看的 `message` 通过 `Display` 透到
/// tauri 的 setup 失败日志。
fn app_error_to_tauri(err: error::AppError) -> tauri::Error {
    let detail = err.to_string();
    let boxed: Box<dyn std::error::Error> = detail.into();
    tauri::Error::Setup(boxed.into())
}
