//! 导出命令集成测试(ticket #31)。
//!
//! 验收点:
//! - 整库 JSON 导出可**回环导入** —— export → import 后数据等价
//! - 当前视图 CSV 导出表头正确,转义正确(含中文、逗号、引号、换行)
//!
//! 单元侧的 CSV 转义纯函数测试在 `commands/export.rs::tests`,本文件
//! 走端到端 `fresh_db()` 内存库 + mock_app。

mod support;

use kewutong_lib::commands::export::{
    export_database_json, export_tasks_csv, import_database_json,
};
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, CreatePersonArgs, CreateSubTeamArgs,
};
use kewutong_lib::commands::project::{create_project, CreateProjectArgs};
use kewutong_lib::commands::task::{
    create_task, set_task_status, CreateTaskArgs, SetTaskStatusArgs, TaskStatus,
};
use kewutong_lib::state::AppState;
use kewutong_lib::testing::{fresh_db, fresh_db_with_clock, fresh_db_with_seed};
use serde_json::Value;
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;

// ---------------------------------------------------------------------------
// 公共 fixture
// ---------------------------------------------------------------------------

fn fresh_app() -> tauri::App<tauri::test::MockRuntime> {
    mock_app(fresh_db())
}

fn fresh_app_with_clock(
    clock: Arc<kewutong_lib::clock::FixedClock>,
) -> tauri::App<tauri::test::MockRuntime> {
    mock_app(fresh_db_with_clock(clock))
}

// ---------------------------------------------------------------------------
// JSON 导出 / 导入 round-trip
// ---------------------------------------------------------------------------

#[test]
fn export_返回_json_文本_且_含_schema_version() {
    let app = fresh_app();
    let payload = export_database_json(app.state()).expect("export");
    assert_eq!(payload.schema_version, 8, "迁移号应当是 8");
    assert!(payload.byte_size > 0);
    let json: Value = serde_json::from_str(&payload.json_text).expect("合法 JSON");
    assert_eq!(json["schemaVersion"], 8);
    assert!(json["exportedAt"].is_string());
    assert!(json["tables"].is_object());
}

#[test]
fn export_seed_数据_后_各表行数正确() {
    // 用 `fresh_db_with_seed` fixture:V007 自动 seed 示例数据 +
    // fixture 显式 seed 真实 4 子组 / 20 人,导出后断言每张表至少 1 行。
    let app = mock_app(fresh_db_with_seed());
    let payload = export_database_json(app.state()).expect("export");
    let json: Value = serde_json::from_str(&payload.json_text).expect("JSON");
    let tables = json["tables"].as_object().expect("tables");

    for key in [
        "sub_team",
        "person",
        "project",
        "task",
        "recurring_template",
    ] {
        let arr = tables[key].as_array().expect("array");
        assert!(!arr.is_empty(), "{key} 应当至少 1 行");
    }
}

#[test]
fn round_trip_等价_种子库_导出再导入_行数一致() {
    // 在一个新库里 export → 解析 → 写到一个空的新库。两边行数一致。
    let app_a = fresh_app();
    let export = export_database_json(app_a.state()).expect("export");
    let json_a: Value = serde_json::from_str(&export.json_text).expect("JSON");

    // 第二个空库:用 fresh_db 跑完迁移,清掉所有示例行
    let app_b = fresh_app();
    let json_text = export.json_text.clone();
    {
        let state_ref = app_b.state::<AppState>();
        let conn = state_ref.db().expect("连接");
        conn.execute_batch(
            "DELETE FROM task WHERE is_sample = 1; \
             DELETE FROM recurring_template WHERE is_sample = 1; \
             DELETE FROM project WHERE is_sample = 1; \
             DELETE FROM person WHERE is_sample = 1; \
             DELETE FROM sub_team WHERE is_sample = 1;",
        )
        .expect("清示例");
    }
    import_database_json(app_b.state(), json_text).expect("import");

    // 重新导出 app_b,与 app_a 比对每张表的行数
    let export_b = export_database_json(app_b.state()).expect("re-export");
    let json_b: Value = serde_json::from_str(&export_b.json_text).expect("JSON");

    for key in [
        "sub_team",
        "person",
        "project",
        "task",
        "recurring_template",
        "notification_log",
    ] {
        let arr_a = json_a["tables"][key].as_array().expect("a");
        let arr_b = json_b["tables"][key].as_array().expect("b");
        assert_eq!(
            arr_a.len(),
            arr_b.len(),
            "{key} 行数不一致:a={} b={}",
            arr_a.len(),
            arr_b.len()
        );
    }
}

