//! `project` 命令的集成测试（ticket #20）。
//!
//! 验收点：
//! - 项目 CRUD：必填校验、负责人 / 子组 FK 兜底
//! - `project.status` 由视图层聚合 `task.status` 派生，含空项目、全 Cancelled、
//!   全 Done、混合等边界
//! - 删除项目 → 项目下任务的 `project_id` 置 NULL，不留悬空 FK
//! - `list_projects` 默认排除 Done / Cancelled，`include_done = true` 含历史
//! - `list_project_candidates` 是 `#` 内联选项目的权威：排除已 Done /
//!   Cancelled 的项目、按 query 子串过滤、条数封顶
//!
//! 命令层单元侧在 `project.rs` 内 `#[cfg(test)] mod tests`；本文件走
//! `fresh_db()` 内存库的端到端集成路径。

mod support;

use kewutong_lib::clock::FixedClock;
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, CreatePersonArgs, CreateSubTeamArgs,
};
use kewutong_lib::commands::project::{
    create_project, delete_project, list_project_candidates, list_projects,
    update_project, CreateProjectArgs, DeleteProjectArgs, ListProjectCandidatesArgs,
    ListProjectsArgs, ProjectStatus, UpdateProjectArgs,
};
use kewutong_lib::commands::task::{
    create_task, list_tasks, set_task_status, CreateTaskArgs, ListTasksArgs,
    SetTaskStatusArgs, TaskStatus,
};
use kewutong_lib::testing::{fresh_db, fresh_db_with_clock};
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;

/// 通用 fixture：建一个子组、两个人，返回 mock app + owner。clock 保留在
/// 测试体内（`Arc<FixedClock>` 可继续推进），通过 fixture 入参传入。
fn fresh_state_with_team_and_owner(
    clock: Arc<FixedClock>,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    kewutong_lib::commands::personnel::Person,
) {
    let app = mock_app(fresh_db_with_clock(clock));
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
    (app, owner)
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

#[test]
fn 项目_create_返回_含_status_的新行() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);

    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "综合楼改造".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: Some("2026-09-01".into()),
            due_date: Some("2026-12-31".into()),
            notes: Some("市里督办".into()),
        },
    )
    .expect("建项目");

    assert!(project.id > 0);
    assert_eq!(project.name, "综合楼改造");
    assert_eq!(project.owner_person_id, owner.id);
    assert_eq!(project.sub_team_id, owner.sub_team_id);
    assert_eq!(project.start_date.as_deref(), Some("2026-09-01"));
    assert_eq!(project.due_date.as_deref(), Some("2026-12-31"));
    assert_eq!(project.notes.as_deref(), Some("市里督办"));
    // 新建空项目 → status 派生为 Active
    assert_eq!(project.status, ProjectStatus::Active);
}

#[test]
fn 项目_create_空白名被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);

    for blank in ["", "   ", "\t"] {
        let err = create_project(
            app.state(),
            CreateProjectArgs {
                name: blank.into(),
                owner_person_id: owner.id,
                sub_team_id: owner.sub_team_id,
                start_date: None,
                due_date: None,
                notes: None,
            },
        )
        .expect_err("空白项目名应当被拒");
        assert_eq!(err.code(), "INVALID_ARGUMENT", "blank={blank:?}");
        assert!(err.message().contains("项目名"));
    }
}

#[test]
fn 项目_create_负责人不存在被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);

    let err = create_project(
        app.state(),
        CreateProjectArgs {
            name: "某项目".into(),
            owner_person_id: 9999,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect_err("负责人不存在应当被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("负责人"));
}

#[test]
fn 项目_create_子组不存在被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);

    let err = create_project(
        app.state(),
        CreateProjectArgs {
            name: "某项目".into(),
            owner_person_id: owner.id,
            sub_team_id: 9999,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect_err("子组不存在应当被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("子组"));
}

#[test]
fn 项目_update_改名字与日期_且_status_保持_derived() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock.clone());

    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "旧名".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: Some("2026-09-01".into()),
            due_date: Some("2026-09-30".into()),
            notes: None,
        },
    )
    .expect("建");

    clock.advance(chrono::TimeDelta::hours(1));
    let updated = update_project(
        app.state(),
        UpdateProjectArgs {
            id: project.id,
            name: "新名".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: Some("2026-10-01".into()),
            due_date: Some("2026-12-31".into()),
            notes: Some("新增备注".into()),
        },
    )
    .expect("改");

    assert_eq!(updated.name, "新名");
    assert_eq!(updated.start_date.as_deref(), Some("2026-10-01"));
    assert_eq!(updated.due_date.as_deref(), Some("2026-12-31"));
    assert_eq!(updated.notes.as_deref(), Some("新增备注"));
    // 空项目派生仍是 Active
    assert_eq!(updated.status, ProjectStatus::Active);
}

