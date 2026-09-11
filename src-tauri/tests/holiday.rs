//! 节假日命令的集成测试（ticket #23）。
//!
//! 验收点：
//! - 日历视图命令返回 effective set（seed + override）
//! - set_holiday_override / clear_holiday_override 立即反映在日历视图里
//! - 跨年加载：当年 + 下一年两份种子合并
//! - 日期格式非法被拒；范围过大被拒

mod support;

use chrono::NaiveDate;
use kewutong_lib::commands::holiday::{
    clear_holiday_override, holiday_calendar, set_holiday_override, ClearHolidayOverrideArgs,
    HolidayCalendarArgs, SetHolidayOverrideArgs,
};
use kewutong_lib::holiday::{DayKind, DaySource, HolidayCalendar};
use kewutong_lib::testing::{fresh_db, fresh_db_with_clock};
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;
use tempfile::TempDir;

fn date(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").expect("合法日期")
}

/// 临时目录里写一对 cn-2026 / cn-2027 种子,返回 (TempDir, 目录路径)。
/// TempDir 持有——`TempDir` drop 时整个目录会被删。
fn write_seed_pair() -> (TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("临时目录");
    let path = dir.path().to_path_buf();
    std::fs::write(
        path.join("cn-2026.json"),
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
        path.join("cn-2027.json"),
        r#"{
          "holidays": [
            { "start": "2027-02-06", "end": "2027-02-14", "name": "春节" }
          ],
          "workdays": []
        }"#,
    )
    .expect("写 2027");
    (dir, path)
}

/// 把已经加载好种子的日历装进 AppState。封装出来让每个测试少写一遍
/// boilerplate——避免前面 lint 警告「`state.db()` 临时值被释放」。
fn install_calendar_with_seed(
    app: &tauri::App<tauri::test::MockRuntime>,
    seed_path: std::path::PathBuf,
) {
    let state = app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("db");
    let cal = HolidayCalendar::load(&seed_path, 2026, &conn).expect("load");
    state.install_calendar(cal);
    // seed_path 与 TempDir 必须活到本测试结束——把它们 move 进 helper 不
    // 切实际,直接在调用方持有更稳。这里不持有,但调用方得保证 seed_dir
    // 至少活到 install_calendar 之后。
    drop(seed_path);
}

#[test]
fn 日历视图_只返回_种子_与_override_的有效天() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-10-01 09:00:00"));
    let (seed_dir, seed_path) = write_seed_pair();
    let app = mock_app(fresh_db_with_clock(clock));
    install_calendar_with_seed(&app, seed_path.clone());

    let view = holiday_calendar(
        app.state(),
        HolidayCalendarArgs {
            start_inclusive: "2026-10-01".into(),
            end_inclusive: "2026-10-10".into(),
        },
    )
    .expect("view");

    // 10/1-10/7 种子国庆节(7 天) + 10/10 调休(1 天)
    assert_eq!(view.len(), 8);
    let kinds: Vec<_> = view.iter().map(|d| (d.date.as_str(), d.kind, d.source)).collect();
    assert!(kinds.contains(&("2026-10-01", DayKind::Holiday, DaySource::Seed)));
    assert!(kinds.contains(&("2026-10-10", DayKind::Workday, DaySource::Seed)));
    drop(seed_dir);
}

#[test]
fn set_override_立即反映到日历视图() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-10-01 09:00:00"));
    let (seed_dir, seed_path) = write_seed_pair();
    let app = mock_app(fresh_db_with_clock(clock));
    install_calendar_with_seed(&app, seed_path.clone());

    // 翻 10/8(种子未覆盖,默认 workday)为 Holiday
    set_holiday_override(
        app.state(),
        SetHolidayOverrideArgs {
            date: "2026-10-08".into(),
            kind: DayKind::Holiday,
        },
    )
    .expect("set");

    let view = holiday_calendar(
        app.state(),
        HolidayCalendarArgs {
            start_inclusive: "2026-10-08".into(),
            end_inclusive: "2026-10-08".into(),
        },
    )
    .expect("view");

    assert_eq!(view.len(), 1);
    assert_eq!(view[0].kind, DayKind::Holiday);
    assert_eq!(view[0].source, DaySource::Override);
    drop(seed_dir);
}

