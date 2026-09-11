//! 「今日 / 本周」视图的集成测试（ticket #21）。
//!
//! 验收点（来自 ticket #21）：
//! - 计数瓦片：在岗人数 / 进行中 / 阻塞中等三个数字由命令层算出
//! - 四列分桶：已逾期 / 今天 / 明天 / 本周剩余（止于本周日）
//! - 分桶边界走可注入 clock；周日当天 / 周一当天 / 跨日三种边界钉死
//! - 四列只看在飞任务（排除 Done / Cancelled），无截止日也不进桶
//! - 计数「在岗人数」= `person.deactivated_at IS NULL` 的行数
//! - 视图查询命中 `(due_date) WHERE due_date IS NOT NULL` 部分索引（只跑 SQL 不写断言）

mod support;

use kewutong_lib::clock::FixedClock;
use kewutong_lib::commands::personnel::{
    create_person, create_sub_team, deactivate_person, CreatePersonArgs, CreateSubTeamArgs,
};
use kewutong_lib::commands::task::{
    create_task, set_task_status, today_week, CreateTaskArgs, SetTaskStatusArgs, TaskStatus,
    TodayWeek,
};
use kewutong_lib::testing::fresh_db_with_clock;
use std::sync::Arc;
use support::mock_app;
use tauri::Manager;

/// 在 `(clock, owner)` 已经就位的 fixture 上再追加若干带指定 `due_date` 的
/// 在飞任务——只关心桶的分配，不关心别的状态字段。
fn seed_tasks(
    app: &tauri::App<tauri::test::MockRuntime>,
    owner_id: i64,
    due_dates: &[&str],
) -> Vec<i64> {
    let mut ids = Vec::with_capacity(due_dates.len());
    for due in due_dates {
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
        ids.push(task.id);
    }
    ids
}

// ---------------------------------------------------------------------------
// 计数瓦片
// ---------------------------------------------------------------------------

#[test]
fn 计数瓦片_在岗人数_排除离岗人员() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs {
            name: "暖通".into(),
            description: None,
        },
    )
    .expect("建组");
    for name in ["甲", "乙", "丙"] {
        create_person(
            app.state(),
            CreatePersonArgs {
                name: name.into(),
                sub_team_id: team.id,
                contact: "示例".into(),
            },
        )
        .expect("录人");
    }
    // 离岗 1 人——不计入「在岗人数」
    let left = create_person(
        app.state(),
        CreatePersonArgs {
            name: "丁".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");
    deactivate_person(app.state(), kewutong_lib::commands::personnel::PersonIdArgs { id: left.id })
        .expect("离岗");

    let view = today_week(app.state()).expect("today_week 应当成功");

    assert_eq!(view.counts.active_people, 3, "3 人在岗,1 人离岗");
}

#[test]
fn 计数瓦片_进行中_只数_in_progress_跨所有截止日() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = {
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
                name: "甲".into(),
                sub_team_id: team.id,
                contact: "示例".into(),
            },
        )
        .expect("录人");
        (app, owner)
    };

    // 5 条任务:2 条 In-progress(任意日期) + 1 条 Open + 1 条 Done + 1 条 Blocked
    let ip_near = create_task(
        app.state(),
        CreateTaskArgs {
            title: "近期在做".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-10".into()),
        },
    )
    .unwrap();
    let ip_far = create_task(
        app.state(),
        CreateTaskArgs {
            title: "远期在做".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-12-31".into()),
        },
    )
    .unwrap();
    let open = create_task(
        app.state(),
        CreateTaskArgs {
            title: "Open".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-15".into()),
        },
    )
    .unwrap();
    let done = create_task(
        app.state(),
        CreateTaskArgs {
            title: "Done".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-20".into()),
        },
    )
    .unwrap();
    let blocked = create_task(
        app.state(),
        CreateTaskArgs {
            title: "Blocked".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-12".into()),
        },
    )
    .unwrap();
    for (id, target) in [
        (ip_near.id, TaskStatus::InProgress),
        (ip_far.id, TaskStatus::InProgress),
        (done.id, TaskStatus::Done),
        (
            blocked.id,
            TaskStatus::Blocked,
        ),
    ] {
        let reason = match target {
            TaskStatus::Blocked => Some("卡审批".to_string()),
            _ => None,
        };
        set_task_status(
            app.state(),
            SetTaskStatusArgs {
                task_id: id,
                status: target,
                blocked_reason: reason,
                waiting_on_person_id: None,
            },
        )
        .expect("切状态");
    }
    let _ = open; // 留 Open

    let view = today_week(app.state()).expect("today_week 应当成功");

    assert_eq!(view.counts.in_progress, 2, "只数 In-progress,不论日期");
    assert_eq!(
        view.counts.blocked, 1,
        "只数 Blocked(Waiting-on 本用例也无)——其它状态不计"
    );
}

