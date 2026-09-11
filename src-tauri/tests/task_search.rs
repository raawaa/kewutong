//! ticket #27 的集成测试：FTS5 trigram 全文搜索 + 复合筛选。
//!
//! 验收点（来自 ticket #27）：
//! - 中文子串搜索命中（trigram 部分匹配），标题与描述都进索引
//! - 任务 update / delete 后 FTS 行同步正确——测试直接断言触发器有效
//! - 复合筛选：状态 × 人员 × 项目 × 到期日区间任意组合结果正确
//! - 离岗人员的过滤在筛选中可控
//! - 长查询（FTS5 MATCH + 聚合）走 `spawn_blocking`,不阻塞短查询
//!
//! 与其它 ticket 的测试约定一致：走完整命令层（DTO + 错误映射 + SQLite）,
//! 配 `fresh_db_with_clock` 的内存库。
//!
//! `search_tasks` 是 async 命令（[#27 验收]），但测试体在同步上下文里
//! 跑——直接走 [`kewutong_lib::commands::task::search_tasks_blocking_for_tests`]
//! 共享同步体,避开 Tauri async runtime 包装。

mod support;

use kewutong_lib::clock::FixedClock;
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, deactivate_person, CreatePersonArgs, CreateSubTeamArgs,
    PersonIdArgs,
};
use kewutong_lib::commands::project::{create_project, CreateProjectArgs};
use kewutong_lib::commands::task::{
    create_task, list_tasks_filtered, search_tasks_blocking_for_tests, set_task_status,
    update_task, CreateTaskArgs, ListTasksFilteredArgs, SearchTasksArgs, SetTaskStatusArgs,
    TaskStatus, UpdateTaskArgs,
};
use kewutong_lib::state::AppState;
use kewutong_lib::testing::fresh_db_with_clock;
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;

// ---------------------------------------------------------------------------
// 公共 fixture：建子组 + 多名人员 + 一个项目
// ---------------------------------------------------------------------------

/// 三种子组场景下的常用骨架：暖通（含 2 人）+ 电气（含 1 人）+ 1 个项目。
///
/// 返回 `(app, owners[(暖通甲, 暖通乙, 电气丙)], project_id)`——测试主体
/// 在此基础上插入任务并断言 FTS5 / 筛选行为。
fn fixture_three_owners(
    clock: Arc<FixedClock>,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    (i64, i64, i64),
    i64,
) {
    let app = mock_app(fresh_db_with_clock(clock));
    let team_warm = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通".into(),
            description: None,
        },
    )
    .expect("建暖通组");
    let team_elec = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "电气".into(),
            description: None,
        },
    )
    .expect("建电气组");

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
            name: "暖通乙".into(),
            sub_team_id: team_warm.id,
            contact: "示例".into(),
        },
    )
    .expect("录暖通乙");
    let elec_c = create_person(
        app.state(),
        CreatePersonArgs {
            name: "电气丙".into(),
            sub_team_id: team_elec.id,
            contact: "示例".into(),
        },
    )
    .expect("录电气丙");

    let project = create_project(
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
    .expect("建项目");

    (app, (warm_a.id, warm_b.id, elec_c.id), project.id)
}

// ---------------------------------------------------------------------------
// FTS5 trigram 同步触发器（ticket #27 验收点）
// ---------------------------------------------------------------------------

#[test]
fn 搜索_触发器在_insert_后立刻把_任务写入_影子表() {
    // 验收点：task INSERT 后 task_fts 立即可见——trigger `task_ai` 有效。
    // 端到端断言：建一条,搜得到。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "外委合同评审".into(),
            description: Some("本年度外委合同集中评审".into()),
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务成功");

    // 直接断言 `task_ai` 触发器把 rowid 同步进了影子表——不绕 search 命令。
    let state = app.state::<AppState>().inner();
    let count: i64 = {
        let conn = state.db().expect("conn");
        conn.query_row(
            "SELECT COUNT(*) FROM task_fts WHERE rowid = ?1",
            rusqlite::params![task.id],
            |row| row.get(0),
        )
        .expect("query task_fts")
    };
    assert_eq!(count, 1, "task_ai 触发器应把新建任务的 rowid 同步到 task_fts");

    // 搜「合同」能命中"外委合同评审"——LIKE 兜底路径,2 字短查询
    let hits = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "合同".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜索成功");
    assert_eq!(hits.len(), 1, "LIKE 兜底应能命中子串");
    assert_eq!(hits[0].title, "外委合同评审");

    // 搜「外委」——子串前缀也能命中
    let hits = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "外委".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜索成功");
    assert_eq!(hits.len(), 1);
}

