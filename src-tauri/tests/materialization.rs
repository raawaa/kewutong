//! 物化引擎集成测试（ticket #25）。
//!
//! 验收点：
//! - 物化在启动 + 跨入下一周各触发一次;触发时机走可注入 clock
//! - **幂等**:重复跑不产生重复实例;跨周触发只补增量
//! - 停用的 Template 不生成;终止条件(`ends_on` / `ends_after_n`)到点即停
//! - 实例写入 `task`,`recurring_template_id` / `scheduled_at` /
//!   `original_scheduled_at` 正确,`rescheduled_from_id` 为 NULL
//! - 墙钟 + `iana_zone` → 绝对 UTC `scheduled_at` 换算正确,含跨日边界
//! - `holiday_behavior = SKIP`:节假日区间内不生成实例
//! - `holiday_behavior = SHIFT`:原实例 `Cancelled` + 新实例
//!   `rescheduled_from_id` 指向原实例
//! - Makeup Workday 按普通工作日处理,不跳过不顺延
//! - 索引 `idx_task_template_scheduled_at_unique` 已建
//! - `MaterializationWindow = 12 weeks` 滑动窗口
//! - 跨入下一周由 `should_materialize_this_tick` 决定
//!
//! 单元侧在 `materialization.rs` 的 `#[cfg(test)] mod tests`;
//! 本文件走 mock_app + fresh_db 的端到端集成路径——日历通过
//! [`AppState::install_calendar`] 装入,materialize 走
//! [`materialize_from_state`] 用 state 的连接与内存日历。

mod support;

use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, CreatePersonArgs, CreateSubTeamArgs,
};
use kewutong_lib::commands::recurring_template::{
    set_recurring_template_enabled, upsert_recurring_template, SetRecurringTemplateEnabledArgs,
    UpsertRecurringTemplateArgs,
};
use kewutong_lib::holiday::HolidayCalendar;
use kewutong_lib::materialization::{
    apply_holiday_behavior, expand_rule, materialize_from_state, should_materialize_this_tick,
    wall_clock_to_utc_sql, IsoWeek, MaterializedEvent,
};
use kewutong_lib::recurring::{byday, EndsSpec, Freq, HolidayBehavior, StructuredRule};
use chrono::NaiveDate;
use std::sync::Arc;
use support::mock_app;
use tempfile::TempDir;
use tauri::Manager;

fn date(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("合法日期")
}

/// 临时目录里写一对 cn-2026 / cn-2027 种子,返回 (TempDir, 目录路径)。
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
        r#"{ "holidays": [], "workdays": [] }"#,
    )
    .expect("写 2027");
    (dir, path)
}

fn fresh_calendar_from_seed_dir(seed_dir: &std::path::Path) -> HolidayCalendar {
    let conn = kewutong_lib::db::open_in_memory().expect("内存库");
    HolidayCalendar::load(seed_dir, 2026, &conn).expect("加载")
}

/// 起一个 mock app + team + owner + 已装好的节假日日历,返回 app。
/// 把日历装进 state 后续 [`materialize_from_state`] 才会读到种子;
/// 临时目录由返回值的 `TempDir` 持有(`_dir` 字段)。
struct AppFixture {
    app: tauri::App<tauri::test::MockRuntime>,
    sub_team_id: i64,
    _dir: TempDir,
}