#[test]
fn 计数瓦片_阻塞中等_数_blocked_加_waiting_on() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = {
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
                name: "甲".into(),
                sub_team_id: team.id,
                contact: "示例".into(),
            },
        )
        .expect("录人");
        (app, owner)
    };

    let b1 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "Blocked".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .unwrap();
    let w1 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "Waiting".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .unwrap();
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: b1.id,
            status: TaskStatus::Blocked,
            blocked_reason: Some("卡审批".into()),
            waiting_on_person_id: None,
        },
    )
    .expect("Blocked");
    set_task_status(
        app.state(),
        SetTaskStatusArgs {
            task_id: w1.id,
            status: TaskStatus::WaitingOn,
            blocked_reason: Some("等回函".into()),
            waiting_on_person_id: Some(owner.id),
        },
    )
    .expect("Waiting-on");

    let view = today_week(app.state()).expect("today_week 应当成功");

    assert_eq!(view.counts.blocked, 2);
    assert_eq!(
        view.counts.in_progress, 0,
        "Blocked / Waiting-on 不计入进行中"
    );
}

// ---------------------------------------------------------------------------
// 四列分桶：周内基本形态
// ---------------------------------------------------------------------------

#[test]
fn 四列_周中_周一_时分桶边界正确() {
    // 2026-09-10 是周四。本周日 = 2026-09-13(本周日)。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
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
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");

    let ids = seed_tasks(
        &app,
        owner.id,
        &[
            "2026-09-01", // 已逾期
            "2026-09-09", // 已逾期（紧邻今天）
            "2026-09-10", // 今天
            "2026-09-11", // 明天
            "2026-09-12", // 本周剩余(周六)
            "2026-09-13", // 本周剩余(周日,即本周末日)
            "2026-09-14", // 下周一(本周剩余之外)
            "2026-09-30", // 远期,本周剩余之外
        ],
    );

    let view = today_week(app.state()).expect("today_week 应当成功");

    let by_id = |tasks: &[kewutong_lib::commands::task::Task]| -> Vec<i64> {
        tasks.iter().map(|t| t.id).collect()
    };
    let overdue_ids = by_id(&view.buckets.overdue);
    let today_ids = by_id(&view.buckets.today);
    let tomorrow_ids = by_id(&view.buckets.tomorrow);
    let rest_ids = by_id(&view.buckets.this_week_rest);

    assert_eq!(overdue_ids, vec![ids[0], ids[1]]);
    assert_eq!(today_ids, vec![ids[2]]);
    assert_eq!(tomorrow_ids, vec![ids[3]]);
    assert_eq!(rest_ids, vec![ids[4], ids[5]], "Tue-Sun 之外的不进桶");
}

#[test]
fn 四列_周日当天_本周剩余为空() {
    // 2026-09-13 是周日——「本周剩余」理应为空（再往后就是下周了）。
    // 「明天」按字面仍是今天 + 1 = 周一,所以周一的任务落进 tomorrow 桶。
    let clock = Arc::new(FixedClock::at("2026-09-13 10:00:00"));
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
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");

    seed_tasks(
        &app,
        owner.id,
        &[
            "2026-09-10", // 已逾期
            "2026-09-13", // 今天(周日)
            "2026-09-14", // 明天(周一,字面意义的「明天」)
            "2026-09-15", // 远期(已超周——不进任何桶)
        ],
    );

    let view = today_week(app.state()).expect("today_week 应当成功");

    assert_eq!(view.buckets.overdue.len(), 1);
    assert_eq!(view.buckets.today.len(), 1);
    assert_eq!(view.buckets.tomorrow.len(), 1, "字面意义的明天(周一)仍进 tomorrow 桶");
    assert!(
        view.buckets.this_week_rest.is_empty(),
        "周日当天没有「本周剩余」"
    );
}