#[test]
fn round_trip_关键字段_不变_等式() {
    // 不仅是行数——关键字段值也应当一致。
    let app = fresh_app();
    let export = export_database_json(app.state()).expect("export");

    let app2 = fresh_app();
    let json_text = export.json_text.clone();
    {
        let state_ref = app2.state::<AppState>();
        let conn = state_ref.db().expect("连接");
        conn.execute_batch(
            "DELETE FROM task WHERE is_sample = 1; \
             DELETE FROM recurring_template WHERE is_sample = 1; \
             DELETE FROM project WHERE is_sample = 1; \
             DELETE FROM person WHERE is_sample = 1; \
             DELETE FROM sub_team WHERE is_sample = 1;",
        )
        .expect("清示例");
    }
    import_database_json(app2.state(), json_text).expect("import");

    // 重新导出 app2,关键字段对比
    let export2 = export_database_json(app2.state()).expect("re-export");
    let a: Value = serde_json::from_str(&export.json_text).unwrap();
    let b: Value = serde_json::from_str(&export2.json_text).unwrap();

    // sub_team.name / project.name / task.title /
    // recurring_template.name —— 这些 string 字段全部一致
    for (key, fields) in [
        ("sub_team", vec!["name", "sort_order"]),
        ("person", vec!["name", "sub_team_id"]),
        ("project", vec!["name", "owner_person_id"]),
        (
            "recurring_template",
            vec!["name", "freq", "byday_mask", "holiday_behavior"],
        ),
    ] {
        let arr_a = a["tables"][key].as_array().unwrap();
        let arr_b = b["tables"][key].as_array().unwrap();
        for (ra, rb) in arr_a.iter().zip(arr_b.iter()) {
            for f in &fields {
                assert_eq!(ra[f], rb[f], "{key}.{f} 不一致: a={} b={}", ra[f], rb[f]);
            }
        }
    }

    // task 的 status / due_date / scheduled_at 在所有 task 上对齐
    let tasks_a = a["tables"]["task"].as_array().unwrap();
    let tasks_b = b["tables"]["task"].as_array().unwrap();
    for (ta, tb) in tasks_a.iter().zip(tasks_b.iter()) {
        for f in ["status", "due_date", "scheduled_at", "title"] {
            assert_eq!(ta[f], tb[f], "task.{f} 不一致");
        }
    }
}

