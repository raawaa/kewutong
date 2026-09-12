//! 系统托盘与窗口生命周期（ticket #29）。
//!
//! 设计要点（对应 acceptance criteria）：
//! 1. **关主窗口 = 最小化到托盘**：拦截 `WindowEvent::CloseRequested`,
//!    `api.prevent_close()` 后 `hide()`。进程存活；退出走托盘菜单
//!    「退出」项的显式 `app.exit(0)`。
//! 2. **跨平台唤回**：
//!    - Windows / macOS：托盘 click 事件可达——左键直接唤回主窗口，并
//!      由 [`tauri_plugin_positioner::WindowExt::move_window`] 贴到托盘
//!      旁边。
//!    - Linux：托盘不发 click 事件（`tauri/src/tray/mod.rs` 注释），右键
//!      菜单的「显示主窗口」是主路径；另起一个 500ms 焦点轮询兜底——
//!      检测到托盘图标获得焦点（这是 libappindicator 在 StatusNotifierItem
//!      协议下能给到的最具体信号）就把主窗口唤回。位置走屏幕右下角，
//!      **避开 `Position::Tray*`**（plugins-workspace#2927）。
//! 3. **`tauri-plugin-positioner`**：用于把唤回的窗口贴到托盘旁边（macOS
//!    / Windows）；Linux 走 BottomRight 分支不调此 API。
//! 4. **托盘不可用降级**：`install` 失败时回 `Err`,`run()` 捕获后把
//!    `AppState::tray_status` 翻成 `Unavailable { reason }`,**不 panic**——
//!    前端通过 `commands::tray::tray_status` 拿到这个 reason 并展示 banner。
//!    此时关窗走默认行为（直接关闭）,进程退出,下次启动再试。
//! 5. **macOS 菜单栏样式**：第一次隐藏主窗口时 `set_activation_policy(Accessory)`
//!    让 dock 图标也消失,真正"最小化到菜单栏";唤回时切回 `Regular`。
//!
//! 已记录的上游已知 issue（research #8 §4）：
//! - Linux 托盘 click 不触发 → 右键菜单 + 焦点轮询兜底
//! - Wayland `.deb` 托盘偶发缺失 tauri#14234（无法在 app 层修,文档化）
//! - macOS 托盘 set_title/icon 偶发消失 tauri#12060（本期不动 icon,文档化）

use crate::error::{AppError, Result};
use crate::state::{AppState, TrayStatus};
#[cfg(target_os = "linux")]
use std::time::Duration;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};
// WindowExt 提供 `move_window`;Position 在 tray-icon feature 下才有 Tray*
// 变体——Linux 上避开 Tray* 但仍走同一 trait 的 BottomRight。
use tauri_plugin_positioner::{Position, WindowExt};

/// Linux 焦点轮询间隔。500ms 是 libappindicator StatusNotifierItem 实现下
/// 既不会刷屏又能给出「秒级响应」的折中——托盘 click 事件本身不发，焦点
/// 状态变更本身就有 polling 滞后，这条轮询只是把这个滞后显式化了。
#[cfg(target_os = "linux")]
const LINUX_FOCUS_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 托盘菜单项 ID。前端要监听时也用同一份字符串,这里集中定义避免漂移。
pub mod menu_id {
    /// 「显示主窗口」。
    pub const SHOW: &str = "tray_show";
    /// 「退出」。
    pub const QUIT: &str = "tray_quit";
}

/// 托盘窗口定位策略：跨平台分流的可测试抽象。
///
/// 编译期分支；`for_current_platform` 是 `const`-friendly 的纯函数。
/// 这一层抽象让集成测试可以断言「Linux 上不挑 `Tray*`」,而不必真正起
/// 一个 Tauri runtime。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayWindowPosition {
    /// macOS / Windows：托盘旁边(用 `Position::TrayBottomCenter` 或 `TrayCenter`)。
    TrayBottomCenter,
    /// Linux：屏幕右下角(避开 `Position::Tray*`,plugins-workspace#2927)。
    ScreenBottomRight,
}

impl TrayWindowPosition {
    /// 按当前编译目标挑一个。
    #[cfg(target_os = "linux")]
    pub fn for_current_platform() -> Self {
        Self::ScreenBottomRight
    }

    #[cfg(not(target_os = "linux"))]
    pub fn for_current_platform() -> Self {
        Self::TrayBottomCenter
    }
}

/// 安装托盘图标 + 菜单 + 事件回调。成功时把 `AppState::tray_status` 翻
/// 成 `Available`,**调用方**失败时自己决定要不要降级（不要在这里吞错）。
///
/// 失败模式（不一定是真错,可能是 Linux GTK 缺 libappindicator / Wayland 不
/// 支持某些协议）：
/// - 拿不到 `default_window_icon` → `AppError::internal("托盘图标缺失...")`
/// - `Menu::new` 失败 → 原样冒泡
/// - `TrayIconBuilder::build` 失败 → 原样冒泡
pub fn install<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Result<()> {
    let menu = build_menu(app)?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| AppError::internal("托盘图标缺失：default_window_icon 未注册"))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon.clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(handle_tray_event)
        .build(app)
        .map_err(|err| AppError::internal(format!("注册托盘失败：{err}")))?;

    state.set_tray_status(TrayStatus::Available);
    Ok(())
}

/// 注册「关窗 = 隐藏到托盘」拦截器。
///
/// 仅在托盘状态为 `Available` 时安装——托盘不可用时这条拦截会让窗口
/// 关掉也唤不回来,反而比默认行为更糟,直接放行关窗即可。
pub fn intercept_close_to_tray<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    state: &AppState,
) {
    if !matches!(state.tray_status(), TrayStatus::Available) {
        // 降级路径:不拦关窗,让默认行为跑(应用退出)
        return;
    }
    let app = window.app_handle().clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            hide_main_window(&app);
        }
    });
}

