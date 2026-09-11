//! 实例动作层（ticket #26「实例动作与改期溯源」）。
//!
//! 覆盖三个面向：
//!
//! 1. **手工改期** [`reschedule_instance`]：原 instance → `Cancelled` +
//!    新 instance `Open`，`rescheduled_from_id` 指向原，`original_scheduled_at`
//!    保留模板原定时间。**与 SHIFT 路径共用同一段 INSERT 体** ——
//!    见 [`crate::materialization::insert_rescheduled_instance`]，
//!    两条路径产出的数据形状一致（issue #26 AC 验收）。
//!
//! 2. **覆盖单 instance 时间** [`override_instance_scheduled_at`]：仅
//!    UPDATE 一行的 `scheduled_at`，**不**创建新 instance，`rescheduled_from_id`
//!    保持 NULL。出差场景：业务周期不变，仅本次会议时间微调。
//!
//! 3. **改期溯源** [`instance_reschedule_chain`]：沿 `rescheduled_from_id`
//!    一路递归回溯，返回整条链（含自身）。科长时间轴 UI 据此显示
//!    "改期自 X" 链。
//!
//! **状态机 / Skip / Mark Done 不在本本文件** —— 改 Done / Cancelled 走
//! [`crate::commands::task::set_task_status`]（全 app 唯一入口，ADR 0003
//! §D6）。`Skip` = 设 `Cancelled`，UI 端根据 `recurring_template_id IS NOT
//! NULL && status='Cancelled'` 判定"已跳过"标签（issue #26 AC #2）。
//!
//! 出差场景：模板级时区整体修改走 [`update_recurring_template_zone`]。
//!
//! ## 改期路径的「状态变更」入口选择
//!
//! `reschedule_instance` 走 `set_task_status` 把原 instance 标 Cancelled,
//!
//! **不**直接 UPDATE `status`——理由：保持 ADR 0003 §D6 「状态机唯一入口」
//! 的不变量(`blocked_at` / `blocked_reason` / `waiting_on_person_id` 联动
//! 重置都集中在那里)。代价：`set_task_status` 单独事务提交,后续 INSERT
//! 新 instance 是第二个事务——若两步之间崩溃,用户看到一条 Cancelled 没
//! 替代,但这是幂等的可恢复态(用户重新改期即可)。与 SHIFT 路径的 1 步
//! INSERT 行为不完全对称,但 SHIFT 是物化层原子扫描循环的一部分,不在
//! 此权衡范围内。

use crate::commands::recurring_template::{
    fetch_template as fetch_template_in_conn, RecurringTemplate,
};
use crate::commands::task::{
    fetch_task as fetch_task_in_conn, set_task_status, SetTaskStatusArgs, Task, TaskStatus,
};
use crate::error::{AppError, Result};
use crate::materialization::{
    insert_rescheduled_instance, resolve_owner as resolve_owner_template,
    TemplateMaterializeInput, SHANGHAI_OFFSET_SECONDS,
};
use crate::recurring::{validate_iana_zone, StructuredRule};
use crate::state::AppState;
use chrono::{Duration, NaiveDateTime};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use tauri::State;

// ---------------------------------------------------------------------------
// 入参 DTO
// ---------------------------------------------------------------------------

/// [`reschedule_instance`] 的入参。`new_scheduled_at` 是 UTC 入库格式
/// `'%Y-%m-%d %H:%M:%S'`——前后端都用同一种字符串避免再加一次时区换算。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RescheduleInstanceArgs {
    pub task_id: i64,
    pub new_scheduled_at: String,
}

/// [`override_instance_scheduled_at`] 的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideInstanceScheduledAtArgs {
    pub task_id: i64,
    pub new_scheduled_at: String,
}

/// [`update_recurring_template_zone`] 的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTemplateZoneArgs {
    pub template_id: i64,
    pub iana_zone: String,
}