#[test]
fn 四列_周一当天_本周剩余跨到周日() {
    // 2026-09-07 是周一——「本周剩余」= 周二到周日(09-08 ~ 09-13)。
    let clock = Arc::new(FixedClock::at("2026-09-07 08:00:00"));
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
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");

    seed_tasks(
        &app,
        owner.id,
        &[
            "2026-09-06", // 已逾期(上周日)
            "2026-09-07", // 今天(周一)
            "2026-09-08", // 明天(周二)
            "2026-09-09", // 本周剩余(周三)
            "2026-09-13", // 本周剩余(周日)
            "2026-09-14", // 下周一(不进任何桶)
        ],
    );

    let view = today_week(app.state()).expect("today_week 应当成功");

    assert_eq!(view.buckets.overdue.len(), 1);
    assert_eq!(view.buckets.today.len(), 1);
    assert_eq!(view.buckets.tomorrow.len(), 1);
    assert_eq!(
        view.buckets.this_week_rest.len(),
        2,
        "本周剩余 = 周三 + 周日"
    );
}

#[test]
fn 四列_周六_本周剩余为空_周日进_tomorrow() {
    // 2026-09-12 是周六——「明天」= 周日,「本周剩余」理应为空（再往后就是下周）。
    // 周日的任务进 tomorrow 桶,而非 this_week_rest。
    let clock = Arc::new(FixedClock::at("2026-09-12 09:00:00"));
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
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");

    seed_tasks(
        &app,
        owner.id,
        &[
            "2026-09-10",
            "2026-09-12", // 今天(周六)
            "2026-09-13", // 明天(周日)——进 tomorrow 桶
            "2026-09-14", // 下周一(不进任何桶)
        ],
    );

    let view = today_week(app.state()).expect("today_week 应当成功");

    assert_eq!(view.buckets.today.len(), 1);
    assert_eq!(view.buckets.tomorrow.len(), 1, "周日进 tomorrow");
    assert!(
        view.buckets.this_week_rest.is_empty(),
        "周六当天没有「本周剩余」——周日已被 tomorrow 占走"
    );
}

#[test]
fn 四列_跨日_时钟跨过本地午夜后_今天跟着本地走() {
    // 本地 23:30(UTC 15:30)→ 跨到次日 00:30(UTC 16:30)。「今天」应当跟着
    // 科长本地走——不会因为 UTC 没翻篇就停在原日。
    let clock = Arc::new(FixedClock::at("2026-09-10 15:30:00"));
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
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");

    seed_tasks(
        &app,
        owner.id,
        &[
            "2026-09-10",
            "2026-09-11", // 本地夜跨过来后这就是「今天」了
            "2026-09-12", // 本地「明天」
        ],
    );

    let before_view = today_week(app.state()).expect("跨日前");
    assert_eq!(before_view.buckets.today.len(), 1, "09-10 是今天");
    assert_eq!(before_view.buckets.tomorrow.len(), 1, "09-11 是明天");

    clock.advance(chrono::TimeDelta::hours(1));
    let after_view = today_week(app.state()).expect("跨日后");
    assert_eq!(
        after_view.buckets.today.len(),
        1,
        "UTC 16:30 本地已是 09-11 00:30——09-11 应当进「今天」"
    );
    // 已逾期只包含 09-10 一条
    assert_eq!(after_view.buckets.overdue.len(), 1);
    // 明天 = 09-12
    assert_eq!(after_view.buckets.tomorrow.len(), 1);
}

// ---------------------------------------------------------------------------
// 四列过滤语义：排除 Done / Cancelled / 无截止日
// ---------------------------------------------------------------------------