fn fresh_state_with_team_owner(clock: Arc<kewutong_lib::clock::FixedClock>) -> AppFixture {
    let (dir, seed_dir) = write_seed_pair();
    let cal = fresh_calendar_from_seed_dir(&seed_dir);
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
    let _owner = create_person(
        app.state(),
        CreatePersonArgs {
            name: "张三".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");
    AppFixture {
        app,
        sub_team_id: team.id,
        _dir: dir,
    }
}

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

fn quarterly_rule_struct() -> StructuredRule {
    StructuredRule {
        freq: Freq::Yearly,
        byday_mask: 0,
        bymonthday: Some(vec![1]),
        bymonth: Some(vec![1, 4, 7, 10]),
        byhour: 10,
        byminute: 0,
        iana_zone: "Asia/Shanghai".into(),
        ends: EndsSpec::On { date: "2030-01-01".into() },
        holiday_behavior: HolidayBehavior::Skip,
    }
}

// ---------------------------------------------------------------------------
// 纯函数侧：rrule / 边界
// ---------------------------------------------------------------------------

/// 验收点：「rrule crate 与自家'月末 = 0'编码的语义一致性」——通过手算
/// 已知日期集合,钉死 expand_rule 的结果。
#[test]
fn expand_weekly_与_手算一致() {
    let days = expand_rule(&weekly_rule(), date("2026-09-07"), date("2026-09-30"), 0).unwrap();
    // 9/7 (Mon) 起的周一:9/7, 9/14, 9/21, 9/28
    assert_eq!(
        days,
        vec![
            date("2026-09-07"),
            date("2026-09-14"),
            date("2026-09-21"),
            date("2026-09-28"),
        ]
    );
}

/// 验收点：月末 = 0 与 rrule `BYMONTHDAY=-1` 一致。
#[test]
fn expand_monthly_月末_0_与_rrule_bymonthday_负_1_一致() {
    let mut rule = monthly_day1_rule(HolidayBehavior::Skip);
    rule.bymonthday = Some(vec![0]);
    rule.ends = EndsSpec::On { date: "2027-12-31".into() };
    let days = expand_rule(&rule, date("2026-01-01"), date("2026-12-31"), 0).unwrap();
    // 12 个月每月最后一天
    assert_eq!(days.len(), 12);
    assert_eq!(days[0], date("2026-01-31"));
    assert_eq!(days[1], date("2026-02-28")); // 非闰年
    assert_eq!(days[3], date("2026-04-30"));
    assert_eq!(days[11], date("2026-12-31"));
}

/// 验收点（外部参考）:用 `rrule` crate 展开同一 RRULE,确认自家
/// `expand_rule` 与 RFC 5545 一致——`0 → -1` 的翻译正确。
#[test]
fn expand_与_外部_rrule_crate_对照_语义一致() {
    use rrule::RRuleSet;

    /// 跑 rrule 库,返回 [start, end] 内的本地日期列表。
    fn run_rrule(rrule_text: &str, start: NaiveDate, end: NaiveDate) -> Vec<NaiveDate> {
        let dt_start = start.and_hms_opt(0, 0, 0).unwrap().and_utc();
        let rrule_text = format!(
            "DTSTART:{}\nRRULE:{}",
            dt_start.format("%Y%m%dT%H%M%SZ"),
            rrule_text
        );
        let set: RRuleSet = rrule_text.parse().expect("rrule 解析");
        // rrule 0.14 限制:每次 all() 拿到的最大条数(同一年内大量展开
        // 时,需要抬高这个)。3000 够所有用例。
        let result = set.all(3000);
        result
            .dates
            .into_iter()
            .map(|d| d.with_timezone(&chrono::Utc).date_naive())
            .filter(|d| *d >= start && *d <= end)
            .collect()
    }

    // weekly MO
    {
        let rrule_text = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0;UNTIL=20261231T235959Z";
        let ours = expand_rule(&weekly_rule(), date("2026-09-07"), date("2026-09-30"), 0).unwrap();
        let theirs = run_rrule(rrule_text, date("2026-09-07"), date("2026-09-30"));
        assert_eq!(ours, theirs, "weekly MO 9月与 rrule 不一致");
    }

    // monthly 1
    {
        let rrule_text = "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0;UNTIL=20261231T235959Z";
        let ours = expand_rule(&monthly_day1_rule(HolidayBehavior::Skip), date("2026-09-01"), date("2026-12-31"), 0).unwrap();
        let theirs = run_rrule(rrule_text, date("2026-09-01"), date("2026-12-31"));
        assert_eq!(ours, theirs, "monthly 1 与 rrule 不一致");
    }

    // monthly 月末 (BYMONTHDAY=-1) —— 验证 0 → -1 的翻译
    {
        let rrule_text = "FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=16;BYMINUTE=30;UNTIL=20270630T235959Z";
        let mut rule = monthly_day1_rule(HolidayBehavior::Skip);
        rule.bymonthday = Some(vec![0]);
        rule.ends = EndsSpec::On { date: "2027-06-30".into() };
        let ours = expand_rule(&rule, date("2026-09-01"), date("2027-06-30"), 0).unwrap();
        let theirs = run_rrule(rrule_text, date("2026-09-01"), date("2027-06-30"));
        assert_eq!(ours, theirs, "monthly 月末(0/-1)与 rrule 不一致");
    }

    // yearly 1/4/7/10 月 1 号
    {
        let rrule_text = "FREQ=YEARLY;BYMONTHDAY=1;BYMONTH=1,4,7,10;BYHOUR=10;BYMINUTE=0;UNTIL=20300101T235959Z";
        let mut rule = quarterly_rule_struct();
        rule.ends = EndsSpec::On { date: "2030-01-01".into() };
        let ours = expand_rule(&rule, date("2026-01-01"), date("2027-12-31"), 0).unwrap();
        let theirs = run_rrule(rrule_text, date("2026-01-01"), date("2027-12-31"));
        assert_eq!(ours, theirs, "yearly 1/4/7/10 与 rrule 不一致");
    }
}

/// 跨日边界：墙钟 08:00 Asia/Shanghai = UTC 00:00 同日,物化后
/// scheduled_at 应当是 00:00:00 而非 08:00:00。
#[test]
fn expand_then_convert_物化后_墙钟_08_00_变_utc_00_00() {
    let utc = wall_clock_to_utc_sql(date("2026-09-07"), 8, 0);
    assert_eq!(utc, "2026-09-07 00:00:00");
    // 跨日: 2026-09-08 00:00 Asia/Shanghai → 2026-09-07 16:00:00 UTC
    let utc2 = wall_clock_to_utc_sql(date("2026-09-08"), 0, 0);
    assert_eq!(utc2, "2026-09-07 16:00:00");
}

// ---------------------------------------------------------------------------
// apply_holiday_behavior：SKIP / SHIFT / 调休
// ---------------------------------------------------------------------------

/// 验收点：SKIP 在默认周末（无 seed）= 不生成。
#[test]
fn apply_skip_默认周末_纯空日历() {
    let cal = HolidayCalendar::default();
    let events = apply_holiday_behavior(
        vec![date("2026-09-12"), date("2026-09-14")],
        &cal,
        HolidayBehavior::Skip,
    );
    assert_eq!(events.len(), 2);
    assert!(matches!(events[0], MaterializedEvent::Skip { .. }));
    assert!(matches!(events[1], MaterializedEvent::Keep { .. }));
}

/// 验收点：SHIFT 默认 Sat → Mon。
#[test]
fn apply_shift_默认_sat_到_mon() {
    let cal = HolidayCalendar::default();
    let events = apply_holiday_behavior(vec![date("2026-09-12")], &cal, HolidayBehavior::Shift);
    assert_eq!(
        events,
        vec![MaterializedEvent::Shift {
            original: date("2026-09-12"),
            target: date("2026-09-14"),
        }]
    );
}

/// 验收点：调休工作日按普通工作日处理（不跳过、不顺延）。
#[test]
fn apply_skip_调休工作日_keep() {
    let (_dir, seed_dir) = write_seed_pair();
    let cal = fresh_calendar_from_seed_dir(&seed_dir);
    let events = apply_holiday_behavior(
        vec![date("2026-10-10")],
        &cal,
        HolidayBehavior::Skip,
    );
    assert!(matches!(events[0], MaterializedEvent::Keep { .. }), "调休 SKIP 应 Keep");
}

/// 验收点：SHIFT 时调休工作日可作为目标日;但普通工作日(默认)优先
/// 作为目标。10/1 国庆 → 10/2-10/7 都 seed 为 holiday → 10/8 (Thu,
/// 默认 workday) 是首个非节假日 → target = 10/8。
#[test]
fn apply_shift_节假日后第一个_非节假日_作为_target() {
    let (_dir, seed_dir) = write_seed_pair();
    let cal = fresh_calendar_from_seed_dir(&seed_dir);
    let events = apply_holiday_behavior(
        vec![date("2026-10-01")],
        &cal,
        HolidayBehavior::Shift,
    );
    assert_eq!(
        events,
        vec![MaterializedEvent::Shift {
            original: date("2026-10-01"),
            target: date("2026-10-08"),
        }]
    );
}

// ---------------------------------------------------------------------------
// 物化到 DB：幂等 / 窗口 / 终止条件
// ---------------------------------------------------------------------------

#[test]
fn materialize_weekly_物化_12_周_并_可查回() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_state_with_team_owner(clock);
    let template = upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "周一例会".into(),
            rule: weekly_rule(),
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建模板");

    let counts = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("物化");
    assert_eq!(counts.templates, 1);
    // 12 周 = 84 天,9/10 + 84 = 12/3。期间每周一生成,除非落在
    // 国庆 10/1-10/7 区间:10/5 (Mon) 在国庆 → SKIP。其余 11 个
    // 周一:9/14, 9/21, 9/28, 10/12, 10/19, 10/26, 11/2, 11/9,
    // 11/16, 11/23, 11/30。
    assert_eq!(counts.kept, 11, "12 周内除 10/5 落在国庆外的周一 instance");
    assert_eq!(counts.skipped, 1, "10/5 周一在国庆内被 SKIP");
    assert_eq!(counts.cancelled, 0);
    assert_eq!(counts.shifted, 0);

    // 实例已在 task 表
    let instances: Vec<(i64, String, String, Option<String>, Option<i64>)> = {
        let state = fx.app.state::<kewutong_lib::state::AppState>();
        let conn = state.db().expect("conn");
        let mut stmt = conn
            .prepare(
                "SELECT id, scheduled_at, status, original_scheduled_at, rescheduled_from_id
                 FROM task
                WHERE recurring_template_id = ?1
                ORDER BY scheduled_at",
            )
            .expect("prepare");
        stmt.query_map(rusqlite::params![template.id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .expect("query")
        .filter_map(Result::ok)
        .collect()
    };
    assert_eq!(instances.len(), 11, "10/5 在国庆内 SKIP,剩 11 个");
    // 第一条是 9/14, scheduled_at 应是 UTC 00:00
    assert_eq!(instances[0].1, "2026-09-14 00:00:00");
    assert_eq!(instances[0].2, "Open");
    // original_scheduled_at = scheduled_at（Keep 路径上两者相同）
    assert_eq!(instances[0].3.as_deref(), Some("2026-09-14 00:00:00"));
    // rescheduled_from_id 为 NULL
    assert!(instances[0].4.is_none());
}

#[test]
fn materialize_幂等_重复跑不产生重复_instance() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_state_with_team_owner(clock);
    upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "周一例会".into(),
            rule: weekly_rule(),
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建模板");

    let counts1 = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("第一次");
    let counts2 = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("第二次");
    assert_eq!(counts1.kept, 11, "10/5 在国庆被 SKIP");
    assert_eq!(counts2.kept, 0, "重复物化不应再产生 instance");
    assert_eq!(counts2.cancelled, 0);
    assert_eq!(counts2.shifted, 0);

    let state = fx.app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task WHERE recurring_template_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(total, 11);
}

#[test]
fn materialize_停用模板_不生成_instance() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_state_with_team_owner(clock);
    let template = upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "季节性".into(),
            rule: weekly_rule(),
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建");
    set_recurring_template_enabled(
        fx.app.state(),
        SetRecurringTemplateEnabledArgs { id: template.id, enabled: false },
    )
    .expect("停用");

    let counts = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("物化");
    assert_eq!(counts.templates, 0, "停用模板不参与扫描");
    assert_eq!(counts.kept, 0);
}

#[test]
fn materialize_ends_on_到点即停() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_state_with_team_owner(clock);
    let mut rule = weekly_rule();
    rule.ends = EndsSpec::On { date: "2026-09-21".into() };
    upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "短周期".into(),
            rule,
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建");

    let counts = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("物化");
    // 9/14, 9/21 → 2 个
    assert_eq!(counts.kept, 2);
}