/// [`instance_reschedule_chain`] 的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceIdArgs {
    pub task_id: i64,
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 手工改期单次 instance。
///
/// 数据形态与 SHIFT 路径（[`crate::materialization::materialize_template`]
/// 里的 `Shift { original, target }` 分支）一致：原 instance → `Cancelled`
// + 新 instance → `Open`，`rescheduled_from_id` 指向原 instance，
/// `original_scheduled_at` 保留**模板原定时间**（SHIFT 路径与本函数同走
/// [`insert_rescheduled_instance`]，验收点 #26 AC）。
///
/// 改期**不**触碰 `recurring_template` 表——下周 / 下下周仍按原规则走。
#[tauri::command]
pub fn reschedule_instance(
    state: State<'_, AppState>,
    args: RescheduleInstanceArgs,
) -> Result<Task> {
    parse_sql_timestamp(&args.new_scheduled_at)?;

    // 取 Arc 出来——`state: State<'_, AppState>` 不是 Copy,但
    // `state.inner()` 给我们 `&Arc<AppStateInner>`,clone 一次拿到独立
    // 句柄,可与 `set_task_status` 之后再次借 conn。
    let app_state = state.inner().clone();

    // 第一段:读 instance 行 + 模板,做预校验。
    let (template, original_scheduled_at) = {
        let conn = app_state.db()?;
        let (template, original_scheduled_at, current_status) =
            load_instance_row(&conn, args.task_id)?;
        if current_status == TaskStatus::Cancelled {
            return Err(AppError::invalid(
                "已取消的 instance 无法再改期,可考虑新建一条一次性任务。",
            ));
        }
        if current_status == TaskStatus::Done {
            return Err(AppError::invalid(
                "已完成的 instance 不能再改期——若需回顾当日工作,请新建一次性任务。",
            ));
        }
        if args.new_scheduled_at == original_scheduled_at {
            return Err(AppError::invalid(
                "改期目标时间与原时间相同,请换一个时间或直接改状态。",
            ));
        }
        let collide: Option<i64> = conn
            .query_row(
                "SELECT id FROM task
                  WHERE recurring_template_id = ?1 AND scheduled_at = ?2 AND id != ?3",
                params![template.id, &args.new_scheduled_at, args.task_id],
                |row| row.get(0),
            )
            .optional()?;
        if collide.is_some() {
            return Err(AppError::invalid(
                "目标时间已被同模板的另一个 instance 占用,请换一个时间或先改那条。",
            ));
        }
        (template, original_scheduled_at)
    };

    // 第二段:走 set_task_status 把原 instance 标 Cancelled——保持
    // ADR 0003 §D6「状态机唯一入口」不变量(自动重置 blocked_* 三列)。
    set_task_status(
        state,
        SetTaskStatusArgs {
            task_id: args.task_id,
            status: TaskStatus::Cancelled,
            blocked_reason: None,
            waiting_on_person_id: None,
        },
    )?;

    // 第三段:写新 instance——走共享 INSERT 体,与 SHIFT 路径同 INSERT
    // 体(issue #26 AC #5)。若此处崩溃,用户看到一条已 Cancelled 的
    // 原 instance,无替代——可恢复(用户重试改期即可)。
    let new_title = format!(
        "{} @ {}",
        template.name,
        original_scheduled_at_local(&original_scheduled_at)
    );
    let new_id = {
        let conn = app_state.db()?;
        let tx = conn.unchecked_transaction()?;
        let id = insert_rescheduled_instance(
            &tx,
            &template,
            &args.new_scheduled_at,
            &original_scheduled_at,
            &new_title,
        )?;
        tx.execute(
            "UPDATE task SET rescheduled_from_id = ?1 WHERE id = ?2",
            params![args.task_id, id],
        )?;
        tx.commit().map_err(AppError::from)?;
        id
    };
    let conn = app_state.db()?;
    fetch_task_in_conn(&conn, new_id)?
        .ok_or_else(|| AppError::internal(format!("改期后的 instance id={new_id} 查不到")))
}