#[test]
fn 四列_排除_done_与_cancelled_任务() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = {
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
                name: "甲".into(),
                sub_team_id: team.id,
                contact: "示例".into(),
            },
        )
        .expect("录人");
        (app, owner)
    };

    let done = create_task(
        app.state(),
        CreateTaskArgs {
            title: "已完".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-10".into()),
        },
    )
    .unwrap();
    let cancelled = create_task(
        app.state(),
        CreateTaskArgs {
            title: "已撤".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-10".into()),
        },
    )
    .unwrap();
    let open = create_task(
        app.state(),
        CreateTaskArgs {
            title: "待开始".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-10".into()),
        },
    )
    .unwrap();
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

    let view = today_week(app.state()).expect("today_week 应当成功");

    let today_ids: Vec<i64> = view.buckets.today.iter().map(|t| t.id).collect();
    assert_eq!(
        today_ids,
        vec![open.id],
        "Done / Cancelled 不进任何桶"
    );
}

#[test]
fn 四列_排除无截止日的任务() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner) = {
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
                name: "甲".into(),
                sub_team_id: team.id,
                contact: "示例".into(),
            },
        )
        .expect("录人");
        (app, owner)
    };

    let with_due = create_task(
        app.state(),
        CreateTaskArgs {
            title: "有期".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-10".into()),
        },
    )
    .unwrap();
    let no_due = create_task(
        app.state(),
        CreateTaskArgs {
            title: "无期".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: None,
        },
    )
    .unwrap();

    let view = today_week(app.state()).expect("today_week 应当成功");

    let in_buckets: Vec<i64> = view
        .buckets
        .overdue
        .iter()
        .chain(view.buckets.today.iter())
        .chain(view.buckets.tomorrow.iter())
        .chain(view.buckets.this_week_rest.iter())
        .map(|t| t.id)
        .collect();
    assert_eq!(in_buckets, vec![with_due.id], "无 due_date 不进任何桶");
    let _ = no_due;
}

// ---------------------------------------------------------------------------
// 同列内排序：到期日升序、id 兜底
// ---------------------------------------------------------------------------

#[test]
fn 四列_桶内按_due_date_升序_id_兜底() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
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
            name: "甲".into(),
            sub_team_id: team.id,
            contact: "示例".into(),
        },
    )
    .expect("录人");

    // 同桶多条逾期任务:日期与 id 都乱的,按 due_date 升序、再 id 升序。
    let late_late = create_task(
        app.state(),
        CreateTaskArgs {
            title: "晚晚".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-08-01".into()),
        },
    )
    .unwrap();
    let late = create_task(
        app.state(),
        CreateTaskArgs {
            title: "晚".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-05".into()),
        },
    )
    .unwrap();
    let late_late2 = create_task(
        app.state(),
        CreateTaskArgs {
            title: "晚晚2".into(),
            description: None,
            owner_person_id: owner.id,
            project_id: None,
            due_date: Some("2026-09-05".into()),
        },
    )
    .unwrap();

    let view = today_week(app.state()).expect("today_week 应当成功");
    let ids: Vec<i64> = view.buckets.overdue.iter().map(|t| t.id).collect();
    // Aug 1 < Sep 5,同 Sep 5 内 id 升序兜底
    assert_eq!(
        ids,
        vec![late_late.id, late.id, late_late2.id],
        "Aug 1 (id=1) 先,然后 Sep 5 按 id 升序"
    );
}

// ---------------------------------------------------------------------------
// EXPLAIN QUERY PLAN 验证：桶查询命中部分索引
// ---------------------------------------------------------------------------