#[test]
fn materialize_ends_after_n_到次即停() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_state_with_team_owner(clock);
    let mut rule = weekly_rule();
    rule.ends = EndsSpec::After { n: 3 };
    upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "三次截止".into(),
            rule,
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建");

    let counts = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("物化");
    // 9/14, 9/21, 9/28 → 3 个
    assert_eq!(counts.kept, 3);
}

/// 验收点(对应 Spec 反馈):`ends_after_n` 是**全局计数**,跨物化窗
/// 口累计。第一窗口物化 3 个后,第二窗口不会再生成。
#[test]
fn materialize_ends_after_n_跨窗口_累计_到点即停() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_state_with_team_owner(clock.clone());
    let mut rule = weekly_rule();
    rule.ends = EndsSpec::After { n: 5 };
    upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "五次截止".into(),
            rule,
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建");

    // 第一窗口 9/10-12/3:5 个 Monday 落在 ends_after_n=5 上限内。
    // 9/14, 9/21, 9/28, 10/5, 10/12 都被取到;但 10/5 在国庆 (10/1-10/7
    // seed holiday) → SKIP 不生成。最终 4 Keep + 1 Skip,合计 5 个
    // occurrence,占满 n=5。
    let c1 = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("首次");
    assert_eq!(c1.kept, 4, "首窗 4 Keep(10/5 SKIP)");
    assert_eq!(c1.skipped, 1, "10/5 在国庆被 SKIP");

    // 5 周后跨周再触发:emitted=4 仍 < 5,新窗口 11/30 之后的 Monday
    // 进来——但窗口起点 10/15 之前已经生成的 (9/14, 9/21, 9/28, 10/12)
    // 算 emitted,新窗口起点 10/15 起的 Monday 中,只剩 10/19 一个能
    // 物化(5 - 4 = 1 个剩余)。
    clock.advance(chrono::TimeDelta::days(35));
    let c2 = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("跨周");
    assert_eq!(c2.kept, 1, "全局已物化 4,本窗口补 1 个 = n");
    assert_eq!(c2.kept + c1.kept, 5, "全局累计 = ends_after_n");

    // 再触发一次:emitted=5 == n,完全停止
    let c3 = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("再触发");
    assert_eq!(c3.kept, 0, "已到 n=5 上限,停止");

    let state = fx.app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task WHERE recurring_template_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(total, 5, "全局累计严格 ≤ n");
}

