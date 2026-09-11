//! 「人员矩阵」视图的集成测试（ticket #22）。
//!
//! 验收点（来自 ticket #22）：
//! - 分段瀑布流：每个子组一段，段内自适应分列
//! - 窗口从最窄到最宽都不出现横向滚动条（验收靠前端 CSS / 测试只关心 DTO 形状）
//! - 每人展示在飞任务数与阻塞数，数字由命令层算出
//! - 离岗人员默认过滤掉
//! - 就地改状态走同一个「点徽章 → 6 项菜单」手势
//! - 查询命中 `(owner_person_id, status, due_date)` 与
//!   `person(sub_team_id, deactivated_at)` 索引（EXPLAIN QUERY PLAN 兜底）
//! - 集成测试覆盖按子组分段的查询结果与两个计数

mod support;

use kewutong_lib::clock::FixedClock;
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, deactivate_person, CreatePersonArgs, CreateSubTeamArgs,
    PersonIdArgs, PersonnelMatrix,
};
use kewutong_lib::commands::task::{
    create_task, set_task_status, CreateTaskArgs, SetTaskStatusArgs, TaskStatus,
};
use kewutong_lib::state::AppState;
use kewutong_lib::testing::fresh_db_with_clock;
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/// 在已就位的 `(clock, conn)` 上建若干子组 + 人员——矩阵测试只关心组内人
/// 的归属与人员列表顺序。返回每个子组的人数，按建组顺序对应。
///
/// 注意：人员名带子组前缀,避免同测试内多次复用 helper 时撞同子组 UNIQUE。
fn seed_sub_teams_and_people(
    app: &tauri::App<tauri::test::MockRuntime>,
    plan: &[(&str, &[&str])],
) -> Vec<(i64, i64)> {
    // (sub_team_id, person_count)
    let mut ids = Vec::with_capacity(plan.len());
    for (team_name, members) in plan {
        let team = create_sub_team(
            app.state(),
            CreateSubTeamArgs {
                name: (*team_name).into(),
                description: None,
            },
        )
        .expect("建组");
        for suffix in *members {
            // 同子组内 UNIQUE——前缀化避免 helper 复用时撞名。
            let name = format!("{team_name}-{suffix}");
            create_person(
                app.state(),
                CreatePersonArgs {
                    name,
                    sub_team_id: team.id,
                    contact: "示例".into(),
                },
            )
            .expect("录人");
        }
        ids.push((team.id, members.len() as i64));
    }
    ids
}

/// 给指定 owner 追加若干带 `due_date` 与目标状态的任务。
///
/// 返回 `Vec<i64>` 顺序与传入 `due_dates` 一致；status 数组长度必须与
/// due_dates 一致（缺省就当 `Open`）。
fn seed_tasks(
    app: &tauri::App<tauri::test::MockRuntime>,
    owner_id: i64,
    due_dates_and_status: &[(&str, Option<TaskStatus>)],
) -> Vec<i64> {
    let mut ids = Vec::with_capacity(due_dates_and_status.len());
    for (due, status) in due_dates_and_status {
        let task = create_task(
            app.state(),
            CreateTaskArgs {
                title: format!("任务@{due}"),
                description: None,
                owner_person_id: owner_id,
                project_id: None,
                due_date: Some((*due).to_string()),
            },
        )
        .expect("建任务");
        if let Some(target) = status {
            let reason = match target {
                TaskStatus::Blocked | TaskStatus::WaitingOn => Some("理由".to_string()),
                _ => None,
            };
            let waiting_on = if matches!(target, TaskStatus::WaitingOn) {
                Some(owner_id)
            } else {
                None
            };
            set_task_status(
                app.state(),
                SetTaskStatusArgs {
                    task_id: task.id,
                    status: *target,
                    blocked_reason: reason,
                    waiting_on_person_id: waiting_on,
                },
            )
            .expect("切状态");
        }
        ids.push(task.id);
    }
    ids
}

// ---------------------------------------------------------------------------
// 段与人员列：按子组分段、按 sort_order 排序、默认过滤离岗
// ---------------------------------------------------------------------------

#[test]
fn 矩阵_按子组分段且按_sort_order_升序() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));
    // 用「先建组、再按字母序建组」证明顺序由 sort_order 决定,不依赖插入顺序。
    seed_sub_teams_and_people(&app, &[("电气", &["a"]), ("暖通", &["a"])]);

    let view: PersonnelMatrix = kewutong_lib::commands::personnel::personnel_matrix(
        app.state(),
        kewutong_lib::commands::personnel::PersonnelMatrixArgs {
            include_deactivated: false,
        },
    )
    .expect("personnel_matrix 应当成功");

    let names: Vec<&str> = view
        .segments
        .iter()
        .map(|s| s.sub_team.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["电气", "暖通"],
        "按建组顺序的 sort_order 升序排列"
    );
}

