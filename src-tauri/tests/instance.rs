//! 实例动作集成测试（ticket #26「实例动作与改期溯源」）。
//!
//! 验收点：
//! - 单实例可标记 Done / Cancelled，不影响同 Template 的其它实例
//! - 跳过（手动 Skip）= status='Cancelled'；UI 标签"已跳过"由前端判定
//! - 改期：原 instance → Cancelled + 新 instance → Open，
//!   `rescheduled_from_id` 指向原，`original_scheduled_at` 保留模板原定时间
//! - 改期**不**触碰 `recurring_template` 表的任何字段
//! - 手工改期与 SHIFT 路径产出的数据形状一致（同 INSERT 体）
//! - 改期链回溯：从一条 instance 沿 `rescheduled_from_id` 一路回溯到最初日期
//! - 出差场景：可整体改 Template 的 `iana_zone`，也可单独覆盖 instance 的 `scheduled_at`
//!
//! 端到端走 mock_app + fresh_db，与 #25 同一套脚手架。

mod support;

use kewutong_lib::commands::instance::{
    instance_reschedule_chain, override_instance_scheduled_at, reschedule_instance,
    update_recurring_template_zone, InstanceIdArgs, OverrideInstanceScheduledAtArgs,
    RescheduleInstanceArgs, UpdateTemplateZoneArgs,
};
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, CreatePersonArgs, CreateSubTeamArgs,
};
use kewutong_lib::commands::recurring_template::{
    upsert_recurring_template, UpsertRecurringTemplateArgs,
};
use kewutong_lib::materialization::materialize_from_state;
use kewutong_lib::recurring::{byday, EndsSpec, Freq, HolidayBehavior, StructuredRule};
use kewutong_lib::state::AppState;
use std::sync::Arc;
use support::mock_app;
use tauri::{Manager, State};
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// 公共 fixture
// ---------------------------------------------------------------------------

fn weekly_rule() -> StructuredRule {
    StructuredRule {
        freq: Freq::Weekly,
        byday_mask: byday::MO,
        bymonthday: None,
        bymonth: None,
        byhour: 8,
        byminute: 0,
        iana_zone: "Asia/Shanghai".into(),
        ends: EndsSpec::On { date: "2026-12-31".into() },
        holiday_behavior: HolidayBehavior::Skip,
    }
}

fn monthly_day1_rule(behavior: HolidayBehavior) -> StructuredRule {
    StructuredRule {
        freq: Freq::Monthly,
        byday_mask: 0,
        bymonthday: Some(vec![1]),
        bymonth: None,
        byhour: 9,
        byminute: 0,
        iana_zone: "Asia/Shanghai".into(),
        ends: EndsSpec::On { date: "2026-12-31".into() },
        holiday_behavior: behavior,
    }
}

struct AppFixture {
    app: tauri::App<tauri::test::MockRuntime>,
    sub_team_id: i64,
    template_id: i64,
    _dir: TempDir,
}

fn fresh_fixture_with_team_and_template(
    clock: Arc<kewutong_lib::clock::FixedClock>,
    rule: StructuredRule,
    template_name: &str,
) -> AppFixture {
    fresh_fixture_with_team_and_template_inner(clock, rule, template_name, false)
}

/// 同 [`fresh_fixture_with_team_and_template`],但额外把 cn-2026.json 写进
/// 临时目录,让 SHIFT 路径能命中 10/1 国庆节等种子节日。
fn fresh_fixture_with_holidays(
    clock: Arc<kewutong_lib::clock::FixedClock>,
    rule: StructuredRule,
    template_name: &str,
) -> AppFixture {
    fresh_fixture_with_team_and_template_inner(clock, rule, template_name, true)
}

