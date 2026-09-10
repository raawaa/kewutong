//! `personnel` 命令的集成测试（ticket #17）。
//!
//! 走完整的命令层：DTO 序列化 → 错误映射 → SQLite。直接调用
//! `#[tauri::command]` 标注的 Rust 函数，配 `fresh_db()` 的内存库。
//!
//! 验收点（来自 ticket #17）：
//! - 成功路径：子组 CRUD / 人员 CRUD / 离岗复岗 / 重排 / 删除空子组
//! - 约束拒绝路径：
//!   - `sub_team.name` UNIQUE 违例 → 中文错误
//!   - `UNIQUE(sub_team_id, name)` 同子组重名 → 中文错误
//!   - 必填字符串空白 → 中文错误
//! - 离岗过滤后的花名册查询（`include_deactivated = false`）

mod support;

use kewutong_lib::clock::FixedClock;
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, deactivate_person, delete_person, delete_sub_team,
    list_people, list_sub_teams, reactivate_person, reorder_sub_teams, update_person,
    update_sub_team, CreatePersonArgs, CreateSubTeamArgs, DeleteSubTeamArgs, ListPeopleArgs,
    PersonIdArgs, ReorderSubTeamsArgs, UpdatePersonArgs, UpdateSubTeamArgs,
};
use kewutong_lib::testing::{fresh_db, fresh_db_with_clock};
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;

// ---------------------------------------------------------------------------
// 子组 CRUD
// ---------------------------------------------------------------------------

#[test]
fn 子组_create_list_update_全链路通畅() {
    let app = mock_app(fresh_db());

    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通".into(),
            description: Some("楼宇温控与通风".into()),
        },
    )
    .expect("新建子组应当成功");
    assert!(team.id > 0);
    assert_eq!(team.name, "暖通");
    assert_eq!(team.description.as_deref(), Some("楼宇温控与通风"));
    // 首个子组：sort_order 从 0 开始
    assert_eq!(team.sort_order, 0);

    let second = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "电气".into(),
            description: None,
        },
    )
    .expect("第二个子组应当成功");
    assert_eq!(second.sort_order, 1);

    let listed = list_sub_teams(app.state()).expect("列表应当能取到");
    let names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["暖通", "电气"]);

    let updated = update_sub_team(
        app.state(),
        UpdateSubTeamArgs {
            id: team.id,
            name: "暖通空调".into(),
            description: Some("  ".into()), // 空白描述应折叠为 None
        },
    )
    .expect("编辑子组应当成功");
    assert_eq!(updated.name, "暖通空调");
    assert_eq!(updated.description, None);
}

#[test]
fn 子组重名被拒并给出中文提示() {
    let app = mock_app(fresh_db());
    create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通".into(),
            description: None,
        },
    )
    .expect("首个同名子组应当能建");

    let err = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通".into(),
            description: Some("重名".into()),
        },
    )
    .expect_err("第二个同名子组应当被拒");

    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert_eq!(err.message(), "已存在同名子组。");
}

#[test]
fn 子组空白名被拒() {
    let app = mock_app(fresh_db());
    for blank in ["", "   ", "\t\n"] {
        let err = create_sub_team(
            app.state(),
            CreateSubTeamArgs {
                name: blank.into(),
                description: None,
            },
        )
        .expect_err("空白子组名应当被拒");

        assert_eq!(err.code(), "INVALID_ARGUMENT", "blank = {blank:?}");
        assert_eq!(err.message(), "子组名不能为空。");
    }
}

#[test]
fn 子组_edit_到不存在_id_给中文提示() {
    let app = mock_app(fresh_db());
    let err = update_sub_team(
        app.state(),
        UpdateSubTeamArgs {
            id: 9999,
            name: "某个组".into(),
            description: None,
        },
    )
    .expect_err("不存在的 id 应当被拒");

    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert_eq!(err.message(), "子组不存在或已被删除。");
}

#[test]
fn 子组_删除空子组_成功() {
    let app = mock_app(fresh_db());
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "行政".into(),
            description: None,
        },
    )
    .expect("建组应当成功");

    delete_sub_team(
        app.state(),
        DeleteSubTeamArgs { id: team.id },
    )
    .expect("空子组删除应当成功");

    let listed = list_sub_teams(app.state()).expect("应能列表");
    assert!(listed.is_empty());
}

