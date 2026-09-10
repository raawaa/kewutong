//! 集成测试共用的 Tauri 测试脚手架。
//!
//! 数据库 fixture 在 `kewutong_lib::testing`（`fresh_db()` 等），这里只放需要
//! `tauri` 的 `test` feature 的部分——mock app / webview，供 IPC 往返断言使用。

use kewutong_lib::state::AppState;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

/// 建一个注入了 `state` 且注册了全部命令的 mock app。命令清单从 crate 里取，
/// 与正式入口是同一份。
pub fn mock_app(state: AppState) -> App<MockRuntime> {
    kewutong_lib::register_commands(mock_builder().manage(state))
        .build(mock_context(noop_assets()))
        .expect("mock app 应当能建起来")
}

/// 同 [`mock_app`]，另带一个可以走 IPC 的 webview。
#[allow(dead_code)] // 仅 ping 之类的需要走 IPC 往返的测试用
pub fn mock_app_with_webview(state: AppState) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = mock_app(state);
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview 应当能建起来");
    (app, webview)
}

/// 拼一条前端会发出的 IPC 请求。
#[allow(dead_code)] // 仅 ping 之类的需要走 IPC 往返的测试用
pub fn invoke_request(cmd: &str, body: serde_json::Value) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: tauri::ipc::InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    }
}