fn fresh_fixture_with_team_and_template_inner(
    clock: Arc<kewutong_lib::clock::FixedClock>,
    rule: StructuredRule,
    template_name: &str,
    with_seed_holidays: bool,
) -> AppFixture {
    let dir = tempfile::tempdir().expect("临时目录");
    let seed_dir = dir.path().to_path_buf();
    if with_seed_holidays {
        std::fs::write(
            seed_dir.join("cn-2026.json"),
            r#"{
              "holidays": [
                { "start": "2026-02-15", "end": "2026-02-23", "name": "春节" },
                { "start": "2026-10-01", "end": "2026-10-07", "name": "国庆节" }
              ],
              "workdays": [
                { "start": "2026-02-14", "end": "2026-02-14", "name": "春节" },
                { "start": "2026-10-10", "end": "2026-10-10", "name": "国庆节" }
              ]
            }"#,
        )
        .expect("写 2026");
        std::fs::write(
            seed_dir.join("cn-2027.json"),
            r#"{ "holidays": [], "workdays": [] }"#,
        )
        .expect("写 2027");
    }
    let conn = kewutong_lib::db::open_in_memory().expect("内存库");
    let cal = kewutong_lib::holiday::HolidayCalendar::load(&seed_dir, 2026, &conn).expect("加载");
    let state = kewutong_lib::testing::fresh_db_with_clock(clock);
    state.install_calendar(cal);
    let app = mock_app(state);
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通".into(),
            description: None,
        },
    )
    .expect("建组");
    create_person(
        app.state(),
        CreatePersonArgs {
            name: "张三".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");
    let template = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: template_name.into(),
            rule,
            project_id: None,
            sub_team_id: Some(team.id),
            notes: None,
        },
    )
    .expect("建模板");
    AppFixture {
        app,
        sub_team_id: team.id,
        template_id: template.id,
        _dir: dir,
    }
}

/// 一行 SELECT 的形状。
type InstanceRow = (
    i64,              // id
    String,           // status
    String,           // scheduled_at
    Option<String>,   // original_scheduled_at
    Option<i64>,      // rescheduled_from_id
    Option<i64>,      // recurring_template_id
);

/// 用闭包访问 DB connection——确保 MutexGuard 闭包结束就 drop,
/// 不会拖到下一次命令调用引发锁竞争死锁。
fn with_conn<F, R>(state: &State<'_, AppState>, f: F) -> R
where
    F: FnOnce(&rusqlite::Connection) -> R,
{
    let conn = state.db().expect("拿连接");
    f(&conn)
}

fn select_instance(
    conn: &rusqlite::Connection,
    template_id: i64,
    scheduled_at: &str,
) -> InstanceRow {
    conn.query_row(
        "SELECT id, status, scheduled_at, original_scheduled_at, rescheduled_from_id, recurring_template_id
           FROM task
          WHERE recurring_template_id = ?1 AND scheduled_at = ?2",
        rusqlite::params![template_id, scheduled_at],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        },
    )
    .expect("查 instance")
}

fn select_all_instances(conn: &rusqlite::Connection, template_id: i64) -> Vec<InstanceRow> {
    let mut stmt = conn
        .prepare(
            "SELECT id, status, scheduled_at, original_scheduled_at, rescheduled_from_id, recurring_template_id
               FROM task
              WHERE recurring_template_id = ?1
              ORDER BY scheduled_at, id",
        )
        .expect("prepare");
    stmt.query_map(rusqlite::params![template_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, Option<i64>>(5)?,
        ))
    })
    .expect("query")
    .filter_map(Result::ok)
    .collect()
}

// ---------------------------------------------------------------------------
// 单实例可独立标记 Done / Cancelled：互不影响
// ---------------------------------------------------------------------------