/// 唤回主窗口。从托盘菜单 / 图标点击 / 单实例重复启动都会调到这里。
///
/// macOS / Windows：调 `move_window(TrayBottomCenter)` 把窗口贴到托盘
/// 旁边——`tauri-plugin-positioner` 的 `tray-icon` feature 已经把 tray
/// 矩形存进内部 state；窗口 `show` 之后 `move_window` 在坐标里能找到它。
///
/// Linux：避开 `Position::Tray*`（plugins-workspace#2927），调用者传入
/// `Position::BottomRight` —— 屏幕右下角，不依赖 tray 矩形。
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        position_window_for_platform(&window);
        restore_activation_policy(app);
    }
}

/// 按平台挑一个位置策略并应用。
fn position_window_for_platform<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "linux")]
    {
        // Linux:屏幕右下角,不调 Position::Tray*(plugins-workspace#2927)
        let _ = window.move_window(Position::BottomRight);
    }
    #[cfg(not(target_os = "linux"))]
    {
        // macOS / Windows:贴到托盘旁边
        let _ = window.move_window(Position::TrayBottomCenter);
    }
}

/// 隐藏主窗口。关窗拦截 + macOS 第一次隐藏时切到 `Accessory` 模式让
/// dock 图标也跟着消失,真正"最小化到菜单栏"。
pub fn hide_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    apply_minimize_activation_policy(app);
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> Result<Menu<R>> {
    let show = MenuItem::with_id(app, menu_id::SHOW, "显示主窗口", true, None::<&str>)
        .map_err(menu_error)?;
    let quit = MenuItem::with_id(app, menu_id::QUIT, "退出", true, None::<&str>)
        .map_err(menu_error)?;
    let separator = PredefinedMenuItem::separator(app).map_err(menu_error)?;

    Menu::with_items(app, &[&show, &separator, &quit]).map_err(menu_error)
}

fn menu_error(err: tauri::Error) -> AppError {
    AppError::internal(format!("构建托盘菜单失败：{err}"))
}

/// 托盘菜单事件分发。
fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        menu_id::SHOW => show_main_window(app),
        menu_id::QUIT => {
            // 显式退出——只有这条路径走得到 `exit`。
            // 其它路径（关窗、单实例重复启动、托盘菜单「显示」）都只是
            // 隐藏窗口。
            app.exit(0);
        }
        // 未知 id 忽略掉：未来加菜单项时不会因为拼写错让进程炸掉
        _ => {}
    }
}

/// 托盘图标事件。Linux 上 Click 事件不触发（`tauri/src/tray/mod.rs` 注
/// 释）,所以这里实际只服务 Windows / macOS 的左键唤回；Linux 走菜单
/// 「显示主窗口」+ [`spawn_linux_focus_poll`] 焦点轮询兜底。
fn handle_tray_event<R: Runtime>(
    tray: &tauri::tray::TrayIcon<R>,
    event: TrayIconEvent,
) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        show_main_window(tray.app_handle());
    }
}

/// Linux 焦点轮询兜底。
///
/// libappindicator 在 SNI 协议下没有 click 事件，但点击图标时焦点会
/// 短暂地转向托盘区域的某个窗口（取决于 DE）。每 500ms 轮询一次：
/// - 主窗口目前是隐藏的
/// - 系统焦点不在主窗口上（说明用户焦点在托盘）
///
/// 两个条件同时满足就认为「用户意图是唤回主窗口」,主动 `show` +
/// `set_focus` 一下。
///
/// `Enter` / `Leave` / `Move` 事件对 Linux 也不发——这条轮询就是 tauri
/// 没给信号时唯一能动的探针。**只 Linux 编译**,Windows / macOS 走 click
/// 事件主路径。
#[cfg(target_os = "linux")]
pub fn spawn_linux_focus_poll<R: Runtime>(app: &AppHandle<R>) {
    use tauri::async_runtime;

    let app = app.clone();
    async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(LINUX_FOCUS_POLL_INTERVAL);
        // 第一次 tick 立即触发,保证主窗口被关掉后能很快被唤回
        interval.tick().await;
        loop {
            interval.tick().await;
            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            // 不可见 = 不轮询；可见就跳过,避免重复唤回消耗焦点
            if !window.is_visible().unwrap_or(false) {
                // 主窗口当前隐藏,且系统焦点不在它上 → 唤回
                if !window.is_focused().unwrap_or(false) {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// macOS 专用：activation policy 切换
// ---------------------------------------------------------------------------

/// macOS：第一次隐藏主窗口时切到 `Accessory`,dock 图标消失,真正"最小化
/// 到菜单栏"。其他平台这一对调用是 no-op。
fn apply_minimize_activation_policy<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// macOS：唤回主窗口时切回 `Regular`,dock 图标重新出现。
fn restore_activation_policy<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 定位策略_按当前平台返回正确变体() {
        let resolved = TrayWindowPosition::for_current_platform();
        #[cfg(target_os = "linux")]
        assert_eq!(resolved, TrayWindowPosition::ScreenBottomRight);
        #[cfg(not(target_os = "linux"))]
        assert_eq!(resolved, TrayWindowPosition::TrayBottomCenter);
    }

    #[test]
    fn 菜单_id_是稳定字符串() {
        assert_eq!(menu_id::SHOW, "tray_show");
        assert_eq!(menu_id::QUIT, "tray_quit");
    }
}
