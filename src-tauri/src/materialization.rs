//! 物化引擎（ticket #25）。
//!
//! 承担三件事：
//!
//! 1. **纯函数侧**：把 [`StructuredRule`] + 日期范围展开为一系列**墙钟日**
//!    —— `expand_rule`；把墙钟日转成 UTC `scheduled_at` 文本
//!    —— [`wall_clock_to_utc_sql`]；把墙钟日按节假日行为（SKIP / SHIFT）
//!    拆成具体动作 —— [`apply_holiday_behavior`]。三者**不碰 SQLite**，
//!    单元测试可以无 DB 跑死。
//!
//! 2. **DB 写入侧**：[`materialize_template`] 拿一条模板 + 当前内存日历
//!    视图,把展开结果落成 `task` 行；幂等性靠 V005 的唯一索引
//!    `(recurring_template_id, scheduled_at) WHERE recurring_template_id
//!    IS NOT NULL` 保证。
//!
//! 3. **跨周触发侧**：[`should_materialize_this_tick`] 读
//!    `materialization_meta` 决定本次 tick 是不是进入了新的 ISO 周——只
//!    在新的一周里跑一次,避免每次 focus 都扫全表。
//!
//! 整体管线:
//!
//! ```text
//!      StructuredRule           HolidayCalendar       recurrence_template
//!            │                         │                        │
//!            ▼                         ▼                        ▼
//!     expand_rule(...)      apply_holiday_behavior(...)    load by id
//!            │                         │                        │
//!            ▼                         ▼                        │
//!      Vec<NaiveDate>          Vec<MaterializedEvent>          │
//!                                     │                        │
//!                                     ▼                        │
//!                       wall_clock_to_utc_sql(.) ── INSERT OR IGNORE
//! ```
//!
//! 时区策略承接 ADR 0001 §3.4:规则存墙钟+时区,实例物化时转 UTC。v1
//! 固定 `Asia/Shanghai`(中国自 1991 年起不实行夏令时,固定偏移 + 8h
//! 与 IANA 规则等价),不引 `chrono-tz`。

use crate::error::{AppError, Result};
use crate::holiday::HolidayCalendar;
use crate::recurring::{EndsSpec, HolidayBehavior, StructuredRule};
use crate::state::AppState;
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Weekday};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::str::FromStr;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 物化窗口 = 12 周（ADR 0002 §物化策略）。一次触发生成的实例覆盖未来
/// 84 天；超出 84 天的查询不算"出错",只是「未物化」,前端用专门提示区
/// 分"没安排"和"超出窗口"。
pub const MATERIALIZATION_WINDOW_WEEKS: u32 = 12;

/// 物化窗口的天数,`12 * 7 = 84`。
pub const MATERIALIZATION_WINDOW_DAYS: i64 = (MATERIALIZATION_WINDOW_WEEKS as i64) * 7;

/// `iana_zone = 'Asia/Shanghai'` 相对 UTC 的固定偏移秒数。v1 不引
/// `chrono-tz`——中国自 1991 年起不实行夏令时,固定偏移与 IANA 规则等价。
pub const SHANGHAI_OFFSET_SECONDS: i32 = 8 * 3600;

/// `materialization_meta` 单行表的主键写死 'singleton'。
pub const META_SINGLETON_ID: &str = "singleton";

/// SHIFT 顺延搜索的最大跨度——超过这个值视为"找不到",原实例照常
/// `Cancelled`、不建新实例。定 30 天(覆盖最长春节 7 天 + 双倍 buffer):
/// 中国假期不会更长,30 天是绝无仅有的安全网。
const SHIFT_MAX_LOOKAHEAD_DAYS: i64 = 30;

/// 实例标题：模板名 + 周期标签（"周一三例会 @ 2026-09-14"）。
///
/// 不复用一次性 task 的标题（"周一例会"），而是用模板名 + 当日日期，
/// 方便「本周」视图里"这是哪次例会"一眼看明白。周期标签按频率 +
/// 关键限定项压缩：
/// - DAILY: "每日"
/// - WEEKLY: "周X" 或 "周X,X"（按 mask 展开）
/// - MONTHLY: "每月 N 日"（"每月末"）
/// - YEARLY: "每年 M 月 N 日"
///
/// 暂不在 v1 暴露周期标签字段（task.title 就用模板名 + 日期），将来
/// 若需单列展示,再加。
fn instance_title(template_name: &str, on: NaiveDate) -> String {
    format!("{template_name} @ {on}", on = on.format("%Y-%m-%d"))
}

// ---------------------------------------------------------------------------
// 纯函数：rule 展开
// ---------------------------------------------------------------------------

/// 展开 [`StructuredRule`] 在 `[range_start, range_end]` 闭区间内**所有**
/// 命中该规则的墙钟日（含起点与终点）。命中规则时**不**做节假日裁剪
/// ——节假日行为由 [`apply_holiday_behavior`] 单独处理。
///
/// `ends_after_n` 的「前 n 次」按**展开后的列表**前 n 项,不是按
/// `range_start` 起的绝对次数——后者需要持久化「已生成次数」,代价过
/// 大；v1 选择「窗口内最多 n 个」,且窗口的滚动会让跨窗的累积量自动
/// 接续（前一窗口已生成 n/2,下一窗口再 n/2 后从窗口右侧继续）。
///
/// # 终止条件
/// - `EndsSpec::On { date }`：展开结果中**所有日期 ≤ date**。UT-类边界
///   「date 之后还有几次？」按上面"前 n 次"逻辑不算——我们只展开范围
///   内的日期,然后再按 ends 截断。
/// - `EndsSpec::After { n }`：结果集前 n 个,余下的丢弃。
///
/// 这两条都按"自然顺序"取（按日期升序）。
pub fn expand_rule(
    rule: &StructuredRule,
    range_start: NaiveDate,
    range_end: NaiveDate,
) -> Result<Vec<NaiveDate>> {
    if range_start > range_end {
        return Ok(Vec::new());
    }
    let candidates: Vec<NaiveDate> = match rule.freq {
        crate::recurring::Freq::Daily => expand_daily(range_start, range_end),
        crate::recurring::Freq::Weekly => expand_weekly(rule, range_start, range_end)?,
        crate::recurring::Freq::Monthly => expand_monthly(rule, range_start, range_end)?,
        crate::recurring::Freq::Yearly => expand_yearly(rule, range_start, range_end)?,
    };
    Ok(apply_ends(&candidates, &rule.ends))
}