#[test]
fn import_跨_schema_version_被拒_给中文提示() {
    // 构造一个 schemaVersion=999 的假 JSON,导入应被拒。
    let app = fresh_app();
    let fake = serde_json::json!({
        "schemaVersion": 999,
        "exportedAt": "2026-09-10T00:00:00Z",
        "tables": {}
    })
    .to_string();
    let err = import_database_json(app.state(), fake).expect_err("跨版本应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("版本"));
}

#[test]
fn import_缺_schema_version_被拒() {
    let app = fresh_app();
    let bad = serde_json::json!({
        "exportedAt": "2026-09-10T00:00:00Z",
        "tables": {}
    })
    .to_string();
    let err = import_database_json(app.state(), bad).expect_err("应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("schemaVersion"));
}

#[test]
fn import_非法_json_被拒() {
    let app = fresh_app();
    let err = import_database_json(app.state(), "{not-json".into())
        .expect_err("非 JSON 应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("解析失败"));
}

#[test]
fn import_后_无悬空_fk() {
    // import 也要保证库自洽——AC「导入后能用」
    let app = fresh_app();
    let export = export_database_json(app.state()).expect("export");
    let app2 = fresh_app();
    let json_text = export.json_text;
    {
        let state_ref = app2.state::<AppState>();
        let conn = state_ref.db().expect("连接");
        conn.execute_batch(
            "DELETE FROM task WHERE is_sample = 1; \
             DELETE FROM recurring_template WHERE is_sample = 1; \
             DELETE FROM project WHERE is_sample = 1; \
             DELETE FROM person WHERE is_sample = 1; \
             DELETE FROM sub_team WHERE is_sample = 1;",
        )
        .expect("清示例");
    }
    import_database_json(app2.state(), json_text).expect("import");

    let state_ref = app2.state::<AppState>();
    let conn = state_ref.db().expect("连接");
    let orphan: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task t \
              WHERE NOT EXISTS(SELECT 1 FROM person p WHERE p.id = t.owner_person_id) \
                 OR (t.project_id IS NOT NULL \
                     AND NOT EXISTS(SELECT 1 FROM project pr WHERE pr.id = t.project_id)) \
                 OR (t.recurring_template_id IS NOT NULL \
                     AND NOT EXISTS(SELECT 1 FROM recurring_template r WHERE r.id = t.recurring_template_id))",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(orphan, 0, "import 后 task 仍引用不存在的父行");
}

// ---------------------------------------------------------------------------
// CSV 导出
// ---------------------------------------------------------------------------

#[test]
fn csv_表头_列名_与设计一致() {
    let app = fresh_app();
    let payload = export_tasks_csv(app.state()).expect("csv");
    let first_line = payload.csv_text.lines().next().expect("至少表头");
    // CRLF 行尾 → 末字符是 \r;取到逗号分隔
    let cols: Vec<&str> = first_line.trim_end_matches('\r').split(',').collect();
    assert_eq!(
        cols,
        vec![
            "id",
            "title",
            "status",
            "owner",
            "sub_team",
            "project",
            "due_date",
            "scheduled_at",
            "is_recurring",
            "blocked_at",
            "blocked_reason",
            "waiting_on",
            "created_at",
        ]
    );
}

#[test]
fn csv_默认排除_done_和_cancelled() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let app = fresh_app_with_clock(clock);

    // 清掉 seed 的示例任务——本测试只关心 open / done / cancelled 三
    // 条新增任务的可见性。
    {
        let state_ref = app.state::<AppState>();
        let conn = state_ref.db().expect("连接");
        conn.execute_batch(
            "DELETE FROM task WHERE is_sample = 1; \
             DELETE FROM recurring_template WHERE is_sample = 1; \
             DELETE FROM project WHERE is_sample = 1; \
             DELETE FROM person WHERE is_sample = 1; \
             DELETE FROM sub_team WHERE is_sample = 1;",
        )
        .expect("清示例");
    }

    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "测试组".into(),
            description: None,
        },
    )
    .expect("组");
    let owner = create_person(
        app.state(),
        CreatePersonArgs {
            name: "测试人".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("人");

    // 三条任务:open / done / cancelled
    let _open = create_task(
        app.state(),
        CreateTaskArgs {
            title: "在飞".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-20".into()),
        },
    )
    .expect("建");
    let done = create_task(
        app.state(),
        CreateTaskArgs {
            title: "完事".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-21".into()),
        },
    )
    .expect("建");
    let cancelled = create_task(
        app.state(),
        CreateTaskArgs {
            title: "撤了".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-22".into()),
        },
    )
    .expect("建");

    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: done.id,
            status: TaskStatus::Done,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("完");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: cancelled.id,
            status: TaskStatus::Cancelled,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("撤");

    let payload = export_tasks_csv(app.state()).expect("csv");
    // 1 表头 + 1 数据行(只 open)
    let line_count = payload.csv_text.lines().count();
    assert_eq!(line_count, 2, "应当只有表头 + 1 条 in-flight");
    assert!(payload.csv_text.contains("在飞"));
    assert!(!payload.csv_text.contains("完事"));
    assert!(!payload.csv_text.contains("撤了"));
}

#[test]
fn csv_中文_逗号_引号_换行_全部正确转义() {
    // 准备一条"标题含逗号 / 子组名含逗号 / 人员名含引号 / 项目名含换行"
    // 的任务,确认 CSV 行字段全部按 RFC 4180 转义。
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let app = fresh_app_with_clock(clock);

    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通,示例组".into(), // 子组名含逗号 → CSV 要加引号
            description: None,
        },
    )
    .expect("组");
    let owner = create_person(
        app.state(),
        CreatePersonArgs {
            name: "张三 \"组长\"".into(), // 含引号
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("人");
    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "项目\n跨行".into(), // 含换行
            owner_person_id: owner.id,
            sub_team_id: team.id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("项目");

    let _task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "标题,含逗号".into(), // 含逗号
            description: Some("描述含 \"引号\"".into()),
            owner_person_id: owner.id,
            project_id: Some(project.id),
            due_date: Some("2026-09-20".into()),
        },
    )
    .expect("建");

    let payload = export_tasks_csv(app.state()).expect("csv");
    let text = &payload.csv_text;

    // 子组字段加引号:"暖通,示例组" → 整字段加引号
    assert!(
        text.contains("\"暖通,示例组\""),
        "子组字段含逗号应加引号,实际: {text}"
    );
    // 人员字段含引号:"张三 ""组长"""
    assert!(
        text.contains("\"张三 \"\"组长\"\"\""),
        "人员字段引号应双倍转义,实际: {text}"
    );
    // 项目字段含换行:必须包在引号里,内部 \n 保留
    assert!(
        text.contains("\"项目\n跨行\""),
        "项目字段含换行应加引号,实际: {text}"
    );
    // 标题含逗号
    assert!(
        text.contains("\"标题,含逗号\""),
        "标题含逗号应加引号,实际: {text}"
    );
}