#[test]
fn 子组_删除非空子组_被拒且明确告知人数() {
    // 离岗人员的记录也仍然算「组下还有人」——空 = 真零,而不是"在岗零"。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));

    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "运行".into(),
            description: None,
        },
    )
    .expect("建组应当成功");

    let on_a = create_person(
        app.state(),
        CreatePersonArgs {
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");
    let _on_b = create_person(
        app.state(),
        CreatePersonArgs {
            name: "乙".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");
    let off = create_person(
        app.state(),
        CreatePersonArgs {
            name: "丙".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");
    deactivate_person(app.state(), PersonIdArgs { id: off.id })
        .expect("离岗应当成功");

    let err = delete_sub_team(app.state(), DeleteSubTeamArgs { id: team.id })
        .expect_err("非空子组删除应当被拒");

    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert_eq!(
        err.message(),
        "该子组下还有 3 名人员,请先调岗或删除人员后再删除子组。"
    );

    // 把在岗的人调走 + 删离岗的人 + 删掉另一名在岗的人员之后,该子组真的空了 → 可以删
    let other_team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "电气".into(),
            description: None,
        },
    )
    .expect("建组应当成功");
    update_person(
        app.state(),
        UpdatePersonArgs {
            id: on_a.id,
            name: "甲".into(),
            sub_team_id: other_team.id,
            contact: "示例".into(),
        },
    )
    .expect("调岗应当成功");
    delete_person(app.state(), PersonIdArgs { id: off.id })
        .expect("删人应当成功");

    let err = delete_sub_team(app.state(), DeleteSubTeamArgs { id: team.id })
        .expect_err("仍有 1 人在岗,该组还是非空");
    assert_eq!(
        err.message(),
        "该子组下还有 1 名人员,请先调岗或删除人员后再删除子组。"
    );
}

#[test]
fn 子组_删除不存在_id_被拒() {
    let app = mock_app(fresh_db());
    let err = delete_sub_team(
        app.state(),
        DeleteSubTeamArgs { id: 4242 },
    )
    .expect_err("删除不存在的 id 应当被拒");

    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert_eq!(err.message(), "子组不存在或已被删除。");
}

#[test]
fn 子组_重排按传入顺序写回_sort_order() {
    let app = mock_app(fresh_db());
    let mut ids = Vec::new();
    for name in ["A", "B", "C", "D"] {
        let team = create_sub_team(
            app.state(),
            CreateSubTeamArgs {
                name: name.into(),
                description: None,
            },
        )
        .expect("建组应当成功");
        ids.push(team.id);
    }

    // 期望顺序：D, B, A, C
    let desired = vec![ids[3], ids[1], ids[0], ids[2]];
    reorder_sub_teams(
        app.state(),
        ReorderSubTeamsArgs {
            ordered_ids: desired.clone(),
        },
    )
    .expect("重排应当成功");

    let listed = list_sub_teams(app.state()).expect("应能列表");
    let ordered_ids: Vec<i64> = listed.iter().map(|s| s.id).collect();
    assert_eq!(ordered_ids, desired);
    let ordered_names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(ordered_names, vec!["D", "B", "A", "C"]);
}

#[test]
fn 子组_重排传入不一致的_id_集合被拒() {
    let app = mock_app(fresh_db());
    let x = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "X".into(),
            description: None,
        },
    )
    .expect("建组应当成功");
    let _y = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "Y".into(),
            description: None,
        },
    )
    .expect("建组应当成功");

    // 库里有 x、y 两个子组,这里只传 x——集合不一致,后端拒绝。
    let err = reorder_sub_teams(
        app.state(),
        ReorderSubTeamsArgs {
            ordered_ids: vec![x.id],
        },
    )
    .expect_err("不一致的 id 集合应当被拒");

    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert_eq!(err.message(), "子组列表与数据库不一致,请刷新后重试。");
}

// ---------------------------------------------------------------------------
// 人员 CRUD + 离岗 / 复岗
// ---------------------------------------------------------------------------

#[test]
fn 人员_create_list_update_全链路通畅() {
    let app = mock_app(fresh_db());
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通".into(),
            description: None,
        },
    )
    .expect("建组应当成功");

    let person = create_person(
        app.state(),
        CreatePersonArgs {
            name: "张三".into(),
            sub_team_id: team.id,
            contact: "工号 001".into(),
        },
    )
    .expect("录人应当成功");
    assert_eq!(person.name, "张三");
    assert_eq!(person.sub_team_id, team.id);
    assert_eq!(person.contact, "工号 001");
    assert!(person.deactivated_at.is_none());

    // 调岗到另一子组
    let team_b = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "电气".into(),
            description: None,
        },
    )
    .expect("建组应当成功");
    let updated = update_person(
        app.state(),
        UpdatePersonArgs {
            id: person.id,
            name: "张三".into(),
            sub_team_id: team_b.id,
            contact: "工号 001".into(),
        },
    )
    .expect("编辑人员应当成功");
    assert_eq!(updated.sub_team_id, team_b.id);

    let listed = list_people(
        app.state(),
        ListPeopleArgs {
            include_deactivated: true,
            sub_team_id: None,
        },
    )
    .expect("列表应当能取到");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].sub_team_id, team_b.id);
}