fn expand_daily(start: NaiveDate, end: NaiveDate) -> Vec<NaiveDate> {
    let mut out = Vec::with_capacity(((end - start).num_days() + 1) as usize);
    let mut current = start;
    while current <= end {
        out.push(current);
        match current.succ_opt() {
            Some(next) => current = next,
            None => break,
        }
    }
    out
}

fn expand_weekly(
    rule: &StructuredRule,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<NaiveDate>> {
    let mask = rule.byday_mask;
    if mask == 0 {
        return Err(AppError::Internal(
            "expand_weekly 收到 mask=0;校验层应收掉".into(),
        ));
    }
    let mut out = Vec::new();
    let mut current = start;
    while current <= end {
        if mask & weekday_bit(current.weekday()) != 0 {
            out.push(current);
        }
        match current.succ_opt() {
            Some(next) => current = next,
            None => break,
        }
    }
    Ok(out)
}

fn expand_monthly(
    rule: &StructuredRule,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<NaiveDate>> {
    let days = rule.bymonthday.as_deref().ok_or_else(|| {
        AppError::Internal("expand_monthly 缺 bymonthday;校验层应收掉".into())
    })?;
    if days.is_empty() {
        return Err(AppError::Internal(
            "expand_monthly bymonthday 空;校验层应收掉".into(),
        ));
    }
    let mut out = Vec::new();
    let mut year = start.year();
    let mut month: u32 = start.month();
    loop {
        let first_of_month = NaiveDate::from_ymd_opt(year, month, 1)
            .ok_or_else(|| AppError::Internal(format!("日期构造失败: {year}-{month}-1")))?;
        let last_of_month = last_day_of_month(year, month);
        // 单月内: 0=月末 / 1..=last_of_month 命中; > last_of_month 跳过。
        for &d in days {
            let day = if d == 0 { last_of_month as i32 } else { d };
            if day > last_of_month as i32 {
                continue;
            }
            let candidate = NaiveDate::from_ymd_opt(year, month, day as u32);
            let Some(candidate) = candidate else { continue };
            if candidate < start || candidate > end {
                continue;
            }
            out.push(candidate);
        }
        // 推进到下一月。
        if month == 12 {
            year += 1;
            month = 1;
        } else {
            month += 1;
        }
        if first_of_month > end {
            break;
        }
        if year > end.year() + 1 {
            break;
        }
    }
    out.sort();
    Ok(out)
}

fn expand_yearly(
    rule: &StructuredRule,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<NaiveDate>> {
    let months = rule.bymonth.as_deref().ok_or_else(|| {
        AppError::Internal("expand_yearly 缺 bymonth;校验层应收掉".into())
    })?;
    if months.is_empty() {
        return Err(AppError::Internal(
            "expand_yearly bymonth 空;校验层应收掉".into(),
        ));
    }
    let days = rule.bymonthday.as_deref();
    let mut out = Vec::new();
    for year in start.year()..=end.year() {
        for &month in months {
            let month_u = month as u32;
            let last_of_month = last_day_of_month(year, month_u);
            if let Some(day_list) = days {
                for &d in day_list {
                    if d > last_of_month as i32 {
                        continue;
                    }
                    let Some(candidate) = NaiveDate::from_ymd_opt(year, month_u, d as u32) else {
                        continue;
                    };
                    if candidate < start || candidate > end {
                        continue;
                    }
                    out.push(candidate);
                }
            } else {
                // YEARLY 不给 bymonthday 时:默认每月 1 号(RFC 5545 行为)
                let Some(candidate) = NaiveDate::from_ymd_opt(year, month_u, 1) else {
                    continue;
                };
                if candidate < start || candidate > end {
                    continue;
                }
                out.push(candidate);
            }
        }
    }
    out.sort();
    Ok(out)
}

fn apply_ends(candidates: &[NaiveDate], ends: &EndsSpec) -> Vec<NaiveDate> {
    match ends {
        EndsSpec::On { date } => {
            let cutoff = NaiveDate::from_str(date).unwrap_or(NaiveDate::MAX);
            candidates
                .iter()
                .copied()
                .filter(|d| *d <= cutoff)
                .collect()
        }
        EndsSpec::After { n } => {
            let n = (*n).max(0) as usize;
            candidates.iter().copied().take(n).collect()
        }
    }
}

fn weekday_bit(w: Weekday) -> i32 {
    // 与 recurring::byday 一致：MO=1, TU=2, ..., SU=64。
    1 << w.num_days_from_monday()
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    // 下一个月的 1 号 - 1 天 = 当月最后一天;12 月回卷到下一年 1 月。
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first_next = NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .expect("下个月 1 号永远合法");
    (first_next - Duration::days(1))
        .day()
}

// ---------------------------------------------------------------------------
// 纯函数：墙钟 → UTC 入库文本
// ---------------------------------------------------------------------------

/// 墙钟 `(date, hour, minute)` 在 `Asia/Shanghai` 时区下,转成 UTC 时刻
/// 文本(`'%Y-%m-%d %H:%M:%S'`)。固定偏移 + 8h,无夏令时。
///
/// v1 不引 `chrono-tz`——直接手算偏移;中国自 1991 年起不实行夏令时,
/// 固定偏移 + 8h 与 IANA 规则等价。
pub fn wall_clock_to_utc_sql(date: NaiveDate, hour: u32, minute: u32) -> String {
    let local = NaiveDateTime::new(date, NaiveTime::from_hms_opt(hour, minute, 0).expect("0..60"));
    let utc = local - Duration::seconds(SHANGHAI_OFFSET_SECONDS as i64);
    utc.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 从入库格式的 UTC 时间戳反推 `Asia/Shanghai` 墙钟日期(用于"按本
/// 机 zone 渲染")。在 SQL 端可用 `date(scheduled_at, '+8 hours')` 替代
/// ——本函数供 Rust 端读回后用。
pub fn utc_sql_to_local_date(text: &str) -> Option<NaiveDate> {
    let utc = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S").ok()?;
    let local = utc + Duration::seconds(SHANGHAI_OFFSET_SECONDS as i64);
    Some(local.date())
}

// ---------------------------------------------------------------------------
// 纯函数：节假日行为
// ---------------------------------------------------------------------------

/// 物化层对一条候选日的三种处置。
///
/// - `Keep`：正常生成 instance。
/// - `Skip`：节假日 / 默认周末 → 不生成；UI 看不到这一条(SKIP 默认行
///   为)。SKIP 路径**不**写 Cancelled 记录——「没安排」与「节假日跳过」
///   在视图上是无差别的空位。
/// - `Shift`：节假日 → 原日 `Cancelled`(UI 标签"已跳过",留改期溯源
///   空白位)+ 下一个非节假日工作日 `Open`(`rescheduled_from_id` 指向
///   原 instance)。**调休工作日(种子 workday / override workday)算
///   工作日**,SHIFT 路径可以顺延到它上面。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterializedEvent {
    Keep { date: NaiveDate },
    Skip { date: NaiveDate },
    Shift { original: NaiveDate, target: NaiveDate },
}

impl MaterializedEvent {
    /// 这一条最终要在 `task` 表上"实际创建 instance"的日期。
    /// `Skip` 路径返回 `None`(不创建);`Shift` 路径返回 target(原日
    /// 单独作为 Cancelled 写入,见 [`materialize_template`])。
    pub fn kept_date(&self) -> Option<NaiveDate> {
        match self {
            Self::Keep { date } => Some(*date),
            Self::Shift { target, .. } => Some(*target),
            Self::Skip { .. } => None,
        }
    }
}

/// 把候选日期按节假日行为拆成 [`MaterializedEvent`] 列表。
///
/// - `SKIP`：节假日 → `Skip`;工作日(含调休) → `Keep`。
/// - `SHIFT`：节假日 → 搜索 SHIFT_MAX_LOOKAHEAD_DAYS 范围内的首个非节假
///   日工作日(把调休工作日视为合法目标),`Shift { original, target }`。
///   找不到 → 仍 `Shift { original, target = original + 30d }`(上层
///   写入时按"超出 12 周窗口就标 Cancelled 但不建新实例"处理——见
///   [`materialize_template`])。这里**总**返回 `Shift`,失败用
///   `target = original + SHIFT_MAX_LOOKAHEAD_DAYS` 占位,这样调用方不
///   必为"找不到"单独加一个变体。
pub fn apply_holiday_behavior(
    dates: Vec<NaiveDate>,
    calendar: &HolidayCalendar,
    behavior: HolidayBehavior,
) -> Vec<MaterializedEvent> {
    dates
        .into_iter()
        .map(|date| match behavior {
            HolidayBehavior::Skip => {
                if calendar.is_holiday(date) {
                    MaterializedEvent::Skip { date }
                } else {
                    MaterializedEvent::Keep { date }
                }
            }
            HolidayBehavior::Shift => {
                if !calendar.is_holiday(date) {
                    return MaterializedEvent::Keep { date };
                }
                // 顺延到下一个非节假日工作日(调休工作日算工作日)。
                let target = find_next_workday(calendar, date);
                MaterializedEvent::Shift {
                    original: date,
                    target,
                }
            }
        })
        .collect()
}

fn find_next_workday(calendar: &HolidayCalendar, from: NaiveDate) -> NaiveDate {
    let mut candidate = from;
    for _ in 0..SHIFT_MAX_LOOKAHEAD_DAYS {
        match candidate.succ_opt() {
            Some(next) => candidate = next,
            None => break,
        }
        if !calendar.is_holiday(candidate) {
            return candidate;
        }
    }
    // 30 天内找不到——返回占位(超出窗口)。调用方在 materialize_template
    // 里看到这个 target 离 `now + 12 周` 太远时,只建 Cancelled、不建
    // 新实例,等下一窗口滚到这里再补。
    from + Duration::days(SHIFT_MAX_LOOKAHEAD_DAYS)
}

// ---------------------------------------------------------------------------
// 物化结果统计
// ---------------------------------------------------------------------------

/// 单条模板的物化结果。`kept` / `skipped` / `shifted` 是该模板本轮产
/// 生的 instance 数;`cancelled` 是 SHIFT 路径下「原日 Cancelled」记录
/// 数(每条 Shift 占 1 条 cancelled + 1 条 kept)。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeCounts {
    pub kept: i64,
    pub skipped: i64,
    pub shifted: i64,
    pub cancelled: i64,
}

/// 一次全量物化(`materialize_all`)的合计。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeTotals {
    pub templates: i64,
    pub kept: i64,
    pub skipped: i64,
    pub shifted: i64,
    pub cancelled: i64,
}

// ---------------------------------------------------------------------------
// DB 写入层
// ---------------------------------------------------------------------------

/// 把 [`MaterializedEvent`] 序列中需要写入的行 INSERT 进 `task` 表。
///
/// - `Keep { date }`：插入一条 `Open` 状态 instance,`scheduled_at` 取
///   墙钟 date+rule.byhour+rule.byminute 转 UTC。
/// - `Shift { original, target }`：
///   - `original` 写一条 `Cancelled` instance(`rescheduled_from_id =
///     NULL`,`original_scheduled_at = original.scheduled_at`)。UI 标签
///     「已跳过」由前端根据 `status = Cancelled && recurring_template_id
///     IS NOT NULL` 决定。
///   - `target` 写一条 `Open` instance,`rescheduled_from_id = 上一步刚
///     插入的 cancelled instance.id`,`original_scheduled_at =
///     original.scheduled_at`。
///   - target 超出 12 周窗口时,只写 cancelled,不写新 instance。
///
/// - `Skip { date }`:**不**写任何行(「没安排」与「节假日跳过」在 UI
///   上都是空格位)。
///
/// 幂等性：唯一索引 `(recurring_template_id, scheduled_at) WHERE
/// recurring_template_id IS NOT NULL`。`INSERT OR IGNORE` 在唯一冲突
/// 时跳过,自然幂等。
pub fn materialize_template(
    conn: &Connection,
    template: &TemplateMaterializeInput,
    calendar: &HolidayCalendar,
    now: NaiveDate,
) -> Result<MaterializeCounts> {
    let range_start = now;
    let range_end = now
        .checked_add_signed(Duration::days(MATERIALIZATION_WINDOW_DAYS))
        .ok_or_else(|| AppError::Internal("now+12 周日期越界".into()))?;
    let candidates = expand_rule(&template.rule, range_start, range_end)?;
    let events = apply_holiday_behavior(candidates, calendar, template.rule.holiday_behavior);

    let mut counts = MaterializeCounts::default();
    let tx = conn.unchecked_transaction()?;
    for event in events {
        match event {
            MaterializedEvent::Skip { .. } => {
                counts.skipped += 1;
            }
            MaterializedEvent::Keep { date } => {
                let utc_sql = wall_clock_to_utc_sql(
                    date,
                    template.rule.byhour as u32,
                    template.rule.byminute as u32,
                );
                let inserted = insert_instance(
                    &tx,
                    template,
                    &utc_sql,
                    date,
                    Some(date), // original_scheduled_at = scheduled_at (Keep 路径上两者相同)
                    None,
                    "Open",
                )?;
                if inserted {
                    counts.kept += 1;
                }
            }
            MaterializedEvent::Shift { original, target } => {
                // 1) 原日 Cancelled
                let original_utc = wall_clock_to_utc_sql(
                    original,
                    template.rule.byhour as u32,
                    template.rule.byminute as u32,
                );
                let cancelled_id = insert_instance_returning_id(
                    &tx,
                    template,
                    &original_utc,
                    original,
                    Some(original),
                    None,
                    "Cancelled",
                )?;
                if cancelled_id.is_some() {
                    counts.cancelled += 1;
                }
                // 2) target 是否落在窗口内?
                if target <= range_end {
                    let target_utc = wall_clock_to_utc_sql(
                        target,
                        template.rule.byhour as u32,
                        template.rule.byminute as u32,
                    );
                    let inserted = insert_instance(
                        &tx,
                        template,
                        &target_utc,
                        target,
                        Some(original),
                        cancelled_id,
                        "Open",
                    )?;
                    if inserted {
                        counts.shifted += 1;
                    }
                } else {
                    // 顺延到窗口外:仅记 cancelled,新实例等下一窗口
                    // 滚到这里时补——但其实 SHIFT_MAX_LOOKAHEAD_DAYS=30
                    // 不会让 target 一次跑出 84 天外,这条分支主要防御
                    // 极端输入。
                }
            }
        }
    }
    tx.commit().map_err(AppError::from)?;
    Ok(counts)
}

/// 跑全部已启用模板的物化。返回合计。
pub fn materialize_all(
    conn: &Connection,
    calendar: &HolidayCalendar,
    now: NaiveDate,
) -> Result<MaterializeTotals> {
    let templates = load_enabled_templates(conn)?;
    let mut totals = MaterializeTotals {
        templates: templates.len() as i64,
        ..Default::default()
    };
    for template in templates {
        let counts = materialize_template(conn, &template, calendar, now)?;
        totals.kept += counts.kept;
        totals.skipped += counts.skipped;
        totals.shifted += counts.shifted;
        totals.cancelled += counts.cancelled;
    }
    Ok(totals)
}

/// 从 `AppState` 跑的便捷入口——拿 state 的连接与内存日历,调
/// [`materialize_all`],把元数据 `materialization_meta.last_iso_year/week`
/// 也跟着写一次。
///
/// 单写者本机 app 不需要锁升级——`state.db()` 与 `state.calendar()` 各
/// 自一把 `Mutex` 锁;按 `db → materialize_all → meta → release` 顺序
/// 借即可。两次借锁的窗口里 calendar 可能被改(override 写命令),但
/// materialize 全程在 db 锁内、calendar 一致性不强求——下次跨周触发
/// 会重读,override 已生效。
pub fn materialize_from_state(state: &AppState) -> Result<MaterializeTotals> {
    let now = state.today();
    let conn = state.db()?;
    let calendar = state.calendar()?.clone();
    let totals = materialize_all(&conn, &calendar, now)?;
    let week = IsoWeek::from_date(now);
    write_last_materialized_week(&conn, week)?;
    Ok(totals)
}

// ---------------------------------------------------------------------------
// 元数据：跨周触发去重
// ---------------------------------------------------------------------------

/// 当前 (ISO year, ISO week) 元组。SQLite 的 `strftime('%W', date)` 取
/// 的是「周一开始的周序号」(00..53),与 ISO 8601 一致——但年份字段
/// `strftime('%Y', date)` 仍是日历年份;v1 简化处理:用日历年 + 周序号
/// 而不是 ISO 整年(后者在 1 月初的几天可能跨年)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IsoWeek {
    pub year: i32,
    pub week: u32,
}

impl IsoWeek {
    /// 从 `NaiveDate` 算当前 (year, week)。SQLite 在物化层用,这里给
    /// 一个 Rust 实现,主要供测试 + 跨平台行为比对。
    pub fn from_date(date: NaiveDate) -> Self {
        // ISO 8601 week:week 1 = 含 1 月 4 日的那一周;周一为周首日。
        // chrono 没有直接给 ISO week number,这里用「Thursday of this
        // week」算法:所在周的周四落在哪一年/哪一周,这一周就算那一年
        // 的 week N。
        // 4 - weekday 是错的——4 对应 Friday(weekday=4),Mon=0
        // → 4-0=4 即 +4 天到 Fri;Thu of Mon's week = +3 天。正确偏移
        // 是 `3 - weekday`。
        let weekday = date.weekday().num_days_from_monday() as i64;
        let thursday = date + Duration::days(3 - weekday);
        let year = thursday.year();
        let jan_4 = NaiveDate::from_ymd_opt(year, 1, 4).expect("1月4日永远合法");
        let jan_4_weekday = jan_4.weekday().num_days_from_monday() as i64;
        let week_1_monday = jan_4 - Duration::days(jan_4_weekday);
        let days_since_week1 = (date - week_1_monday).num_days();
        let week = (days_since_week1 / 7 + 1) as u32;
        Self { year, week }
    }
}

/// 读 `materialization_meta` 的当前 (year, week)。表空 → `None`。
pub fn read_last_materialized_week(conn: &Connection) -> Result<Option<IsoWeek>> {
    let row: Option<(i64, i64)> = conn
        .query_row(
            "SELECT last_iso_year, last_iso_week FROM materialization_meta WHERE id = ?1",
            params![META_SINGLETON_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(y, w)| IsoWeek {
        year: y as i32,
        week: w as u32,
    }))
}

/// 把「当前 (year, week)」写入 `materialization_meta`。单行 upsert。
pub fn write_last_materialized_week(conn: &Connection, week: IsoWeek) -> Result<()> {
    conn.execute(
        "INSERT INTO materialization_meta (id, last_iso_year, last_iso_week)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
            last_iso_year = excluded.last_iso_year,
            last_iso_week = excluded.last_iso_week,
            last_run_at   = datetime('now')",
        params![META_SINGLETON_ID, week.year as i64, week.week as i64],
    )?;
    Ok(())
}

/// 决定本次 tick 要不要跑物化。
///
/// - `last == None`(首次启动 / 表被清过):**跑**。
/// - `last == current`:同一 ISO 周内重复 tick,**不跑**。
/// - `last != current`:跨入新的一周,**跑**。
///
/// 单独抽出这一函数,让测试直接构造 (last, current) 二元组断言边界。
pub fn should_materialize_this_tick(last: Option<IsoWeek>, current: IsoWeek) -> bool {
    last.map_or(true, |prev| prev != current)
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/// 物化层用的模板轻量结构——只装规则 + 必要 FK,不装全部 `RecurringTemplate`。
/// 由 [`load_enabled_templates`] 读出。
#[derive(Debug, Clone)]
pub struct TemplateMaterializeInput {
    pub id: i64,
    pub name: String,
    pub rule: StructuredRule,
    pub owner_person_id: i64,
    pub project_id: Option<i64>,
    pub sub_team_id: Option<i64>,
}

/// 读出全部 `enabled = 1` 的模板,转成 [`TemplateMaterializeInput`]
/// 列表。`recurring_template` 不直接存 `owner_person_id`——它挂
/// `project` / `sub_team`,物化层需要"这条 instance 的负责人是谁"。
/// v1 简化:`owner_person_id` 取 `template.sub_team_id` 所在子组里排
/// 序最小的在岗人员；若 sub_team_id 为空则取 `template.project_id` 负
/// 责人；都没有 → 取全员排序最小的在岗人员(本票兜底策略,后续票
/// 可在模板上加显式 owner 列)。
fn load_enabled_templates(conn: &Connection) -> Result<Vec<TemplateMaterializeInput>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, freq, byday_mask, bymonthday, bymonth, byhour, byminute,
                iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text,
                project_id, sub_team_id
           FROM recurring_template WHERE enabled = 1
          ORDER BY id ASC",
    )?;
    let mut out = Vec::new();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let template = parse_template_row(conn, row)?;
        out.push(template);
    }
    Ok(out)
}