#[test]
fn mark_instance_done_不影响同_template_其它_instance() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    // 拿到 9/14 周一那条 instance
    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    // 标 Done（state 由 tauri 再次借走，与 conn guard 不冲突——闭包结束 conn 已 drop）
    kewutong_lib::commands::task::set_task_status(
        fx.app.state(),
        kewutong_lib::commands::task::SetTaskStatusArgs {
            task_id: inst_id,
            status: kewutong_lib::commands::task::TaskStatus::Done,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("标 Done");

    // 9/14 已 Done,9/21 仍 Open
    with_conn(&state, |conn| {
        let updated = select_instance(conn, fx.template_id, "2026-09-14 00:00:00");
        assert_eq!(updated.1, "Done");
        let other = select_instance(conn, fx.template_id, "2026-09-21 00:00:00");
        assert_eq!(other.1, "Open", "同模板的下一条 instance 不应被波及");
    });
}

#[test]
fn skip_instance_设_cancelled_ui_端据此判定_已跳过() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    kewutong_lib::commands::task::set_task_status(
        fx.app.state(),
        kewutong_lib::commands::task::SetTaskStatusArgs {
            task_id: inst_id,
            status: kewutong_lib::commands::task::TaskStatus::Cancelled,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("标 Cancelled");

    with_conn(&state, |conn| {
        let updated = select_instance(conn, fx.template_id, "2026-09-14 00:00:00");
        assert_eq!(updated.1, "Cancelled");
        assert!(
            updated.5.is_some(),
            "recurring_template_id 仍非空,前端据此显示「已跳过」"
        );
        let other = select_instance(conn, fx.template_id, "2026-09-21 00:00:00");
        assert_eq!(other.1, "Open");
    });
}

// ---------------------------------------------------------------------------
// 改期：原 instance Cancelled + 新 instance Open + rescheduled_from_id
// ---------------------------------------------------------------------------

#[test]
fn reschedule_instance_原_cancelled_新_open_rescheduled_from_指向原() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let (inst_id, original_scheduled_at) = with_conn(&state, |conn| {
        let row = select_instance(conn, fx.template_id, "2026-09-14 00:00:00");
        assert_eq!(row.1, "Open");
        (row.0, row.2.clone())
    });

    // 把 9/14 周一例会改到 9/16 周三（UTC 00:00）
    let new = reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: inst_id,
            new_scheduled_at: "2026-09-16 00:00:00".into(),
        },
    )
    .expect("改期");

    assert_eq!(new.scheduled_at.as_deref(), Some("2026-09-16 00:00:00"));
    assert_eq!(new.status, kewutong_lib::commands::task::TaskStatus::Open);
    assert!(new.recurring_template_id.is_some());

    with_conn(&state, |conn| {
        let orig = select_instance(conn, fx.template_id, "2026-09-14 00:00:00");
        assert_eq!(orig.1, "Cancelled");
        assert_eq!(orig.2, "2026-09-14 00:00:00");
        assert_eq!(orig.3.as_deref(), Some(original_scheduled_at.as_str()));
        assert!(orig.4.is_none(), "Cancelled row 自己不指向任何上游");

        let moved = select_instance(conn, fx.template_id, "2026-09-16 00:00:00");
        assert_eq!(moved.1, "Open");
        assert_eq!(moved.2, "2026-09-16 00:00:00");
        assert_eq!(
            moved.3.as_deref(),
            Some(original_scheduled_at.as_str()),
            "新 instance 的 original_scheduled_at 保留模板原定时间(9/14 UTC)"
        );
        assert_eq!(moved.4, Some(inst_id), "新 instance rescheduled_from_id 指向原 Cancelled");
    });
}

