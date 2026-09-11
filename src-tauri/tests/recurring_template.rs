//! `recurring_template` 命令的集成测试（ticket #24）。
//!
//! 验收点：
//! - `recurring_template` 表按 ADR 0001 §3.4 + V004 全列：freq 4 值 /
//!   holiday_behavior 2 值 / `ends_on` XOR `ends_after_n` CHECK /
//!   `project_id` OR `sub_team_id` 至少一项非空 CHECK
//! - `rrule_text` 由 `upsert` 入口派生,DB 不重算;解析时优先信任结构化
//!   字段,`rrule_text` 仅作 sanity check
//! - bitmask（MO=1<<0..SU=1<<6） + bymonthday（0=月末） 编码落库后再读
//!   仍一致
//! - 索引 `recurring_template(enabled, ends_on)` 已建
//! - 模板可停用 / 启用而不删除
//! - 四类规则（每周多日 / 每月多日 / 月末 / 季度）的结构化字段 ↔
//!   `rrule_text` 双向一致
//!
//! 单元侧在 `recurring.rs` 与 `commands/recurring_template.rs` 的
//! `#[cfg(test)] mod tests`；本文件走 `fresh_db()` 内存库的端到端集成路径。

mod support;

use kewutong_lib::clock::FixedClock;
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, CreatePersonArgs, CreateSubTeamArgs,
};
use kewutong_lib::commands::project::{create_project, CreateProjectArgs};
use kewutong_lib::commands::recurring_template::{
    list_recurring_templates, set_recurring_template_enabled, upsert_recurring_template,
    ListRecurringTemplatesArgs, RecurringTemplate, SetRecurringTemplateEnabledArgs,
    UpsertRecurringTemplateArgs,
};
use kewutong_lib::recurring::{EndsSpec, Freq, HolidayBehavior, StructuredRule};
use kewutong_lib::recurring::byday;
use kewutong_lib::testing::{fresh_db_with_clock};
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

fn fresh_state_with_team_owner_and_project(
    clock: &Arc<FixedClock>,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    kewutong_lib::commands::personnel::Person,
    i64, // sub_team_id
) {
    let app = mock_app(fresh_db_with_clock(clock.clone()));
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通".into(),
            description: None,
        },
    )
    .expect("建组");
    let owner = create_person(
        app.state(),
        CreatePersonArgs {
            name: "张三".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");
    (app, owner, team.id)
}

fn weekly_rule_struct() -> StructuredRule {
    StructuredRule {
        freq: Freq::Weekly,
        byday_mask: byday::MO | byday::WE,
        bymonthday: None,
        bymonth: None,
        byhour: 8,
        byminute: 0,
        iana_zone: "Asia/Shanghai".into(),
        ends: EndsSpec::On {
            date: "2026-12-31".into(),
        },
        holiday_behavior: HolidayBehavior::Skip,
    }
}

fn monthly_rule_struct() -> StructuredRule {
    StructuredRule {
        freq: Freq::Monthly,
        byday_mask: 0,
        bymonthday: Some(vec![1, 15]),
        bymonth: None,
        byhour: 9,
        byminute: 0,
        iana_zone: "Asia/Shanghai".into(),
        ends: EndsSpec::After { n: 24 },
        holiday_behavior: HolidayBehavior::Shift,
    }
}

fn monthly_last_day_rule_struct() -> StructuredRule {
    StructuredRule {
        freq: Freq::Monthly,
        byday_mask: 0,
        bymonthday: Some(vec![0]),
        bymonth: None,
        byhour: 16,
        byminute: 30,
        iana_zone: "Asia/Shanghai".into(),
        ends: EndsSpec::On {
            date: "2027-06-30".into(),
        },
        holiday_behavior: HolidayBehavior::Skip,
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
        ends: EndsSpec::On {
            date: "2030-01-01".into(),
        },
        holiday_behavior: HolidayBehavior::Skip,
    }
}

// ---------------------------------------------------------------------------
// upsert + 读回
// ---------------------------------------------------------------------------

#[test]
fn upsert_新建_weekly_读回字段_与_入参一致() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let saved = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "周一三早会".into(),
            rule: weekly_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: Some("科室例会".into()),
        },
    )
    .expect("建模板");

    assert!(saved.id > 0);
    assert_eq!(saved.name, "周一三早会");
    assert_eq!(saved.freq, Freq::Weekly);
    assert_eq!(saved.byday_mask, byday::MO | byday::WE);
    assert!(saved.bymonthday.is_none());
    assert!(saved.bymonth.is_none());
    assert_eq!(saved.byhour, 8);
    assert_eq!(saved.byminute, 0);
    assert_eq!(saved.iana_zone, "Asia/Shanghai");
    assert_eq!(saved.ends, EndsSpec::On { date: "2026-12-31".into() });
    assert_eq!(saved.holiday_behavior, HolidayBehavior::Skip);
    assert!(saved.enabled);
    assert_eq!(saved.notes.as_deref(), Some("科室例会"));
    assert_eq!(saved.sub_team_id, Some(sub_team_id));
    assert!(saved.project_id.is_none());
    // rrule_text 由 App 层派生,落库与读回一致
    assert_eq!(
        saved.rrule_text,
        "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=0;UNTIL=20261231T235959Z"
    );
}

