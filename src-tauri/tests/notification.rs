//! 通知引擎集成测试（ticket #30）。
//!
//! 验收点：
//! - due_24h：到期内 + 不重复
//! - blocked_3d：超过 3 天 + 不重复 + payload 含 blocked_at / days_blocked / blocked_reason
//! - weekly_digest：周一 8 点 + 节假日跳过 + 一周一不重复
//! - 未读面板：viewed_at IS NULL + 部分索引 + mark_read
//! - 通知 OS 触达由调度器负责,本文件只断言"落库正确 + 返回 row"路径
//!
//! 单测侧在 `notifications.rs` 的 `#[cfg(test)] mod tests`（payload 形
//! 状 / 周报窗口算法）;本文件走 mock_app + fresh_db 的端到端集成路径。

mod support;

use kewutong_lib::clock::FixedClock;
use kewutong_lib::commands::notification::{
    get_notification, list_notifications, list_unread_notifications, mark_all_notifications_read,
    mark_notification_read, GetNotificationArgs, MarkReadArgs,
};
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, CreatePersonArgs, CreateSubTeamArgs,
};
use kewutong_lib::commands::task::{create_task, set_task_status, CreateTaskArgs, SetTaskStatusArgs};
use kewutong_lib::notifications::{NotificationPayload, NotificationRow, self};
use kewutong_lib::state::AppState;
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;

/// 起一个空 DB + 系统时钟 + 空日历的 mock app。
fn empty_app() -> tauri::App<tauri::test::MockRuntime> {
    let state = kewutong_lib::testing::fresh_db();
    mock_app(state)
}

/// 起一个空 DB + 给定时钟 + 空日历的 mock app。时钟用 FixedClock 让"现在"可钉。
fn app_with_clock(at: &str) -> (tauri::App<tauri::test::MockRuntime>, Arc<FixedClock>) {
    let clock = Arc::new(FixedClock::at(at));
    let state = kewutong_lib::testing::fresh_db_with_clock(clock.clone());
    (mock_app(state), clock)
}

/// 在 app 里塞一个最小可用的 owner (子组 + 人员),返回 person_id。
fn seed_owner(app: &tauri::App<tauri::test::MockRuntime>) -> i64 {
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通".into(),
            description: None,
        },
    )
    .expect("建子组");
    let person = create_person(
        app.state(),
        CreatePersonArgs {
            name: "张三".into(),
            sub_team_id: team.id,
            contact: "13800138000".into(),
        },
    )
    .expect("建人员");
    person.id
}

/// 一次性任务 —— given 截止日 + 状态。
fn seed_one_off_task(
    app: &tauri::App<tauri::test::MockRuntime>,
    owner_id: i64,
    title: &str,
    due_date: Option<&str>,
) -> i64 {
    create_task(
        app.state(),
        CreateTaskArgs {
            title: title.into(),
            description: None,
            owner_person_id: owner_id,
            project_id: None,
            due_date: due_date.map(str::to_string),
        },
    )
    .expect("建任务")
    .id
}

/// 把任务置入 Blocked 状态——必须给 reason,set_status 内部预检。
fn seed_blocked_task(
    app: &tauri::App<tauri::test::MockRuntime>,
    owner_id: i64,
    title: &str,
) -> i64 {
    let id = seed_one_off_task(app, owner_id, title, None);
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: id,
            status: kewutong_lib::commands::task::TaskStatus::Blocked,
            blocked_reason: Some("等外委回函".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("置 Blocked");
    id
}

// ---------------------------------------------------------------------------
// due_24h
// ---------------------------------------------------------------------------

#[test]
fn due_24h_命中_今天_和_明天_截止_的一次性任务() {
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00"); // UTC: 周四 16:00 local

    let owner = seed_owner(&app);
    let task_today = seed_one_off_task(&app, owner, "今天到期", Some("2026-09-10"));
    let task_tomorrow = seed_one_off_task(&app, owner, "明天到期", Some("2026-09-11"));
    let _task_later = seed_one_off_task(&app, owner, "后天到期", Some("2026-09-12"));
    let _task_no_due = seed_one_off_task(&app, owner, "无截止", None);
    let _task_done_today = seed_one_off_task(&app, owner, "今天已完成", Some("2026-09-10"));
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: _task_done_today,
            status: kewutong_lib::commands::task::TaskStatus::Done,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("置 Done");

    let inserted = notifications::run_due_24h(app.state::<AppState>().inner()).expect("run_due_24h");
    let mut ids: Vec<i64> = inserted.iter().map(|r| r.id).collect();
    ids.sort();

    assert_eq!(inserted.len(), 2, "命中今天 + 明天;Done 不算;无截止不算");
    assert!(ids.contains(&task_today));
    assert!(ids.contains(&task_tomorrow));
}

#[test]
fn due_24h_已通知的任务_再跑_不重复() {
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00");
    let owner = seed_owner(&app);
    let task_id = seed_one_off_task(&app, owner, "今天到期", Some("2026-09-10"));

    let first = notifications::run_due_24h(app.state::<AppState>().inner()).expect("首次");
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].related_task_id, Some(task_id));
    assert_eq!(first[0].kind, "due_24h");

    let second = notifications::run_due_24h(app.state::<AppState>().inner()).expect("二次");
    assert!(second.is_empty(), "同 (kind, task) 不重复");
}

