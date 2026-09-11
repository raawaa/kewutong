//! 物化命令层（ticket #25）。
//!
//! 把 [`crate::materialization`] 暴露成两条命令：
//!
//! 1. `materialize_now`：手动触发。返回物化合计——前端 UI 的"立即刷新"
//!    按钮可以调。
//! 2. `materialize_if_new_week`：启动 / 后台 tick 调。每小时一次；只
//!    在跨入新 ISO 周时跑一次,其余时间 noop。返回是否实际跑了物化,
//!    + 跑了的话合计计数。
//!
//! 错误一律 [`crate::error::AppError`],前端只负责展示。

use crate::error::Result;
use crate::materialization::{
    materialize_from_state, read_last_materialized_week, should_materialize_this_tick, IsoWeek,
    MaterializeTotals,
};
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

/// `materialize_if_new_week` 的返回 DTO。前端据此决定是否提示"刚刚生
/// 成了 N 个 instance"——`materialized = false` 时不弹提示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeIfNewWeekResult {
    pub materialized: bool,
    pub totals: MaterializeTotals,
}

/// 立即物化一次——UI 的"立即刷新"按钮、调停模板后想看到新 instance
/// 等场景手动触发。返回合计。
#[tauri::command]
pub fn materialize_now(state: State<'_, AppState>) -> Result<MaterializeTotals> {
    materialize_from_state(state.inner())
}

/// 跨周检查：本次 tick 是不是进入了新 ISO 周,是就跑一次物化。其它
/// 时间直接返回 `MaterializeIfNewWeekResult { materialized: false, .. }`。
///
/// 启动后挂个每小时一次的定时器调它(详见 [`crate::lib::run`])——
/// 每小时一次的粒度够用:科长不会在跨入新一周后 1 小时内还看不到
/// 物化结果。
#[tauri::command]
pub fn materialize_if_new_week(
    state: State<'_, AppState>,
) -> Result<MaterializeIfNewWeekResult> {
    let now = state.today();
    let current_week = IsoWeek::from_date(now);
    let conn = state.db()?;
    let last = read_last_materialized_week(&conn)?;
    if !should_materialize_this_tick(last, current_week) {
        return Ok(MaterializeIfNewWeekResult {
            materialized: false,
            totals: MaterializeTotals::default(),
        });
    }
    let totals = materialize_from_state(state.inner())?;
    Ok(MaterializeIfNewWeekResult {
        materialized: true,
        totals,
    })
}

/// 后台 tick 调用的非 Tauri 命令版——直接吃 `&AppState`(`Arc<...>`)
/// 即可,不依赖 `tauri::State` 生命周期。`materialized = true` 时
/// 内部已写元数据;调用方无需再做任何收尾。
///
/// 单独抽出这一函数让 [`crate::spawn_materialize_tick`] 与命令层共用
/// 同一份"是否要跑"的判定逻辑,避免在两处重复实现"读 meta + 比较
/// + 调物化"的序列。
pub fn materialize_if_new_week_via_state(state: &AppState) -> Result<bool> {
    let now = state.today();
    let current_week = IsoWeek::from_date(now);
    let conn = state.db()?;
    let last = read_last_materialized_week(&conn)?;
    if !should_materialize_this_tick(last, current_week) {
        return Ok(false);
    }
    let _totals = materialize_from_state(state)?;
    Ok(true)
}
