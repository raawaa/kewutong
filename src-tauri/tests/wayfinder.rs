//! ticket #28 的集成测试：⌘K 全局命令面板的命令层。
//!
//! 验收点（来自 ticket #28）：
//! - 模糊匹配可导航到人员 / 项目 / 任务三类目标
//! - 选中目标跳转到对应视图并定位（前端侧,见 `App.test.tsx`）
//! - 面板内可直接触发新建任务（前端侧,见 `App.test.tsx`）
//! - **候选查询走命令层,前端不含匹配逻辑**
//! - 键盘全程可操作（前端侧）
//!
//! 与其它 ticket 的测试约定一致：走完整命令层（DTO + 错误映射 + SQLite）,
//! 配 `fresh_db_with_clock` 的内存库。

mod support;

use kewutong_lib::clock::FixedClock;
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, deactivate_person, CreatePersonArgs, CreateSubTeamArgs,
    PersonIdArgs,
};
use kewutong_lib::commands::project::{create_project, CreateProjectArgs};
use kewutong_lib::commands::task::{
    create_task, CreateTaskArgs,
};
use kewutong_lib::commands::wayfinder::{wayfinder_search, WayfinderSearchArgs};
use kewutong_lib::testing::fresh_db_with_clock;
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;

// ---------------------------------------------------------------------------
// 公共 fixture
// ---------------------------------------------------------------------------

