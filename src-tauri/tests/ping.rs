//! `ping` 命令的集成测试：走完整命令层（DTO 序列化 + 错误映射 + IPC 往返）。

mod support;

use kewutong_lib::clock::FixedClock;
use kewutong_lib::commands::diagnostics::{ping, PingReply};
use kewutong_lib::testing::{fresh_db, fresh_db_with_clock};
use std::sync::Arc;
use support::{invoke_request, mock_app, mock_app_with_webview};
use tauri::Manager;

#[test]
fn ping_直接调用返回_pong_与迁移版本() {
    let app = mock_app(fresh_db());

    let reply = ping(app.state(), None).expect("ping 应当成功");

    assert_eq!(reply.message, "pong");
    // 当前已应用的最高迁移版本。当前有 V001__initial.sql,所以是 Some(1)。
    // 新增 migration 后改这里。
    assert_eq!(reply.schema_version, Some(1));
    assert_eq!(reply.echo, None);
}

#[test]
fn ping_的_now_来自可注入的_clock() {
    let clock = Arc::new(FixedClock::at("2026-01-01 08:30:00"));
    let app = mock_app(fresh_db_with_clock(clock.clone()));

    let reply = ping(app.state(), None).expect("ping 应当成功");
    assert_eq!(reply.now, "2026-01-01 08:30:00");

    // 把"现在"拨到任意时刻，命令跟着走
    clock.set_at("2027-10-01 00:00:00");
    let reply = ping(app.state(), None).expect("ping 应当成功");
    assert_eq!(reply.now, "2027-10-01 00:00:00");
}

#[test]
fn ping_把_echo_原样带回() {
    let app = mock_app(fresh_db());

    let reply = ping(app.state(), Some("你好".into())).expect("ping 应当成功");

    assert_eq!(reply.echo.as_deref(), Some("你好"));
}

#[test]
fn ping_经_ipc_往返后_dto_是_camel_case() {
    let clock = Arc::new(FixedClock::at("2026-09-10 12:00:00"));
    let (_app, webview) = mock_app_with_webview(fresh_db_with_clock(clock));

    let body = tauri::test::get_ipc_response(
        &webview,
        invoke_request("ping", serde_json::json!({ "echo": "喂" })),
    )
    .expect("ping 应当成功");

    let raw: serde_json::Value = body.deserialize().expect("返回值应当是 JSON");
    assert_eq!(
        raw,
        serde_json::json!({
            "message": "pong",
            "now": "2026-09-10 12:00:00",
            "schemaVersion": 1,
            "echo": "喂",
        })
    );

    // 前端拿到的形状能反序列化回同一个 DTO
    let reply: PingReply = serde_json::from_value(raw).expect("DTO 应当能往返");
    assert_eq!(reply.echo.as_deref(), Some("喂"));
}

#[test]
fn 空白的_echo_被拒并映射成带中文消息的错误() {
    let (_app, webview) = mock_app_with_webview(fresh_db());

    let err = tauri::test::get_ipc_response(
        &webview,
        invoke_request("ping", serde_json::json!({ "echo": "   " })),
    )
    .expect_err("空白 echo 应当被拒");

    assert_eq!(err["code"], "INVALID_ARGUMENT");
    assert_eq!(err["message"], "回声内容不能为空。");
    assert!(err["detail"].is_null());
}
