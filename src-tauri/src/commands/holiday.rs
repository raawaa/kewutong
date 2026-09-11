//! 节假日命令层（ticket #23）。
//!
//! 覆盖「日历视图查询」与「切换某一天为 Holiday/Workday」的 App 内覆盖手
//! 势。所有写操作都走 [`crate::holiday::set_override`] / [`crate::holiday::clear_override`]
//! ——命令层只是入参校验 + 错误映射,不替它们写 SQL。

use crate::clock::parse_sql_date;
use crate::error::{AppError, Result};
use crate::holiday::{self, DayInfo, DayKind, DaySource, OverrideKind};
use crate::state::AppState;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// 日历视图（ticket #23 验收点）的一行。
///
/// `kind` 是 effective 类别；`source` 区分「种子写的 / 你之前手动改的 /
/// 默认 weekday/weekend」；`name` 只在 Holiday/Workday 且来自种子时有值
/// （App 覆盖暂未要求命名）。`kind` 与 `source` 直接复用 [`DayKind`] /
/// [`DaySource`]——serde 派生 `kebab-case` 与前端约定一致,不必再造一层
/// 一对一 DTO。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayCalendarDay {
    pub date: String,
    pub kind: DayKind,
    pub name: Option<String>,
    pub source: DaySource,
}

/// `holiday_calendar` 入参。
///
/// 闭区间 `[start_inclusive, end_inclusive]`,按 ISO 8601 `YYYY-MM-DD`
/// 解析。`end - start` 上限 92 天（约一季度）——日历视图一次拉一季，避免
/// 单 RPC 返回数千行；超出会被 App 层拒绝。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayCalendarArgs {
    pub start_inclusive: String,
    pub end_inclusive: String,
}

/// `set_holiday_override` 入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetHolidayOverrideArgs {
    pub date: String,
    pub kind: DayKind,
}

/// `clear_holiday_override` 入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearHolidayOverrideArgs {
    pub date: String,
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 列出闭区间 `[start, end]` 内所有 effective Holiday / Workday 的天。
///
/// 默认工作日（含默认周末）不返回——前端按日历格子自己渲染就好。返
/// 回的列表按 `date` 升序,便于 UI 走一遍循环就把日历填上。
#[tauri::command]
pub fn holiday_calendar(
    state: State<'_, AppState>,
    args: HolidayCalendarArgs,
) -> Result<Vec<HolidayCalendarDay>> {
    let start = parse_iso_date(&args.start_inclusive, "起始日")?;
    let end = parse_iso_date(&args.end_inclusive, "结束日")?;
    if start > end {
        return Err(AppError::invalid("起始日不能晚于结束日。"));
    }
    let span_days = (end - start).num_days();
    if span_days > MAX_CALENDAR_SPAN_DAYS {
        return Err(AppError::invalid(format!(
            "日历视图范围最多 {MAX_CALENDAR_SPAN_DAYS} 天（约一季度），当前 {span_days} 天。"
        )));
    }

    let calendar = state.calendar()?;
    let mut days = Vec::new();
    for (date, info) in calendar.iter_range(start, end) {
        // 只列 Seed / Override 的 Holiday/Workday——默认工作日(含周末)
        // 不在返回里,前端按日历格子自己画底色。
        if matches!(info.kind, DayKind::Holiday | DayKind::Workday)
            && matches!(info.source, DaySource::Seed | DaySource::Override)
        {
            days.push(day_to_dto(date, info));
        }
    }
    Ok(days)
}

/// App 内覆盖：把 `date` 标记为 Holiday 或 Workday。
///
/// 写完 SQLite 后**不**重读整张日历——下次查询自动走 effective set；如
/// 果要让前端立即看到本次改动，调用方自己再发一次 `holiday_calendar`。
#[tauri::command]
pub fn set_holiday_override(
    state: State<'_, AppState>,
    args: SetHolidayOverrideArgs,
) -> Result<()> {
    let date = parse_iso_date(&args.date, "覆盖日期")?;
    let kind = OverrideKind::from(args.kind);
    let conn = state.db()?;
    holiday::set_override(&conn, date, kind)?;
    let mut calendar = state.calendar()?;
    holiday::reload_overrides_from_db(&conn, &mut calendar)?;
    Ok(())
}

/// 清除 App 内某天的覆盖——回到种子/默认。
#[tauri::command]
pub fn clear_holiday_override(
    state: State<'_, AppState>,
    args: ClearHolidayOverrideArgs,
) -> Result<()> {
    let date = parse_iso_date(&args.date, "覆盖日期")?;
    let conn = state.db()?;
    holiday::clear_override(&conn, date)?;
    let mut calendar = state.calendar()?;
    holiday::reload_overrides_from_db(&conn, &mut calendar)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

const MAX_CALENDAR_SPAN_DAYS: i64 = 92;

fn parse_iso_date(text: &str, label: &str) -> Result<NaiveDate> {
    parse_sql_date(text).ok_or_else(|| {
        AppError::invalid(format!("{label}格式不对,应形如 2026-09-10。"))
    })
}

fn day_to_dto(date: NaiveDate, info: DayInfo) -> HolidayCalendarDay {
    HolidayCalendarDay {
        date: date.format("%Y-%m-%d").to_string(),
        kind: info.kind,
        name: info.name,
        source: info.source,
    }
}

impl From<DayKind> for OverrideKind {
    fn from(kind: DayKind) -> Self {
        match kind {
            DayKind::Holiday => Self::Holiday,
            DayKind::Workday => Self::Workday,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析_日期_非法格式给中文提示_且带字段名() {
        for bad in ["2026/09/10", "10-01", "2026-13-01", "明天", ""] {
            let err = parse_iso_date(bad, "起始日").expect_err("非法日期应当被拒");
            assert_eq!(err.code(), "INVALID_ARGUMENT");
            assert!(err.message().contains("起始日"), "bad={bad:?}");
        }
    }

    #[test]
    fn override_kind_从_DayKind_转换_两值枚举() {
        assert_eq!(OverrideKind::from(DayKind::Holiday), OverrideKind::Holiday);
        assert_eq!(OverrideKind::from(DayKind::Workday), OverrideKind::Workday);
    }
}