#[test]
fn 项目_update_空白名被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);
    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "某项目".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    let err = update_project(
        app.state(),
        UpdateProjectArgs {
            id: project.id,
            name: "   ".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect_err("空白名应当被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("项目名"));
}

#[test]
fn 项目_update_日期格式不合法被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);
    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "某项目".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    for bad in ["2026/09/10", "10-01", "2026-13-01", "明天"] {
        let err = update_project(
            app.state(),
            UpdateProjectArgs {
                id: project.id,
                name: "某项目".into(),
                owner_person_id: owner.id,
                sub_team_id: owner.sub_team_id,
                start_date: None,
                due_date: Some(bad.into()),
                notes: None,
            },
        )
        .expect_err("非法日期应当被拒");
        assert_eq!(err.code(), "INVALID_ARGUMENT", "bad={bad:?}");
        assert!(err.message().contains("截止日"), "bad={bad:?}");
    }
}

// ---------------------------------------------------------------------------
// status 派生（核心验收点）
// ---------------------------------------------------------------------------

#[test]
fn status_空项目_派生为_active() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);

    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "新项目".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    assert_eq!(project.status, ProjectStatus::Active);
}

#[test]
fn status_全_cancelled_派生为_cancelled() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);
    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "全撤".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    // 建三条任务并全部取消
    for title in ["A", "B", "C"] {
        let task = create_task(
            app.state(),
            CreateTaskArgs {
                title: title.into(),
                description: None,
                owner_person_id: owner.id,
                project_id: Some(project.id),
                due_date: None,
            },
        )
        .expect("建任务");
        set_task_status(
            app.state(),
            SetTaskStatusArgs {
                task_id: task.id,
                status: TaskStatus::Cancelled,
                blocked_reason: None,
                waiting_on_person_id: None,
            },
        )
        .expect("撤");
    }

    let listed = list_projects(
        app.state(),
        ListProjectsArgs { include_done: true },
    )
    .expect("列");
    let derived = listed.iter().find(|p| p.id == project.id).expect("找得到");
    assert_eq!(derived.status, ProjectStatus::Cancelled);
}

#[test]
fn status_全_done_派生为_done() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);
    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "全完".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    for title in ["A", "B"] {
        let task = create_task(
            app.state(),
            CreateTaskArgs {
                title: title.into(),
                description: None,
                owner_person_id: owner.id,
                project_id: Some(project.id),
                due_date: None,
            },
        )
        .expect("建任务");
        set_task_status(
            app.state(),
            SetTaskStatusArgs {
                task_id: task.id,
                status: TaskStatus::Done,
                blocked_reason: None,
                waiting_on_person_id: None,
            },
        )
        .expect("完");
    }

    let listed = list_projects(
        app.state(),
        ListProjectsArgs { include_done: true },
    )
    .expect("列");
    let derived = listed.iter().find(|p| p.id == project.id).expect("找得到");
    assert_eq!(derived.status, ProjectStatus::Done);
}