#[test]
fn 桶查询_走_due_date_的_partial_index() {
    // 这一票不发断言——只跑 EXPLAIN QUERY PLAN,人工/日志检查走没走索引。
    // 不命中也能通过,但运维检查时一票会盯这条。
    use rusqlite::Connection;

    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));
    let state = app.state::<kewutong_lib::state::AppState>();
    let conn: std::sync::MutexGuard<'_, Connection> = state.db().expect("conn");

    let mut stmt = conn
        .prepare(
            "EXPLAIN QUERY PLAN \
             SELECT id FROM task \
              WHERE due_date IS NOT NULL \
                AND due_date < ?1 \
                AND status NOT IN ('Done','Cancelled') \
              ORDER BY due_date ASC, id ASC",
        )
        .expect("plan");
    let plan = stmt
        .query_map(rusqlite::params!["2026-09-10"], |row| row.get::<_, String>(3))
        .expect("run");
    let details: Vec<String> = plan.map(|r| r.unwrap()).collect();
    eprintln!("EXPLAIN overdue: {details:?}");
    assert!(
        details.iter().any(|d| d.contains("idx_task_due_date")),
        "EXPLAIN QUERY PLAN 应命中 idx_task_due_date（partial index），实际：{details:?}"
    );
}

// ---------------------------------------------------------------------------
// 空库 / 边界空桶
// ---------------------------------------------------------------------------

#[test]
fn 空库_四列都为空_计数都为_0() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let app = mock_app(fresh_db_with_clock(clock));

    let view: TodayWeek = today_week(app.state()).expect("空库也应当返回");
    assert_eq!(view.counts.active_people, 0);
    assert_eq!(view.counts.in_progress, 0);
    assert_eq!(view.counts.blocked, 0);
    assert!(view.buckets.overdue.is_empty());
    assert!(view.buckets.today.is_empty());
    assert!(view.buckets.tomorrow.is_empty());
    assert!(view.buckets.this_week_rest.is_empty());
    // 物化窗口右端 = today + 12 周 = 2026-12-03
    assert_eq!(view.materialization_window_end, "2026-12-03");
}

// ---------------------------------------------------------------------------
// 周期性 instance 混排进今日/本周桶（ticket #25）
// ---------------------------------------------------------------------------

use kewutong_lib::commands::recurring_template::{
    upsert_recurring_template, UpsertRecurringTemplateArgs,
};
use kewutong_lib::holiday::HolidayCalendar;
use kewutong_lib::materialization::{materialize_from_state, wall_clock_to_utc_sql};
use kewutong_lib::recurring::{byday, EndsSpec, Freq, HolidayBehavior, StructuredRule};
use chrono::NaiveDate;

/// 直接 INSERT 一条 instance(走物化等价路径),绕开完整模板物化。
/// 测试用——快速把 instance 行塞进去,验证 today_week 的桶逻辑。
fn seed_instance(
    app: &tauri::App<tauri::test::MockRuntime>,
    template_id: i64,
    owner_id: i64,
    sub_team_id: i64,
    local_date: NaiveDate,
    hour: u32,
    minute: u32,
    status: &str,
) -> i64 {
    let state = app.state::<kewutong_lib::state::AppState>();
    let conn = state.db().expect("conn");
    let utc = wall_clock_to_utc_sql(local_date, hour, minute);
    let title = format!("instance@{local_date}");
    conn.execute(
        "INSERT INTO task (title, status, owner_person_id, sub_team_id,
                            recurring_template_id, scheduled_at, original_scheduled_at,
                            rescheduled_from_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL, datetime('now'), datetime('now'))",
        rusqlite::params![title, status, owner_id, sub_team_id, template_id, utc],
    )
    .expect("insert instance");
    conn.last_insert_rowid()
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