#[test]
fn reschedule_instance_不动_recurring_template_任何字段() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    // 抓模板改期前的全部字段——覆盖 spec AC #4「任何规则字段」。
    let before = with_conn(&state, |conn| {
        conn.query_row(
            "SELECT name, freq, byday_mask, bymonthday, bymonth, byhour, byminute,
                    iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text,
                    project_id, sub_team_id, enabled, notes, created_at
               FROM recurring_template WHERE id = ?1",
            rusqlite::params![fx.template_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                    row.get::<_, i64>(14)?,
                    row.get::<_, Option<String>>(15)?,
                    row.get::<_, String>(16)?,
                ))
            },
        )
        .map(|t| {
            // 大元组没有 Debug,转 Vec<String> 便于 assert_eq 报错。
            vec![
                format!("{:?}", t.0),
                format!("{:?}", t.1),
                t.2.to_string(),
                format!("{:?}", t.3),
                format!("{:?}", t.4),
                t.5.to_string(),
                t.6.to_string(),
                t.7.clone(),
                format!("{:?}", t.8),
                format!("{:?}", t.9),
                t.10.clone(),
                t.11.clone(),
                format!("{:?}", t.12),
                format!("{:?}", t.13),
                t.14.to_string(),
                format!("{:?}", t.15),
                t.16.clone(),
            ]
        })
        .expect("查模板")
    });

    reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: inst_id,
            new_scheduled_at: "2026-09-16 00:00:00".into(),
        },
    )
    .expect("改期");

    let after = with_conn(&state, |conn| {
        conn.query_row(
            "SELECT name, freq, byday_mask, bymonthday, bymonth, byhour, byminute,
                    iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text,
                    project_id, sub_team_id, enabled, notes, created_at
               FROM recurring_template WHERE id = ?1",
            rusqlite::params![fx.template_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                    row.get::<_, i64>(14)?,
                    row.get::<_, Option<String>>(15)?,
                    row.get::<_, String>(16)?,
                ))
            },
        )
        .map(|t| {
            vec![
                format!("{:?}", t.0),
                format!("{:?}", t.1),
                t.2.to_string(),
                format!("{:?}", t.3),
                format!("{:?}", t.4),
                t.5.to_string(),
                t.6.to_string(),
                t.7.clone(),
                format!("{:?}", t.8),
                format!("{:?}", t.9),
                t.10.clone(),
                t.11.clone(),
                format!("{:?}", t.12),
                format!("{:?}", t.13),
                t.14.to_string(),
                format!("{:?}", t.15),
                t.16.clone(),
            ]
        })
        .expect("查模板")
    });

    assert_eq!(
        before, after,
        "改期 instance 不得动 recurring_template 的任何字段"
    );
}

#[test]
fn reschedule_instance_已是_cancelled_被拒() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    kewutong_lib::commands::task::set_task_status(
        fx.app.state(),
        kewutong_lib::commands::task::SetTaskStatusArgs {
            task_id: inst_id,
            status: kewutong_lib::commands::task::TaskStatus::Cancelled,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("标 Cancelled");

    let err = reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: inst_id,
            new_scheduled_at: "2026-09-16 00:00:00".into(),
        },
    )
    .expect_err("已 Cancelled 的 instance 不能再改期");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("已取消") || err.message().contains("Cancelled"));
}

#[test]
fn reschedule_instance_非_instance_被拒() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();

    let once = kewutong_lib::commands::task::create_task(
        fx.app.state(),
        kewutong_lib::commands::task::CreateTaskArgs {
            title: "一次性".into(),
            description: None,
            owner_person_id: 1,
            project_id: None,
            due_date: Some("2026-09-15".into()),
        },
    )
    .expect("建一次性");

    let err = reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: once.id,
            new_scheduled_at: "2026-09-16 00:00:00".into(),
        },
    )
    .expect_err("一次性 task 不能改期");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("实例") || err.message().contains("instance"));
}

#[test]
fn reschedule_instance_目标时间与现有_instance_冲突被拒() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    let err = reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: inst_id,
            new_scheduled_at: "2026-09-21 00:00:00".into(),
        },
    )
    .expect_err("目标时间已被占用");
    // 命令层先一步给中文消息,DB 唯一索引兜底——验收点是"被拒",
    // 错误码不强求(INVALID_ARGUMENT 是更友好的 UX)。
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("占用") || err.message().contains("冲突"));
}

#[test]
fn reschedule_instance_无效时间戳格式被拒() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    let err = reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: inst_id,
            new_scheduled_at: "not-a-timestamp".into(),
        },
    )
    .expect_err("格式不对");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("时间"));
}