#[test]
fn due_24h_payload_含_title_due_date_owner_字段() {
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00");
    let owner = seed_owner(&app);
    seed_one_off_task(&app, owner, "外委合同评审", Some("2026-09-10"));

    let inserted = notifications::run_due_24h(app.state::<AppState>().inner()).expect("run");
    assert_eq!(inserted.len(), 1);
    // payload 是 JSON Value,反序列化回 NotificationPayload 验证字段集。
    let payload: NotificationPayload =
        serde_json::from_value(inserted[0].payload.clone()).expect("反序列化");
    match payload {
        NotificationPayload::Due24h {
            title,
            due_date,
            owner_person_id,
            owner_name,
            ..
        } => {
            assert_eq!(title, "外委合同评审");
            assert_eq!(due_date, "2026-09-10");
            assert_eq!(owner_person_id, owner);
            assert_eq!(owner_name, "张三");
        }
        other => panic!("payload 不是 Due24h: {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// blocked_3d
// ---------------------------------------------------------------------------

#[test]
fn blocked_3d_命中_Blocked_超_3_天_的任务() {
    // 钉在 2026-09-10 08:00:00 UTC。让 blocked_at = 2026-09-05 08:00:00
    // (5 天前),> 3 天阈值,应命中。
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00");
    let owner = seed_owner(&app);
    let blocked = seed_blocked_task(&app, owner, "阻塞 5 天");
    // blocked_at 是 set_status 写入 "2026-09-10 08:00:00" (now) —— 没超过 3 天,不命中。
    // 改写一条 task 让它的 blocked_at 提前 5 天,模拟"老阻塞"。
    {
        let state_ref = app.state::<AppState>();
        let conn = state_ref.db().expect("锁");
        conn.execute(
            "UPDATE task SET blocked_at = '2026-09-05 08:00:00' WHERE id = ?1",
            rusqlite::params![blocked],
        )
        .expect("改 blocked_at");
    }

    let inserted = notifications::run_blocked_3d(app.state::<AppState>().inner()).expect("run");
    assert_eq!(inserted.len(), 1);
    assert_eq!(inserted[0].related_task_id, Some(blocked));
}

#[test]
fn blocked_3d_阻塞_2_天_不命中() {
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00");
    let owner = seed_owner(&app);
    let blocked = seed_blocked_task(&app, owner, "阻塞 2 天");
    // blocked_at = 2026-09-08 08:00:00,差 2 天,< 3 天阈值,不命中。
    {
        let state_ref = app.state::<AppState>();
        let conn = state_ref.db().expect("锁");
        conn.execute(
            "UPDATE task SET blocked_at = '2026-09-08 08:00:00' WHERE id = ?1",
            rusqlite::params![blocked],
        )
        .expect("改");
    }

    let inserted = notifications::run_blocked_3d(app.state::<AppState>().inner()).expect("run");
    assert!(inserted.is_empty(), "2 天不命中 3 天阈值");
}

#[test]
fn blocked_3d_payload_含_blocked_at_days_blocked_blocked_reason() {
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00");
    let owner = seed_owner(&app);
    let blocked = seed_blocked_task(&app, owner, "等外委回函");
    {
        let state_ref = app.state::<AppState>();
        let conn = state_ref.db().expect("锁");
        conn.execute(
            "UPDATE task SET blocked_at = '2026-09-05 08:00:00' WHERE id = ?1",
            rusqlite::params![blocked],
        )
        .expect("改");
    }

    let inserted = notifications::run_blocked_3d(app.state::<AppState>().inner()).expect("run");
    let payload: NotificationPayload =
        serde_json::from_value(inserted[0].payload.clone()).expect("反序列化");
    match payload {
        NotificationPayload::Blocked3d {
            blocked_at,
            days_blocked,
            blocked_reason,
            ..
        } => {
            assert_eq!(blocked_at, "2026-09-05 08:00:00");
            assert!(days_blocked >= 5, "应当 >= 5,实为 {days_blocked}");
            assert_eq!(blocked_reason, "等外委回函");
        }
        other => panic!("payload 不是 Blocked3d: {other:?}"),
    }
}

#[test]
fn blocked_3d_命中_idx_task_status_blocked_at() {
    // EXPLAIN QUERY PLAN 验证查询路径走 partial index。
    let app = empty_app();
    let state_ref = app.state::<AppState>();
    let conn = state_ref.db().expect("锁");
    let plan: Vec<String> = conn
        .prepare(
            "EXPLAIN QUERY PLAN \
             SELECT id FROM task \
              WHERE status IN ('Blocked','Waiting-on') \
                AND blocked_at IS NOT NULL \
                AND blocked_at < datetime('now', '-3 days')",
        )
        .expect("prepare")
        .query_map([], |row| row.get::<_, String>(3))
        .expect("query")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect");
    let joined = plan.join(" | ");
    assert!(
        joined.contains("idx_task_status_blocked_at"),
        "查询路径应命中部分索引,实际 plan: {joined}"
    );
}

#[test]
fn blocked_3d_同任务_再跑_不重复() {
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00");
    let owner = seed_owner(&app);
    let blocked = seed_blocked_task(&app, owner, "阻塞 5 天");
    {
        let state_ref = app.state::<AppState>();
        let conn = state_ref.db().expect("锁");
        conn.execute(
            "UPDATE task SET blocked_at = '2026-09-05 08:00:00' WHERE id = ?1",
            rusqlite::params![blocked],
        )
        .expect("改");
    }

    let first = notifications::run_blocked_3d(app.state::<AppState>().inner()).expect("首次");
    assert_eq!(first.len(), 1);
    let second = notifications::run_blocked_3d(app.state::<AppState>().inner()).expect("二次");
    assert!(second.is_empty(), "dedup");
}

// ---------------------------------------------------------------------------
// weekly_digest
// ---------------------------------------------------------------------------

#[test]
fn weekly_digest_周一_8_点_触发_一次() {
    let (app, _clock) = app_with_clock("2026-09-07 00:00:00"); // Mon 00:00 UTC = 08:00 local
    let owner = seed_owner(&app);
    // 周报 4 个计数:overdue / due_today / due_tomorrow / blocked
    seed_one_off_task(&app, owner, "逾期任务", Some("2026-09-05"));
    seed_one_off_task(&app, owner, "今日到期", Some("2026-09-07"));
    seed_one_off_task(&app, owner, "明日到期", Some("2026-09-08"));
    seed_blocked_task(&app, owner, "阻塞任务");

    let inserted = notifications::run_weekly_digest(app.state::<AppState>().inner()).expect("run");
    assert_eq!(inserted.len(), 1);
    let payload: NotificationPayload =
        serde_json::from_value(inserted[0].payload.clone()).expect("反序列化");
    match payload {
        NotificationPayload::WeeklyDigest {
            week_start,
            week_end,
            overdue_count,
            due_today_count,
            due_tomorrow_count,
            blocked_count,
        } => {
            assert_eq!(week_start, "2026-09-07");
            assert_eq!(week_end, "2026-09-13");
            assert_eq!(overdue_count, 1);
            assert_eq!(due_today_count, 1);
            assert_eq!(due_tomorrow_count, 1);
            assert_eq!(blocked_count, 1);
        }
        other => panic!("payload 不是 WeeklyDigest: {other:?}"),
    }
}

#[test]
fn weekly_digest_同一周_再跑_不重复_而是_返回_已有_row() {
    let (app, _clock) = app_with_clock("2026-09-07 00:00:00");
    let _owner = seed_owner(&app);

    let first = notifications::run_weekly_digest(app.state::<AppState>().inner()).expect("首次");
    assert_eq!(first.len(), 1);
    let first_id = first[0].id;

    let second = notifications::run_weekly_digest(app.state::<AppState>().inner()).expect("二次");
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].id, first_id, "同周应当返回已有 row,不写新行");
}

#[test]
fn weekly_digest_周一_override_holiday_不触发() {
    let (app, _clock) = app_with_clock("2026-09-07 00:00:00");
    {
        let state_ref = app.state::<AppState>();
        let conn = state_ref.db().expect("锁");
        conn.execute(
            "INSERT INTO holiday_override (date, kind) VALUES ('2026-09-07','holiday')",
            [],
        )
        .expect("override");
        let mut cal = state_ref.calendar().expect("日历锁");
        kewutong_lib::holiday::reload_overrides_from_db(&conn, &mut cal).expect("reload");
    }

    let result = notifications::run_weekly_digest(app.state::<AppState>().inner()).expect("run");
    assert!(result.is_empty(), "周一若是 holiday 应跳过");
}

// ---------------------------------------------------------------------------
// run_all 三 规则一起跑
// ---------------------------------------------------------------------------

#[test]
fn run_all_三规则_各自_正确() {
    let (app, _clock) = app_with_clock("2026-09-07 00:00:00"); // Mon 00:00 UTC = 08:00 local
    let owner = seed_owner(&app);

    // due_24h: 今天 + 明天
    seed_one_off_task(&app, owner, "今天到期", Some("2026-09-07"));
    seed_one_off_task(&app, owner, "明天到期", Some("2026-09-08"));

    // blocked_3d: 一个阻塞 5 天
    let blocked = seed_blocked_task(&app, owner, "阻塞 5 天");
    {
        let binding = app.state::<AppState>(); let conn = binding.db().expect("锁");
        conn.execute(
            "UPDATE task SET blocked_at = '2026-09-02 08:00:00' WHERE id = ?1",
            rusqlite::params![blocked],
        )
        .expect("改");
    }

    // weekly_digest: 周一 8 点触发

    let summary = notifications::run_all(app.state::<AppState>().inner()).expect("run_all");
    assert_eq!(summary.due_24h.len(), 2);
    assert_eq!(summary.blocked_3d.len(), 1);
    assert_eq!(summary.weekly_digest.len(), 1);
    assert_eq!(summary.total_inserted(), 4);
}

// ---------------------------------------------------------------------------
// 未读面板 / 已读标记
// ---------------------------------------------------------------------------

#[test]
fn list_unread_按触发时间倒序_且_只看_viewed_at_is_null() {
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00");
    let owner = seed_owner(&app);
    let task_a = seed_one_off_task(&app, owner, "今天到期 A", Some("2026-09-10"));
    let _task_b = seed_one_off_task(&app, owner, "今天到期 B", Some("2026-09-10"));

    let _ = notifications::run_due_24h(app.state::<AppState>().inner()).expect("run");
    let unread = list_unread_notifications(app.state()).expect("list");
    assert_eq!(unread.len(), 2);
    // 都是 due_24h 且未读
    for row in &unread {
        assert_eq!(row.kind, "due_24h");
        assert!(row.viewed_at.is_none());
        assert!(row.related_task_id.is_some());
    }

    // 标记 task_a 对应的已读
    let target_id = unread
        .iter()
        .find(|r| r.related_task_id == Some(task_a))
        .expect("A 的 row")
        .id;
    let marked = mark_notification_read(
        app.state(),
        MarkReadArgs { id: target_id },
    )
    .expect("mark");
    assert!(marked);

    let unread_after = list_unread_notifications(app.state()).expect("list");
    assert_eq!(unread_after.len(), 1);
    assert_ne!(unread_after[0].id, target_id);

    // 再 mark 一次同一 id,返回 false(幂等)
    let again = mark_notification_read(
        app.state(),
        MarkReadArgs { id: target_id },
    )
    .expect("mark");
    assert!(!again);
}

#[test]
fn mark_all_read_把所有未读_一次清空() {
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00");
    let owner = seed_owner(&app);
    seed_one_off_task(&app, owner, "A", Some("2026-09-10"));
    seed_one_off_task(&app, owner, "B", Some("2026-09-10"));
    seed_one_off_task(&app, owner, "C", Some("2026-09-10"));
    let _ = notifications::run_due_24h(app.state::<AppState>().inner()).expect("run");

    let unread_before = list_unread_notifications(app.state()).expect("list");
    assert_eq!(unread_before.len(), 3);

    let n = mark_all_notifications_read(app.state()).expect("mark all");
    assert_eq!(n, 3);

    let unread_after = list_unread_notifications(app.state()).expect("list");
    assert!(unread_after.is_empty());
}

#[test]
fn list_notifications_历史视图_含_已读() {
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00");
    let owner = seed_owner(&app);
    seed_one_off_task(&app, owner, "A", Some("2026-09-10"));
    seed_one_off_task(&app, owner, "B", Some("2026-09-10"));
    let _ = notifications::run_due_24h(app.state::<AppState>().inner()).expect("run");

    // 全部已读
    let _ = mark_all_notifications_read(app.state()).expect("mark all");

    let unread = list_unread_notifications(app.state()).expect("list unread");
    assert!(unread.is_empty());

    let history = list_notifications(app.state()).expect("list history");
    assert_eq!(history.len(), 2);
    for row in &history {
        assert!(row.viewed_at.is_some(), "历史视图含已读");
    }
}

#[test]
fn get_notification_用于_点通知跳转() {
    let (app, _clock) = app_with_clock("2026-09-10 08:00:00");
    let owner = seed_owner(&app);
    let task_id = seed_one_off_task(&app, owner, "今天到期", Some("2026-09-10"));
    let inserted = notifications::run_due_24h(app.state::<AppState>().inner()).expect("run");
    let notif_id = inserted[0].id;

    let row = get_notification(
        app.state(),
        GetNotificationArgs { id: notif_id },
    )
    .expect("get");
    let payload: NotificationPayload =
        serde_json::from_value(row.payload.clone()).expect("反序列化");
    match payload {
        NotificationPayload::Due24h { task_id: pid, .. } => assert_eq!(pid, task_id),
        other => panic!("expected Due24h, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Schema 验证
// ---------------------------------------------------------------------------

#[test]
fn notification_log_表存在_且_索引_就位() {
    let app = empty_app();
    let owner = seed_owner(&app);
    let task_id = seed_one_off_task(&app, owner, "样本", Some("2026-09-10"));
    let state_ref = app.state::<AppState>();
    let conn = state_ref.db().expect("锁");

    // 表存在
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notification_log'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(exists, 1, "notification_log 表应当存在");

    // 合法 payload + 合法 FK target
    conn.execute(
        "INSERT INTO notification_log (kind, related_task_id, payload) VALUES ('due_24h', ?1, ?2)",
        rusqlite::params![
            task_id,
            r#"{"kind":"due_24h","task_id":1,"title":"t","due_date":"2026-09-10","owner_person_id":1,"owner_name":"x"}"#,
        ],
    )
    .expect("合法 payload 应能写入");

    // 非法 JSON payload 应被 CHECK 拒
    let bad = conn.execute(
        "INSERT INTO notification_log (kind, related_task_id, payload) VALUES ('due_24h', ?1, ?2)",
        rusqlite::params![task_id, "not json"],
    );
    assert!(bad.is_err(), "非法 JSON payload 应被 CHECK 拒");

    // 至少关联一个实体的 CHECK——weekly_digest 允许 NULL/NULL。
    let weekly = conn.execute(
        "INSERT INTO notification_log (kind, payload) VALUES ('weekly_digest', ?1)",
        rusqlite::params![r#"{"kind":"weekly_digest","week_start":"2026-09-07","week_end":"2026-09-13","overdue_count":0,"due_today_count":0,"due_tomorrow_count":0,"blocked_count":0}"#],
    );
    assert!(weekly.is_ok(), "weekly_digest 允许两者 NULL");

    // due_24h 不挂 task 也应被拒
    let due_no_task = conn.execute(
        "INSERT INTO notification_log (kind, payload) VALUES ('due_24h', ?1)",
        rusqlite::params![r#"{"kind":"due_24h","task_id":1,"title":"t","due_date":"2026-09-10","owner_person_id":1,"owner_name":"x"}"#],
    );
    assert!(due_no_task.is_err(), "due_24h 必须挂一个 task_id");

    // 部分索引 idx_notification_log_viewed_at_unread 存在
    let idx_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_notification_log_viewed_at_unread'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(idx_exists, 1, "未读面板的部分索引应当存在");
}

// ---------------------------------------------------------------------------
// 辅助:把所有 NotificationRow 摊平到一个用于断言的迭代器
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn rows_to_payloads(rows: &[NotificationRow]) -> Vec<NotificationPayload> {
    rows.iter()
        .map(|r| serde_json::from_value(r.payload.clone()).expect("反序列化"))
        .collect()
}