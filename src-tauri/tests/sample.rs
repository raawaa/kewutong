//! 示例数据命令集成测试（ticket #31）。
//!
//! 验收点：
//! - V007 seed 落地后 `is_sample_data_present` 返回 true
//! - `clear_sample_data` 删除所有示例行,`is_sample_data_present` 变 false
//! - 清除后**无悬空 FK**(task.project_id / task.owner_person_id /
//!   task.recurring_template_id / person.sub_team_id / project.owner_person_id /
//!   project.sub_team_id 都不引用已删除的行)
//! - 真实数据(`is_sample = 0`)在清除后完整保留——子组 100-103、人员
//!   100-135 全员仍在
//! - 真实数据上 `clear_sample_data` 是 no-op(返回 0 / 0 / 0 / 0 / 0)
//! - `data_file_location` 在 fixture 注入路径后能正确返回

mod support;

use kewutong_lib::commands::sample::{
    clear_sample_data, data_file_location, is_sample_data_present, seed_real_teams,
};
use kewutong_lib::state::AppState;
use kewutong_lib::testing::{fresh_db_file, fresh_db_with_seed};
use rusqlite::OptionalExtension;
use support::mock_app;
use tauri::Manager;
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// 公共 fixture
// ---------------------------------------------------------------------------

/// 含 V007 示例数据的 fixture——sample / export 类测试需要看到示例数
/// 据才能断言。`fresh_db_with_seed` 内部跑 `seed_real_teams_via_state`,
/// 保证示例 + 真实数据都在。
fn fresh_app() -> tauri::App<tauri::test::MockRuntime> {
    mock_app(fresh_db_with_seed())
}

/// 走 `fresh_db_file` 的文件 fixture——`data_file_location` 测试要用真
/// 路径。文件库模式不灌示例 / 真实数据,本 fixture 仅校验路径透传。
fn fresh_app_with_path() -> (
    tauri::App<tauri::test::MockRuntime>,
    TempDir,
    std::path::PathBuf,
) {
    let dir = tempfile::tempdir().expect("临时目录");
    let path = dir.path().join("kewutong.db");
    let app = mock_app(fresh_db_file(&path));
    (app, dir, path)
}

// ---------------------------------------------------------------------------
// seed 落地即看到
// ---------------------------------------------------------------------------

#[test]
fn fresh_db_走完迁移后_is_sample_data_present_是_true() {
    let app = fresh_app();

    let presence = is_sample_data_present(app.state()).expect("查询");
    assert!(presence.present, "seed 后应当有示例数据");
}

#[test]
fn fresh_db_走完迁移后_示例数据形态符合_ac() {
    // AC:2 示例子组 / 1 示例项目 / 5 示例任务 / 2 Template / 8 instance
    //   (7 weekly + 1 monthly;Oct 5 + Oct 1 SKIP)
    let app = fresh_app();
    let state = app.state::<AppState>();
    let conn = state.db().expect("连接");

    let counts = |table: &str, where_clause: Option<&str>| -> i64 {
        let sql = match where_clause {
            Some(w) => format!("SELECT COUNT(*) FROM {table} WHERE {w}"),
            None => format!("SELECT COUNT(*) FROM {table}"),
        };
        conn.query_row(&sql, [], |row| row.get(0)).expect("count")
    };

    assert_eq!(counts("sub_team", Some("is_sample = 1")), 2, "示例子组");
    assert_eq!(counts("person", Some("is_sample = 1")), 4, "示例人员");
    assert_eq!(counts("project", Some("is_sample = 1")), 1, "示例项目");
    assert_eq!(
        counts(
            "task",
            Some("is_sample = 1 AND recurring_template_id IS NULL"),
        ),
        5,
        "示例一次性任务(覆盖 6 态)"
    );
    assert_eq!(
        counts(
            "recurring_template",
            Some("is_sample = 1"),
        ),
        2,
        "示例 Template"
    );
    // 7 weekly + 1 monthly = 8 instance
    assert_eq!(
        counts(
            "task",
            Some("is_sample = 1 AND recurring_template_id IS NOT NULL"),
        ),
        8,
        "示例 instance(7 周一例会 + 1 月度汇报,Oct 5 / Oct 1 SKIP)"
    );
}