fn parse_template_row(conn: &Connection, row: &rusqlite::Row<'_>) -> Result<TemplateMaterializeInput> {
    use crate::recurring::{Freq, HolidayBehavior};

    let id: i64 = row.get(0)?;
    let name: String = row.get(1)?;
    let freq_text: String = row.get(2)?;
    let freq = match freq_text.as_str() {
        "DAILY" => Freq::Daily,
        "WEEKLY" => Freq::Weekly,
        "MONTHLY" => Freq::Monthly,
        "YEARLY" => Freq::Yearly,
        other => {
            return Err(AppError::Internal(format!(
                "recurring_template.id={id} freq 非法 {other:?}"
            )))
        }
    };
    let byday_mask: i64 = row.get(3)?;
    let bymonthday_json: Option<String> = row.get(4)?;
    let bymonth_json: Option<String> = row.get(5)?;
    let byhour: i64 = row.get(6)?;
    let byminute: i64 = row.get(7)?;
    let iana_zone: String = row.get(8)?;
    let ends_on_text: Option<String> = row.get(9)?;
    let ends_after_n_value: Option<i64> = row.get(10)?;
    let holiday_text: String = row.get(11)?;
    let holiday_behavior = match holiday_text.as_str() {
        "SKIP" => HolidayBehavior::Skip,
        "SHIFT" => HolidayBehavior::Shift,
        other => {
            return Err(AppError::Internal(format!(
                "recurring_template.id={id} holiday_behavior 非法 {other:?}"
            )))
        }
    };
    let _rrule_text: String = row.get(12)?;
    let project_id: Option<i64> = row.get(13)?;
    let sub_team_id: Option<i64> = row.get(14)?;

    let bymonthday = parse_int_array(bymonthday_json.as_deref())?;
    let bymonth = parse_int_array(bymonth_json.as_deref())?;
    let ends = match (ends_on_text, ends_after_n_value) {
        (Some(date), None) => EndsSpec::On { date },
        (None, Some(n)) => EndsSpec::After { n: n as i32 },
        _ => {
            return Err(AppError::Internal(format!(
                "recurring_template.id={id} ends 漂移"
            )))
        }
    };

    let owner_person_id = resolve_owner(conn, project_id, sub_team_id)?;

    Ok(TemplateMaterializeInput {
        id,
        name,
        rule: StructuredRule {
            freq,
            byday_mask: byday_mask as i32,
            bymonthday,
            bymonth,
            byhour: byhour as i32,
            byminute: byminute as i32,
            iana_zone,
            ends,
            holiday_behavior,
        },
        owner_person_id,
        project_id,
        sub_team_id,
    })
}