fn fresh_app_with_calendar(clock: Arc<FixedClock>) -> (tauri::App<tauri::test::MockRuntime>, i64, i64) {
    let (dir, seed_dir) = write_seed_pair();
    let conn = kewutong_lib::db::open_in_memory().expect("内存库");
    let cal = HolidayCalendar::load(&seed_dir, 2026, &conn).expect("加载");
    let state = fresh_db_with_clock(clock);
    state.install_calendar(cal);
    let app = mock_app(state);
    let team = create_sub_team(
        app.state(),
        CreateSubTeamArgs { name: "暖通".into(), description: None },
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
    let _ = (dir, seed_dir); // 持有 TempDir
    (app, owner.id, team.id)
}

fn write_seed_pair() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("临时目录");
    let path = dir.path().to_path_buf();
    std::fs::write(
        path.join("cn-2026.json"),
        r#"{ "holidays": [], "workdays": [] }"#,
    )
    .expect("写 2026");
    std::fs::write(path.join("cn-2027.json"), r#"{ "holidays": [], "workdays": [] }"#)
        .expect("写 2027");
    (dir, path)
}

#[test]
fn 今日_instance_混排进_今天_列_且带_is_recurring_标记() {
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00")); // Thu
    let (app, owner, sub_team) = fresh_app_with_calendar(clock);
    let template = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "周一例会".into(),
            rule: weekly_rule(),
            project_id: None,
            sub_team_id: Some(sub_team),
            notes: None,
        },
    )
    .expect("建模板");

    // 手动塞一条 scheduled_at = 2026-09-14 00:00 UTC (= 09-14 08:00 Asia/Shanghai)
    // 的 instance。9/14 是 Mon,本地日期与 UTC 日期相同。
    let id = seed_instance(
        &app,
        template.id,
        owner,
        sub_team,
        NaiveDate::from_ymd_opt(2026, 9, 14).unwrap(),
        8,
        0,
        "Open",
    );
    assert!(id > 0);

    let _ = id; // 第一次 query 仅为驱动 `id` 落库,真正断言在第二次 query 上
    let id2 = seed_instance(
        &app,
        template.id,
        owner,
        sub_team,
        NaiveDate::from_ymd_opt(2026, 9, 10).unwrap(),
        8,
        0,
        "Open",
    );
    let view: TodayWeek = today_week(app.state()).expect("view");
    let today_instance = view
        .buckets
        .today
        .iter()
        .find(|t| t.id == id2)
        .expect("9/10 instance 落在 today 桶");
    assert!(today_instance.is_recurring, "instance 应带 is_recurring=true");
    assert_eq!(today_instance.recurring_template_id, Some(template.id));
    assert_eq!(today_instance.effective_date.as_deref(), Some("2026-09-10"));
    assert!(today_instance.due_date.is_none());
}

#[test]
fn 今日_instance_跨日_utc_前一日但本地是_今天_仍进_今天_桶() {
    // scheduled_at = 2026-09-09 16:00:00 UTC = 2026-09-10 00:00 Asia/Shanghai
    // 本地日期是 9/10,但 UTC 日期是 9/9。
    // today_week 用 `date(scheduled_at, '+8 hours')` 转本地日期,应正确归到 9/10。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner, sub_team) = fresh_app_with_calendar(clock);
    let template = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "早班".into(),
            rule: weekly_rule(),
            project_id: None,
            sub_team_id: Some(sub_team),
            notes: None,
        },
    )
    .expect("建模板");

    // 0:00 Asia/Shanghai 的 instance → UTC 是前一日 16:00
    let id = seed_instance(
        &app,
        template.id,
        owner,
        sub_team,
        NaiveDate::from_ymd_opt(2026, 9, 10).unwrap(),
        0,
        0,
        "Open",
    );

    let view: TodayWeek = today_week(app.state()).expect("view");
    let inst = view.buckets.today.iter().find(|t| t.id == id).expect("9/10 instance");
    assert_eq!(inst.effective_date.as_deref(), Some("2026-09-10"));
    assert!(inst.is_recurring);
}

#[test]
fn 今日_instance_跨日_utc_同日但本地是_明天_不误进_今天_桶() {
    // scheduled_at = 2026-09-10 18:00:00 UTC = 2026-09-11 02:00 Asia/Shanghai
    // 本地日期是 9/11(明天),UTC 日期是 9/10(今天)。应进 tomorrow 桶,
    // 不进 today 桶。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner, sub_team) = fresh_app_with_calendar(clock);
    let template = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "夜班".into(),
            rule: weekly_rule(),
            project_id: None,
            sub_team_id: Some(sub_team),
            notes: None,
        },
    )
    .expect("建模板");

    let id = seed_instance(
        &app,
        template.id,
        owner,
        sub_team,
        NaiveDate::from_ymd_opt(2026, 9, 11).unwrap(),
        2,
        0,
        "Open",
    );

    let view: TodayWeek = today_week(app.state()).expect("view");
    assert!(
        view.buckets.today.iter().all(|t| t.id != id),
        "9/11 02:00 local instance 不应进 today"
    );
    assert!(
        view.buckets.tomorrow.iter().any(|t| t.id == id),
        "9/11 02:00 local instance 应进 tomorrow"
    );
}

