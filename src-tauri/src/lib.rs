//! 科室任务管理——桌面 app 的 Rust 端。

pub mod clock;
pub mod commands;
pub mod db;
pub mod error;
pub mod holiday;
pub mod materialization;
pub mod notifications;
pub mod recurring;
pub mod state;
pub mod testing;
pub mod tray;

use chrono::Datelike;
use state::AppState;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;

/// 数据库文件名；落在系统的 app data 目录下，由 Syncthing 做文件夹级同步。
const DB_FILE_NAME: &str = "kewutong.db";

/// 后台 tick 周期：每小时跑一次 `materialize_if_new_week`。跨入新
/// ISO 周时物化,其余时间 noop。1 小时粒度够用——科长不会在跨入新一周
/// 后 1 小时内还看不到 instance。
const MATERIALIZE_TICK_INTERVAL: Duration = Duration::from_secs(3600);

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
        // —— 全文搜索与复合筛选（ticket #27）——
        commands::task::list_tasks_filtered,
        commands::task::search_tasks,
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
        // —— 物化引擎（ticket #25）——
        commands::materialization::materialize_now,
        commands::materialization::materialize_if_new_week,
        // —— 实例动作与改期溯源（ticket #26）——
        commands::instance::reschedule_instance,
        commands::instance::override_instance_scheduled_at,
        commands::instance::update_recurring_template_zone,
        commands::instance::instance_reschedule_chain,
        // —— ⌘K 全局命令面板（ticket #28）——
        commands::wayfinder::wayfinder_search,
        // —— 托盘状态查询（ticket #29）——
        commands::tray::tray_status,
        // —— 通知（ticket #30）——
        commands::notification::list_unread_notifications,
        commands::notification::list_notifications,
        commands::notification::mark_notification_read,
        commands::notification::mark_all_notifications_read,
        commands::notification::get_notification,
        // —— 示例数据与数据文件位置（ticket #31）——
        commands::sample::is_sample_data_present,
        commands::sample::clear_sample_data,
        commands::sample::data_file_location,
        commands::sample::seed_real_teams,
        // —— 导出（JSON 整库 + CSV 当前视图，ticket #31）——
        commands::export::export_database_json,
        commands::export::import_database_json,
        commands::export::export_tasks_csv,
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
            tray::show_main_window(app);
        }));
    }

    // 托盘定位插件：macOS / Windows 上把唤回的窗口贴到托盘旁边；
    // Linux 上虽不直接用 Tray* 位置,但插件自身是位置抽象的稳定入口,
    // 接入后后续要加「唤回贴托盘」也无需换方案。
    //
    // `tray-icon` feature 启用后插件会监听 tray click 事件把当前 tray 矩形
    // 存进内部 state——Linux 上即便 click 事件本身没触发,这个 feature
    // 不打开也不会更糟。
    builder = builder.plugin(tauri_plugin_positioner::init());

    // OS 通知插件（ticket #30）：三条规则命中的任务走这条路径 emit
    // 桌面通知。permission 在 macOS 上首次弹权限请求;被拒时 emit 走
    // fallback——通知仍写库,只不弹 OS 弹窗。
    builder = builder.plugin(tauri_plugin_notification::init());

    register_commands(builder)
        .setup(|app| {
            let db_path = app.path().app_data_dir()?.join(DB_FILE_NAME);
            let state = state::compat::with_system_clock(db::open(&db_path)?);
            state.set_db_path(db_path);
            install_holiday_calendar(app.handle(), &state)?;
            // 首启灌入真实 4 子组 / 20 人骨架(ticket #31)。
            // 已存在真实子组时静默跳过——保证后续启动与跨机同步漂移场景
            // 不重复灌入。失败不阻塞启动,科长手动录也好。
            if let Err(err) = commands::sample::seed_real_teams_via_state(&state) {
                eprintln!("[kewutong] 首启真实数据 seed 失败：{err}");
            }
            // 启动时立即跑一次物化——保证应用一打开就能看到未来 12 周
            // 的 instance。失败不阻塞启动,物化是后台能力。
            if let Err(err) = materialization::materialize_from_state(&state) {
                eprintln!("[kewutong] 启动物化失败：{err}");
            }
            // 启动时也跑一次通知扫描——若启动时正好是周一 8 点,触发周报;
            // due_24h / blocked_3d 立即能命中已存在的过期任务。失败不阻塞。
            let app_handle = app.handle().clone();
            match notifications::run_all(&state) {
                Ok(summary) => emit_os_notifications(&app_handle, summary.into_flat()),
                Err(err) => eprintln!("[kewutong] 启动通知扫描失败：{err}"),
            }
            let state_for_tick = Arc::clone(&state);
            let state_for_setup = Arc::clone(&state);
            app.manage(state);

            // 托盘（ticket #29）：失败不 panic,把 state 翻成 Unavailable 让
            // 前端 banner 提示;同时关窗拦截器看到 Unavailable 不会拦截——
            // 关窗走默认行为(应用退出)。
            match tray::install(app.handle(), &state_for_setup) {
                Ok(()) => {
                    if let Some(window) = app.get_webview_window("main") {
                        tray::intercept_close_to_tray(&window, &state_for_setup);
                    } else {
                        eprintln!("[kewutong] 主窗口未注册,跳过关窗拦截");
                    }
                    // Linux:托盘 click 事件不发,起焦点轮询兜底
                    #[cfg(target_os = "linux")]
                    tray::spawn_linux_focus_poll(app.handle());
                }
                Err(err) => {
                    let reason = err.message().to_string();
                    state_for_setup.set_tray_status(crate::state::TrayStatus::Unavailable {
                        reason: reason.clone(),
                    });
                    eprintln!("[kewutong] 托盘初始化失败：{reason}");
                }
            }

            spawn_materialize_tick(state_for_tick, app.handle().clone());
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

/// 后台 tick：每小时跑一次。物化 + 通知扫描共用一个 trigger——
/// ticket #30 AC「通知调度器可与物化层的定时器共用 trigger」。
///
/// 物化：跨入新 ISO 周时跑一次,其余时间 noop。通知扫描：每次 tick
/// 都跑,规则内部自己判定今天是否要 emit（due_24h 看 due_date 区间、
/// blocked_3d 看 blocked_at 阈值、weekly_digest 看周一 8 点 + 非
/// holiday）。落库与去重由 [`notifications::run_all`] 负责,emit OS
/// 通知由 [`emit_os_notifications`] 完成。
///
/// 用 `tauri::async_runtime::spawn` 走 Tauri 自带的 tokio runtime,避
/// 免引额外 runtime 依赖。tick 的 panic 由 Tauri runtime 兜底,不
/// 影响主进程。
fn spawn_materialize_tick<R: tauri::Runtime>(state: AppState, app: tauri::AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(MATERIALIZE_TICK_INTERVAL);
        // 第一次 tick 立即触发——配合启动那次,即使启动时今天没跨入新
        // 周,1 小时内还会再校一次。
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(err) = commands::materialization::materialize_if_new_week_via_state(&state) {
                eprintln!("[kewutong] tick 物化失败：{err}");
            }
            match notifications::run_all(&state) {
                Ok(summary) => emit_os_notifications(&app, summary.into_flat()),
                Err(err) => eprintln!("[kewutong] tick 通知扫描失败：{err}"),
            }
        }
    });
}

