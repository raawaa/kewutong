//! 节假日数据层（ticket #23）。
//!
//! 承担三件事：
//!
//! 1. 解析打包的 `holidays/cn-<year>.json`（ADR 0003 schema）
//! 2. 启动加载当前年 + 下一年,缺文件有明确降级行为而非 panic
//! 3. 与 SQLite 中的手工覆盖合并,App 内覆盖**优先于**打包种子
//!
//! `HolidayCalendar` 是合并后的查询入口:`is_holiday` / `is_makeup_workday` /
//! `get_holiday_name` / `iter_range`。物化层（ticket #25）通过这三只读接口
//! 拿到 effective set,不直接读 JSON 也不直接碰 SQLite。
//!
//! 解析层零容错——`#[serde(deny_unknown_fields)]` 拒绝未知字段;垃圾进 =
//! 垃圾出,trust 抓取脚本 + 人工 `git diff` review。

use crate::error::{AppError, Result};
use chrono::{Datelike, NaiveDate};
use rusqlite::Connection;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

// ---------------------------------------------------------------------------
// 打包 schema（ADR 0003）
// ---------------------------------------------------------------------------

/// JSON 文件一条目。`start == end` 表示单天。
///
/// `#[serde(deny_unknown_fields)]` 拒绝任何未声明字段——抓取脚本未来加新
/// 字段会立刻在 CI 暴露,而不是被静默丢弃。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HolidayEntry {
    #[serde(deserialize_with = "deserialize_naive_date_iso")]
    pub start: NaiveDate,
    #[serde(deserialize_with = "deserialize_naive_date_iso")]
    pub end: NaiveDate,
    pub name: Option<String>,
}

/// JSON 文件顶层。schema 演进走 ADR 接力——不预留 `schema_version` 字段。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HolidayFile {
    pub holidays: Vec<HolidayEntry>,
    pub workdays: Vec<HolidayEntry>,
}

// ---------------------------------------------------------------------------
// 合并后的运行时模型
// ---------------------------------------------------------------------------

/// 一天的 effective 类别。`Holiday` 与 `Workday` 语义相反：
///
/// - `Holiday`：休息日（节假日或默认周末）；物化 SKIP 路径跳过，
///   SHIFT 路径不作为目标日。
/// - `Workday`：工作日（调休工作日或默认 weekday）；物化 SKIP 路径
///   不跳过,但若作为 SHIFT 目标日则跳过——这是 SHIFT 路径区分「调休
///   vs 普通工作日」的关键（ADR 0003 §后果）。
///
/// 区分「调休 vs 默认 weekday」靠 [`DaySource`]，不在 [`DayKind`]。
/// 仅看 [`DayKind`] 的查询请走 [`HolidayCalendar::is_makeup_workday`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DayKind {
    Holiday,
    Workday,
}

/// 一天的 effective 信息：用于日历视图（ticket #23 验收点）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayInfo {
    pub kind: DayKind,
    pub name: Option<String>,
    pub source: DaySource,
}

/// 一条记录的来源,用于 UI 标识「这条是种子写的还是你手动改的」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DaySource {
    /// 默认 weekday/weekend——既不在 JSON 里也不在 override 里。
    Default,
    /// 来自 `holidays/cn-<year>.json`。
    Seed,
    /// 来自 SQLite 的 `holiday_override` 表。**优先于种子**。
    Override,
}

/// App 内手工覆盖的种类。`None` 表示清除该日期的覆盖（恢复种子/默认）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverrideKind {
    Holiday,
    Workday,
}

impl OverrideKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Holiday => "holiday",
            Self::Workday => "workday",
        }
    }
}

/// 加载完的日历视图：当年 + 下一年的种子合并进 `seed_*`,override 单独存。
///
/// 查询接口一律 O(log n) 二分；日历视图按月遍历也用 iter_range 一次拿到。
#[derive(Debug, Clone, Default)]
pub struct HolidayCalendar {
    /// 种子：日期 → 节日名。`holidays/cn-YYYY.json` 中的 `holidays[]`。
    seed_holidays: BTreeMap<NaiveDate, String>,
    /// 种子：日期 → 节日名。`holidays/cn-YYYY.json` 中的 `workdays[]`。
    seed_workdays: BTreeMap<NaiveDate, String>,
    /// 覆盖：日期 → kind。优先于种子。
    overrides: BTreeMap<NaiveDate, DayKind>,
    /// 加载时,实际读到了哪些年份的文件（按文件名解析出来的）。用于日志
    /// / 启动检查。
    loaded_years: Vec<i32>,
}

