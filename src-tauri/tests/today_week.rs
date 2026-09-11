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
}