/// 把每个新插入的通知 emit 成 OS 通知。
///
/// 单条失败不连累后续;emit 整体失败(权限被拒 / Linux 缺 dbus 等)只
/// 打日志,不 panic。通知仍写在 DB 里——前端"未读面板"是兜底通道,
/// OS 弹窗是锦上添花。
fn emit_os_notifications<R: tauri::Runtime>(app: &tauri::AppHandle<R>, rows: Vec<notifications::NotificationRow>) {
    if rows.is_empty() {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    for row in rows {
        // payload 反序列化拿标题/正文——emit 阶段不替 payload 重新设计
        // 形状,与序列化路径共用同一份 NotificationPayload 渲染逻辑。
        let payload: Result<notifications::NotificationPayload, _> =
            serde_json::from_value(row.payload.clone());
        let (title, body) = match payload {
            Ok(p) => p.render_message(),
            Err(err) => {
                eprintln!("[kewutong] 通知 id={} payload 反序列化失败：{err}", row.id);
                continue;
            }
        };
        let body_with_id = format!("{body}\n\n（通知 #{}）", row.id);
        if let Err(err) = app
            .notification()
            .builder()
            .title(title)
            .body(body_with_id)
            .show()
        {
            eprintln!("[kewutong] emit 通知失败 (id={})：{err}", row.id);
        }
    }
}

/// `AppError` → `tauri::Error`：Tauri 没有给 `AppError` 实现 `From`,在
/// setup 钩子边界手动包一次。给科长看的 `message` 通过 `Display` 透到
/// tauri 的 setup 失败日志。
fn app_error_to_tauri(err: error::AppError) -> tauri::Error {
    let detail = err.to_string();
    let boxed: Box<dyn std::error::Error> = detail.into();
    tauri::Error::Setup(boxed.into())
}