#[test]
fn 人员_同子组重名被拒_跨组同名允许() {
    let app = mock_app(fresh_db());
    let team_a = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "A".into(),
            description: None,
        },
    )
    .expect("建组应当成功");
    let team_b = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "B".into(),
            description: None,
        },
    )
    .expect("建组应当成功");

    create_person(
        app.state(),
        CreatePersonArgs {
            name: "张三".into(),
            sub_team_id: team_a.id,
            contact: "示例".into(),
        },
    )
    .expect("首个同名人员应当能录");

    // 同子组重名 → 拒
    let err = create_person(
        app.state(),
        CreatePersonArgs {
            name: "张三".into(),
            sub_team_id: team_a.id,
            contact: "示例".into(),
        },
    )
    .expect_err("同子组重名应当被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert_eq!(err.message(), "同子组内已存在同名人员。");

    // 跨子组同名 → 允许
    create_person(
        app.state(),
        CreatePersonArgs {
            name: "张三".into(),
            sub_team_id: team_b.id,
            contact: "示例".into(),
        },
    )
    .expect("跨子组同名应当能录");
}

#[test]
fn 人员_空白字段全部被拒() {
    let app = mock_app(fresh_db());
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "A".into(),
            description: None,
        },
    )
    .expect("建组应当成功");

    for (name, contact, expected) in [
        ("", "示例", "姓名不能为空。"),
        ("   ", "示例", "姓名不能为空。"),
        ("甲", "", "联系方式不能为空。"),
        ("甲", " \t", "联系方式不能为空。"),
    ] {
        let err = create_person(
            app.state(),
            CreatePersonArgs {
                name: name.into(),
                sub_team_id: team.id,
                contact: contact.into(),
            },
        )
        .expect_err("空白字段应当被拒");
        assert_eq!(err.code(), "INVALID_ARGUMENT", "name={name:?} contact={contact:?}");
        assert_eq!(err.message(), expected);
    }
}

#[test]
fn 人员_所属子组不存在被拒() {
    let app = mock_app(fresh_db());
    let err = create_person(
        app.state(),
        CreatePersonArgs {
            name: "甲".into(),
            sub_team_id: 9999,
            contact: "示例".into(),
        },
    )
    .expect_err("指向不存在的子组应当被拒");

    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert_eq!(err.message(), "所属子组不存在。");
}