/// 仅覆盖单 instance 的 `scheduled_at`，**不**取消原 instance,**不**挂
/// `rescheduled_from_id` ——这是"出差调时区"场景的轻量手势：业务周期
/// 不变,仅本次会议时间微调,不想看到多一条 Cancelled 行。
#[tauri::command]
pub fn override_instance_scheduled_at(
    state: State<'_, AppState>,
    args: OverrideInstanceScheduledAtArgs,
) -> Result<Task> {
    parse_sql_timestamp(&args.new_scheduled_at)?;
    let conn = state.db()?;

    let (template, original_scheduled_at, status) =
        load_instance_row(&conn, args.task_id)?;
    if status == TaskStatus::Cancelled {
        return Err(AppError::invalid("已取消的 instance 无法再覆盖时间。"));
    }
    if args.new_scheduled_at == original_scheduled_at {
        return Err(AppError::invalid(
            "覆盖目标时间与原时间相同,请换一个时间或直接保存。",
        ));
    }
    // 预先拦同 template 占用,给科长友好提示——与 `reschedule_instance` 行为对齐。
    let collide: Option<i64> = conn
        .query_row(
            "SELECT id FROM task
              WHERE recurring_template_id = ?1 AND scheduled_at = ?2 AND id != ?3",
            params![template.id, &args.new_scheduled_at, args.task_id],
            |row| row.get(0),
        )
        .optional()?;
    if collide.is_some() {
        return Err(AppError::invalid(
            "目标时间已被同模板的另一个 instance 占用,请换一个时间或先改那条。",
        ));
    }

    let updated = conn.execute(
        "UPDATE task
            SET scheduled_at = ?1, updated_at = datetime('now')
          WHERE id = ?2 AND recurring_template_id = ?3",
        params![&args.new_scheduled_at, args.task_id, template.id],
    )?;
    if updated == 0 {
        return Err(AppError::invalid("任务不存在或已被删除。"));
    }

    fetch_task_in_conn(&conn, args.task_id)?
        .ok_or_else(|| AppError::internal(format!("覆盖后的 instance id={} 查不到", args.task_id)))
}

/// 整体修改模板的 `iana_zone`。`upsert_recurring_template` 已能改
/// `iana_zone`（连同其它规则一起重写），但用户场景"出差切时区"经常只想
/// 动一个字段,不想被"重写规则"覆盖到 ends / byday 等;本命令走最窄入口。
///
/// 不动 `rrule_text`——RRULE 字符串不含 iana_zone（见 [`crate::recurring`]
/// 文档）。
#[tauri::command]
pub fn update_recurring_template_zone(
    state: State<'_, AppState>,
    args: UpdateTemplateZoneArgs,
) -> Result<RecurringTemplate> {
    validate_iana_zone(&args.iana_zone)?;
    let conn = state.db()?;
    let affected = conn.execute(
        "UPDATE recurring_template SET iana_zone = ?1 WHERE id = ?2",
        params![&args.iana_zone, args.template_id],
    )?;
    if affected == 0 {
        return Err(AppError::invalid("模板不存在或已被删除。"));
    }
    fetch_template_in_conn(&conn, args.template_id)?
        .ok_or_else(|| AppError::internal(format!("模板 id={} 查不到", args.template_id)))
}

/// 沿 `rescheduled_from_id` 一路回溯,返回整条链（含自身,自身在最前）。
///
/// 深度上限 32——防环路（自指改期已被前置校验拦掉,但跨用户的 Syncthing
/// 同步漂移可能引入环路;32 步已远超正常改期深度）。
const RESCHEDULE_CHAIN_MAX_DEPTH: usize = 32;

#[tauri::command]
pub fn instance_reschedule_chain(
    state: State<'_, AppState>,
    args: InstanceIdArgs,
) -> Result<Vec<Task>> {
    let conn = state.db()?;
    let mut chain: Vec<Task> = Vec::new();
    let mut current_id = args.task_id;
    let mut seen = std::collections::HashSet::new();

    for _ in 0..RESCHEDULE_CHAIN_MAX_DEPTH {
        if !seen.insert(current_id) {
            break;
        }
        match fetch_task_in_conn(&conn, current_id)? {
            Some(task) => {
                let next_id = task.rescheduled_from_id;
                chain.push(task);
                match next_id {
                    Some(parent) => current_id = parent,
                    None => break,
                }
            }
            None => break,
        }
    }
    Ok(chain)
}

// ---------------------------------------------------------------------------
// 内部 helper
// ---------------------------------------------------------------------------

/// 把 [`RecurringTemplate`] 转成 [`TemplateMaterializeInput`]——物化层期望
/// 的最小字段集。结构化字段已在 DTO 层校验过,这里直接搬,不重复 match。
fn load_template_materialize_input(
    conn: &rusqlite::Connection,
    template_id: i64,
) -> Result<TemplateMaterializeInput> {
    let tmpl = fetch_template_in_conn(conn, template_id)?
        .ok_or_else(|| AppError::internal(format!("模板 id={template_id} 查不到")))?;
    let owner_person_id = resolve_owner_template(conn, tmpl.project_id, tmpl.sub_team_id)?;
    Ok(TemplateMaterializeInput {
        id: tmpl.id,
        name: tmpl.name,
        rule: StructuredRule {
            freq: tmpl.freq,
            byday_mask: tmpl.byday_mask,
            bymonthday: tmpl.bymonthday,
            bymonth: tmpl.bymonth,
            byhour: tmpl.byhour,
            byminute: tmpl.byminute,
            iana_zone: tmpl.iana_zone,
            ends: tmpl.ends,
            holiday_behavior: tmpl.holiday_behavior,
        },
        owner_person_id,
        project_id: tmpl.project_id,
        sub_team_id: tmpl.sub_team_id,
    })
}