// ---------------------------------------------------------------------------
// 节假日行为：SKIP / SHIFT / 调休
// ---------------------------------------------------------------------------

#[test]
fn materialize_skip_节假日区间内_不生成_instance() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-28 09:00:00"));
    let fx = fresh_state_with_team_owner(clock);
    let template = upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "月报".into(),
            rule: monthly_day1_rule(HolidayBehavior::Skip),
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建");

    // 9/28 启动 → 窗口 9/28 - 12/27
    // 10/1 (Wed) 国庆节 → SKIP 不生成
    // 11/1 (Sun) 默认 weekend → SKIP
    // 12/1 (Tue) workday → Keep
    let counts = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("物化");
    assert_eq!(counts.kept, 1, "只有 12/1 真正生成");
    assert_eq!(counts.skipped, 2, "10/1 与 11/1 都跳过");

    let state = fx.app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task WHERE recurring_template_id = ?1",
            rusqlite::params![template.id],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(n, 1);
}

#[test]
fn materialize_shift_原日_cancelled_新_instance_rescheduled_from_指向原() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-28 09:00:00"));
    let fx = fresh_state_with_team_owner(clock);
    let template = upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "月报 SHIFT".into(),
            rule: monthly_day1_rule(HolidayBehavior::Shift),
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建");

    let counts = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("物化");
    // 10/1 国庆 → Cancelled + Shift to 10/8 (10/2-10/7 都 holiday, 10/8 是首个默认 workday)
    // 11/1 (Sun, default holiday) → Cancelled + Shift to 11/2 (Mon)
    // 12/1 (Tue, workday) → Keep
    assert_eq!(counts.kept, 1, "只有 12/1 直接生成");
    assert_eq!(counts.shifted, 2, "10/1 → 10/8 与 11/1 → 11/2 都新 instance");
    assert_eq!(counts.cancelled, 2, "10/1 与 11/1 都 Cancelled");

    let state = fx.app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let rows: Vec<(i64, String, String, Option<String>, Option<i64>)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, scheduled_at, status, original_scheduled_at, rescheduled_from_id
                 FROM task
                WHERE recurring_template_id = ?1
                ORDER BY scheduled_at",
            )
            .expect("prepare");
        stmt.query_map(rusqlite::params![template.id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .expect("query")
        .filter_map(Result::ok)
        .collect()
    };
    // 应有 5 条:10/1 cancelled, 10/8 open (shifted), 11/1 cancelled, 11/2 open, 12/1 open
    assert_eq!(rows.len(), 5);

    // 10/1 cancelled
    let oct1 = rows.iter().find(|r| r.1 == "2026-10-01 01:00:00").expect("10/1");
    assert_eq!(oct1.2, "Cancelled");
    // 10/8 (Thu) open with rescheduled_from_id
    let oct8 = rows.iter().find(|r| r.1 == "2026-10-08 01:00:00").expect("10/8");
    assert_eq!(oct8.2, "Open");
    assert_eq!(oct8.4, Some(oct1.0), "10/8 的 rescheduled_from_id 指向 10/1 cancelled");
    // 11/1 cancelled
    let nov1 = rows.iter().find(|r| r.1 == "2026-11-01 01:00:00").expect("11/1");
    assert_eq!(nov1.2, "Cancelled");
    // 11/2 (Mon) 顺延
    let nov2 = rows.iter().find(|r| r.1 == "2026-11-02 01:00:00").expect("11/2");
    assert_eq!(nov2.2, "Open");
    assert_eq!(nov2.4, Some(nov1.0));
    // 12/1 open, rescheduled_from_id NULL
    let dec1 = rows.iter().find(|r| r.1 == "2026-12-01 01:00:00").expect("12/1");
    assert_eq!(dec1.2, "Open");
    assert!(dec1.4.is_none());
}