#[test]
fn reschedule_instance_同_template_其它_instance_不动() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: inst_id,
            new_scheduled_at: "2026-09-16 00:00:00".into(),
        },
    )
    .expect("改期");

    with_conn(&state, |conn| {
        let sep21 = select_instance(conn, fx.template_id, "2026-09-21 00:00:00");
        assert_eq!(sep21.1, "Open");
        assert!(sep21.4.is_none());
        let sep28 = select_instance(conn, fx.template_id, "2026-09-28 00:00:00");
        assert_eq!(sep28.1, "Open");
    });
}

// ---------------------------------------------------------------------------
// 手工改期与 SHIFT 路径产出的数据形状一致（同 INSERT 体）
// ---------------------------------------------------------------------------

#[test]
fn manual_reschedule_与_shift_路径_产出的列集合与语义一致() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-28 09:00:00"));

    // ---- SHIFT 路径 ----
    let fx_shift = fresh_fixture_with_holidays(
        clock.clone(),
        monthly_day1_rule(HolidayBehavior::Shift),
        "月报 SHIFT",
    );
    let shift_all: Vec<InstanceRow> = {
        let state = fx_shift.app.state::<AppState>();
        materialize_from_state(state.inner()).expect("物化 SHIFT");
        with_conn(&state, |conn| select_all_instances(conn, fx_shift.template_id))
    };
    assert_eq!(
        shift_all.len(),
        5,
        "SHIFT 应产出 5 条:2 cancelled+2 shifted+1 kept(12月)"
    );
    let shift_cancelled = shift_all
        .iter()
        .find(|r| r.1 == "Cancelled" && r.2 == "2026-10-01 01:00:00")
        .expect("10/1 cancelled");
    let shift_new = shift_all
        .iter()
        .find(|r| r.1 == "Open" && r.2 == "2026-10-08 01:00:00")
        .expect("10/8 open");
    assert_eq!(
        shift_new.4,
        Some(shift_cancelled.0),
        "新 instance rescheduled_from_id = cancelled.id"
    );
    assert_eq!(
        shift_new.3, shift_cancelled.3,
        "新 instance original_scheduled_at = cancelled.original_scheduled_at"
    );
    assert_eq!(shift_cancelled.5, Some(fx_shift.template_id));
    assert_eq!(shift_new.5, Some(fx_shift.template_id));

    // ---- 手工改期路径 ----
    // 用独立的 09/10 时钟,以便 9/14 这条 instance 落在 12 周窗口里。
    let clock_manual = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx_manual = fresh_fixture_with_team_and_template(clock_manual, weekly_rule(), "周一例会");
    {
        let state = fx_manual.app.state::<AppState>();
        materialize_from_state(state.inner()).expect("物化 手工");
        let inst_id = with_conn(&state, |conn| {
            select_instance(conn, fx_manual.template_id, "2026-09-14 00:00:00").0
        });
        reschedule_instance(
            fx_manual.app.state(),
            RescheduleInstanceArgs {
                task_id: inst_id,
                new_scheduled_at: "2026-09-16 00:00:00".into(),
            },
        )
        .expect("改期");
        let manual_all =
            with_conn(&state, |conn| select_all_instances(conn, fx_manual.template_id));
        let manual_cancelled = manual_all
            .iter()
            .find(|r| r.1 == "Cancelled" && r.2 == "2026-09-14 00:00:00")
            .expect("9/14 cancelled");
        let manual_new = manual_all
            .iter()
            .find(|r| r.1 == "Open" && r.2 == "2026-09-16 00:00:00")
            .expect("9/16 open");
        assert_eq!(manual_new.4, Some(manual_cancelled.0));
        assert_eq!(manual_new.3, manual_cancelled.3);

        // ---- 关键不变量对比 ----
        // 两条路径产出的 cancelled / new 行各自比对——SHIFT 与 manual 在
        // 不同日期,所以**绝对值**(具体 UTC 字符串)不同,**模式**(cancelled
        // 的 original_scheduled_at = new 的 original_scheduled_at)相同。
        let check_pair = |cancelled: &InstanceRow, new: &InstanceRow, label: &str| {
            assert_eq!(cancelled.1, "Cancelled", "{label} cancelled.status");
            assert!(cancelled.4.is_none(), "{label} cancelled.rescheduled_from_id == None");
            assert_eq!(new.1, "Open", "{label} new.status");
            assert_eq!(
                new.3, cancelled.3,
                "{label} new.original_scheduled_at == cancelled.original_scheduled_at"
            );
            assert_eq!(
                new.4,
                Some(cancelled.0),
                "{label} new.rescheduled_from_id == cancelled.id"
            );
            assert!(new.5.is_some(), "{label} new.recurring_template_id != None");
        };
        check_pair(
            shift_all
                .iter()
                .find(|r| r.1 == "Cancelled" && r.2 == "2026-10-01 01:00:00")
                .unwrap(),
            shift_all
                .iter()
                .find(|r| r.1 == "Open" && r.2 == "2026-10-08 01:00:00")
                .unwrap(),
            "SHIFT",
        );
        check_pair(manual_cancelled, manual_new, "manual");
    }
}