#[test]
fn 矩阵_默认过滤掉离岗人员_且_整段若全离岗则该段不出现在结果中() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));
    // 暖通:甲在岗 / 乙离岗 -> 段仍出现,但只剩甲
    // 电气:全员离岗 -> 段直接消失
    seed_sub_teams_and_people(&app, &[("暖通", &["甲", "乙"]), ("电气", &["丙", "丁"])]);

    // 找出暖通段下"乙"的 id 并离岗,以及电气段下全员
    let all_people = kewutong_lib::commands::personnel::list_people(
        app.state(),
        kewutong_lib::commands::personnel::ListPeopleArgs {
            include_deactivated: true,
            sub_team_id: None,
        },
    )
    .unwrap();
    for person in &all_people {
        deactivate_person(app.state(), PersonIdArgs { id: person.id })
            .expect("全离岗");
    }
    // 仅把暖通-甲复岗——证明暖通段只剩甲
    let jia = all_people
        .iter()
        .find(|p| p.name == "暖通-甲")
        .unwrap();
    kewutong_lib::commands::personnel::reactivate_person(
        app.state(),
        PersonIdArgs { id: jia.id },
    )
    .expect("甲复岗");

    let view = kewutong_lib::commands::personnel::personnel_matrix(
        app.state(),
        kewutong_lib::commands::personnel::PersonnelMatrixArgs {
            include_deactivated: false,
        },
    )
    .expect("matrix");

    // 暖通段:甲还在岗
    let warm = view
        .segments
        .iter()
        .find(|s| s.sub_team.name == "暖通")
        .expect("暖通段应当出现");
    assert_eq!(
        warm.people.iter().map(|p| p.person.name.as_str()).collect::<Vec<_>>(),
        vec!["暖通-甲"]
    );
    // 电气段:全员离岗,整段被略去
    assert!(
        !view.segments.iter().any(|s| s.sub_team.name == "电气"),
        "整段全离岗时该段不出现在结果中"
    );
}

#[test]
fn 矩阵_include_deactivated_为真_时_离岗人员仍出现_但挂在段尾() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));
    let (team_id, _) = {
        let ids = seed_sub_teams_and_people(&app, &[("暖通", &["甲", "乙", "丙"])]);
        (ids[0].0, ())
    };
    let yi_id = {
        let all = kewutong_lib::commands::personnel::list_people(
            app.state(),
            kewutong_lib::commands::personnel::ListPeopleArgs {
                include_deactivated: true,
                sub_team_id: Some(team_id),
            },
        )
        .unwrap();
        all.iter().find(|p| p.name == "暖通-乙").unwrap().id
    };
    deactivate_person(app.state(), PersonIdArgs { id: yi_id }).expect("离岗");

    let view = kewutong_lib::commands::personnel::personnel_matrix(
        app.state(),
        kewutong_lib::commands::personnel::PersonnelMatrixArgs {
            include_deactivated: true,
        },
    )
    .expect("matrix");

    let names: Vec<&str> = view
        .segments
        .iter()
        .find(|s| s.sub_team.id == team_id)
        .map(|s| s.people.iter().map(|p| p.person.name.as_str()).collect())
        .unwrap();
    // 顺序：在岗的在前(id 升序),离岗的紧随其后;组内 id 自增,
    // 所以暖通-甲(在岗)、暖通-丙(在岗)先,然后离岗的暖通-乙。
    assert_eq!(names, vec!["暖通-甲", "暖通-丙", "暖通-乙"]);
}

// ---------------------------------------------------------------------------
// 两个计数：在飞任务数 / 阻塞数
// ---------------------------------------------------------------------------