impl HolidayCalendar {
    /// 从 `seed_dir` 读 `cn-<year>.json`,加载 `current_year` 与
    /// `current_year + 1` 两份;再从 `conn` 读 `holiday_override` 表合并
    /// 覆盖。**两个文件都缺**也能启动（年末过渡场景）——空日历生效。
    pub fn load(seed_dir: &Path, current_year: i32, conn: &Connection) -> Result<Self> {
        let mut calendar = Self::default();

        for year in [current_year, current_year + 1] {
            let path = seed_dir.join(format!("cn-{year}.json"));
            match load_one_seed_file(&path, year) {
                SeedLoadOutcome::Loaded(file) => {
                    merge_seed_into(&mut calendar, file, year);
                    calendar.loaded_years.push(year);
                }
                SeedLoadOutcome::Missing => {
                    // 缺文件不 panic——主票验收点。降级为空。
                }
                SeedLoadOutcome::Invalid(err) => {
                    return Err(err);
                }
            }
        }

        load_overrides_into(conn, &mut calendar.overrides)?;
        Ok(calendar)
    }

    /// 实际加载到的年份列表,按升序。供启动日志/调试使用。
    pub fn loaded_years(&self) -> &[i32] {
        &self.loaded_years
    }

    /// 当天是不是休息日（含 override、种子、调休外的默认周末）。
    ///
    /// 默认 weekday 不算休息日——「今天周一」+「没有 override 也没有种
    /// 子」就返 `false`。
    pub fn is_holiday(&self, date: NaiveDate) -> bool {
        self.info(date).kind == DayKind::Holiday
    }

    /// 当天是不是**调休**工作日（override workday 或 seed workday）。
    ///
    /// 与 [`is_holiday`](Self::is_holiday) 不对称——普通 weekday 走
    /// [`info`](Self::info) 的 Default 分支时 `kind = Workday`,但
    /// `source = Default`,**不**算调休。物化层 SHIFT 路径依赖这条不对
    /// 称性区分「调休 vs 普通工作日」(ADR 0003 §后果)。
    pub fn is_makeup_workday(&self, date: NaiveDate) -> bool {
        let info = self.info(date);
        info.kind == DayKind::Workday && info.source != DaySource::Default
    }

    /// 当天的节日名（如"春节"）；仅 Holiday/Workday(种子)时有值。
    ///
    /// Override 不带 name——App 内覆盖只关心是/不是节假日,暂未要求命名。
    pub fn get_holiday_name(&self, date: NaiveDate) -> Option<String> {
        self.info(date).name
    }

    /// 当天的 effective 信息。物化层与日历视图共用这一个入口。
    pub fn info(&self, date: NaiveDate) -> DayInfo {
        if let Some(kind) = self.overrides.get(&date) {
            return DayInfo {
                kind: *kind,
                name: None, // override 不带 name——App 内未要求
                source: DaySource::Override,
            };
        }
        if let Some(name) = self.seed_holidays.get(&date) {
            return DayInfo {
                kind: DayKind::Holiday,
                name: Some(name.clone()),
                source: DaySource::Seed,
            };
        }
        if let Some(name) = self.seed_workdays.get(&date) {
            return DayInfo {
                kind: DayKind::Workday,
                name: Some(name.clone()),
                source: DaySource::Seed,
            };
        }
        DayInfo {
            kind: match date.weekday() {
                chrono::Weekday::Sat | chrono::Weekday::Sun => DayKind::Holiday,
                _ => DayKind::Workday,
            },
            name: None,
            source: DaySource::Default,
        }
    }