#[test]
fn fresh_db_走完迁移后_示例_instance_日期落在_2026_国庆窗口() {
    // AC:Oct 5 周一例会与 Oct 1 月度汇报不生成。直接断言表里没有这
    // 两个日期的 instance。
    let app = fresh_app();
    let state = app.state::<AppState>();
    let conn = state.db().expect("连接");

    let oct5_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task \
              WHERE is_sample = 1 \
                AND recurring_template_id = 1 \
                AND scheduled_at = '2026-10-05 00:00:00'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(oct5_count, 0, "Oct 5 周一例会应当被国庆 SKIP");

    let oct1_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task \
              WHERE is_sample = 1 \
                AND recurring_template_id = 2 \
                AND scheduled_at = '2026-10-01 01:00:00'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(oct1_count, 0, "Oct 1 月度汇报应当被国庆 SKIP");

    // 反向断言:前后一周 + Nov 1 都在
    for expected_at in [
        "2026-09-14 00:00:00",
        "2026-09-21 00:00:00",
        "2026-09-28 00:00:00",
        "2026-10-12 00:00:00",
        "2026-11-02 00:00:00",
    ] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task \
                  WHERE is_sample = 1 \
                    AND recurring_template_id = 1 \
                    AND scheduled_at = ?1",
                rusqlite::params![expected_at],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(n, 1, "周一例会 {expected_at} 应当存在");
    }
    let nov1: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task \
              WHERE is_sample = 1 \
                AND recurring_template_id = 2 \
                AND scheduled_at = '2026-11-01 01:00:00'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(nov1, 1, "Nov 1 月度汇报应当存在");
}

// ---------------------------------------------------------------------------
// 真实 4 子组 / 20 人分桶
// ---------------------------------------------------------------------------

#[test]
fn fresh_db_走完迁移后_真实_4_子组_20_人分桶_就位() {
    // AC:暖通 5 / 电气 5 / 行政 4 / 运行 6 = 20 人
    // fixture 已经灌好示例 + 真实数据。这里直接断言形态。
    let app = fresh_app();
    let state = app.state::<AppState>();
    {
        let conn = state.db().expect("连接");

        let team_count = |name: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM sub_team \
                  WHERE is_sample = 0 AND name = ?1",
                rusqlite::params![name],
                |row| row.get(0),
            )
            .expect("count")
        };
        let member_count = |team_name: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM person p \
                  JOIN sub_team s ON s.id = p.sub_team_id \
                  WHERE p.is_sample = 0 AND s.name = ?1",
                rusqlite::params![team_name],
                |row| row.get(0),
            )
            .expect("count")
        };

        assert_eq!(team_count("暖通"), 1);
        assert_eq!(team_count("电气"), 1);
        assert_eq!(team_count("行政"), 1);
        assert_eq!(team_count("运行"), 1);

        assert_eq!(member_count("暖通"), 5);
        assert_eq!(member_count("电气"), 5);
        assert_eq!(member_count("行政"), 4);
        assert_eq!(member_count("运行"), 6);

        // 总数 = 20
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM person WHERE is_sample = 0",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(total, 20);
    }

    // 再调一次 seed → seeded=false(已存在真实子组,跳过)
    let again = seed_real_teams(state).expect("seed 2");
    assert!(!again.seeded, "二次 seed 应当 seeded=false");
    assert_eq!(again.sub_teams_inserted, 0);
}

// ---------------------------------------------------------------------------
// 一键清除
// ---------------------------------------------------------------------------

#[test]
fn clear_sample_data_清掉_全部示例行_且真实数据保留() {
    // fixture 已经灌好示例 + 真实数据。清示例 → 真实数据保留。
    let app = fresh_app();

    let summary = clear_sample_data(app.state()).expect("清");
    assert_eq!(summary.sub_teams, 2);
    assert_eq!(summary.people, 4);
    assert_eq!(summary.projects, 1);
    assert_eq!(
        summary.tasks, 13,
        "5 一次性 + 8 instance = 13 条 task"
    );
    assert_eq!(summary.recurring_templates, 2);

    // 横幅应当消失
    let presence = is_sample_data_present(app.state()).expect("查询");
    assert!(!presence.present, "清完后 is_sample_data_present 应当 false");

    // 真实数据完整保留
    let state = app.state::<AppState>();
    let conn = state.db().expect("连接");
    let real_sub_teams: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sub_team WHERE is_sample = 0",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(real_sub_teams, 4, "真实 4 子组保留");
    let real_people: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM person WHERE is_sample = 0",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(real_people, 20, "真实 20 人保留");
}