// ---------------------------------------------------------------------------
// 改期链回溯
// ---------------------------------------------------------------------------

#[test]
fn instance_reschedule_chain_单_instance_返回自身() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    let chain = instance_reschedule_chain(fx.app.state(), InstanceIdArgs { task_id: inst_id })
        .expect("链");
    assert_eq!(chain.len(), 1, "没改过期的 instance 链只有自己");
    assert_eq!(chain[0].id, inst_id);
}

#[test]
fn instance_reschedule_chain_多层改期沿_rescheduled_from_id_回溯() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    // 三次改期——目标时间必须不撞现有 instance(避开周一/三);用周二
    // / 周四 / 周六这种"同模板不会出现"的日子。
    let r1 = reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: inst_id,
            new_scheduled_at: "2026-09-15 00:00:00".into(),
        },
    )
    .expect("改期 1");

    let r2 = reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: r1.id,
            new_scheduled_at: "2026-09-17 00:00:00".into(),
        },
    )
    .expect("改期 2");

    let r3 = reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: r2.id,
            new_scheduled_at: "2026-09-19 00:00:00".into(),
        },
    )
    .expect("改期 3");

    let chain = instance_reschedule_chain(fx.app.state(), InstanceIdArgs { task_id: r3.id })
        .expect("链");
    assert_eq!(chain.len(), 4, "自身 + 三层 Cancelled 上游");
    assert_eq!(chain[0].id, r3.id);
    assert_eq!(chain[1].id, r2.id);
    assert_eq!(chain[2].id, r1.id);
    assert_eq!(chain[3].id, inst_id);
    assert_eq!(chain[0].status, kewutong_lib::commands::task::TaskStatus::Open);
    for upper in &chain[1..] {
        assert_eq!(upper.status, kewutong_lib::commands::task::TaskStatus::Cancelled);
    }
}

#[test]
fn instance_reschedule_chain_未知_id_返回空() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let chain = instance_reschedule_chain(fx.app.state(), InstanceIdArgs { task_id: 99999 })
        .expect("链");
    assert!(chain.is_empty());
}

// ---------------------------------------------------------------------------
// 出差场景：覆盖 instance scheduled_at
// ---------------------------------------------------------------------------

#[test]
fn override_instance_scheduled_at_只改_scheduled_at_不改_status_和_original() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    let updated = override_instance_scheduled_at(
        fx.app.state(),
        OverrideInstanceScheduledAtArgs {
            task_id: inst_id,
            new_scheduled_at: "2026-09-15 00:00:00".into(),
        },
    )
    .expect("覆盖");

    assert_eq!(updated.id, inst_id, "覆盖走 UPDATE,不创建新行");
    assert_eq!(updated.scheduled_at.as_deref(), Some("2026-09-15 00:00:00"));

    with_conn(&state, |conn| {
        let moved = select_instance(conn, fx.template_id, "2026-09-15 00:00:00");
        assert_eq!(moved.0, inst_id);
        assert_eq!(moved.1, "Open");
        assert_eq!(moved.4, None, "override 不挂 rescheduled_from_id（这不是改期）");
    });
}