#[test]
fn upsert_编辑_改_name_与_ends_且_id_保留() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let saved = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "原名".into(),
            rule: weekly_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("建");

    clock.advance(chrono::TimeDelta::hours(1));
    let mut edited_rule = weekly_rule_struct();
    edited_rule.ends = EndsSpec::After { n: 12 };
    let updated = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: Some(saved.id),
            name: "新名".into(),
            rule: edited_rule,
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: Some("改后".into()),
        },
    )
    .expect("改");

    assert_eq!(updated.id, saved.id);
    assert_eq!(updated.name, "新名");
    assert_eq!(updated.ends, EndsSpec::After { n: 12 });
    assert_eq!(updated.notes.as_deref(), Some("改后"));
    assert!(updated.rrule_text.contains("COUNT=12"));
}

/// 票面 AC:可停用 / 启用 Template 而不删除。**编辑规则不应顺手把模板
/// 复活**——启停由 set_recurring_template_enabled 单管,upsert 刻意不写
/// enabled 列。
#[test]
fn upsert_编辑_不改_enabled_已停用模板保持停用() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let saved = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "季节性".into(),
            rule: weekly_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("建");
    set_recurring_template_enabled(
        app.state(),
        SetRecurringTemplateEnabledArgs {
            id: saved.id,
            enabled: false,
        },
    )
    .expect("停用");

    let updated = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: Some(saved.id),
            name: "季节性改个名".into(),
            rule: weekly_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("改");

    assert!(!updated.enabled, "编辑不应复活已停用的模板");
    assert_eq!(updated.name, "季节性改个名");
}

#[test]
fn upsert_空白名被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    for blank in ["", "   ", "\t"] {
        let err = upsert_recurring_template(
            app.state(),
            UpsertRecurringTemplateArgs {
                id: None,
                name: blank.into(),
                rule: weekly_rule_struct(),
                project_id: None,
                sub_team_id: Some(sub_team_id),
                notes: None,
            },
        )
        .expect_err("空白名应被拒");
        assert_eq!(err.code(), "INVALID_ARGUMENT", "blank={blank:?}");
        assert!(err.message().contains("模板名称"), "blank={blank:?}");
    }
}

#[test]
fn upsert_project_id_不存在被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let err = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "某".into(),
            rule: weekly_rule_struct(),
            project_id: Some(9999),
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect_err("不存在的 project_id 应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("项目"));
}

#[test]
fn upsert_sub_team_id_不存在被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, _sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let err = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "某".into(),
            rule: weekly_rule_struct(),
            project_id: None,
            sub_team_id: Some(9999),
            notes: None,
        },
    )
    .expect_err("不存在的 sub_team_id 应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("子组"));
}

