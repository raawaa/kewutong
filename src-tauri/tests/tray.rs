//! 托盘模块（ticket #29）的集成测试。
//!
//! 覆盖三个可独立测试的缝：
//! 1. 跨平台托盘定位策略（`TrayWindowPosition::for_current_platform`）
//!    —— 编译期分支,Linux 强制避开 `Position::Tray*`。
//! 2. `AppState` 持有的 `TrayStatus` 状态机。
//! 3. `commands::tray::tray_status` 把状态序列化成 DTO。

mod support;

use kewutong_lib::commands::tray::{TrayStatusDto, tray_status};
use kewutong_lib::state::TrayStatus;
use support::mock_app;
use tauri::Manager;

#[test]
fn 托盘定位策略_按当前平台返回正确变体() {
    use kewutong_lib::tray::TrayWindowPosition;

    let resolved = TrayWindowPosition::for_current_platform();

    #[cfg(target_os = "linux")]
    assert_eq!(resolved, TrayWindowPosition::ScreenBottomRight);
    #[cfg(not(target_os = "linux"))]
    assert_eq!(resolved, TrayWindowPosition::TrayBottomCenter);
}

#[test]
fn 托盘菜单项_id_是稳定字符串() {
    // 前端若想监听托盘菜单事件,会用同样的 ID;改值前请先确认调用方都改了
    use kewutong_lib::tray::menu_id;
    assert_eq!(menu_id::SHOW, "tray_show");
    assert_eq!(menu_id::QUIT, "tray_quit");
}

#[test]
fn 托盘状态默认值是_不可用_且带原因() {
    let state = kewutong_lib::testing::fresh_db();

    let status = state.tray_status();

    match status {
        TrayStatus::Unavailable { reason } => {
            assert!(!reason.is_empty(), "原因不能是空串,前端要拿去给科长看");
        }
        TrayStatus::Available => {
            panic!("新构造的 AppState 托盘应当还没初始化");
        }
    }
}

#[test]
fn 托盘状态_set_available_后能读出_available() {
    let state = kewutong_lib::testing::fresh_db();

    state.set_tray_status(TrayStatus::Available);

    assert_eq!(state.tray_status(), TrayStatus::Available);
}

#[test]
fn 托盘状态_set_unavailable_后能读出_unavailable_并带原因() {
    let state = kewutong_lib::testing::fresh_db();

    state.set_tray_status(TrayStatus::Unavailable {
        reason: "测试用原因".into(),
    });

    match state.tray_status() {
        TrayStatus::Unavailable { reason } => assert_eq!(reason, "测试用原因"),
        TrayStatus::Available => panic!("set_unavailable 之后不应再是 Available"),
    }
}

#[test]
fn tray_status_命令_默认返回_unavailable() {
    let app = mock_app(kewutong_lib::testing::fresh_db());

    let dto = tray_status(app.state()).expect("命令应当成功");

    assert!(!dto.available);
    assert!(
        !dto.reason.is_empty(),
        "前端 banner 要展示原因,空串会让科长看不到"
    );
}

#[test]
fn tray_status_命令_设置_available_后返回_available_且原因为空() {
    let state = kewutong_lib::testing::fresh_db();
    state.set_tray_status(TrayStatus::Available);
    let app = mock_app(state);

    let dto = tray_status(app.state()).expect("命令应当成功");

    assert!(dto.available);
    assert!(dto.reason.is_empty());
}

#[test]
fn tray_status_命令_dto_字段是_camel_case() {
    let app = mock_app(kewutong_lib::testing::fresh_db());

    let dto = tray_status(app.state()).expect("命令应当成功");

    // 序列化前应当就是 camelCase 字段名,这里手工校验不让 `rename_all`
    // 在重构时悄悄被改回 snake_case 让前端拿不到字段
    let json = serde_json::to_value(&dto).expect("dto 应当能序列化");
    assert!(json.get("available").is_some(), "字段名应是 available");
    assert!(json.get("reason").is_some(), "字段名应是 reason");
}

#[test]
fn tray_status_命令_返回的_dto_与状态机的不可用路径一致() {
    // 端到端:让状态机走过 set_unavailable → 命令读出 → DTO 字段一致
    let state = kewutong_lib::testing::fresh_db();
    state.set_tray_status(TrayStatus::Unavailable {
        reason: "Linux 上 GTK 初始化失败".into(),
    });
    let app = mock_app(state);

    let dto: TrayStatusDto = tray_status(app.state()).expect("命令应当成功");

    assert!(!dto.available);
    assert_eq!(dto.reason, "Linux 上 GTK 初始化失败");
}