#[test]
fn override_instance_scheduled_at_目标时间_被占用_被拒() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    let err = override_instance_scheduled_at(
        fx.app.state(),
        OverrideInstanceScheduledAtArgs {
            task_id: inst_id,
            new_scheduled_at: "2026-09-21 00:00:00".into(),
        },
    )
    .expect_err("目标时间被占");
    // 命令层先一步给中文消息(INVALID_ARGUMENT),DB 唯一索引仍兜底。
    // 与 `reschedule_instance` 行为对齐,验收点是「被拒」+ 友好消息。
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("占用"));
}

#[test]
fn reschedule_instance_自指改期_原时间同_新时间_被拒() {
    // 自指改期 = 把 instance 改期到它自己的 scheduled_at——会触发
    // Cancelled 行的 rescheduled_from_id 指向自己,instance_reschedule_chain
    // 沿环路 32 次循环才退出。命令层提前拦掉。
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");
    let state = fx.app.state::<AppState>();
    materialize_from_state(state.inner()).expect("物化");

    let inst_id = with_conn(&state, |conn| {
        select_instance(conn, fx.template_id, "2026-09-14 00:00:00").0
    });

    let err = reschedule_instance(
        fx.app.state(),
        RescheduleInstanceArgs {
            task_id: inst_id,
            new_scheduled_at: "2026-09-14 00:00:00".into(),
        },
    )
    .expect_err("自指改期应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("相同") || err.message().contains("原时间"));
}

#[test]
fn override_instance_scheduled_at_非_instance_被拒() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");

    let once = kewutong_lib::commands::task::create_task(
        fx.app.state(),
        kewutong_lib::commands::task::CreateTaskArgs {
            title: "一次性".into(),
            description: None,
            owner_person_id: 1,
            project_id: None,
            due_date: Some("2026-09-15".into()),
        },
    )
    .expect("建一次性");

    let err = override_instance_scheduled_at(
        fx.app.state(),
        OverrideInstanceScheduledAtArgs {
            task_id: once.id,
            new_scheduled_at: "2026-09-16 00:00:00".into(),
        },
    )
    .expect_err("一次性 task 走 override 应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
}

// ---------------------------------------------------------------------------
// 出差场景：模板级 iana_zone 整体修改
// ---------------------------------------------------------------------------

#[test]
fn update_recurring_template_zone_改_iana_zone_其它字段不动() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");

    let updated = update_recurring_template_zone(
        fx.app.state(),
        UpdateTemplateZoneArgs {
            template_id: fx.template_id,
            iana_zone: "Asia/Shanghai".into(),
        },
    )
    .expect("改");
    assert_eq!(updated.iana_zone, "Asia/Shanghai");

    let state = fx.app.state::<AppState>();
    let row = with_conn(&state, |conn| {
        conn.query_row(
            "SELECT iana_zone, freq, byday_mask FROM recurring_template WHERE id = ?1",
            rusqlite::params![fx.template_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .expect("查模板")
    });
    assert_eq!(row.0, "Asia/Shanghai");
    assert_eq!(row.1, "WEEKLY");
    assert_eq!(row.2, byday::MO as i64);
}

#[test]
fn update_recurring_template_zone_未知_模板_被拒() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");

    let err = update_recurring_template_zone(
        fx.app.state(),
        UpdateTemplateZoneArgs {
            template_id: 99999,
            iana_zone: "Asia/Shanghai".into(),
        },
    )
    .expect_err("模板不存在");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
}

#[test]
fn update_recurring_template_zone_非法_zone_被拒() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_fixture_with_team_and_template(clock, weekly_rule(), "周一例会");

    let err = update_recurring_template_zone(
        fx.app.state(),
        UpdateTemplateZoneArgs {
            template_id: fx.template_id,
            iana_zone: "America/New_York".into(),
        },
    )
    .expect_err("非本票时区被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("Asia/Shanghai"));
}