// ---------------------------------------------------------------------------
// 票面 AC：DB CHECK 直接生效
// ---------------------------------------------------------------------------

/// 内部 helper：拿一条 already-valid 模板的 (id, name, rule) 元组,然后直
/// 接走 SQL UPDATE 把 ends_on / ends_after_n 写成违反 XOR 的形状——目的
/// 是验证 V004 的 CHECK 真的写在了 DB 上,不是只在 App 层。
fn upsert_one_and_get_id(
    app: &tauri::App<tauri::test::MockRuntime>,
    name: &str,
    rule: StructuredRule,
    sub_team_id: i64,
) -> RecurringTemplate {
    upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: name.into(),
            rule,
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("建")
}

#[test]
fn db_check_ends_xor_都填被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);
    let saved = upsert_one_and_get_id(&app, "x", weekly_rule_struct(), sub_team_id);

    let state = app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    // 直接 SQL 把 ends_on 与 ends_after_n 同时填上,绕开 App 层 XOR 校验
    let result = conn.execute(
        "UPDATE recurring_template SET ends_on = ?1, ends_after_n = ?2 WHERE id = ?3",
        rusqlite::params!["2026-12-31", 10i64, saved.id],
    );
    assert!(result.is_err(), "DB CHECK XOR 应当拒绝");
    let err = result.expect_err("已拒");
    assert!(
        err.to_string().contains("CHECK") || err.to_string().contains("constraint"),
        "err={err}"
    );
}

#[test]
fn db_check_ends_xor_都不填被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);
    let saved = upsert_one_and_get_id(&app, "x", weekly_rule_struct(), sub_team_id);

    let state = app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let result = conn.execute(
        "UPDATE recurring_template SET ends_on = NULL, ends_after_n = NULL WHERE id = ?1",
        rusqlite::params![saved.id],
    );
    assert!(result.is_err(), "DB CHECK XOR 应当拒绝");
}

#[test]
fn db_check_scope_两者都空被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);
    let saved = upsert_one_and_get_id(&app, "x", weekly_rule_struct(), sub_team_id);

    let state = app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let result = conn.execute(
        "UPDATE recurring_template SET project_id = NULL, sub_team_id = NULL WHERE id = ?1",
        rusqlite::params![saved.id],
    );
    assert!(result.is_err(), "DB CHECK scope 应当拒绝");
}

#[test]
fn db_check_scope_两者都填允许() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);
    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "P".into(),
            owner_person_id: owner.id,
            sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建项目");

    let saved = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "scope 双绑".into(),
            rule: weekly_rule_struct(),
            project_id: Some(project.id),
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("应允许:项目级 + 子组级");

    assert_eq!(saved.project_id, Some(project.id));
    assert_eq!(saved.sub_team_id, Some(sub_team_id));
}

#[test]
fn db_check_freq_枚举_非法值被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);
    let saved = upsert_one_and_get_id(&app, "x", weekly_rule_struct(), sub_team_id);

    let state = app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let result = conn.execute(
        "UPDATE recurring_template SET freq = 'HOURLY' WHERE id = ?1",
        rusqlite::params![saved.id],
    );
    assert!(result.is_err(), "DB CHECK freq 枚举应拒绝");
}

#[test]
fn db_check_holiday_behavior_非法值被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);
    let saved = upsert_one_and_get_id(&app, "x", weekly_rule_struct(), sub_team_id);

    let state = app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let result = conn.execute(
        "UPDATE recurring_template SET holiday_behavior = 'IGNORE' WHERE id = ?1",
        rusqlite::params![saved.id],
    );
    assert!(result.is_err(), "DB CHECK holiday_behavior 枚举应拒绝");
}

#[test]
fn db_check_json_valid_拒非法_json() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);
    let saved = upsert_one_and_get_id(&app, "x", weekly_rule_struct(), sub_team_id);

    let state = app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let result = conn.execute(
        "UPDATE recurring_template SET bymonthday = '{not-json}' WHERE id = ?1",
        rusqlite::params![saved.id],
    );
    assert!(result.is_err(), "DB CHECK json_valid 应拒非 JSON 字符串");
}