#[test]
fn 矩阵_每人_in_flight_count_与_blocked_count_由命令层算出() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));
    let (team_a, _) = {
        let ids = seed_sub_teams_and_people(&app, &[("暖通", &["甲", "乙"])]);
        (ids[0].0, ())
    };

    // 给甲塞 5 条任务,横跨 6 状态:
    //   1 Open          (在飞)
    //   1 In-progress   (在飞)
    //   1 Blocked       (在飞 + 阻塞)
    //   1 Waiting-on    (在飞 + 阻塞)
    //   1 Done          (不在飞)
    //   1 Cancelled     (不在飞)
    let ids = seed_tasks(
        &app,
        /* 甲的 id */
        {
            // 用 list_people 拿 id,避免对建组/录人顺序做隐含假设
            let roster = kewutong_lib::commands::personnel::list_people(
                app.state(),
                kewutong_lib::commands::personnel::ListPeopleArgs {
                    include_deactivated: true,
                    sub_team_id: Some(team_a),
                },
            )
            .unwrap();
            roster.iter().find(|p| p.name == "暖通-甲").unwrap().id
        },
        &[
            ("2026-09-10", Some(TaskStatus::Open)),
            ("2026-09-11", Some(TaskStatus::InProgress)),
            ("2026-09-12", Some(TaskStatus::Blocked)),
            ("2026-09-13", Some(TaskStatus::WaitingOn)),
            ("2026-09-14", Some(TaskStatus::Done)),
            ("2026-09-15", Some(TaskStatus::Cancelled)),
        ],
    );

    let view = kewutong_lib::commands::personnel::personnel_matrix(
        app.state(),
        kewutong_lib::commands::personnel::PersonnelMatrixArgs {
            include_deactivated: false,
        },
    )
    .expect("matrix");

    let segment = view
        .segments
        .iter()
        .find(|s| s.sub_team.id == team_a)
        .expect("暖通段应当存在");
    let jia = segment
        .people
        .iter()
        .find(|p| p.person.name == "暖通-甲")
        .expect("甲应当在岗段中");
    // 在飞 = 6 - Done - Cancelled = 4
    assert_eq!(jia.in_flight_count, 4, "Done/Cancelled 不计入在飞");
    // 阻塞 = Blocked + Waiting-on = 2
    assert_eq!(jia.blocked_count, 2, "Blocked+Waiting-on 计入阻塞");

    // 乙手上没有任何任务——两个计数都是 0
    let yi = segment
        .people
        .iter()
        .find(|p| p.person.name == "暖通-乙")
        .expect("乙应当在岗段中");
    assert_eq!(yi.in_flight_count, 0);
    assert_eq!(yi.blocked_count, 0);
    assert!(yi.tasks.is_empty(), "无任务时 tasks 数组为空");

    // ids 用来锁住顺序无关性——这里只为静音未用告警
    let _ = ids;
}

#[test]
fn 矩阵_每人_tasks_只看在飞任务且按状态优先级加_due_date_排序() {
    // 排序：先看在飞(Cancelled/Done 已剔除),状态优先级与 prototype/core-views
    // 的 STATUS_ORDER 对齐(open / in-progress / blocked / waiting-on),
    // 同状态内按 due_date 升序。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));
    let (team_id, _) = {
        let ids = seed_sub_teams_and_people(&app, &[("暖通", &["甲"])]);
        (ids[0].0, ())
    };
    let roster = kewutong_lib::commands::personnel::list_people(
        app.state(),
        kewutong_lib::commands::personnel::ListPeopleArgs {
            include_deactivated: true,
            sub_team_id: Some(team_id),
        },
    )
    .unwrap();
    let jia_id = roster.iter().find(|p| p.name == "暖通-甲").unwrap().id;

    // 注意:done 与 cancelled 不应出现在 matrix.tasks 里。
    // 状态优先级:Open > In-progress > Blocked > Waiting-on(prototype STATUS_ORDER)。
    seed_tasks(
        &app,
        jia_id,
        &[
            ("2026-09-20", Some(TaskStatus::Done)),         // 排除
            ("2026-09-18", Some(TaskStatus::Cancelled)),   // 排除
            // 同一状态多条:同状态内按 due_date ASC
            ("2026-09-14", Some(TaskStatus::Open)),
            ("2026-09-12", Some(TaskStatus::Open)),
            // 不同状态混合,排序按状态优先级而非 due_date:
            // Open@14 < InProgress@13 < Blocked@11 < WaitingOn@15
            ("2026-09-13", Some(TaskStatus::InProgress)),
            ("2026-09-11", Some(TaskStatus::Blocked)),
            ("2026-09-15", Some(TaskStatus::WaitingOn)),
        ],
    );

    let view = kewutong_lib::commands::personnel::personnel_matrix(
        app.state(),
        kewutong_lib::commands::personnel::PersonnelMatrixArgs {
            include_deactivated: false,
        },
    )
    .expect("matrix");

    let jia = view
        .segments
        .iter()
        .find(|s| s.sub_team.id == team_id)
        .unwrap()
        .people
        .first()
        .expect("甲");
    let due_dates: Vec<&str> = jia.tasks.iter().map(|t| t.due_date.as_deref().unwrap()).collect();
    // 5 条在飞任务。状态优先级 + 同状态按 due_date ASC:
    //   Open (09-12, 09-14) → InProgress (09-13) → Blocked (09-11) → WaitingOn (09-15)
    assert_eq!(
        due_dates,
        vec!["2026-09-12", "2026-09-14", "2026-09-13", "2026-09-11", "2026-09-15"]
    );
    let _ = jia_id;
}