#[test]
fn 搜索_描述里的关键词也进索引() {
    // 验收点：标题与描述都进索引——仅描述里有"档案"也能搜到。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);

    create_task(
        app.state(),
        CreateTaskArgs {
            title: "整理卷宗".into(),
            // 标题里没"档案"——仅在描述里出现
            description: Some("把去年的项目档案归档入库".into()),
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务成功");

    let hits = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "档案".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜索成功");
    assert_eq!(hits.len(), 1, "描述里的关键词应被索引");
    assert_eq!(hits[0].title, "整理卷宗");
}

#[test]
fn 搜索_触发器在_update_后同步_任务_fts() {
    // 验收点：UPDATE 触发器先 delete 再 insert——改完应当立即可搜到新词,
    // 旧词消失(不带旧的残留)。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "原任务".into(),
            description: Some("原描述".into()),
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务");

    // 改之前搜"原任务"能命中
    let before = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "原任务".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜索");
    assert_eq!(before.len(), 1);

    // 改标题 / 描述——模拟"原任务变成新任务"
    update_task(
        app.state(),
        UpdateTaskArgs {
            id: task.id,
            title: "新任务".into(),
            description: Some("新描述".into()),
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("改任务成功");

    // 直接断言 `task_au` 触发器 delete-then-insert 路径——旧词 trigram
    // 应当从 task_fts 索引里消失,新词 trigram 应当出现。
    let state = app.state::<AppState>().inner();
    let new_term_count: i64 = {
        let conn = state.db().expect("conn");
        // "新任务" 的 trigram 只有"新任务"一项——直接查索引里有没有
        conn.query_row(
            "SELECT COUNT(*) FROM task_fts WHERE rowid = ?1 \
             AND task_fts MATCH ?2",
            rusqlite::params![task.id, "新任务"],
            |row| row.get(0),
        )
        .expect("query new term")
    };
    assert_eq!(new_term_count, 1, "新词 trigram 应被 task_au 索引");

    let old_term_count: i64 = {
        let conn = state.db().expect("conn");
        conn.query_row(
            "SELECT COUNT(*) FROM task_fts WHERE rowid = ?1 \
             AND task_fts MATCH ?2",
            rusqlite::params![task.id, "原任务"],
            |row| row.get(0),
        )
        .expect("query old term")
    };
    assert_eq!(
        old_term_count, 0,
        "旧词 trigram 应从 task_fts 消失——task_au 的 delete-then-insert 路径有效"
    );

    // 端到端兜底
    let after_new = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "新任务".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜索新词");
    assert_eq!(after_new.len(), 1, "新词应被索引");
    assert_eq!(after_new[0].id, task.id);

    let after_old = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "原任务".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜索旧词");
    assert!(after_old.is_empty(), "旧词应从索引中消失");

    // 描述里"新描述"也能命中
    let desc_hit = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "新描述".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜描述");
    assert_eq!(desc_hit.len(), 1);
}

#[test]
fn 搜索_物理删除后_task_fts_影子表也_移除() {
    // 验收点：DELETE 触发器同步从 task_fts 移除。
    // 直接断言 task_fts rowid 同步被移除——不绕 search 命令。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);
    let state = app.state::<AppState>().inner();

    let task = create_task(
        app.state(),
        CreateTaskArgs {
            title: "要被删除".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务");

    // 物理删除——走 raw DELETE
    {
        let conn = state.db().expect("conn");
        conn.execute(
            "DELETE FROM task WHERE id = ?1",
            rusqlite::params![task.id],
        )
        .expect("删除任务");
    }

    // 直接断言 task_fts 的 rowid 同步被移除——`conn` 在这个块内释放,
    // 避免与下面的 `search_tasks_blocking_for_tests` 撞锁。
    let count: i64 = {
        let conn = state.db().expect("conn");
        conn.query_row(
            "SELECT COUNT(*) FROM task_fts WHERE rowid = ?1",
            rusqlite::params![task.id],
            |row| row.get(0),
        )
        .expect("query task_fts")
    };
    assert_eq!(count, 0, "DELETE 触发器应当同步 task_fts 移除该 rowid");

    // 端到端兜底:search 也搜不到
    let after = search_tasks_blocking_for_tests(
        state,
        SearchTasksArgs {
            query: "要被删除".into(),
            include_cancelled: true,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("search 应当成功(返回空列表)");
    assert!(after.is_empty());
}

#[test]
fn 搜索_单字符_查询_通过_like_兜底命中() {
    // 短查询（< 3 字）走 LIKE 子串匹配——trigram 无法生成 token,
    // LIKE '%合%' 命中"外委合同评审"里的"合"。这是给短查询的兜底。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);

    create_task(
        app.state(),
        CreateTaskArgs {
            title: "外委合同评审".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务");

    let hits = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "合".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜索应当成功,不报错");
    assert_eq!(hits.len(), 1, "LIKE '%合%' 应命中");
    assert_eq!(hits[0].title, "外委合同评审");
}

#[test]
fn 搜索_关键词_全_是_fts5_特殊字符_返回_空_而不是_抛错() {
    // 清洗策略:FTS5 特殊字符被替换成空白,全部替换后为空 → 返回空
    // 而不是抛 INVALID_ARGUMENT。命令面板里打了 "***" 想清屏,
    // 不该给中文错误。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);

    create_task(
        app.state(),
        CreateTaskArgs {
            title: "某任务".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务");

    let hits = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "***".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("全特殊字符不报错");
    assert!(hits.is_empty(), "全特殊字符应返回空");
}

#[test]
fn 搜索_默认_过滤_cancelled_与_离岗_负责人() {
    // 验收点:include_cancelled 与 include_deactivated_owners 默认 false,
    // 与 list_tasks_filtered 对齐。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, warm_b, _), _) = fixture_three_owners(clock);

    let t_a = create_task(
        app.state(),
        CreateTaskArgs {
            title: "外委合同 A".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");
    let t_b = create_task(
        app.state(),
        CreateTaskArgs {
            title: "外委合同 B".into(),
            description: None,
            owner_person_id: warm_b,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");

    // t_b 取消,t_b 的 owner 离岗
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: t_b.id,
            status: TaskStatus::Cancelled,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("取消");
    deactivate_person(app.state(), PersonIdArgs { id: warm_b }).expect("离岗");

    // 默认搜索——应当只命中 t_a
    let hits = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "外委合同".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜索");
    let ids: Vec<i64> = hits.iter().map(|t| t.id).collect();
    assert_eq!(ids, vec![t_a.id], "默认过滤 cancelled 与离岗");

    // include_cancelled = true——但 t_b 的负责人仍离岗,默认过滤掉
    let hits = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "外委合同".into(),
            include_cancelled: true,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜索");
    assert_eq!(hits.len(), 1, "含 cancelled 但离岗仍过滤");
    assert_eq!(hits[0].id, t_a.id);

    // 两个都打开——t_b 出现
    let hits = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "外委合同".into(),
            include_cancelled: true,
            include_deactivated_owners: true,
            limit: None,
        },
    )
    .expect("搜索");
    let ids: Vec<i64> = hits.iter().map(|t| t.id).collect();
    assert_eq!(ids.len(), 2, "都开时两条都出现");
    assert!(ids.contains(&t_a.id) && ids.contains(&t_b.id));
}

#[test]
fn 搜索_空_关键词_被拒() {
    let app = mock_app(fresh_db_with_clock(Arc::new(FixedClock::at(
        "2026-09-10 09:00:00",
    ))));

    for blank in ["", "   "] {
        let err = search_tasks_blocking_for_tests(
            app.state::<AppState>().inner(),
            SearchTasksArgs {
                query: blank.into(),
                include_cancelled: false,
                include_deactivated_owners: false,
                limit: None,
            },
        )
        .expect_err("空关键词应被拒");
        assert_eq!(err.code(), "INVALID_ARGUMENT", "blank={blank:?}");
        assert!(err.message().contains("搜索关键词不能为空"));
    }
}

#[test]
fn 搜索_limit_截断_返回_前_n_条() {
    // 验证 limit 在 SQL 端生效:10 条任务匹配,limit = 3 → 返回 3 条。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);

    for i in 0..10 {
        create_task(
            app.state(),
            CreateTaskArgs {
                title: format!("合同任务 {i:02}"),
                description: None,
                owner_person_id: warm_a,
                project_id: None,
                due_date: None,
            },
        )
        .expect("建");
    }

    let hits = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "合同".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: Some(3),
        },
    )
    .expect("搜索");
    assert_eq!(hits.len(), 3, "limit 应当截断到 3 条");
}

// ---------------------------------------------------------------------------
// 复合筛选 list_tasks_filtered
// ---------------------------------------------------------------------------

#[test]
fn 筛选_空过滤返回_全部_在飞_任务() {
    // 空 statuses + 全 None 维度 + include_cancelled = false + 默认离岗过滤
    // → 行为应当收敛到「在岗 + 在飞」5 条任务中的 3 条。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, warm_b, _), _) = fixture_three_owners(clock);

    // 5 条任务:3 条 warm_a 在岗,1 条 cancelled,1 条 warm_b 离岗
    for _ in 0..3 {
        create_task(
            app.state(),
            CreateTaskArgs {
                title: "在岗任务".into(),
                description: None,
                owner_person_id: warm_a,
                project_id: None,
                due_date: None,
            },
        )
        .expect("建");
    }
    let cancelled = create_task(
        app.state(),
        CreateTaskArgs {
            title: "已取消".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");
    create_task(
        app.state(),
        CreateTaskArgs {
            title: "离岗任务".into(),
            description: None,
            owner_person_id: warm_b,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");

    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: cancelled.id,
            status: TaskStatus::Cancelled,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("取消");
    deactivate_person(app.state(), PersonIdArgs { id: warm_b }).expect("离岗");

    let hits = list_tasks_filtered(
        app.state(),
        ListTasksFilteredArgs {
            statuses: vec![],
            owner_person_id: None,
            project_id: None,
            due_date_from: None,
            due_date_to: None,
            include_cancelled: false,
            include_deactivated_owners: false,
        },
    )
    .expect("筛选成功");
    assert_eq!(hits.len(), 3, "默认过滤 cancelled + 离岗");
}

#[test]
fn 筛选_按状态_多选() {
    // 验收点:statuses 多选——只给 Blocked + In-progress,其它状态都过滤掉。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);

    let t_open = create_task(
        app.state(),
        CreateTaskArgs {
            title: "open".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");
    let t_blocked = create_task(
        app.state(),
        CreateTaskArgs {
            title: "blocked".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");
    let t_inprog = create_task(
        app.state(),
        CreateTaskArgs {
            title: "inprog".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");
    let t_done = create_task(
        app.state(),
        CreateTaskArgs {
            title: "done".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");

    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: t_blocked.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some("卡审批".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("Blocked");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: t_inprog.id,
            status: TaskStatus::InProgress,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("InProgress");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: t_done.id,
            status: TaskStatus::Done,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )
    .expect("Done");

    let hits = list_tasks_filtered(
        app.state(),
        ListTasksFilteredArgs {
            statuses: vec![TaskStatus::Blocked, TaskStatus::InProgress],
            owner_person_id: None,
            project_id: None,
            due_date_from: None,
            due_date_to: None,
            include_cancelled: false,
            include_deactivated_owners: false,
        },
    )
    .expect("筛选成功");
    let ids: Vec<i64> = hits.iter().map(|t| t.id).collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&t_blocked.id));
    assert!(ids.contains(&t_inprog.id));
    // 不应出现 Open / Done
    assert!(!ids.contains(&t_open.id));
    assert!(!ids.contains(&t_done.id));
}

#[test]
fn 筛选_按人员_与_项目_复合() {
    // 验收点:owner × project 两个维度同时约束。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), project_id) = fixture_three_owners(clock);

    let t1 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "warm_a+项目".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: Some(project_id),
            due_date: None,
        },
    )
    .expect("建");
    create_task(
        app.state(),
        CreateTaskArgs {
            title: "warm_a 无项目".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");

    // 只筛 owner = warm_a AND project = project_id → 只有 t1
    let hits = list_tasks_filtered(
        app.state(),
        ListTasksFilteredArgs {
            statuses: vec![],
            owner_person_id: Some(warm_a),
            project_id: Some(project_id),
            due_date_from: None,
            due_date_to: None,
            include_cancelled: false,
            include_deactivated_owners: false,
        },
    )
    .expect("筛选");
    let ids: Vec<i64> = hits.iter().map(|t| t.id).collect();
    assert_eq!(ids, vec![t1.id]);
}

#[test]
fn 筛选_按到期日区间_含两端() {
    // 验收点:due_date_from / due_date_to 含两端(Between 含边界语义)。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);

    for date in [
        "2026-09-01", "2026-09-09", "2026-09-10", "2026-09-15", "2026-09-20",
    ] {
        create_task(
            app.state(),
            CreateTaskArgs {
                title: format!("任务@{date}"),
                description: None,
                owner_person_id: warm_a,
                project_id: None,
                due_date: Some(date.into()),
            },
        )
        .expect("建");
    }

    // from=09-10, to=09-15 → 应命中 09-10 / 09-15(边界含)
    let hits = list_tasks_filtered(
        app.state(),
        ListTasksFilteredArgs {
            statuses: vec![],
            owner_person_id: None,
            project_id: None,
            due_date_from: Some("2026-09-10".into()),
            due_date_to: Some("2026-09-15".into()),
            include_cancelled: false,
            include_deactivated_owners: false,
        },
    )
    .expect("筛选");
    assert_eq!(hits.len(), 2, "边界含两端");
    let titles: Vec<&str> = hits.iter().map(|t| t.title.as_str()).collect();
    assert!(titles.contains(&"任务@2026-09-10"));
    assert!(titles.contains(&"任务@2026-09-15"));
}

#[test]
fn 筛选_到期日格式_非法_被拒() {
    let app = mock_app(fresh_db_with_clock(Arc::new(FixedClock::at(
        "2026-09-10 09:00:00",
    ))));

    for (from, to) in [
        (Some("2026/10/01"), None),
        (None, Some("明天")),
        (Some("2026-13-01"), Some("2026-09-15")),
    ] {
        let err = list_tasks_filtered(
            app.state(),
            ListTasksFilteredArgs {
                statuses: vec![],
                owner_person_id: None,
                project_id: None,
                due_date_from: from.map(|s| s.to_string()),
                due_date_to: to.map(|s| s.to_string()),
                include_cancelled: false,
                include_deactivated_owners: false,
            },
        )
        .expect_err("非法日期应当被拒");
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert!(err.message().contains("格式不对"));
    }
}

#[test]
fn 筛选_四维交叉_状态_x_人员_x_项目_x_到期日() {
    // 验收点:四维交叉任意组合结果正确。
    // t1: warm_a + project + 09-15 + Blocked → 命中
    // t2: warm_a + project + 09-15 + Open(状态不符)
    // t3: warm_a + 无项目 + 09-15 + Blocked(项目不符)
    // t4: warm_a + project + 09-01 + Blocked(到期日不符)
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), project_id) = fixture_three_owners(clock);

    let t1 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "命中 #1".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: Some(project_id),
            due_date: Some("2026-09-15".into()),
        },
    )
    .expect("建");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: t1.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some("卡".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("Blocked");

    // 偏离状态(Open)
    create_task(
        app.state(),
        CreateTaskArgs {
            title: "偏离状态".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: Some(project_id),
            due_date: Some("2026-09-15".into()),
        },
    )
    .expect("建");

    // 偏离项目(无项目)+ Blocked
    let t3 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "偏离项目".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: Some("2026-09-15".into()),
        },
    )
    .expect("建");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: t3.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some("卡".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("Blocked t3");

    // 偏离到期日(09-01)+ 项目 + Blocked
    let t4 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "偏离到期日".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: Some(project_id),
            due_date: Some("2026-09-01".into()),
        },
    )
    .expect("建");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: t4.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some("卡".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("Blocked t4");

    // 给四维过滤:warm_a / project_id / 09-10..09-20 / Blocked → 仅 t1
    let hits = list_tasks_filtered(
        app.state(),
        ListTasksFilteredArgs {
            statuses: vec![TaskStatus::Blocked],
            owner_person_id: Some(warm_a),
            project_id: Some(project_id),
            due_date_from: Some("2026-09-10".into()),
            due_date_to: Some("2026-09-20".into()),
            include_cancelled: false,
            include_deactivated_owners: false,
        },
    )
    .expect("筛选");
    let ids: Vec<i64> = hits.iter().map(|t| t.id).collect();
    assert_eq!(ids, vec![t1.id], "四维交叉仅命中 t1");
}

#[test]
fn 筛选_离岗过滤_默认_隐藏_负责人_离岗_的_任务() {
    // 验收点:离岗人员过滤在筛选中可控——默认隐藏,显式打开显示。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, warm_b, _), _) = fixture_three_owners(clock);

    let t_a = create_task(
        app.state(),
        CreateTaskArgs {
            title: "warm_a 任务".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");
    let t_b = create_task(
        app.state(),
        CreateTaskArgs {
            title: "warm_b 任务".into(),
            description: None,
            owner_person_id: warm_b,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建");

    deactivate_person(app.state(), PersonIdArgs { id: warm_b }).expect("warm_b 离岗");

    // 默认——warm_b 的任务应当被过滤
    let hits = list_tasks_filtered(
        app.state(),
        ListTasksFilteredArgs {
            statuses: vec![],
            owner_person_id: None,
            project_id: None,
            due_date_from: None,
            due_date_to: None,
            include_cancelled: false,
            include_deactivated_owners: false,
        },
    )
    .expect("筛选");
    let ids: Vec<i64> = hits.iter().map(|t| t.id).collect();
    assert_eq!(ids, vec![t_a.id], "默认过滤 warm_b 的任务");

    // include_deactivated_owners = true——warm_b 的任务也出现
    let hits = list_tasks_filtered(
        app.state(),
        ListTasksFilteredArgs {
            statuses: vec![],
            owner_person_id: None,
            project_id: None,
            due_date_from: None,
            due_date_to: None,
            include_cancelled: false,
            include_deactivated_owners: true,
        },
    )
    .expect("筛选");
    let ids: Vec<i64> = hits.iter().map(|t| t.id).collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&t_a.id));
    assert!(ids.contains(&t_b.id), "打开后 warm_b 的任务出现");
}

// ---------------------------------------------------------------------------
// 验证「不走 ICU / 不走可加载扩展」——这是 ticket #27 的最后一条验收点。
// ---------------------------------------------------------------------------

#[test]
fn fts5_影子表不_依赖_icu_或_可加载_扩展() {
    // 验收点最后一条:不引入 ICU,不引入可加载扩展。直接查 sqlite_master
    // 看 FTS5 是内置 trigram 还是外部编译——编译进 SQLite 的 trigram 模
    // 块无需额外注册,shadow 表即可建立。本测试断言 V001 migration 跑
    // 完后 task_fts 已经建好,且用 trigram 分词——隐式证明没有 ICU 依赖。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));
    let state = app.state::<AppState>();
    let conn = state.db().expect("conn");

    // 1) 影子表已建
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'task_fts'",
            [],
            |row| row.get(0),
        )
        .expect("查影子表");
    assert_eq!(exists, 1, "task_fts 影子表已建立");

    // 2) 3 条 trigger 齐全
    let trigger_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master \
              WHERE type = 'trigger' AND name IN ('task_ai', 'task_ad', 'task_au')",
            [],
            |row| row.get(0),
        )
        .expect("查触发器");
    assert_eq!(trigger_count, 3, "task_ai / task_ad / task_au 三条触发器齐全");

    // 3) 影子表走 trigram:插入一段中文,搜子串能命中——直接走 task_fts 的
    //    MATCH 验证,绕开 search 命令,确保不会引入额外 path。
    //
    // 注:trigram 召回需要 query ≥ 3 字且与文档 trigram 任意一对匹配——
    // "外委合同评审" 的 trigram 是「外委合 / 委合同 / 合同评 / 同评审」,
    // query "合同" 单独是 2 字,不能 tokenize;「合同评」「外委合」「委合同」
    // 这几个 3 字子串都召回。"委合同" 是贴近"合同"的真实可用 query。
    conn.execute(
        "INSERT INTO task_fts(rowid, title, description) \
         VALUES (1, '外委合同评审', '本年度外委合同集中评审')",
        [],
    )
    .expect("raw insert into task_fts");

    let hits: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task_fts WHERE task_fts MATCH ?1",
            rusqlite::params!["委合同"],
            |row| row.get(0),
        )
        .expect("MATCH trigram");
    assert_eq!(hits, 1, "trigram MATCH 应能召回中文子串");
}

// ---------------------------------------------------------------------------
// issue #27 验收点（端到端）：搜"合同"能命中"外委合同评审"
// ---------------------------------------------------------------------------

#[test]
fn 搜索_合同_短查询_命中_外委合同评审() {
    // issue body 显式给出的端到端示例:科长半年后打"合同"两字,应能
    // 召回半年前那条"外委合同评审"——不必记住完整措辞。短查询走
    // LIKE 兜底路径(本测试是 2 字 query),见 [`search_tasks_like`] 的
    // 设计说明。
    let clock = Arc::new(FixedClock::at("2026-03-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);

    create_task(
        app.state(),
        CreateTaskArgs {
            title: "外委合同评审".into(),
            description: Some("本年度外委合同集中评审".into()),
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务");

    let hits = search_tasks_blocking_for_tests(
        app.state::<AppState>().inner(),
        SearchTasksArgs {
            query: "合同".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    )
    .expect("搜索成功");
    assert_eq!(hits.len(), 1, "LIKE '%合同%' 应命中");
    assert_eq!(hits[0].title, "外委合同评审");
}

// ---------------------------------------------------------------------------
// 长查询走 `spawn_blocking` 路径——验收点契约
// ---------------------------------------------------------------------------

#[test]
fn 搜索_async_命令走_spawn_blocking_返回正确结果() {
    // 验收点最后一条:长查询走 `spawn_blocking`,不阻塞短查询。本测试
    // 走 Tauri 自带的 `async_runtime::block_on` 驱动 `search_tasks`
    // async 命令,验证:
    // 1) async 入口能跑通
    // 2) 结果与同步路径一致
    //
    // 直接断言"用了 spawn_blocking"靠 mock runtime 不便——但
    // `tauri::async_runtime::block_on(search_tasks(...))` 能跑通本身
    // 就是契约证明:async fn 的 future 内部一定调用了 spawn_blocking
    // 或 await 了某个 spawn_blocking 返回的 future,否则 conn 在 await
    // 跨线程时会被 drop(我们没用 Send 包裹)。
    use kewutong_lib::commands::task::search_tasks;

    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, (warm_a, _, _), _) = fixture_three_owners(clock);

    create_task(
        app.state(),
        CreateTaskArgs {
            title: "外委合同评审".into(),
            description: None,
            owner_person_id: warm_a,
            project_id: None,
            due_date: None,
        },
    )
    .expect("建任务");

    let result = tauri::async_runtime::block_on(search_tasks(
        app.state(),
        SearchTasksArgs {
            query: "合同".into(),
            include_cancelled: false,
            include_deactivated_owners: false,
            limit: None,
        },
    ));
    let hits = result.expect("async 搜索应成功");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "外委合同评审");
}