// ---------------------------------------------------------------------------
// 票面 AC：四类规则的双向一致
// ---------------------------------------------------------------------------

#[test]
fn weekly_多日_结构化_与_rrule_text_读回一致() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let saved = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "周一三".into(),
            rule: weekly_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("建");
    assert_eq!(saved.byday_mask, byday::MO | byday::WE);
    assert_eq!(
        saved.rrule_text,
        "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=0;UNTIL=20261231T235959Z"
    );
}

#[test]
fn monthly_1_15_结构化_与_rrule_text_读回一致() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let saved = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "每月 1/15".into(),
            rule: monthly_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("建");
    assert_eq!(saved.bymonthday.as_deref(), Some(&[1, 15][..]));
    assert_eq!(saved.ends, EndsSpec::After { n: 24 });
    assert_eq!(saved.holiday_behavior, HolidayBehavior::Shift);
    assert_eq!(
        saved.rrule_text,
        "FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0;COUNT=24"
    );
}

#[test]
fn monthly_月末_结构化_与_rrule_text_读回一致_且_0_折叠() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let saved = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "月末".into(),
            rule: monthly_last_day_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("建");
    // 业务层 0 折叠为 0 入库,RRULE 落 -1
    assert_eq!(saved.bymonthday.as_deref(), Some(&[0][..]));
    assert!(saved.rrule_text.contains("BYMONTHDAY=-1"));
    assert!(saved.rrule_text.contains("UNTIL=20270630T235959Z"));
}

#[test]
fn quarterly_1_4_7_10_结构化_与_rrule_text_读回一致() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let saved = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "季度首月".into(),
            rule: quarterly_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("建");
    assert_eq!(saved.bymonthday.as_deref(), Some(&[1][..]));
    assert_eq!(saved.bymonth.as_deref(), Some(&[1, 4, 7, 10][..]));
    assert_eq!(
        saved.rrule_text,
        "FREQ=YEARLY;BYMONTHDAY=1;BYMONTH=1,4,7,10;BYHOUR=10;BYMINUTE=0;UNTIL=20300101T235959Z"
    );
}

#[test]
fn 四类规则_结构化_字段_与_rrule_text_双向_互逆_走_db() {
    // 与 `recurring::tests::四类规则_结构化字段_与_派生_rrule_互逆` 配
    // 对——后者是纯函数侧,本测试多走一趟"落库再读回"以保证 row ↔
    // DTO 映射的 `bymonthday` / `bymonth` JSON 解析与 i64 ↔ i32 转换不丢
    // 精度;并实际把 `rrule_text` 喂给 `parse_rrule_into_structured`,与原
    // 入参结构化字段逐字段比对——完成"双向"路径。
    use kewutong_lib::recurring::parse_rrule_into_structured;

    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let rules = [
        ("每周多日", weekly_rule_struct()),
        ("每月多日", monthly_rule_struct()),
        ("每月末", monthly_last_day_rule_struct()),
        ("季度首月", quarterly_rule_struct()),
    ];
    let mut ids: Vec<(String, i64, StructuredRule)> = Vec::new();
    for (name, rule) in rules {
        let saved = upsert_recurring_template(
            app.state(),
            UpsertRecurringTemplateArgs {
                id: None,
                name: name.into(),
                rule: rule.clone(),
                project_id: None,
                sub_team_id: Some(sub_team_id),
                notes: None,
            },
        )
        .expect("建");
        ids.push((name.into(), saved.id, rule));
    }

    let listed = list_recurring_templates(
        app.state(),
        ListRecurringTemplatesArgs { include_disabled: true },
    )
    .expect("列");

    for (name, id, original_rule) in ids {
        let row = listed.iter().find(|t| t.id == id).expect("找得到");
        let raw = match name.as_str() {
            "每周多日" => "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=0;UNTIL=20261231T235959Z",
            "每月多日" => "FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0;COUNT=24",
            "每月末" => "FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=16;BYMINUTE=30;UNTIL=20270630T235959Z",
            "季度首月" => {
                "FREQ=YEARLY;BYMONTHDAY=1;BYMONTH=1,4,7,10;BYHOUR=10;BYMINUTE=0;UNTIL=20300101T235959Z"
            }
            other => panic!("未知用例: {other}"),
        };
        assert_eq!(row.rrule_text, raw, "name={name}");

        // 真的过一遍 parser——而不是只看字面量相等。
        let parsed = parse_rrule_into_structured(&row.rrule_text)
            .unwrap_or_else(|err| panic!("name={name} 解析失败: {err}"));
        assert_eq!(parsed.freq, original_rule.freq, "name={name} freq");
        assert_eq!(parsed.byday_mask, original_rule.byday_mask, "name={name} byday_mask");
        assert_eq!(parsed.bymonthday, original_rule.bymonthday, "name={name} bymonthday");
        assert_eq!(parsed.bymonth, original_rule.bymonth, "name={name} bymonth");
        assert_eq!(parsed.byhour, original_rule.byhour, "name={name} byhour");
        assert_eq!(parsed.byminute, original_rule.byminute, "name={name} byminute");
        assert_eq!(parsed.ends, original_rule.ends, "name={name} ends");
    }
}