#[test]
fn materialize_调休工作日_skip_按_普通工作日() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-10-08 09:00:00"));
    let fx = fresh_state_with_team_owner(clock);
    let mut rule = monthly_day1_rule(HolidayBehavior::Skip);
    rule.bymonthday = Some(vec![10]);
    let template = upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "10 号任务".into(),
            rule,
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建");

    let counts = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("物化");
    // 10/10 (Sat) 调休 workday → Keep
    // 11/10 (Tue) workday → Keep
    // 12/10 (Thu) workday → Keep
    assert_eq!(counts.kept, 3);
    assert_eq!(counts.skipped, 0);

    let state = fx.app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let sched: String = conn
        .query_row(
            "SELECT scheduled_at FROM task WHERE recurring_template_id = ?1 AND scheduled_at LIKE '2026-10-10%'",
            rusqlite::params![template.id],
            |row| row.get(0),
        )
        .expect("查 10/10");
    // 10/10 09:00 Asia/Shanghai = 10/10 01:00 UTC
    assert_eq!(sched, "2026-10-10 01:00:00");
}

#[test]
fn materialize_调休工作日_shift_可作为_target() {
    // 模板: 每月 1 号 SHIFT; 启动 9/28
    // 10/1 国庆 → SHIFT 跳到 10/8 (10/2-10/7 都 holiday,10/8 是首个默认 workday)
    // 10/10 (Sat 调休 workday) 在 10/8 之后:不再被选中,因 10/8 已就位。
    // 验证 10/8 instance 存在(且 rescheduled_from_id 指向 10/1 cancelled)。
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-28 09:00:00"));
    let fx = fresh_state_with_team_owner(clock);
    let template = upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "月报 SHIFT 调休".into(),
            rule: monthly_day1_rule(HolidayBehavior::Shift),
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建");

    materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("物化");

    let state = fx.app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    // 10/8 instance 应存在且 rescheduled_from_id 非空
    let (target_status, rescheduled_from): (String, Option<i64>) = conn
        .query_row(
            "SELECT status, rescheduled_from_id FROM task
              WHERE recurring_template_id = ?1 AND scheduled_at = '2026-10-08 01:00:00'",
            rusqlite::params![template.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("查 10/8");
    assert_eq!(target_status, "Open");
    assert!(rescheduled_from.is_some(), "10/8 的 rescheduled_from_id 指向 10/1 cancelled");
}

// ---------------------------------------------------------------------------
// 跨周触发
// ---------------------------------------------------------------------------

#[test]
fn should_materialize_边界_已覆盖于单元测试_本文件_只_pin_跨入_新_周_返回_true() {
    let prev = IsoWeek { year: 2026, week: 37 };
    let curr = IsoWeek { year: 2026, week: 38 };
    assert!(should_materialize_this_tick(Some(prev), curr));
    assert!(!should_materialize_this_tick(Some(curr), curr));
    assert!(should_materialize_this_tick(None, curr));
}

/// 验收点：跨周触发只补增量——窗口往前滚时,旧 instance 不重生成,
/// 新尾部 instance 补上。
#[test]
fn materialize_跨周_trigger_只补增量_不重生成_旧_instance() {
    let clock = Arc::new(kewutong_lib::clock::FixedClock::at("2026-09-10 09:00:00"));
    let fx = fresh_state_with_team_owner(clock.clone());
    upsert_recurring_template(
        fx.app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "周一例会".into(),
            rule: weekly_rule(),
            project_id: None,
            sub_team_id: Some(fx.sub_team_id),
            notes: None,
        },
    )
    .expect("建");

    // 第一周 9/10 触发
    let c1 = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("首次");
    // 11 Keep (10/5 SKIP 国庆)
    assert_eq!(c1.kept, 11, "12 周共 11 个周一(10/5 在国庆被 SKIP)");

    // 5 周后(2026-10-15) 跨周再触发,窗口滑到 10/15 - 1/7
    // 10/15 (Thu) 启动:窗口起点 = 10/15。10/19 起的周一:10/19, 10/26,
    // 11/2, 11/9, 11/16, 11/23, 11/30, 12/7, 12/14, 12/21, 12/28 是
    // 落在新窗口的 11 个;1/4 (2027) 已被 ends_on=2026-12-31 截断。
    // 重叠部分(10/19-11/30) 7 个周一已在旧窗口,UNIQUE 跳过。
    clock.advance(chrono::TimeDelta::days(35)); // 9/10 → 10/15
    let c2 = materialize_from_state(fx.app.state::<kewutong_lib::state::AppState>().inner()).expect("跨周");
    // 新生成:12/7, 12/14, 12/21, 12/28 → 4 个
    assert_eq!(c2.kept, 4, "新 12 周窗口仅生成窗口右端新增 instance");

    let state = fx.app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task WHERE recurring_template_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(total, 15, "跨周不重不漏,共 11+4=15 个 instance");
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

#[test]
fn v005_已建_唯一_索引_task_template_scheduled_at_unique() {
    let conn = kewutong_lib::db::open_in_memory().expect("真迁移库");
    let mut stmt = conn
        .prepare(
            "SELECT name, sql FROM sqlite_master
              WHERE type='index' AND tbl_name='task'
                AND name='idx_task_template_scheduled_at_unique'",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    let row = rows.next().expect("有行");
    let row = row.expect("ok");
    let sql: String = row.get(1).expect("sql");
    assert!(sql.contains("UNIQUE"), "应是 UNIQUE 索引: {sql}");
    assert!(
        sql.contains("WHERE recurring_template_id IS NOT NULL"),
        "应是 partial 索引: {sql}"
    );
}

#[test]
fn v005_已建_scheduled_at_普通索引_供_今日视图_扫_instance() {
    let conn = kewutong_lib::db::open_in_memory().expect("真迁移库");
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master
              WHERE type='index' AND tbl_name='task' AND name='idx_task_scheduled_at'",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    assert!(rows.next().expect("有行").is_some(), "idx_task_scheduled_at 应存在");
}