    /// 闭区间 `[start, end]` 内所有 effective Holiday / Workday 的天。
    /// 用于日历视图。
    pub fn iter_range(
        &self,
        start: NaiveDate,
        end: NaiveDate,
    ) -> impl Iterator<Item = (NaiveDate, DayInfo)> + '_ {
        // `step_by_days(1)` 在 1.81 是 stable；这里手写更稳，避免依赖版本。
        let mut current = start;
        std::iter::from_fn(move || {
            if current > end {
                return None;
            }
            let info = self.info(current);
            let result = (current, info);
            current = match current.succ_opt() {
                Some(next) => next,
                None => return None,
            };
            Some(result)
        })
    }
}

// ---------------------------------------------------------------------------
// 种子文件加载
// ---------------------------------------------------------------------------

enum SeedLoadOutcome {
    Loaded(HolidayFile),
    Missing,
    Invalid(AppError),
}

fn load_one_seed_file(path: &Path, year: i32) -> SeedLoadOutcome {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return SeedLoadOutcome::Missing,
        Err(err) => {
            return SeedLoadOutcome::Invalid(AppError::Io(err));
        }
    };
    match serde_json::from_str::<HolidayFile>(&text) {
        Ok(file) => SeedLoadOutcome::Loaded(file),
        Err(err) => {
            // 文件读到了但解析失败——schema 不合法或字段被改过，
            // 启动应当立即失败，而不是带着垃圾数据跑下去。
            SeedLoadOutcome::Invalid(AppError::Internal(format!(
                "解析节假日文件 {path:?}（{year}年）失败：{err}"
            )))
        }
    }
}

fn merge_seed_into(calendar: &mut HolidayCalendar, file: HolidayFile, year: i32) {
    // ADR 0003 §解析层：不写手写一致性检查（start <= end、无重叠）。
    // 但 `start <= end` 的畸形输入会让 expand_days 死循环或错位，
    // 故只在这一个真正危险的点上做兜底——其余交给 git diff review。
    for entry in file.holidays {
        for date in expand_days(entry.start, entry.end) {
            // 跨年截断：文件名是 cn-<year>.json，区间不应跨年。
            if date.year() != year {
                continue;
            }
            calendar
                .seed_holidays
                .insert(date, entry.name.clone().unwrap_or_default());
        }
    }
    for entry in file.workdays {
        for date in expand_days(entry.start, entry.end) {
            if date.year() != year {
                continue;
            }
            calendar
                .seed_workdays
                .insert(date, entry.name.clone().unwrap_or_default());
        }
    }
}

/// 把 `[start, end]` 闭区间展开成逐日迭代器。`start > end` 退化为空。
fn expand_days(start: NaiveDate, end: NaiveDate) -> Vec<NaiveDate> {
    if start > end {
        return Vec::new();
    }
    let mut days = Vec::new();
    let mut current = start;
    loop {
        days.push(current);
        if current == end {
            break;
        }
        match current.succ_opt() {
            Some(next) => current = next,
            None => break,
        }
    }
    days
}

// ---------------------------------------------------------------------------
// override 加载 + 持久化
// ---------------------------------------------------------------------------

fn load_overrides_into(
    conn: &Connection,
    out: &mut BTreeMap<NaiveDate, DayKind>,
) -> Result<()> {
    // 表可能尚未建（首次启动时 migration V003 还没跑）。
    // 但 db::open 始终先跑迁移，所以这里假定表已存在。
    let mut stmt = conn.prepare("SELECT date, kind FROM holiday_override")?;
    let rows = stmt.query_map([], |row| {
        let date_text: String = row.get(0)?;
        let kind_text: String = row.get(1)?;
        Ok((date_text, kind_text))
    })?;
    for row in rows {
        let (date_text, kind_text) = row?;
        let date = parse_iso_date(&date_text).ok_or_else(|| {
            AppError::Internal(format!("holiday_override.date 格式不合法：{date_text:?}"))
        })?;
        let kind = match kind_text.as_str() {
            "holiday" => DayKind::Holiday,
            "workday" => DayKind::Workday,
            other => {
                return Err(AppError::Internal(format!(
                    "holiday_override.kind 未知取值：{other:?}"
                )))
            }
        };
        out.insert(date, kind);
    }
    Ok(())
}