// ---------------------------------------------------------------------------
// 列表 / 启停
// ---------------------------------------------------------------------------

#[test]
fn list_默认仅返回_已启用_已停用_需_include_disabled() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let a = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "A".into(),
            rule: weekly_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("建A");
    let _b = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "B".into(),
            rule: monthly_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: None,
        },
    )
    .expect("建B");

    set_recurring_template_enabled(
        app.state(),
        SetRecurringTemplateEnabledArgs { id: a.id, enabled: false },
    )
    .expect("停用 A");

    let default_list = list_recurring_templates(
        app.state(),
        ListRecurringTemplatesArgs { include_disabled: false },
    )
    .expect("默认列");
    let ids: Vec<i64> = default_list.iter().map(|t| t.id).collect();
    assert!(!ids.contains(&a.id), "已停用 A 不在默认列");
    let a_row = default_list.iter().find(|t| t.id == _b.id).expect("B 应在");
    assert!(a_row.enabled);

    let full = list_recurring_templates(
        app.state(),
        ListRecurringTemplatesArgs { include_disabled: true },
    )
    .expect("全列");
    let full_a = full.iter().find(|t| t.id == a.id).expect("A 应在全列里");
    assert!(!full_a.enabled, "A 已是停用态");
}

#[test]
fn set_enabled_启用_再停用_不丢任何字段() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let saved = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "切来切去".into(),
            rule: weekly_rule_struct(),
            project_id: None,
            sub_team_id: Some(sub_team_id),
            notes: Some("备注".into()),
        },
    )
    .expect("建");

    let disabled = set_recurring_template_enabled(
        app.state(),
        SetRecurringTemplateEnabledArgs { id: saved.id, enabled: false },
    )
    .expect("停");
    assert!(!disabled.enabled);
    assert_eq!(disabled.byday_mask, saved.byday_mask);
    assert_eq!(disabled.rrule_text, saved.rrule_text);
    assert_eq!(disabled.notes.as_deref(), Some("备注"));

    let re_enabled = set_recurring_template_enabled(
        app.state(),
        SetRecurringTemplateEnabledArgs { id: saved.id, enabled: true },
    )
    .expect("启");
    assert!(re_enabled.enabled);
    assert_eq!(re_enabled.byday_mask, saved.byday_mask);
}

#[test]
fn set_enabled_不存在_id_被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));

    let err = set_recurring_template_enabled(
        app.state(),
        SetRecurringTemplateEnabledArgs { id: 9999, enabled: false },
    )
    .expect_err("不存在的 id 应被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("模板"));
}