/// 三种子组 + 多名人员 + 多个项目 + 一些任务——命令面板三类目标都能命中。
fn fixture_command_palette(
    clock: Arc<FixedClock>,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    FixtureHandles,
) {
    let app = mock_app(fresh_db_with_clock(clock));

    let team_warm = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "通风空调".into(),
            description: None,
        },
    )
    .expect("建通风空调组");
    let team_elec = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "强弱电".into(),
            description: None,
        },
    )
    .expect("建强弱电组");

    let warm_a = create_person(
        app.state(),
        CreatePersonArgs {
            name: "暖通甲".into(),
            sub_team_id: team_warm.id,
            contact: "示例".into(),
        },
    )
    .expect("录暖通甲");
    let warm_b = create_person(
        app.state(),
        CreatePersonArgs {
            name: "张小暖".into(),
            sub_team_id: team_warm.id,
            contact: "示例".into(),
        },
    )
    .expect("录张小暖");
    let elec_c = create_person(
        app.state(),
        CreatePersonArgs {
            name: "电气丙".into(),
            sub_team_id: team_elec.id,
            contact: "示例".into(),
        },
    )
    .expect("录电气丙");

    let project_warm = create_project(
        app.state(),
        CreateProjectArgs {
            name: "综合楼改造".into(),
            owner_person_id: warm_a.id,
            sub_team_id: team_warm.id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建综合楼改造");
    let project_elec = create_project(
        app.state(),
        CreateProjectArgs {
            name: "外委合同评审".into(),
            owner_person_id: elec_c.id,
            sub_team_id: team_elec.id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建外委合同评审");
    let _ = project_warm;

    let task_outer = create_task(
        app.state(),
        CreateTaskArgs {
            title: "外委合同评审".into(),
            description: Some("本年度外委合同集中评审".into()),
            owner_person_id: warm_a.id,
            project_id: Some(project_warm.id),
            due_date: Some("2026-09-15".into()),
        },
    )
    .expect("建任务");

    let task_warm = create_task(
        app.state(),
        CreateTaskArgs {
            title: "空调检修".into(),
            description: None,
            owner_person_id: warm_b.id,
            project_id: Some(project_warm.id),
            due_date: Some("2026-09-20".into()),
        },
    )
    .expect("建任务");

    (
        app,
        FixtureHandles {
            _warm_team: team_warm.id,
            _elec_team: team_elec.id,
            warm_a: warm_a.id,
            warm_b: warm_b.id,
            elec_c: elec_c.id,
            project_warm: project_warm.id,
            project_elec: project_elec.id,
            task_outer: task_outer.id,
            task_warm: task_warm.id,
        },
    )
}

#[allow(dead_code)]
struct FixtureHandles {
    _warm_team: i64,
    _elec_team: i64,
    warm_a: i64,
    warm_b: i64,
    elec_c: i64,
    project_warm: i64,
    project_elec: i64,
    task_outer: i64,
    task_warm: i64,
}

// ---------------------------------------------------------------------------
// 三类目标都命中
// ---------------------------------------------------------------------------

#[test]
fn wayfinder_空_query_返回默认排序前_n_条() {
    // 验收点：面板打开后第一眼不是空的——空 query 也拉默认候选。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _handles) = fixture_command_palette(clock);

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "".into(),
            people_limit: Some(6),
            projects_limit: Some(6),
            tasks_limit: Some(12),
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("空 query 也应返回默认候选");

    assert!(!results.people.is_empty(), "默认人员候选非空");
    assert!(!results.projects.is_empty(), "默认项目候选非空");
    assert!(!results.tasks.is_empty(), "默认任务候选非空");
}

#[test]
fn wayfinder_人员_按_name_子串_命中() {
    // 验收点：模糊匹配人员——打"张小"能命中"张小暖",不命中子组名。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _handles) = fixture_command_palette(clock);

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "张小".into(),
            people_limit: Some(10),
            projects_limit: None,
            tasks_limit: None,
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("搜索成功");

    // 张小暖 命中"name"
    let names: Vec<&str> = results.people.iter().map(|p| p.name.as_str()).collect();
    assert!(names.contains(&"张小暖"), "应命中张小暖,实际 {names:?}");
    // matchKind 应是 Name
    for hit in &results.people {
        if hit.name == "张小暖" {
            assert_eq!(
                hit.match_kind,
                kewutong_lib::commands::wayfinder::WayfinderMatchKind::Name,
                "命中名字时 match_kind 应是 Name"
            );
        }
    }
}

#[test]
fn wayfinder_人员_按_子组名_命中_且_match_kind_是_sub_team() {
    // 验收点：打"强弱电"——命中子组名,人员(电气丙)match_kind = SubTeam。
    // 电气丙 名字里没"强弱电",子组名里才有——干净子组命中场景。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, handles) = fixture_command_palette(clock);

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "强弱电".into(),
            people_limit: Some(10),
            projects_limit: None,
            tasks_limit: None,
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("搜索成功");

    let elec = results
        .people
        .iter()
        .find(|p| p.person_id == handles.elec_c)
        .expect("电气丙应当出现");
    assert_eq!(
        elec.match_kind,
        kewutong_lib::commands::wayfinder::WayfinderMatchKind::SubTeam,
        "匹配来自子组名"
    );
}

#[test]
fn wayfinder_项目_默认_排除_done_与_cancelled() {
    // 验收点：命令面板是"在飞"视角——Done / Cancelled 项目不应出现。
    // 本 fixture 没有 Done / Cancelled 项目,这个测试主要确认默认行为不
    // 把它们带进来(后续测试加覆盖)。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _handles) = fixture_command_palette(clock);

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "".into(),
            people_limit: None,
            projects_limit: Some(10),
            tasks_limit: None,
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("搜索成功");

    for project in &results.projects {
        assert!(
            project.status != "Done" && project.status != "Cancelled",
            "Done/Cancelled 项目不应出现,实际 {project:?}"
        );
    }
}

#[test]
fn wayfinder_项目_按_name_子串_命中() {
    // 验收点：打"合同"——命中"外委合同评审"项目。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, handles) = fixture_command_palette(clock);

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "合同".into(),
            people_limit: None,
            projects_limit: Some(10),
            tasks_limit: None,
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("搜索成功");

    let outer = results
        .projects
        .iter()
        .find(|p| p.project_id == handles.project_elec)
        .expect("外委合同评审项目应命中");
    assert_eq!(outer.name, "外委合同评审");
}

#[test]
fn wayfinder_任务_复用_search_tasks_语义() {
    // 验收点：任务命中走 ticket #27 的 FTS5 / LIKE 兜底,中文子串召回——
    // 打"合同"两字命中"外委合同评审"任务。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, handles) = fixture_command_palette(clock);

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "合同".into(),
            people_limit: None,
            projects_limit: None,
            tasks_limit: Some(10),
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("搜索成功");

    let task_ids: Vec<i64> = results.tasks.iter().map(|t| t.id).collect();
    assert!(
        task_ids.contains(&handles.task_outer),
        "LIKE 兜底应命中『外委合同评审』任务,实际 {task_ids:?}"
    );
}

#[test]
fn wayfinder_任务_默认_不含_cancelled_任务() {
    // 验收点：默认 include_cancelled_tasks = false——Cancelled 任务不出现。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, handles) = fixture_command_palette(clock);

    use kewutong_lib::commands::task::{set_task_status, SetTaskStatusArgs, TaskStatus};
    // 把空调检修改成 Cancelled
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: handles.task_warm,
            status: TaskStatus::Cancelled,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("取消空调检修");

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "".into(),
            people_limit: None,
            projects_limit: None,
            tasks_limit: Some(50),
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("搜索成功");

    let task_ids: Vec<i64> = results.tasks.iter().map(|t| t.id).collect();
    assert!(
        !task_ids.contains(&handles.task_warm),
        "默认 Cancelled 任务不应出现,实际 {task_ids:?}"
    );

    // include_cancelled_tasks = true——能命中
    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "".into(),
            people_limit: None,
            projects_limit: None,
            tasks_limit: Some(50),
            include_cancelled_tasks: true,
            include_deactivated_people: false,
        },
    )
    .expect("搜索成功");
    let task_ids: Vec<i64> = results.tasks.iter().map(|t| t.id).collect();
    assert!(
        task_ids.contains(&handles.task_warm),
        "include_cancelled_tasks = true 时 Cancelled 任务应出现,实际 {task_ids:?}"
    );
}

#[test]
fn wayfinder_人员_默认_不含_离岗_人员() {
    // 验收点：默认 include_deactivated_people = false——离岗人员不出现。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, handles) = fixture_command_palette(clock);

    // 暖通甲 离岗
    deactivate_person(app.state(), PersonIdArgs { id: handles.warm_a }).expect("离岗暖通甲");

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "暖".into(),
            people_limit: Some(10),
            projects_limit: None,
            tasks_limit: None,
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("搜索成功");

    let ids: Vec<i64> = results.people.iter().map(|p| p.person_id).collect();
    assert!(
        !ids.contains(&handles.warm_a),
        "默认过滤离岗暖通甲,实际 {ids:?}"
    );
    assert!(
        ids.contains(&handles.warm_b),
        "在岗张小暖仍出现,实际 {ids:?}"
    );

    // include_deactivated_people = true——暖通甲 也出现
    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "暖".into(),
            people_limit: Some(10),
            projects_limit: None,
            tasks_limit: None,
            include_cancelled_tasks: false,
            include_deactivated_people: true,
        },
    )
    .expect("搜索成功");
    let ids: Vec<i64> = results.people.iter().map(|p| p.person_id).collect();
    assert!(
        ids.contains(&handles.warm_a),
        "include_deactivated_people = true 时离岗暖通甲 也出现,实际 {ids:?}"
    );
}