#[test]
fn clear_override_恢复种子() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-10-01 09:00:00"));
    let (seed_dir, seed_path) = write_seed_pair();
    let app = mock_app(fresh_db_with_clock(clock));
    install_calendar_with_seed(&app, seed_path.clone());

    set_holiday_override(
        app.state(),
        SetHolidayOverrideArgs {
            date: "2026-10-01".into(),
            kind: DayKind::Workday,
        },
    )
    .expect("set");

    let view_after_set = holiday_calendar(
        app.state(),
        HolidayCalendarArgs {
            start_inclusive: "2026-10-01".into(),
            end_inclusive: "2026-10-01".into(),
        },
    )
    .expect("view after set");
    assert_eq!(view_after_set[0].kind, DayKind::Workday);
    assert_eq!(view_after_set[0].source, DaySource::Override);

    clear_holiday_override(
        app.state(),
        ClearHolidayOverrideArgs {
            date: "2026-10-01".into(),
        },
    )
    .expect("clear");

    let view_after_clear = holiday_calendar(
        app.state(),
        HolidayCalendarArgs {
            start_inclusive: "2026-10-01".into(),
            end_inclusive: "2026-10-01".into(),
        },
    )
    .expect("view after clear");
    assert_eq!(view_after_clear[0].kind, DayKind::Holiday);
    assert_eq!(view_after_clear[0].source, DaySource::Seed);
    drop(seed_dir);
}

#[test]
fn 跨年加载_当年与下一年两份种子并查() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-12-30 09:00:00"));
    let (seed_dir, seed_path) = write_seed_pair();
    let app = mock_app(fresh_db_with_clock(clock));
    let state = app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("db");
    let cal = HolidayCalendar::load(&seed_path, 2026, &conn).expect("load");

    // 2026 春节(2/15-2/23) 与 2027 春节(2/6-2/14) 都能查到——后者虽属 2027
    // 文件,但启动时"当前年+下一年"两份都加载,年末过渡场景也能用上。
    assert!(cal.is_holiday(date("2026-02-15")));
    assert!(cal.is_holiday(date("2026-02-23")));
    assert!(cal.is_holiday(date("2027-02-06")));
    assert!(!cal.is_holiday(date("2027-03-01")), "2027 春节已过");
    assert_eq!(cal.loaded_years(), &[2026, 2027]);
    drop(seed_dir);
}

#[test]
fn 日历视图_日期格式非法被拒() {
    let app = mock_app(fresh_db());
    let err = holiday_calendar(
        app.state(),
        HolidayCalendarArgs {
            start_inclusive: "2026/10/01".into(),
            end_inclusive: "2026-10-10".into(),
        },
    )
    .expect_err("非法日期应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("起始日"));
}

#[test]
fn 日历视图_范围超过_92_天被拒() {
    let app = mock_app(fresh_db());
    let err = holiday_calendar(
        app.state(),
        HolidayCalendarArgs {
            start_inclusive: "2026-10-01".into(),
            end_inclusive: "2027-01-15".into(), // 107 天
        },
    )
    .expect_err("范围过大应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("92"));
}

#[test]
fn 日历视图_起始晚于结束被拒() {
    let app = mock_app(fresh_db());
    let err = holiday_calendar(
        app.state(),
        HolidayCalendarArgs {
            start_inclusive: "2026-10-10".into(),
            end_inclusive: "2026-10-01".into(),
        },
    )
    .expect_err("起始晚于结束应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("起始日"));
}

#[test]
fn 日历视图_默认工作日_不在返回里() {
    // 日历视图只返回 effective 不为「默认 workday」的格子；
    // 周末虽 kind=Holiday 但 source=Default,也不在返回里——前端按
    // 日历格子自己画周末底色。挑一个**没有任何种子覆盖**的周末来断言。
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-04-01 09:00:00"));
    let (seed_dir, seed_path) = write_seed_pair();
    let app = mock_app(fresh_db_with_clock(clock));
    install_calendar_with_seed(&app, seed_path.clone());

    let view = holiday_calendar(
        app.state(),
        HolidayCalendarArgs {
            start_inclusive: "2026-04-04".into(), // Sat,无种子覆盖
            end_inclusive: "2026-04-05".into(),  // Sun,无种子覆盖
        },
    )
    .expect("view");

    assert!(view.is_empty(), "默认周末不在返回里");
    drop(seed_dir);
}