#[test]
fn 人员_edit_到不存在_id_给中文提示() {
    let app = mock_app(fresh_db());
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "A".into(),
            description: None,
        },
    )
    .expect("建组应当成功");

    let err = update_person(
        app.state(),
        UpdatePersonArgs {
            id: 9999,
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect_err("不存在的人员 id 应当被拒");

    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert_eq!(err.message(), "人员不存在或已被删除。");
}

#[test]
fn 人员_离岗复岗_往返_deactivated_at_跟_clock_走() {
    let clock = Arc::new(FixedClock::at("2026-09-10 08:00:00"));
    let app = mock_app(fresh_db_with_clock(clock.clone()));

    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "A".into(),
            description: None,
        },
    )
    .expect("建组应当成功");
    let person = create_person(
        app.state(),
        CreatePersonArgs {
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");

    clock.advance(chrono::TimeDelta::days(3) + chrono::TimeDelta::hours(4));
    let off = deactivate_person(app.state(), PersonIdArgs { id: person.id })
        .expect("离岗应当成功");
    assert_eq!(off.deactivated_at.as_deref(), Some("2026-09-13 12:00:00"));

    // 重复离岗 → 拒
    let err = deactivate_person(app.state(), PersonIdArgs { id: person.id })
        .expect_err("离岗状态重复离岗应当被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert_eq!(err.message(), "该人员已是离岗状态,无需重复操作。");

    clock.advance(chrono::TimeDelta::days(10));
    let back = reactivate_person(app.state(), PersonIdArgs { id: person.id })
        .expect("复岗应当成功");
    assert_eq!(back.deactivated_at, None);

    // 重复复岗 → 拒
    let err = reactivate_person(app.state(), PersonIdArgs { id: person.id })
        .expect_err("在岗状态重复复岗应当被拒");
    assert_eq!(err.message(), "该人员已是在岗状态,无需重复操作。");
}

#[test]
fn 人员_离岗复岗针对不存在_id_给中文提示() {
    let app = mock_app(fresh_db());

    let err = deactivate_person(app.state(), PersonIdArgs { id: 9999 })
        .expect_err("不存在的人员离岗应当被拒");
    assert_eq!(err.message(), "人员不存在或已被删除。");

    let err = reactivate_person(app.state(), PersonIdArgs { id: 9999 })
        .expect_err("不存在的人员复岗应当被拒");
    assert_eq!(err.message(), "人员不存在或已被删除。");
}

#[test]
fn 人员_物理删除_记录不在花名册() {
    let app = mock_app(fresh_db());
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "A".into(),
            description: None,
        },
    )
    .expect("建组应当成功");
    let person = create_person(
        app.state(),
        CreatePersonArgs {
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");

    delete_person(app.state(), PersonIdArgs { id: person.id })
        .expect("删除人员应当成功");

    let listed = list_people(
        app.state(),
        ListPeopleArgs {
            include_deactivated: true,
            sub_team_id: None,
        },
    )
    .expect("列表应能取到");
    assert!(listed.is_empty());

    // 删第二次给中文提示
    let err = delete_person(app.state(), PersonIdArgs { id: person.id })
        .expect_err("重复删除应当被拒");
    assert_eq!(err.message(), "人员不存在或已被删除。");
}

// ---------------------------------------------------------------------------
// 离岗过滤后的花名册查询（验收点）
// ---------------------------------------------------------------------------

#[test]
fn 花名册_include_deactivated_默认包含离岗人员() {
    let clock = Arc::new(FixedClock::at("2026-09-10 08:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));

    let team_a = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "A".into(),
            description: None,
        },
    )
    .expect("建组应当成功");
    let team_b = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "B".into(),
            description: None,
        },
    )
    .expect("建组应当成功");

    let on_duty_a = create_person(
        app.state(),
        CreatePersonArgs {
            name: "在岗A".into(),
            sub_team_id: team_a.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");
    let off_a = create_person(
        app.state(),
        CreatePersonArgs {
            name: "离岗A".into(),
            sub_team_id: team_a.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");
    let on_duty_b = create_person(
        app.state(),
        CreatePersonArgs {
            name: "在岗B".into(),
            sub_team_id: team_b.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");

    deactivate_person(app.state(), PersonIdArgs { id: off_a.id })
        .expect("离岗应当成功");

    // 人员管理界面（include_deactivated = true）：看到所有人
    let listed = list_people(
        app.state(),
        ListPeopleArgs {
            include_deactivated: true,
            sub_team_id: None,
        },
    )
    .expect("列表应当能取到");
    let all_ids: Vec<i64> = listed.iter().map(|p| p.id).collect();
    assert_eq!(all_ids.len(), 3);
    assert!(all_ids.contains(&on_duty_a.id));
    assert!(all_ids.contains(&off_a.id));
    assert!(all_ids.contains(&on_duty_b.id));

    // 排序：按 (sub_team_id, 是否离岗, id) 升序——同一子组内在岗在前,
    // 离岗紧随其后,各自子组之间按 id 升序排好,UI 上按子组分段时即可直接渲染。
    // 期望顺序：team_a 在前(在岗A → 离岗A),team_b 紧随其后(在岗B)。
    let order: Vec<&str> = listed.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(order, vec!["在岗A", "离岗A", "在岗B"]);
}

#[test]
fn 花名册_include_deactivated_为假时_离岗人员被滤掉() {
    let clock = Arc::new(FixedClock::at("2026-09-10 08:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));

    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "A".into(),
            description: None,
        },
    )
    .expect("建组应当成功");
    let on_duty = create_person(
        app.state(),
        CreatePersonArgs {
            name: "在岗".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");
    let off = create_person(
        app.state(),
        CreatePersonArgs {
            name: "离岗".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");
    deactivate_person(app.state(), PersonIdArgs { id: off.id })
        .expect("离岗应当成功");

    // 指派候选（include_deactivated = false）：只看到在岗
    let listed = list_people(
        app.state(),
        ListPeopleArgs {
            include_deactivated: false,
            sub_team_id: None,
        },
    )
    .expect("列表应当能取到");
    let names: Vec<&str> = listed.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["在岗"]);
    assert_eq!(listed[0].id, on_duty.id);

    // 配合 sub_team_id 过滤
    let in_team = list_people(
        app.state(),
        ListPeopleArgs {
            include_deactivated: false,
            sub_team_id: Some(team.id),
        },
    )
    .expect("按子组过滤应当能取到");
    assert_eq!(in_team.len(), 1);
    assert_eq!(in_team[0].id, on_duty.id);

    // 离岗过滤 + 不存在的子组：返回空集
    let empty = list_people(
        app.state(),
        ListPeopleArgs {
            include_deactivated: false,
            sub_team_id: Some(9999),
        },
    )
    .expect("空结果也是合法的");
    assert!(empty.is_empty());
}