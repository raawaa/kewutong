//! `task` 命令的集成测试（ticket #18）。
//!
//! 走完整的命令层：DTO 序列化 → 错误映射 → SQLite。直接调用
//! `#[tauri::command]` 标注的 Rust 函数，配 `fresh_db()` 的内存库。
//!
//! 验收点（来自 ticket #18 + ADR 0003）：
//! - 状态机入口是 `set_task_status`；六值枚举与 DB CHECK 对齐
//! - 四列联动矩阵（核心覆盖）：
//!   - 进入 Blocked / Waiting-on → `blocked_at` 被写入；reason 必填
//!   - 切出到 Open / In-progress / Done / Cancelled → 三列清空
//!   - Blocked ↔ Waiting-on 反复切换 → `blocked_at` 刷新（不累计）
//!   - 非 Waiting-on 状态带 `waiting_on_person_id` → DB CHECK 拒（DB 层兜底）
//!   - reason 超 500 字符 → App 层预检拒
//! - `list_tasks` 默认过滤 Cancelled；`include_cancelled = true` 含历史
//! - 创建路径：必填校验、负责人 / 项目 FK 兜底

mod support;

use kewutong_lib::clock::FixedClock;
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, CreatePersonArgs, CreateSubTeamArgs, Person,
};
use kewutong_lib::commands::task::{
    create_task, list_tasks, set_task_status, CreateTaskArgs, ListTasksArgs, SetTaskStatusArgs,
    TaskStatus,
};
use kewutong_lib::state::AppState;
use kewutong_lib::testing::{fresh_db, fresh_db_with_clock};
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;

/// 把"建子组 + 建人"做成 helper——大多数 task 测试都需要的脚手架。
/// 返回 `(app, owner)`——`owner` 直接是 `Person` DTO,字段访问用 `.id`。
fn fresh_state_with_owner(clock: Arc<FixedClock>) -> (tauri::App<tauri::test::MockRuntime>, Person) {
    let app = mock_app(fresh_db_with_clock(clock));
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通".into(),
            description: None,
        },
    )
    .expect("建组应当成功");
    let owner = create_person(
        app.state(),
        CreatePersonArgs {
            name: "张三".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人应当成功");
    (app, owner)
}

// ---------------------------------------------------------------------------
// 创建路径
// ---------------------------------------------------------------------------

#[test]
fn 任务_create_默认_open_且不写阻塞三列() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock);

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "周报合并".into(),
            description: Some("把三份周报并到一份".into()),
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-10-01".into()),
        },
    )
    .expect("新建任务应当成功");

    assert!(task.id > 0);
    assert_eq!(task.title, "周报合并");
    assert_eq!(task.status, TaskStatus::Open);
    assert_eq!(task.owner_person_id, owner.id);
    assert_eq!(task.project_id, None);
    assert_eq!(task.due_date.as_deref(), Some("2026-10-01"));
    // 阻塞三列在新建路径不写
    assert!(task.blocked_at.is_none());
    assert!(task.blocked_reason.is_none());
    assert!(task.waiting_on_person_id.is_none());
}

#[test]
fn 任务_create_空白标题被拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock);

    for blank in ["", "   ", "\t"] {
        let err = create_task(
            app.state(),
            CreateTaskArgs {
                title: blank.into(),
                description: None,
                owner_person_id: owner.id,
                project_id: None,
                due_date: None,
            },
        )
        .expect_err("空白标题应当被拒");
        assert_eq!(err.code(), "INVALID_ARGUMENT", "blank={blank:?}");
        assert_eq!(err.message(), "任务标题不能为空。");
    }
}

#[test]
fn 任务_create_负责人不存在被拒() {
    let app = mock_app(fresh_db());
    let err = create_task(
        app.state(),
        CreateTaskArgs {
            title: "某任务".into(),
            description: None,
            owner_person_id: 9999,
            project_id: None,
            due_date: None,
        },
    )
    .expect_err("指向不存在的负责人应当被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("负责人不存在"));
}

// ---------------------------------------------------------------------------
// 四列联动矩阵（issue #18 验收点核心）
// ---------------------------------------------------------------------------

#[test]
fn 状态_进_blocked_写_blocked_at_且_reason_必填() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock);

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "等回函".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务成功");

    // 进 Blocked：必须填 reason
    let err = set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Blocked,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect_err("缺 reason 应当被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("阻塞原因不能为空"));

    // 空白 reason 也拒
    let err = set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some("   ".into()),
            waiting_on_person_id: None,
        },
    )
    .expect_err("空白 reason 应当被拒");
    assert!(err.message().contains("阻塞原因不能为空"));

    // 填了 reason → 成功 + blocked_at = clock 当前
    let updated = set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some("等外委回函".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("填了 reason 应当成功");
    assert_eq!(updated.status, TaskStatus::Blocked);
    assert_eq!(updated.blocked_at.as_deref(), Some("2026-09-10 09:00:00"));
    assert_eq!(updated.blocked_reason.as_deref(), Some("等外委回函"));
    assert!(updated.waiting_on_person_id.is_none());
}