// ---------------------------------------------------------------------------
// rrule_text 作 sanity check（票面 AC）
// ---------------------------------------------------------------------------

#[test]
fn 读路径_rrule_text_与结构化字段不一致时报_internal_错误() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _owner, sub_team_id) = fresh_state_with_team_owner_and_project(&clock);

    let saved = upsert_one_and_get_id(&app, "x", weekly_rule_struct(), sub_team_id);

    // 直接写一个与结构化字段不一致的 rrule_text,绕开 App 层派生。
    // 关键:不要把 `state.db()` 的 guard 跨过 list_recurring_templates 调
    // 用——`AppState.db` 内部是 `Mutex<Connection>`,跨调用持锁会双重锁死。
    {
        let state = app.state::<kewutong_lib::state::AppState>();
        let conn = state.db().expect("conn");
        conn.execute(
            "UPDATE recurring_template SET rrule_text = 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0;UNTIL=20261231T235959Z' WHERE id = ?1",
            rusqlite::params![saved.id],
        )
        .expect("写坏 rrule_text");
    }

    let result = list_recurring_templates(
        app.state(),
        ListRecurringTemplatesArgs { include_disabled: true },
    );
    let err = result.expect_err("不一致应被读路径拒掉");
    assert_eq!(err.code(), "INTERNAL", "漂移属存储损坏,不应无声通过");
    // AppError::Internal 的 `message` 是中文固定话术,真正的 detail 在
    // `detail()` 里——校验 detail 能定位到 rrule_text 漂移。
    let detail = err.detail().expect("Internal 错误必有 detail");
    assert!(
        detail.contains("rrule_text") || detail.contains("RRULE"),
        "detail: {detail}"
    );
}

#[test]
fn 索引_recurring_template_enabled_ends_on_已建() {
    use rusqlite::Connection;
    let conn = Connection::open_in_memory().expect("conn");
    // 跑一遍 refinery 迁移,让 V004 把索引建上
    let _ = kewutong_lib::db::open_in_memory().expect("db"); // 仅作 smoke

    // 用 SQLite 内置 sqlite_master 直接查索引名。
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_recurring_template_enabled_ends_on'")
        .expect("prepare");
    // 此 conn 是空的——上面 _ 已建过真迁移的库,索引在那里,这里仅做
    // 编译期断言;真正的断言放下面,直接打开 db 拿连接。
    let _ = stmt.query([]).map(|_| ()).ok();

    // 真正断言:在隔离 conn 上手动建 V004 schema 不可行,改走:开一个真
    // 内存库,直接查 sqlite_master。
    let real = kewutong_lib::db::open_in_memory().expect("真迁移库");
    let name: String = real
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='recurring_template'",
            [],
            |row| row.get(0),
        )
        .expect("recurring_template 至少有 1 个索引");
    assert!(
        name.contains("idx_recurring_template_enabled_ends_on"),
        "got: {name}"
    );
}

// ---------------------------------------------------------------------------
// 隔离收尾：V001 里的"占位骨架"已经被 V004 替换
// ---------------------------------------------------------------------------

#[test]
fn v004_迁移_已_drop_占位_并_recreate() {
    // 间接验证:开一个真内存库,确认 recurring_template 含 18 列(SPEC
    // §3.4 + 8 个索引列名 + 几个保留),而且 `name` 列存在(占位表没有)。
    let conn = kewutong_lib::db::open_in_memory().expect("真迁移库");
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(recurring_template)")
        .expect("pragma")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query")
        .filter_map(Result::ok)
        .collect();
    for expected in [
        "id", "name", "freq", "byday_mask", "bymonthday", "bymonth",
        "byhour", "byminute", "iana_zone", "ends_on", "ends_after_n",
        "holiday_behavior", "rrule_text", "project_id", "sub_team_id",
        "enabled", "notes", "created_at",
    ] {
        assert!(
            columns.iter().any(|c| c == expected),
            "缺列 {expected}：{columns:?}"
        );
    }
}