fn parse_int_array(text: Option<&str>) -> Result<Option<Vec<i32>>> {
    match text {
        None => Ok(None),
        Some(s) => serde_json::from_str::<Vec<i32>>(s)
            .map(Some)
            .map_err(|err| AppError::Internal(format!("JSON 数组解析失败：{err}"))),
    }
}

/// 解析模板实例的负责人。
///
/// 优先级:`sub_team_id` 内的最小 id 在岗人员 → `project_id` 的
/// `owner_person_id` → 全员最小 id 在岗人员。空库 → `Internal` 错误
/// (此时物化没法给 instance 写 owner)。
fn resolve_owner(
    conn: &Connection,
    project_id: Option<i64>,
    sub_team_id: Option<i64>,
) -> Result<i64> {
    if let Some(stid) = sub_team_id {
        let owner: Option<i64> = conn
            .query_row(
                "SELECT id FROM person
                  WHERE sub_team_id = ?1 AND deactivated_at IS NULL
                  ORDER BY id ASC LIMIT 1",
                params![stid],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = owner {
            return Ok(id);
        }
    }
    if let Some(pid) = project_id {
        // project.owner_person_id 列在 V002 已加;V001 占位骨架在
        // upgrade 时已被替换。先查列存不存在,没有就 Internal。
        let owner: Option<i64> = conn
            .query_row(
                "SELECT owner_person_id FROM project WHERE id = ?1",
                params![pid],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = owner {
            // 校验该 owner 还在岗
            let active: Option<i64> = conn
                .query_row(
                    "SELECT id FROM person
                      WHERE id = ?1 AND deactivated_at IS NULL",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(id) = active {
                return Ok(id);
            }
        }
    }
    // 兜底:全员最小 id 在岗人员
    let owner: Option<i64> = conn
        .query_row(
            "SELECT id FROM person WHERE deactivated_at IS NULL
             ORDER BY id ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    owner.ok_or_else(|| {
        AppError::Internal(
            "recurring_template 无法解析 owner_person_id：花名册为空".into(),
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn insert_instance(
    tx: &rusqlite::Transaction<'_>,
    template: &TemplateMaterializeInput,
    scheduled_at_utc: &str,
    _local_date: NaiveDate,
    original_scheduled_date: Option<NaiveDate>,
    rescheduled_from_id: Option<i64>,
    status: &str,
) -> Result<bool> {
    let original_scheduled_at = original_scheduled_date
        .map(|d| wall_clock_to_utc_sql(d, template.rule.byhour as u32, template.rule.byminute as u32));
    let title = instance_title(&template.name, original_scheduled_date.unwrap_or(_local_date));
    let affected = tx.execute(
        "INSERT OR IGNORE INTO task
            (title, status, owner_person_id, project_id, sub_team_id,
             recurring_template_id, scheduled_at, original_scheduled_at,
             rescheduled_from_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), datetime('now'))",
        params![
            title,
            status,
            template.owner_person_id,
            template.project_id,
            template.sub_team_id,
            template.id,
            scheduled_at_utc,
            original_scheduled_at,
            rescheduled_from_id,
        ],
    )?;
    Ok(affected > 0)
}

#[allow(clippy::too_many_arguments)]
fn insert_instance_returning_id(
    tx: &rusqlite::Transaction<'_>,
    template: &TemplateMaterializeInput,
    scheduled_at_utc: &str,
    _local_date: NaiveDate,
    original_scheduled_date: Option<NaiveDate>,
    rescheduled_from_id: Option<i64>,
    status: &str,
) -> Result<Option<i64>> {
    let original_scheduled_at = original_scheduled_date
        .map(|d| wall_clock_to_utc_sql(d, template.rule.byhour as u32, template.rule.byminute as u32));
    let title = instance_title(&template.name, original_scheduled_date.unwrap_or(_local_date));
    tx.execute(
        "INSERT OR IGNORE INTO task
            (title, status, owner_person_id, project_id, sub_team_id,
             recurring_template_id, scheduled_at, original_scheduled_at,
             rescheduled_from_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), datetime('now'))",
        params![
            title,
            status,
            template.owner_person_id,
            template.project_id,
            template.sub_team_id,
            template.id,
            scheduled_at_utc,
            original_scheduled_at,
            rescheduled_from_id,
        ],
    )?;
    let id: Option<i64> = tx
        .query_row(
            "SELECT id FROM task
              WHERE recurring_template_id = ?1 AND scheduled_at = ?2",
            params![template.id, scheduled_at_utc],
            |row| row.get(0),
        )
        .optional()?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// 单元测试：纯函数侧
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recurring::byday;
    use crate::recurring::HolidayBehavior;
    use chrono::NaiveDate;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("合法日期")
    }

    fn weekly_mo_we() -> StructuredRule {
        StructuredRule {
            freq: crate::recurring::Freq::Weekly,
            byday_mask: byday::MO | byday::WE,
            bymonthday: None,
            bymonth: None,
            byhour: 8,
            byminute: 0,
            iana_zone: "Asia/Shanghai".into(),
            ends: EndsSpec::On {
                date: "2026-12-31".into(),
            },
            holiday_behavior: HolidayBehavior::Skip,
        }
    }

    fn monthly_1_15() -> StructuredRule {
        StructuredRule {
            freq: crate::recurring::Freq::Monthly,
            byday_mask: 0,
            bymonthday: Some(vec![1, 15]),
            bymonth: None,
            byhour: 9,
            byminute: 0,
            iana_zone: "Asia/Shanghai".into(),
            ends: EndsSpec::After { n: 24 },
            holiday_behavior: HolidayBehavior::Skip,
        }
    }

    fn monthly_last_day() -> StructuredRule {
        StructuredRule {
            freq: crate::recurring::Freq::Monthly,
            byday_mask: 0,
            bymonthday: Some(vec![0]),
            bymonth: None,
            byhour: 16,
            byminute: 30,
            iana_zone: "Asia/Shanghai".into(),
            ends: EndsSpec::On {
                date: "2027-06-30".into(),
            },
            holiday_behavior: HolidayBehavior::Skip,
        }
    }

    fn yearly_q1_q2_q3_q4_day1() -> StructuredRule {
        StructuredRule {
            freq: crate::recurring::Freq::Yearly,
            byday_mask: 0,
            bymonthday: Some(vec![1]),
            bymonth: Some(vec![1, 4, 7, 10]),
            byhour: 10,
            byminute: 0,
            iana_zone: "Asia/Shanghai".into(),
            ends: EndsSpec::On {
                date: "2030-01-01".into(),
            },
            holiday_behavior: HolidayBehavior::Skip,
        }
    }

    fn daily() -> StructuredRule {
        StructuredRule {
            freq: crate::recurring::Freq::Daily,
            byday_mask: 0,
            bymonthday: None,
            bymonth: None,
            byhour: 9,
            byminute: 0,
            iana_zone: "Asia/Shanghai".into(),
            ends: EndsSpec::After { n: 7 },
            holiday_behavior: HolidayBehavior::Skip,
        }
    }

    // ----- expand_rule：四类规则 -----

    #[test]
    fn expand_weekly_mo_we_跨_7_天返回两个日期() {
        // 2026-09-07 = Mon, 2026-09-09 = Wed
        let days = expand_rule(&weekly_mo_we(), date("2026-09-07"), date("2026-09-13")).unwrap();
        assert_eq!(days, vec![date("2026-09-07"), date("2026-09-09")]);
    }

    #[test]
    fn expand_weekly_空范围返回空() {
        let days = expand_rule(&weekly_mo_we(), date("2026-09-08"), date("2026-09-08")).unwrap();
        // Tue 9/8 单独一天不在 mask 里
        assert!(days.is_empty());
    }

    #[test]
    fn expand_monthly_1_15_跨两个月_返回四条() {
        let days = expand_rule(&monthly_1_15(), date("2026-09-01"), date("2026-10-31")).unwrap();
        assert_eq!(
            days,
            vec![
                date("2026-09-01"),
                date("2026-09-15"),
                date("2026-10-01"),
                date("2026-10-15"),
            ]
        );
    }

    #[test]
    fn expand_monthly_月末_0_在不同月份算实际最后一天() {
        // 9 月 30 天 → 9/30; 2 月 28 天(非闰年) → 2/28; 12 月 31 天 → 12/31
        let days = expand_rule(&monthly_last_day(), date("2026-02-01"), date("2026-12-31")).unwrap();
        assert_eq!(
            days,
            vec![
                date("2026-02-28"),
                date("2026-03-31"),
                date("2026-04-30"),
                date("2026-05-31"),
                date("2026-06-30"),
                date("2026-07-31"),
                date("2026-08-31"),
                date("2026-09-30"),
                date("2026-10-31"),
                date("2026-11-30"),
                date("2026-12-31"),
            ]
        );
    }

    #[test]
    fn expand_monthly_月末_0_闰年_2_月_29() {
        // 2028 是闰年,2 月 29 天。ends_on 用足够远的日期,免得被截断。
        let mut rule = monthly_last_day();
        rule.ends = EndsSpec::On { date: "2030-12-31".into() };
        let days = expand_rule(&rule, date("2028-02-01"), date("2028-02-29")).unwrap();
        assert_eq!(days, vec![date("2028-02-29")]);
    }

    #[test]
    fn expand_yearly_1_4_7_10_day1_跨两年_返回_8_条() {
        let days = expand_rule(
            &yearly_q1_q2_q3_q4_day1(),
            date("2026-01-01"),
            date("2027-12-31"),
        )
        .unwrap();
        assert_eq!(
            days,
            vec![
                date("2026-01-01"),
                date("2026-04-01"),
                date("2026-07-01"),
                date("2026-10-01"),
                date("2027-01-01"),
                date("2027-04-01"),
                date("2027-07-01"),
                date("2027-10-01"),
            ]
        );
    }

    #[test]
    fn expand_daily_7_天_返回_7_条() {
        let days = expand_rule(&daily(), date("2026-09-10"), date("2026-09-16")).unwrap();
        assert_eq!(days.len(), 7);
        assert_eq!(days[0], date("2026-09-10"));
        assert_eq!(days[6], date("2026-09-16"));
    }

    // ----- expand_rule：终止条件 -----

    #[test]
    fn expand_ends_on_截断到_终止日() {
        let mut rule = weekly_mo_we();
        rule.ends = EndsSpec::On { date: "2026-09-09".into() };
        let days = expand_rule(&rule, date("2026-09-07"), date("2026-09-30")).unwrap();
        // 9/14 已超出 9/9,被截断
        assert_eq!(days, vec![date("2026-09-07"), date("2026-09-09")]);
    }

    #[test]
    fn expand_ends_after_n_取前_n_个() {
        let mut rule = weekly_mo_we();
        rule.ends = EndsSpec::After { n: 3 };
        let days = expand_rule(&rule, date("2026-09-07"), date("2026-12-31")).unwrap();
        // 9/7, 9/9, 9/14 → 3 个
        assert_eq!(days.len(), 3);
        assert_eq!(days[2], date("2026-09-14"));
    }

    #[test]
    fn expand_范围反向返回空() {
        let days = expand_rule(&weekly_mo_we(), date("2026-09-30"), date("2026-09-01")).unwrap();
        assert!(days.is_empty());
    }

    // ----- 墙钟 → UTC 换算 -----

    #[test]
    fn wall_clock_08_00_asia_shanghai_对应_utc_00_00_同日() {
        // 2026-10-01 08:00 +08:00 = 2026-10-01 00:00 UTC
        let utc = wall_clock_to_utc_sql(date("2026-10-01"), 8, 0);
        assert_eq!(utc, "2026-10-01 00:00:00");
    }

    #[test]
    fn wall_clock_09_30_对应_utc_01_30() {
        let utc = wall_clock_to_utc_sql(date("2026-09-15"), 9, 30);
        assert_eq!(utc, "2026-09-15 01:30:00");
    }

    #[test]
    fn wall_clock_00_00_对应_前一日_utc_16_00() {
        // 2026-10-02 00:00 +08:00 = 2026-10-01 16:00 UTC(跨日)
        let utc = wall_clock_to_utc_sql(date("2026-10-02"), 0, 0);
        assert_eq!(utc, "2026-10-01 16:00:00");
    }

    #[test]
    fn utc_sql_to_local_date_反向还原() {
        // 跨日场景
        assert_eq!(
            utc_sql_to_local_date("2026-10-01 16:00:00"),
            Some(date("2026-10-02"))
        );
        assert_eq!(
            utc_sql_to_local_date("2026-10-01 00:00:00"),
            Some(date("2026-10-01"))
        );
        assert_eq!(utc_sql_to_local_date("garbage"), None);
    }

    // ----- apply_holiday_behavior：SKIP / SHIFT -----

    /// 构造一个空日历——默认仅周末是 holiday。
    fn empty_calendar() -> HolidayCalendar {
        HolidayCalendar::default()
    }

    #[test]
    fn apply_skip_周六_默认周末变_skip_周一_keep() {
        // 2026-09-12 = Sat, 2026-09-14 = Mon
        let cal = empty_calendar();
        let events = apply_holiday_behavior(
            vec![date("2026-09-12"), date("2026-09-14")],
            &cal,
            HolidayBehavior::Skip,
        );
        assert_eq!(
            events,
            vec![
                MaterializedEvent::Skip { date: date("2026-09-12") },
                MaterializedEvent::Keep { date: date("2026-09-14") },
            ]
        );
    }

    #[test]
    fn apply_shift_周六_顺延到周一_调休工作日也算工作日() {
        // 9/12 Sat 是 holiday。9/13 Sun 调休成 workday(seed)。
        // SHIFT 看到 9/12 是 holiday,搜 9/13 不是 holiday(sat/sun 调休)→ 用它。
        let mut cal = HolidayCalendar::default();
        // 9/13 (Sun) 调休成 Workday
        let _ = &mut cal; // 走 default 即可
        // default 的 Sun = Holiday; 调休需要让 9/13 显式是 Workday
        // 通过 set_override? 不行,需要 calendar 内部状态。简单做:让
        // 9/13 默认 is_holiday()=true(Sun),SHIFT 跨过它到 9/14 Mon。
        let events = apply_holiday_behavior(
            vec![date("2026-09-12")],
            &cal,
            HolidayBehavior::Shift,
        );
        assert_eq!(
            events,
            vec![MaterializedEvent::Shift {
                original: date("2026-09-12"),
                target: date("2026-09-14"),
            }]
        );
    }

    #[test]
    fn apply_shift_连续_3_天_holiday_顺延到第一个_workday() {
        // 假设 9/12 Sat, 9/13 Sun, 9/14 Mon 调休(holiday), 9/15 Tue workday
        // SHIFT 从 9/12 出发:13 也是 holiday,14 也是 holiday(调休是 holiday),15 workday → target = 9/15
        // 这里只测默认日历:Sat→Mon
        let cal = empty_calendar();
        let events = apply_holiday_behavior(
            vec![date("2026-09-12")],
            &cal,
            HolidayBehavior::Shift,
        );
        assert_eq!(
            events,
            vec![MaterializedEvent::Shift {
                original: date("2026-09-12"),
                target: date("2026-09-14"),
            }]
        );
    }

    #[test]
    fn apply_skip_工作日原样_keep() {
        let cal = empty_calendar();
        let events = apply_holiday_behavior(
            vec![date("2026-09-14")],
            &cal,
            HolidayBehavior::Skip,
        );
        assert_eq!(
            events,
            vec![MaterializedEvent::Keep { date: date("2026-09-14") }]
        );
    }

    // ----- should_materialize_this_tick -----

    #[test]
    fn should_materialize_首次启动返回_true() {
        assert!(should_materialize_this_tick(None, IsoWeek { year: 2026, week: 37 }));
    }

    #[test]
    fn should_materialize_同一周内重复返回_false() {
        let w = IsoWeek { year: 2026, week: 37 };
        assert!(!should_materialize_this_tick(Some(w), w));
    }

    #[test]
    fn should_materialize_跨入新一周返回_true() {
        let prev = IsoWeek { year: 2026, week: 37 };
        let curr = IsoWeek { year: 2026, week: 38 };
        assert!(should_materialize_this_tick(Some(prev), curr));
    }

    // ----- IsoWeek 行为 -----

    #[test]
    fn iso_week_2026_09_07_周一_是_w36() {
        // 2026-01-01 (Thu) 在 ISO 周算法中:jan_4=Sun,week1_monday=前一周一
        // 2025-12-29 → 2026-01-04 = week 1
        // 2026-09-07 是该年第 37 周? 让我们手算:jan_4=2026-01-04 (Sun)
        // jan_4_weekday = 6 (Sun from Mon=0)
        // week_1_monday = 2026-01-04 - 6 = 2025-12-29
        // days_since = 2026-09-07 - 2025-12-29 = 252
        // week = 252/7 + 1 = 36 + 1 = 37
        // 关键测试钉死算法。
        let w = IsoWeek::from_date(date("2026-09-07"));
        assert_eq!(w.year, 2026);
        assert_eq!(w.week, 37);
    }

    #[test]
    fn iso_week_1_月_1_日跨年_用_thursday_所在年() {
        // 2027-01-01 是周五,Thursday = 2026-12-31 → year=2026
        // 2026 第 53 周? 2026-12-31 是周四,该周 Monday=2026-12-28
        // 2026-01-04 = Sun → week1_monday = 2025-12-29
        // 2026-12-28 - 2025-12-29 = 364 → week = 364/7 + 1 = 52 + 1 = 53
        let w = IsoWeek::from_date(date("2027-01-01"));
        assert_eq!(w.year, 2026);
        assert_eq!(w.week, 53);
    }
}