#[test]
fn 今日_instance_与_一次性_task_混排_且实例带_回旋标记() {
    // 验收点:实例与一次性同构混排进同一桶,UI 按 is_recurring 决定 ↻ 标记
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00"));
    let (app, owner, sub_team) = fresh_app_with_calendar(clock);
    let template = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "周一例会".into(),
            rule: weekly_rule(),
            project_id: None,
            sub_team_id: Some(sub_team),
            notes: None,
        },
    )
    .expect("建模板");

    // 一次性 task 落在 9/10
    let one_off = create_task(
        app.state(),
        CreateTaskArgs {
            title: "一次性今天".into(),
            description: None,
            owner_person_id: owner,
            project_id: None,
            due_date: Some("2026-09-10".into()),
        },
    )
    .expect("建一次性");
    // instance 落在 9/10
    let inst = seed_instance(
        &app,
        template.id,
        owner,
        sub_team,
        NaiveDate::from_ymd_opt(2026, 9, 10).unwrap(),
        8,
        0,
        "Open",
    );

    let view: TodayWeek = today_week(app.state()).expect("view");
    assert_eq!(view.buckets.today.len(), 2);
    let one_off_in = view.buckets.today.iter().find(|t| t.id == one_off.id).unwrap();
    let inst_in = view.buckets.today.iter().find(|t| t.id == inst).unwrap();
    assert!(!one_off_in.is_recurring, "一次性 is_recurring=false");
    assert!(inst_in.is_recurring, "instance is_recurring=true");
    assert!(one_off_in.recurring_template_id.is_none());
    assert_eq!(inst_in.recurring_template_id, Some(template.id));
}

#[test]
fn materialize_后_今日_视图_能_查_到_新生成_instance() {
    // 端到端:建模板 → 物化 → today_week 应能在 today/tomorrow 桶里
    // 看到 instance。
    let clock = Arc::new(FixedClock::at("2026-09-10 09:00:00")); // Thu
    let (app, _owner, sub_team) = fresh_app_with_calendar(clock);
    let template = upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "周一例会".into(),
            rule: weekly_rule(),
            project_id: None,
            sub_team_id: Some(sub_team),
            notes: None,
        },
    )
    .expect("建模板");

    let counts = materialize_from_state(
        app.state::<kewutong_lib::state::AppState>().inner(),
    )
    .expect("物化");
    assert!(counts.kept > 0, "应当物化出至少一个 instance");

    let view: TodayWeek = today_week(app.state()).expect("view");
    // 9/10 Thu 没有 Monday,instance 都落在后续的 Mon。
    // 第一周剩余桶(9/12 Sat ~ 9/13 Sun)也没有 Mon。
    // 实例会落在「下周一」= 9/14,不在四列里。
    // 但其它 instance 9/21, 9/28 等同样不在四列里——所以四列里
    // 可能没有 instance。改测:让 today = Mon。
    let _ = (template, view);
    let clock = Arc::new(FixedClock::at("2026-09-14 09:00:00")); // Mon
    let (app, _owner, sub_team) = fresh_app_with_calendar(clock);
    upsert_recurring_template(
        app.state(),
        UpsertRecurringTemplateArgs {
            id: None,
            name: "周一例会".into(),
            rule: weekly_rule(),
            project_id: None,
            sub_team_id: Some(sub_team),
            notes: None,
        },
    )
    .expect("建模板");
    let counts = materialize_from_state(
        app.state::<kewutong_lib::state::AppState>().inner(),
    )
    .expect("物化");
    assert!(counts.kept > 0);

    let view: TodayWeek = today_week(app.state()).expect("view");
    // 9/14 是 Mon,today 桶应当含至少一个 instance
    let any_instance_today = view.buckets.today.iter().any(|t| t.is_recurring);
    assert!(any_instance_today, "9/14 (Mon) 启动时 today 桶应见 instance");
}