#[test]
fn 状态_进_waiting_on_写_blocked_at_且_reason_必填_waiting_on_可选() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock);

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "等批示".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务成功");

    // 不传 waiting_on_person_id —— 允许（"等系统自动恢复"无需指人）
    let updated = set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::WaitingOn,
            blocked_reason: Some("等系统恢复".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("Waiting-on 不强求 waiting_on_person_id");
    assert_eq!(updated.status, TaskStatus::WaitingOn);
    assert_eq!(updated.blocked_at.as_deref(), Some("2026-09-10 09:00:00"));
    assert_eq!(updated.waiting_on_person_id, None);

    // 缺 reason 拒
    let err = set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::WaitingOn,
            blocked_reason: None,
            waiting_on_person_id: Some(owner.id),
        },
    )
    .expect_err("Waiting-on 缺 reason 应当被拒");
    assert!(err.message().contains("等待原因不能为空"));
}

#[test]
fn 状态_reason_超过_500_字符被拒_且_app_层先于_db() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock);
    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "超长原因".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务");

    let too_long: String = "啊".repeat(501);
    let err = set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some(too_long),
            waiting_on_person_id: None,
        },
    )
    .expect_err(">500 字符应当被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert!(err.message().contains("500"));

    // 数据库行没动：仍 Open
    let listed = list_tasks(
        app.state(),
        ListTasksArgs {
            include_cancelled: false,
            owner_person_id: None,
            project_id: None,
        },
    )
    .expect("应能列");
    assert_eq!(listed[0].status, TaskStatus::Open);
    assert!(listed[0].blocked_at.is_none());
}

#[test]
fn 状态_切出_blocked_三列全部清空() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock);

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "切出".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务");

    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some("卡审批".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("进 Blocked 成功");

    // 切到 In-progress
    let back = set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::InProgress,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("切出成功");
    assert_eq!(back.status, TaskStatus::InProgress);
    assert!(back.blocked_at.is_none());
    assert!(back.blocked_reason.is_none());
    assert!(back.waiting_on_person_id.is_none());

    // 再切到 Done —— 同样清空（已空,但确认幂等）
    let done = set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Done,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("切 Done 成功");
    assert_eq!(done.status, TaskStatus::Done);
    assert!(done.blocked_at.is_none());
}

#[test]
fn 状态_blocked_与_waiting_on_互切刷新_blocked_at_不累计() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock.clone());

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "互切".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务");

    // 进 Blocked @ 09:00
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some("卡审批".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("进 Blocked");
    let first = list_tasks(
        app.state(),
        ListTasksArgs {
            include_cancelled: false,
            owner_person_id: None,
            project_id: None,
        },
    )
    .expect("列");
    assert_eq!(first[0].blocked_at.as_deref(), Some("2026-09-10 09:00:00"));

    // 时钟往前推 5 小时——切到 Waiting-on,blocked_at 应当刷新成新的 now
    clock.advance(chrono::TimeDelta::hours(5));
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::WaitingOn,
            blocked_reason: Some("等外委".into()),
            waiting_on_person_id: Some(owner.id),
        },
    )
    .expect("切 Waiting-on");
    let second = list_tasks(
        app.state(),
        ListTasksArgs {
            include_cancelled: false,
            owner_person_id: None,
            project_id: None,
        },
    )
    .expect("列");
    assert_eq!(second[0].status, TaskStatus::WaitingOn);
    assert_eq!(
        second[0].blocked_at.as_deref(),
        Some("2026-09-10 14:00:00"),
        "刷新,不是累计"
    );

    // 再切回 Blocked——再次刷新
    clock.advance(chrono::TimeDelta::hours(2));
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some("卡审批".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("切回 Blocked");
    let third = list_tasks(
        app.state(),
        ListTasksArgs {
            include_cancelled: false,
            owner_person_id: None,
            project_id: None,
        },
    )
    .expect("列");
    assert_eq!(third[0].status, TaskStatus::Blocked);
    assert_eq!(
        third[0].blocked_at.as_deref(),
        Some("2026-09-10 16:00:00"),
        "再次刷新——不是首次阻塞时刻"
    );
}