/// App 内"切换某一天为 Holiday/Workday"——upsert 进 `holiday_override`。
///
/// 持久化由 SQLite 承担；启动加载回 `overrides: BTreeMap` 后查询自动优先于种子。
pub fn set_override(conn: &Connection, date: NaiveDate, kind: OverrideKind) -> Result<()> {
    let date_text = date.format("%Y-%m-%d").to_string();
    conn.execute(
        "INSERT INTO holiday_override (date, kind) VALUES (?1, ?2) \
         ON CONFLICT(date) DO UPDATE SET kind = excluded.kind",
        rusqlite::params![date_text, kind.as_str()],
    )?;
    Ok(())
}

/// 清除某天的覆盖（恢复种子/默认）。
pub fn clear_override(conn: &Connection, date: NaiveDate) -> Result<()> {
    let date_text = date.format("%Y-%m-%d").to_string();
    conn.execute(
        "DELETE FROM holiday_override WHERE date = ?1",
        rusqlite::params![date_text],
    )?;
    Ok(())
}

/// 从 SQLite 重读全部覆盖,替换 `calendar.overrides`。
///
/// set_override / clear_override 命令在 DB 写完后调一次——calendar 在
/// 内存里的 overrides 跟着翻新,下次 `info()` 立即生效,不必重启 App。
pub fn reload_overrides_from_db(conn: &Connection, calendar: &mut HolidayCalendar) -> Result<()> {
    calendar.overrides.clear();
    load_overrides_into(conn, &mut calendar.overrides)
}

// ---------------------------------------------------------------------------
// serde 自定义 visitor：YYYY-MM-DD -> NaiveDate
// ---------------------------------------------------------------------------

fn deserialize_naive_date_iso<'de, D>(deserializer: D) -> std::result::Result<NaiveDate, D::Error>
where
    D: Deserializer<'de>,
{
    let text = String::deserialize(deserializer)?;
    parse_iso_date(&text).ok_or_else(|| {
        serde::de::Error::custom(format!(
            "日期格式应为 YYYY-MM-DD,收到 {text:?}（holiday-cn 抓取脚本的锅或人工编辑出错）"
        ))
    })
}

fn parse_iso_date(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()
}

// ---------------------------------------------------------------------------
// 跨模块复用：抓取脚本（xtask）也调下面这两个函数，保证「merge 规则」
// 在两边只活一份。
// ---------------------------------------------------------------------------

/// 已知节日的「主名」映射表。holiday-cn 逐日的 `name` 可能是「除夕 / 初一 /
/// 初二 / ... / 初八」——这些都是「春节」的同义词；本表把它们折叠到主名，
/// 区间合并按主名进行。
///
/// 维护方式：抓取脚本运行遇未知别名时静默保留原文（不强行折叠），并在
/// stderr 打印一行提示；维护者下一年开工前手动补一行。
pub fn main_festival_name(raw: &str) -> String {
    match raw {
        // 春节的逐日别名（holiday-cn 通常给到「除夕 + 初一 ~ 初八」共 9 天）
        "除夕" | "春节" | "初一" | "初二" | "初三" | "初四" | "初五" | "初六"
        | "初七" | "初八" | "正月初一" | "正月初二" | "正月初三" | "正月初四"
        | "正月初五" | "正月初六" | "正月初七" | "正月初八" => "春节".to_string(),
        // 其它主名按原样返回（holiday-cn 已对齐"国庆节"/"中秋节"/"劳动节"/"元旦"
        // /"清明节"/"端午节"等主名写法）
        other => other.to_string(),
    }
}