#[test]
fn wayfinder_limit_三类各自截断() {
    // 验收点：*_limit 在 SQL 端截断——people / projects / tasks 各自独立。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _handles) = fixture_command_palette(clock);

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "".into(),
            people_limit: Some(2),
            projects_limit: Some(1),
            tasks_limit: Some(1),
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("搜索成功");

    assert!(results.people.len() <= 2, "people 截断到 ≤2");
    assert!(results.projects.len() <= 1, "projects 截断到 ≤1");
    assert!(results.tasks.len() <= 1, "tasks 截断到 ≤1");
}

#[test]
fn wayfinder_无命中_返回_空_列表_而不是_抛错() {
    // 验收点：空命中不报错——前端可以安全渲染"无命中"提示。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _handles) = fixture_command_palette(clock);

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "完全不存在的关键词 xyz123".into(),
            people_limit: Some(6),
            projects_limit: Some(6),
            tasks_limit: Some(12),
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("搜索不应抛错");

    assert!(results.people.is_empty(), "人员无命中");
    assert!(results.projects.is_empty(), "项目无命中");
    assert!(results.tasks.is_empty(), "任务无命中");
}

#[test]
fn wayfinder_查询_like_元字符_被转义_不_全_库_刷出() {
    // 验收点：用户打 `%` 不应该把全员 / 全项目刷出来——
    // LIKE 元字符(%)在 escape_like 那里被转义成 `\%`,作为字面字符匹配。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, _handles) = fixture_command_palette(clock);

    let results = wayfinder_search(
        app.state(),
        WayfinderSearchArgs {
            query: "%".into(),
            people_limit: Some(10),
            projects_limit: Some(10),
            tasks_limit: Some(10),
            include_cancelled_tasks: false,
            include_deactivated_people: false,
        },
    )
    .expect("搜索成功");

    // 不应刷出所有 fixture 项——fixture 没有任何名字 / 子组 / 项目含字面 `%`。
    assert!(
        results.people.is_empty(),
        "% 应作为字面字符匹配,不应刷出全部人员,实际 {:?}",
        results.people
    );
    assert!(
        results.projects.is_empty(),
        "% 应作为字面字符匹配,不应刷出全部项目,实际 {:?}",
        results.projects
    );
}