#[test]
fn 状态_非_waiting_on_带_waiting_on_person_id_被_db_check_拒() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock);

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "等待人员越权".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务");

    // App 层正确路径：先到 Waiting-on 设置 waiting_on_person_id,然后切出
    // 到 In-progress,App 层会清掉三列。验证 App 层路径走完后 DB 行干净。
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::WaitingOn,
            blocked_reason: Some("等回函".into()),
            waiting_on_person_id: Some(owner.id),
        },
    )
    .expect("进 Waiting-on");

    // 直接 raw UPDATE 模拟 App 层失误：带 waiting_on_person_id 但 status
    // 不是 Waiting-on——DB CHECK 必须兜住。注意锁的范围——`std::sync::Mutex`
    // 不可重入,后续 `set_task_status` 也要拿锁,必须先释放 guard。
    let state = app.state::<AppState>();
    let raw_update_failed = {
        let conn = state.db().expect("conn");
        conn.execute(
            "UPDATE task SET status = 'Open', waiting_on_person_id = ?1 WHERE id = ?2",
            rusqlite::params![owner.id, task.id],
        )
        .is_err()
    };
    assert!(
        raw_update_failed,
        "DB CHECK `waiting_on_person_id IS NULL OR status = 'Waiting-on'` 应拒绝"
    );

    // App 层正确路径：set_task_status 切出后,waiting_on_person_id 必为 None。
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::InProgress,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("切 In-progress");
    let listed = list_tasks(
        app.state(),
        ListTasksArgs {
            include_cancelled: false,
            owner_person_id: None,
            project_id: None,
        },
    )
    .expect("列");
    assert!(listed[0].waiting_on_person_id.is_none());
}

#[test]
fn 状态_cancelled_是_task_层软删_默认从列表消失_且_history_可见() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock);

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "撤销".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
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
    .expect("取消成功");

    // 默认（include_cancelled = false）：不出现
    let in_flight = list_tasks(
        app.state(),
        ListTasksArgs {
            include_cancelled: false,
            owner_person_id: None,
            project_id: None,
        },
    )
    .expect("列");
    assert!(in_flight.is_empty(), "Cancelled 应当从在飞列表消失");

    // include_cancelled = true：可见
    let history = list_tasks(
        app.state(),
        ListTasksArgs {
            include_cancelled: true,
            owner_person_id: None,
            project_id: None,
        },
    )
    .expect("列历史");
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, TaskStatus::Cancelled);
}

#[test]
fn 列表_在飞优先_done_置后() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock);

    let t1 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "已完成".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");
    let t2 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "在做".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: t1.id,
            status: TaskStatus::Done,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("Done");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: t2.id,
            status: TaskStatus::InProgress,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("InProgress");

    let listed = list_tasks(
        app.state(),
        ListTasksArgs {
            include_cancelled: false,
            owner_person_id: None,
            project_id: None,
        },
    )
    .expect("列");
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].status, TaskStatus::InProgress, "在飞优先");
    assert_eq!(listed[1].status, TaskStatus::Done);
}

#[test]
fn 列表_按_owner_person_id_过滤() {
    let app = mock_app(fresh_db());
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "A".into(),
            description: None,
        },
    )
    .expect("建组");
    let owner1 = create_person(
        app.state(),
        CreatePersonArgs {
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");
    let owner2 = create_person(
        app.state(),
        CreatePersonArgs {
            name: "乙".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");

    create_task(
        app.state(),
        CreateTaskArgs {
            title: "甲的任务".into(),
            description: None,
            owner_person_id: owner1.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");
    create_task(
        app.state(),
        CreateTaskArgs {
            title: "乙的任务".into(),
            description: None,
            owner_person_id: owner2.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");

    let only_owner1 = list_tasks(
        app.state(),
        ListTasksArgs {
            include_cancelled: false,
            owner_person_id: Some(owner1.id),
            project_id: None,
        },
    )
    .expect("列");
    assert_eq!(only_owner1.len(), 1);
    assert_eq!(only_owner1[0].owner_person_id, owner1.id);
}

#[test]
fn 状态_设置不存在的_id_给中文提示() {
    let app = mock_app(fresh_db());
    let err = set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: 9999,
            status: TaskStatus::Open,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect_err("不存在的 task_id 应当被拒");
    assert_eq!(err.code(), "INVALID_ARGUMENT");
    assert_eq!(err.message(), "任务不存在或已被删除。");
}

#[test]
fn 状态_updated_at_每次状态变更都跟_clock_走() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = fresh_state_with_owner(clock.clone());

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "时间戳".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");
    let initial_updated = task.updated_at.clone();

    clock.advance(chrono::TimeDelta::hours(1));
    let updated = set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: task.id,
            status: TaskStatus::InProgress,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("切 InProgress");
    assert_ne!(updated.updated_at, initial_updated);
    assert_eq!(updated.updated_at, "2026-09-10 10:00:00");
}