#[test]
fn status_混合_在飞任务_派生为_active() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);
    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "进行中".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    // 一条 Open、一条 Done、一条 Cancelled——还有在飞 → Active
    let in_flight = create_task(
        app.state(),
        CreateTaskArgs {
            title: "在做".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: Some(project.id),
            due_date: None,
        },
    )
    .expect("建");
    let done = create_task(
        app.state(),
        CreateTaskArgs {
            title: "做完".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: Some(project.id),
            due_date: None,
        },
    )
    .expect("建");
    let cancelled = create_task(
        app.state(),
        CreateTaskArgs {
            title: "撤了".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: Some(project.id),
            due_date: None,
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

    let _ = in_flight; // 仍 Open

    let listed = list_projects(
        app.state(),
        ListProjectsArgs { include_done: true },
    )
    .expect("列");
    let derived = listed.iter().find(|p| p.id == project.id).expect("找得到");
    assert_eq!(derived.status, ProjectStatus::Active);
}

#[test]
fn status_在飞_加_done_混合_仍派生为_active() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);
    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "混合2".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    // 一条在飞 + 一条 Done
    let in_flight = create_task(
        app.state(),
        CreateTaskArgs {
            title: "在做".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: Some(project.id),
            due_date: None,
        },
    )
    .expect("建");
    let done = create_task(
        app.state(),
        CreateTaskArgs {
            title: "做完".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: Some(project.id),
            due_date: None,
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
    let _ = in_flight;

    let listed = list_projects(
        app.state(),
        ListProjectsArgs { include_done: true },
    )
    .expect("列");
    let derived = listed.iter().find(|p| p.id == project.id).expect("找得到");
    assert_eq!(derived.status, ProjectStatus::Active);
}

// ---------------------------------------------------------------------------
// 列表过滤 + 项目看板查询
// ---------------------------------------------------------------------------

#[test]
fn list_projects_默认排除_done_和_cancelled() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);

    let active = create_project(
        app.state(),
        CreateProjectArgs {
            name: "Active".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    let done = create_project(
        app.state(),
        CreateProjectArgs {
            name: "Done".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");
    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "完".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: Some(done.id),
            due_date: None,
        },
    )
    .expect("建");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Done,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("完");

    let cancelled = create_project(
        app.state(),
        CreateProjectArgs {
            name: "Cancelled".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");
    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "撤".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: Some(cancelled.id),
            due_date: None,
        },
    )
    .expect("建");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Cancelled,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("撤");

    let default_list = list_projects(
        app.state(),
        ListProjectsArgs { include_done: false },
    )
    .expect("默认列");
    let ids: Vec<i64> = default_list.iter().map(|p| p.id).collect();
    assert_eq!(ids, vec![active.id]);

    let full = list_projects(
        app.state(),
        ListProjectsArgs { include_done: true },
    )
    .expect("全列");
    assert_eq!(full.len(), 3);
}

#[test]
fn list_projects_按_到期日_升序_无期置后() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);

    // 故意乱序建
    let no_due = create_project(
        app.state(),
        CreateProjectArgs {
            name: "no_due".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");
    let due_late = create_project(
        app.state(),
        CreateProjectArgs {
            name: "late".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: Some("2026-12-31".into()),
            notes: None,
        },
    )
    .expect("建");
    let due_early = create_project(
        app.state(),
        CreateProjectArgs {
            name: "early".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: Some("2026-09-30".into()),
            notes: None,
        },
    )
    .expect("建");

    let listed = list_projects(
        app.state(),
        ListProjectsArgs { include_done: true },
    )
    .expect("列");
    let ids: Vec<i64> = listed.iter().map(|p| p.id).collect();
    assert_eq!(ids, vec![due_early.id, due_late.id, no_due.id]);
}

// ---------------------------------------------------------------------------
// 删除项目 → 任务 project_id 置 NULL
// ---------------------------------------------------------------------------

#[test]
fn 删除项目_名下任务的_project_id_置_null_且项目下不见残留_fk() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);
    let project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "要删".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    let t1 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "A".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: Some(project.id),
            due_date: None,
        },
    )
    .expect("建");
    let t2 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "B".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: Some(project.id),
            due_date: None,
        },
    )
    .expect("建");

    delete_project(
        app.state(),
        DeleteProjectArgs { id: project.id },
    )
    .expect("删项目");

    // 任务仍存在，但 project_id 已置 NULL
    let after = list_tasks(
        app.state(),
        ListTasksArgs {
            include_cancelled: true,
            owner_person_id: None,
            project_id: None,
        },
    )
    .expect("列");
    assert_eq!(after.len(), 2);
    for task in &after {
        assert!(
            task.project_id.is_none(),
            "任务 id={} 的 project_id 应当置 NULL",
            task.id
        );
    }
    let _ = (t1, t2);

    // 项目本身已不在
    let listed = list_projects(
        app.state(),
        ListProjectsArgs { include_done: true },
    )
    .expect("列");
    assert!(listed.iter().all(|p| p.id != project.id));
}

#[test]
fn 删除项目_项目不存在给中文提示() {
    let app = mock_app(fresh_db());
    let err = delete_project(
        app.state(),
        DeleteProjectArgs { id: 9999 },
    )
    .expect_err("不存在的 id 应当被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("项目不存在"));
}

// ---------------------------------------------------------------------------
// # 内联选项目的候选查询
// ---------------------------------------------------------------------------

#[test]
fn list_project_candidates_默认排除_done_和_cancelled() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);

    let active = create_project(
        app.state(),
        CreateProjectArgs {
            name: "在飞项目".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    // 一个全 Done 的项目——不应出现在候选里
    let done_project = create_project(
        app.state(),
        CreateProjectArgs {
            name: "已完项目".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");
    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "完".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: Some(done_project.id),
            due_date: None,
        },
    )
    .expect("建");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Done,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("完");

    let candidates = list_project_candidates(
        app.state(),
        ListProjectCandidatesArgs { query: None },
    )
    .expect("候选");
    let ids: Vec<i64> = candidates.iter().map(|c| c.project_id).collect();
    assert_eq!(ids, vec![active.id]);
}

#[test]
fn list_project_candidates_按_query_子串过滤() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);

    create_project(
        app.state(),
        CreateProjectArgs {
            name: "综合楼改造".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");
    create_project(
        app.state(),
        CreateProjectArgs {
            name: "管网普查".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    let found = list_project_candidates(
        app.state(),
        ListProjectCandidatesArgs {
            query: Some("综合".into()),
        },
    )
    .expect("候选");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "综合楼改造");
    // 副行给出子组名——跨组同名时科长才选得准
    assert_eq!(found[0].sub_team_name, "暖通");
}

#[test]
fn list_project_candidates_like_元字符被转义_不当通配() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_team_and_owner(clock);

    create_project(
        app.state(),
        CreateProjectArgs {
            name: "正常项目".into(),
            owner_person_id: owner.id,
            sub_team_id: owner.sub_team_id,
            start_date: None,
            due_date: None,
            notes: None,
        },
    )
    .expect("建");

    // 打 `%` 不应当把全部项目刷出来——转义后只匹配字面 `%`
    let found = list_project_candidates(
        app.state(),
        ListProjectCandidatesArgs {
            query: Some("%".into()),
        },
    )
    .expect("候选");
    assert!(found.is_empty(), "`%` 转义后不应命中任何项目");
}