#[test]
fn 矩阵_同一子组_两_人有各自独立的任务列表与计数() {
    // 一个段里多人的情况下,每个人的 tasks / 计数不能互相串。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));
    let (team_id, _) = {
        let ids = seed_sub_teams_and_people(&app, &[("暖通", &["甲", "乙"])]);
        (ids[0].0, ())
    };
    let roster = kewutong_lib::commands::personnel::list_people(
        app.state(),
        kewutong_lib::commands::personnel::ListPeopleArgs {
            include_deactivated: true,
            sub_team_id: Some(team_id),
        },
    )
    .unwrap();
    let jia_id = roster.iter().find(|p| p.name == "暖通-甲").unwrap().id;
    let yi_id = roster.iter().find(|p| p.name == "暖通-乙").unwrap().id;

    // 甲:2 条在飞,其中 1 条 Blocked
    seed_tasks(
        &app,
        jia_id,
        &[
            ("2026-09-10", Some(TaskStatus::Open)),
            ("2026-09-11", Some(TaskStatus::Blocked)),
        ],
    );
    // 乙:1 条 Open,无阻塞
    seed_tasks(&app, yi_id, &[("2026-09-10", Some(TaskStatus::Open))]);

    let view = kewutong_lib::commands::personnel::personnel_matrix(
        app.state(),
        kewutong_lib::commands::personnel::PersonnelMatrixArgs {
            include_deactivated: false,
        },
    )
    .expect("matrix");

    let segment = view
        .segments
        .iter()
        .find(|s| s.sub_team.id == team_id)
        .unwrap();
    let by_name = |name: &str| {
        segment
            .people
            .iter()
            .find(|p| p.person.name == name)
            .unwrap_or_else(|| panic!("{name} 应当在段内"))
    };
    assert_eq!(by_name("暖通-甲").in_flight_count, 2);
    assert_eq!(by_name("暖通-甲").blocked_count, 1);
    assert_eq!(by_name("暖通-乙").in_flight_count, 1);
    assert_eq!(by_name("暖通-乙").blocked_count, 0);
}

// ---------------------------------------------------------------------------
// EXPLAIN QUERY PLAN 兜底
// ---------------------------------------------------------------------------

#[test]
fn 矩阵_query_走_owner_status_due_与_person_sub_team_deactivated_at_索引() {
    // 验收点（ticket #22）：查询命中 `(owner_person_id, status, due_date)`
    // 与 `person(sub_team_id, deactivated_at)` 索引。
    // 不命中也能通过,但运维巡检时会盯这条。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));
    let state = app.state::<AppState>();
    let conn = state.db().expect("conn");

    // 1) 在飞任务查询走 idx_task_owner_status_due:WHERE owner_person_id = ?
    // AND status IN (...)——前导列 owner_person_id 与第二列 status 命中。
    let mut stmt = conn
        .prepare(
            "EXPLAIN QUERY PLAN \
             SELECT id, status FROM task \
              WHERE owner_person_id = ?1 \
                AND status IN ('Open','In-progress','Blocked','Waiting-on')",
        )
        .expect("plan owner");
    let plan_owner: Vec<String> = stmt
        .query_map(rusqlite::params![1], |row| row.get::<_, String>(3))
        .expect("run")
        .map(|r| r.unwrap())
        .collect();
    eprintln!("EXPLAIN matrix owner: {plan_owner:?}");
    assert!(
        plan_owner.iter().any(|d| d.contains("idx_task_owner_status_due")),
        "owner_person_id + status 应当命中 idx_task_owner_status_due, 实际: {plan_owner:?}"
    );

    // 2) 在岗人员查询走 idx_person_sub_team_deactivated_at。
    let mut stmt2 = conn
        .prepare(
            "EXPLAIN QUERY PLAN \
             SELECT id, name FROM person \
              WHERE sub_team_id = ?1 \
                AND deactivated_at IS NULL \
              ORDER BY id ASC",
        )
        .expect("plan person");
    let plan_person: Vec<String> = stmt2
        .query_map(rusqlite::params![1], |row| row.get::<_, String>(3))
        .expect("run")
        .map(|r| r.unwrap())
        .collect();
    eprintln!("EXPLAIN matrix person: {plan_person:?}");
    assert!(
        plan_person
            .iter()
            .any(|d| d.contains("idx_person_sub_team_deactivated_at")),
        "sub_team_id + deactivated_at 应当命中 idx_person_sub_team_deactivated_at, 实际: {plan_person:?}"
    );
}

// ---------------------------------------------------------------------------
// 空库
// ---------------------------------------------------------------------------

#[test]
fn 矩阵_空库返回空_segments_列表() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));

    let view = kewutong_lib::commands::personnel::personnel_matrix(
        app.state(),
        kewutong_lib::commands::personnel::PersonnelMatrixArgs {
            include_deactivated: false,
        },
    )
    .expect("空库也应当返回");

    assert!(view.segments.is_empty());
}