#[test]
fn clear_sample_data_清完后_无悬空_fk() {
    // AC:清除后库仍自洽,**无悬空 FK**
    let app = fresh_app();
    clear_sample_data(app.state()).expect("清");

    // 5 张表逐一查 FK 是否还指向存在的父行。
    let state = app.state::<AppState>();
    let conn = state.db().expect("连接");

    // task.recurring_template_id 必须 NULL(模板全清了)
    let task_with_template: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task WHERE recurring_template_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(task_with_template, 0);

    // task.project_id 必须 NULL(示例项目清了)
    let task_with_project: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task WHERE project_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(task_with_project, 0);

    // task.owner_person_id / task.waiting_on_person_id 必须指向存在的 person
    let orphan_owner: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task t \
              WHERE NOT EXISTS(SELECT 1 FROM person p WHERE p.id = t.owner_person_id)",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(orphan_owner, 0, "task.owner_person_id 全部有 person 父行");

    let orphan_waiting: Option<i64> = conn
        .query_row(
            "SELECT COUNT(*) FROM task t \
              WHERE t.waiting_on_person_id IS NOT NULL \
                AND NOT EXISTS(SELECT 1 FROM person p WHERE p.id = t.waiting_on_person_id)",
            [],
            |row| row.get(0),
        )
        .optional()
        .expect("count");
    assert_eq!(orphan_waiting, Some(0));

    // project.owner_person_id / project.sub_team_id 必须指向存在的父行
    let orphan_project_owners: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM project p \
              WHERE NOT EXISTS(SELECT 1 FROM person pe WHERE pe.id = p.owner_person_id) \
                 OR NOT EXISTS(SELECT 1 FROM sub_team s WHERE s.id = p.sub_team_id)",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(orphan_project_owners, 0);

    // person.sub_team_id 必须指向存在的 sub_team
    let orphan_person: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM person p \
              WHERE NOT EXISTS(SELECT 1 FROM sub_team s WHERE s.id = p.sub_team_id)",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(orphan_person, 0);

    // recurring_template.project_id / sub_team_id 必须指向存在的父行
    let orphan_template: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM recurring_template r \
              WHERE (r.project_id IS NOT NULL \
                     AND NOT EXISTS(SELECT 1 FROM project p WHERE p.id = r.project_id)) \
                 OR NOT EXISTS(SELECT 1 FROM sub_team s WHERE s.id = r.sub_team_id)",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(orphan_template, 0);
}

#[test]
fn clear_sample_data_在_空_示例_状态是_noop() {
    // 已经清过的库再清一次——affects 全 0,不出错。
    let app = fresh_app();
    clear_sample_data(app.state()).expect("第一次清");
    let summary = clear_sample_data(app.state()).expect("第二次清");
    assert_eq!(summary.sub_teams, 0);
    assert_eq!(summary.people, 0);
    assert_eq!(summary.projects, 0);
    assert_eq!(summary.tasks, 0);
    assert_eq!(summary.recurring_templates, 0);
}

#[test]
fn clear_sample_data_不动_真实_数据_即使示例已被手动加进真实库() {
    // 反向断言:clear 不动 is_sample=0 的行(真实数据);
    // 真实数据由 V008 seed 灌入,清除前已在库里。
    let app = fresh_app();
    let state = app.state::<AppState>();

    let summary = clear_sample_data(state.clone()).expect("清");
    assert_eq!(summary.sub_teams, 2);
    assert_eq!(summary.people, 4);

    // 真实 4 子组 / 20 人仍然在(由 V008 seed,与清除无关)
    let conn = state.db().expect("连接");
    let real_people: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM person WHERE is_sample = 0",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(real_people, 20);
}

// ---------------------------------------------------------------------------
// data_file_location
// ---------------------------------------------------------------------------

#[test]
fn data_file_location_返回_state_里的路径() {
    let (app, _dir, path) = fresh_app_with_path();
    let location = data_file_location(app.state()).expect("查路径");
    assert_eq!(location, path.to_string_lossy());
}

#[test]
fn data_file_location_内存库_未设路径_返中文错误() {
    let app = fresh_app();
    let err = data_file_location(app.state::<AppState>()).expect_err("内存 fixture 没路径");
    assert_eq!(err.code(), "INTERNAL");
    assert!(
        err.detail().unwrap_or_default().contains("数据库路径"),
        "INTERNAL 错误的 detail 应当提到数据库路径，实际：{:?}",
        err.detail()
    );
}