/// 给一组**有序、不重复**的日期，按相邻 gap ≤ 1 合并成区间。
///
/// 「gap ≤ 1」=「两个日期差一天」（即 `day == prev.succ_opt()`）；gap ≥ 2
/// 即断开成两条区间。xtask 抓取脚本与解析层共用这一份逻辑。
pub fn merge_into_ranges(dates: &[NaiveDate], name: &str) -> Vec<HolidayEntry> {
    if dates.is_empty() {
        return Vec::new();
    }
    let mut result: Vec<HolidayEntry> = Vec::new();
    let mut range_start = dates[0];
    let mut range_end = dates[0];

    for &day in &dates[1..] {
        let consecutive = day == range_end.succ_opt().unwrap_or(day);
        if consecutive {
            range_end = day;
        } else {
            result.push(HolidayEntry {
                start: range_start,
                end: range_end,
                name: Some(name.to_string()),
            });
            range_start = day;
            range_end = day;
        }
    }
    result.push(HolidayEntry {
        start: range_start,
        end: range_end,
        name: Some(name.to_string()),
    });
    result
}

// ---------------------------------------------------------------------------
// 单元测试（解析 + 合并 + 优先级 + 跨年）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;
    use std::io::Write;

    /// 在临时目录写一个 cn-<year>.json，返回路径。
    fn write_seed_file(dir: &Path, year: i32, text: &str) -> std::path::PathBuf {
        let path = dir.join(format!("cn-{year}.json"));
        let mut f = fs::File::create(&path).expect("写种子文件");
        f.write_all(text.as_bytes()).expect("写入");
        path
    }

    /// 建一个已跑了全部 migration 的内存库；holiday_override 表来自 V003。
    fn fresh_conn() -> Connection {
        db::open_in_memory().expect("内存库")
    }

    #[test]
    fn 解析_合法文件_holidays_与_workdays_分别就位() {
        let json = r#"{
          "holidays": [
            { "start": "2026-02-15", "end": "2026-02-23", "name": "春节" }
          ],
          "workdays": [
            { "start": "2026-02-14", "end": "2026-02-14", "name": "春节" }
          ]
        }"#;

        let parsed: HolidayFile = serde_json::from_str(json).expect("合法 JSON 应通过");

        assert_eq!(parsed.holidays.len(), 1);
        assert_eq!(parsed.holidays[0].name.as_deref(), Some("春节"));
        assert_eq!(parsed.holidays[0].start, NaiveDate::from_ymd_opt(2026, 2, 15).unwrap());
        assert_eq!(parsed.holidays[0].end, NaiveDate::from_ymd_opt(2026, 2, 23).unwrap());

        assert_eq!(parsed.workdays.len(), 1);
        assert_eq!(parsed.workdays[0].start, NaiveDate::from_ymd_opt(2026, 2, 14).unwrap());
        assert_eq!(parsed.workdays[0].end, NaiveDate::from_ymd_opt(2026, 2, 14).unwrap());
    }

    #[test]
    fn 解析_未知字段被拒() {
        let json = r#"{
          "holidays": [],
          "workdays": [],
          "schema_version": 1,
          "year": 2026
        }"#;

        let err = serde_json::from_str::<HolidayFile>(json).expect_err("未知字段应被拒");
        assert!(
            err.to_string().contains("schema_version") || err.to_string().contains("year"),
            "err: {err}"
        );
    }

    #[test]
    fn 解析_日期格式非法被拒() {
        let json = r#"{
          "holidays": [{ "start": "2026/02/15", "end": "2026-02-23", "name": "春节" }],
          "workdays": []
        }"#;

        let err = serde_json::from_str::<HolidayFile>(json).expect_err("非法日期应被拒");
        assert!(err.to_string().contains("YYYY-MM-DD"), "err: {err}");
    }

    #[test]
    fn 解析_顶层未知字段被拒() {
        let json = r#"{
          "holidays": [],
          "workdays": [],
          "regions": { "cn": {} }
        }"#;
        serde_json::from_str::<HolidayFile>(json).expect_err("顶层 regions 应被拒");
    }

    #[test]
    fn load_两个文件_全部缺_降级为空() {
        let dir = tempfile::tempdir().expect("临时目录");
        let conn = fresh_conn();

        let cal = HolidayCalendar::load(dir.path(), 2026, &conn).expect("缺文件应降级");

        assert!(cal.loaded_years().is_empty());
        assert!(!cal.is_holiday(NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()));
        // 周末默认 = holiday;平日默认 ≠ 调休(只是普通工作日)
        assert!(cal.is_holiday(NaiveDate::from_ymd_opt(2026, 10, 3).unwrap())); // Sat
        assert!(!cal.is_makeup_workday(NaiveDate::from_ymd_opt(2026, 10, 5).unwrap())); // Mon, 默认
        assert!(cal.is_makeup_workday(NaiveDate::from_ymd_opt(2026, 10, 5).unwrap()) == false);
        // info() 在默认 weekday 上 kind=Workday 但 source=Default——物化层
        // 拿这个组合判定「不是调休」,与 is_makeup_workday 一致。
        let mon_info = cal.info(NaiveDate::from_ymd_opt(2026, 10, 5).unwrap());
        assert_eq!(mon_info.kind, DayKind::Workday);
        assert_eq!(mon_info.source, DaySource::Default);
    }

    #[test]
    fn load_只缺下一年_当前年存在() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_seed_file(
            dir.path(),
            2026,
            r#"{ "holidays": [{ "start": "2026-10-01", "end": "2026-10-01", "name": "国庆节" }], "workdays": [] }"#,
        );
        let conn = fresh_conn();

        let cal = HolidayCalendar::load(dir.path(), 2026, &conn).expect("只缺下一年应能加载");

        assert_eq!(cal.loaded_years(), &[2026]);
        assert!(cal.is_holiday(NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()));
    }

    #[test]
    fn load_当年缺_下一年存在() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_seed_file(
            dir.path(),
            2027,
            r#"{ "holidays": [{ "start": "2027-01-01", "end": "2027-01-01", "name": "元旦" }], "workdays": [] }"#,
        );
        let conn = fresh_conn();

        let cal = HolidayCalendar::load(dir.path(), 2026, &conn).expect("年末过渡场景应能加载");

        assert_eq!(cal.loaded_years(), &[2027]);
        assert!(cal.is_holiday(NaiveDate::from_ymd_opt(2027, 1, 1).unwrap()));
    }

    #[test]
    fn load_两个文件_且_跨年区间被截断() {
        let dir = tempfile::tempdir().expect("临时目录");
        // 写一个故意跨年的区间——loader 应当只保留属于本年的部分
        write_seed_file(
            dir.path(),
            2026,
            r#"{
              "holidays": [
                { "start": "2025-12-30", "end": "2026-01-02", "name": "元旦" }
              ],
              "workdays": []
            }"#,
        );
        let conn = fresh_conn();

        let cal = HolidayCalendar::load(dir.path(), 2026, &conn).expect("跨年区间应截断");

        assert!(cal.is_holiday(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()));
        assert!(cal.is_holiday(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap()));
        // 2025 部分不在当前年加载范围——但 loader 不带 2025 种子
        // 所以 2025-12-30 应回到默认（按 weekday）
    }

    #[test]
    fn override_优先于_seed() {
        let dir = tempfile::tempdir().expect("临时目录");
        // 种子：2026-10-01 是"国庆节" Holiday
        write_seed_file(
            dir.path(),
            2026,
            r#"{ "holidays": [{ "start": "2026-10-01", "end": "2026-10-07", "name": "国庆节" }], "workdays": [] }"#,
        );
        let conn = fresh_conn();
        set_override(
            &conn,
            NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            OverrideKind::Workday,
        )
        .expect("写 override");

        let cal = HolidayCalendar::load(dir.path(), 2026, &conn).expect("加载");

        let info = cal.info(NaiveDate::from_ymd_opt(2026, 10, 1).unwrap());
        assert_eq!(info.kind, DayKind::Workday, "override.workday 应盖过 seed.holiday");
        assert_eq!(info.source, DaySource::Override);

        // 其它日期仍是种子
        let info = cal.info(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        assert_eq!(info.kind, DayKind::Holiday);
        assert_eq!(info.source, DaySource::Seed);
    }

    #[test]
    fn override_也能把_普通工作日_翻成_holiday() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_seed_file(
            dir.path(),
            2026,
            r#"{ "holidays": [], "workdays": [] }"#,
        );
        let conn = fresh_conn();
        set_override(
            &conn,
            NaiveDate::from_ymd_opt(2026, 9, 14).unwrap(), // Mon, 默认 workday
            OverrideKind::Holiday,
        )
        .expect("写 override");

        let cal = HolidayCalendar::load(dir.path(), 2026, &conn).expect("加载");

        let info = cal.info(NaiveDate::from_ymd_opt(2026, 9, 14).unwrap());
        assert_eq!(info.kind, DayKind::Holiday);
        assert_eq!(info.source, DaySource::Override);
        // 覆写后是真正的 Holiday,两条查询接口都返 true
        assert!(cal.is_holiday(NaiveDate::from_ymd_opt(2026, 9, 14).unwrap()));
        assert!(!cal.is_makeup_workday(NaiveDate::from_ymd_opt(2026, 9, 14).unwrap()));
    }

    #[test]
    fn is_makeup_workday_默认_weekday_返_false() {
        // 物化层 SHIFT 路径靠这条不对称性区分「调休 vs 普通工作日」——
        // 普通 weekday 是默认 working day,但**不是**调休,不应作为 SHIFT
        // 目标日的候选。
        let dir = tempfile::tempdir().expect("临时目录");
        write_seed_file(
            dir.path(),
            2026,
            r#"{ "holidays": [], "workdays": [] }"#,
        );
        let conn = fresh_conn();
        let cal = HolidayCalendar::load(dir.path(), 2026, &conn).expect("加载");

        for date in [
            "2026-09-14", // Mon
            "2026-09-15", // Tue
            "2026-09-16", // Wed
            "2026-09-17", // Thu
            "2026-09-18", // Fri
        ] {
            let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
            assert!(!cal.is_holiday(d), "普通 weekday 不应 is_holiday");
            assert!(
                !cal.is_makeup_workday(d),
                "普通 weekday 不应 is_makeup_workday"
            );
        }
    }

    #[test]
    fn is_makeup_workday_种子_workday_返_true() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_seed_file(
            dir.path(),
            2026,
            r#"{ "holidays": [], "workdays": [{ "start": "2026-10-10", "end": "2026-10-10", "name": "国庆节" }] }"#,
        );
        let conn = fresh_conn();
        let cal = HolidayCalendar::load(dir.path(), 2026, &conn).expect("加载");

        let d = NaiveDate::from_ymd_opt(2026, 10, 10).unwrap();
        assert!(!cal.is_holiday(d));
        assert!(cal.is_makeup_workday(d), "种子 workday 应算调休");
    }

    #[test]
    fn clear_override_恢复种子() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_seed_file(
            dir.path(),
            2026,
            r#"{ "holidays": [{ "start": "2026-10-01", "end": "2026-10-01", "name": "国庆节" }], "workdays": [] }"#,
        );
        let conn = fresh_conn();
        let date = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        set_override(&conn, date, OverrideKind::Workday).expect("写");
        clear_override(&conn, date).expect("清");

        let cal = HolidayCalendar::load(dir.path(), 2026, &conn).expect("加载");

        let info = cal.info(date);
        assert_eq!(info.kind, DayKind::Holiday, "清掉 override 后种子回归");
        assert_eq!(info.source, DaySource::Seed);
    }

    #[test]
    fn iter_range_按月_包含_种子_override_和_周末() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_seed_file(
            dir.path(),
            2026,
            r#"{ "holidays": [{ "start": "2026-10-01", "end": "2026-10-03", "name": "国庆节" }], "workdays": [{ "start": "2026-10-10", "end": "2026-10-10", "name": "国庆节" }] }"#,
        );
        let conn = fresh_conn();
        set_override(
            &conn,
            NaiveDate::from_ymd_opt(2026, 10, 15).unwrap(),
            OverrideKind::Holiday,
        )
        .expect("override");

        let cal = HolidayCalendar::load(dir.path(), 2026, &conn).expect("加载");

        let start = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 10, 31).unwrap();
        let entries: Vec<(NaiveDate, DayKind, DaySource)> = cal
            .iter_range(start, end)
            .map(|(d, info)| (d, info.kind, info.source))
            .collect();

        // 10/1-10/3 种子 holiday
        assert_eq!(entries[0].1, DayKind::Holiday);
        assert_eq!(entries[0].2, DaySource::Seed);
        // 10/10 调休 workday（种子）
        let workday = entries.iter().find(|(d, _, _)| *d == NaiveDate::from_ymd_opt(2026, 10, 10).unwrap()).unwrap();
        assert_eq!(workday.1, DayKind::Workday);
        assert_eq!(workday.2, DaySource::Seed);
        // 10/15 override → Holiday
        let overridden = entries.iter().find(|(d, _, _)| *d == NaiveDate::from_ymd_opt(2026, 10, 15).unwrap()).unwrap();
        assert_eq!(overridden.1, DayKind::Holiday);
        assert_eq!(overridden.2, DaySource::Override);
        // 10/17-10/18 周末 → 默认 Holiday
        let sat = entries.iter().find(|(d, _, _)| *d == NaiveDate::from_ymd_opt(2026, 10, 17).unwrap()).unwrap();
        assert_eq!(sat.1, DayKind::Holiday);
        assert_eq!(sat.2, DaySource::Default);
        // 10/19 Mon → 默认 workday
        let mon = entries.iter().find(|(d, _, _)| *d == NaiveDate::from_ymd_opt(2026, 10, 19).unwrap()).unwrap();
        assert_eq!(mon.1, DayKind::Workday);
        assert_eq!(mon.2, DaySource::Default);
    }

    #[test]
    fn 合并_相邻_gap_1_同主名() {
        // xtask 抓取脚本与解析层共用同一份合并逻辑：相邻 gap ≤ 1 天 +
        // 同主名 → 一条区间。单元覆盖这条规则（端到端 fetch 在 xtask
        // 测试里走）。
        let days = vec![
            NaiveDate::from_ymd_opt(2026, 2, 16).unwrap(), // 春节
            NaiveDate::from_ymd_opt(2026, 2, 17).unwrap(), // 春节（相邻 gap = 1）
            NaiveDate::from_ymd_opt(2026, 2, 19).unwrap(), // 春节（gap = 2 → 断开）
            NaiveDate::from_ymd_opt(2026, 2, 20).unwrap(), // 春节
        ];

        let merged = merge_into_ranges(&days, "春节");

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].start, NaiveDate::from_ymd_opt(2026, 2, 16).unwrap());
        assert_eq!(merged[0].end, NaiveDate::from_ymd_opt(2026, 2, 17).unwrap());
        assert_eq!(merged[1].start, NaiveDate::from_ymd_opt(2026, 2, 19).unwrap());
        assert_eq!(merged[1].end, NaiveDate::from_ymd_opt(2026, 2, 20).unwrap());
    }

    #[test]
    fn 合并_空输入_返回空() {
        let merged = merge_into_ranges(&[], "元旦");
        assert!(merged.is_empty());
    }

    #[test]
    fn 合并_单条输入() {
        let day = NaiveDate::from_ymd_opt(2026, 5, 1).unwrap();
        let merged = merge_into_ranges(&[day], "劳动节");
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].start, day);
        assert_eq!(merged[0].end, day);
    }

    #[test]
    fn 主名映射_春节逐日别名_全部归到_春节() {
        for alias in ["除夕", "春节", "初一", "初二", "初七", "正月初一", "正月初七"] {
            assert_eq!(main_festival_name(alias), "春节", "alias={alias}");
        }
    }

    #[test]
    fn 主名映射_未知别名原样保留() {
        // 未知别名不强行折叠——xtask 抓取后会打印一行提示,维护者下一年开工前手动补。
        assert_eq!(main_festival_name("国庆节"), "国庆节");
        assert_eq!(main_festival_name("中秋节"), "中秋节");
        assert_eq!(main_festival_name("劳动节"), "劳动节");
        assert_eq!(main_festival_name("元旦"), "元旦");
        assert_eq!(main_festival_name("清明节"), "清明节");
        assert_eq!(main_festival_name("端午节"), "端午节");
        assert_eq!(main_festival_name("某个未知节日"), "某个未知节日");
    }
}