/// `task` 行上的 instance 必要信息 + 模板轻量结构——`reschedule_instance`
/// / `override_instance_scheduled_at` 共用。
///
/// `recurring_template_id` 为 `None` 表示一次性 task,两条命令都会拒。
fn load_instance_row(
    conn: &rusqlite::Connection,
    task_id: i64,
) -> Result<(TemplateMaterializeInput, String, TaskStatus)> {
    let row = conn
        .query_row(
            "SELECT recurring_template_id, scheduled_at, status
               FROM task WHERE id = ?1",
            params![task_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => AppError::invalid("任务不存在或已被删除。"),
            other => AppError::from(other),
        })?;
    let template_id = row.0.ok_or_else(|| {
        AppError::invalid("只有周期性 instance 可以改期/覆盖时间,一次性任务请用截止日手势。")
    })?;
    let scheduled_at = row.1.ok_or_else(|| {
        AppError::internal(format!(
            "task.id={task_id} 是 instance 但 scheduled_at IS NULL,数据漂移"
        ))
    })?;
    let status = parse_status(&row.2)?;
    let template = load_template_materialize_input(conn, template_id)?;
    Ok((template, scheduled_at, status))
}

fn parse_status(text: &str) -> Result<TaskStatus> {
    match text {
        "Open" => Ok(TaskStatus::Open),
        "In-progress" => Ok(TaskStatus::InProgress),
        "Blocked" => Ok(TaskStatus::Blocked),
        "Waiting-on" => Ok(TaskStatus::WaitingOn),
        "Done" => Ok(TaskStatus::Done),
        "Cancelled" => Ok(TaskStatus::Cancelled),
        other => Err(AppError::internal(format!(
            "task.status 未知字面量 {other:?}——schema CHECK 应已拦掉"
        ))),
    }
}

/// 解析入库格式 UTC 时间戳——格式不对直接给科长中文提示。
fn parse_sql_timestamp(value: &str) -> Result<()> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
        .map(|_| ())
        .map_err(|_| AppError::invalid("时间格式不对,应形如 2026-09-16 14:00:00(UTC)。"))
}

/// 把原 instance 的 UTC 时间戳转成 Asia/Shanghai 本地日期,作为新 instance
/// 标题的 "@ YYYY-MM-DD" 后缀——与 SHIFT 路径 [`instance_title`] 同一
/// 取值规则(都用「原定日期」,不用「改期后的日期」,让 cancelled 与 shifted
/// 两行标题对齐)。
fn original_scheduled_at_local(utc_sql: &str) -> String {
    let utc = match NaiveDateTime::parse_from_str(utc_sql, "%Y-%m-%d %H:%M:%S") {
        Ok(dt) => dt,
        Err(_) => return utc_sql.to_string(),
    };
    let local = utc + Duration::seconds(SHANGHAI_OFFSET_SECONDS as i64);
    local.format("%Y-%m-%d").to_string()
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sql_timestamp_合法格式通过() {
        assert!(parse_sql_timestamp("2026-09-16 00:00:00").is_ok());
        assert!(parse_sql_timestamp("2026-09-16 23:59:59").is_ok());
    }

    #[test]
    fn parse_sql_timestamp_非法格式被拒_给中文消息() {
        let err = parse_sql_timestamp("2026-09-16 00:00").expect_err("缺秒");
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert!(err.message().contains("时间"));
        assert!(parse_sql_timestamp("garbage").is_err());
    }

    #[test]
    fn original_scheduled_at_local_跨日_把_utc_换到_上海() {
        assert_eq!(original_scheduled_at_local("2026-09-16 00:00:00"), "2026-09-16");
        assert_eq!(original_scheduled_at_local("2026-09-15 16:00:00"), "2026-09-16");
    }

    #[test]
    fn parse_status_六值() {
        for text in ["Open", "In-progress", "Blocked", "Waiting-on", "Done", "Cancelled"] {
            assert!(parse_status(text).is_ok());
        }
        assert!(parse_status("Unknown").is_err());
    }
}