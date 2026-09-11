//! 抓取节假日数据并写出 `holidays/cn-<year>.json` 的 xtask。
//!
//! 用法：`cargo xtask fetch-holidays <year>`
//!
//! 主源走 jsDelivr CDN 抓 `NateScarlet/holiday-cn/{year}.json`（国内友
//! 好），主源缺失当前年份（404 或解析失败）时降级到 `date.nager.at`
//! 的 PublicHolidays API——后者只含法定假首日、**无调休**，SKIP 路径仍
//! 准,SHIFT 路径可能漏跳过个别调休;维护者下个发版补回 holiday-cn。
//!
//! 输出文件路径 `<repo-root>/holidays/cn-<year>.json`；由
//! `env!("CARGO_MANIFEST_DIR")` 解析,无视调用方 cwd——cargo 总是把
//! cwd 钉在 `src-tauri/`,裸的相对路径会写到错地方。
//! 若文件已存在,**不**自动覆盖——避免冲掉人工编辑的本地调整,先打印
//! 「文件已存在,跳过」并退出。
//!
//! 退出码:
//! - 0 = 成功生成(或文件已存在且跳过)
//! - 1 = 参数错误 / 网络失败 / 解析失败 / 写入失败

use chrono::{Datelike, NaiveDate};
use kewutong_lib::holiday::{main_festival_name, merge_into_ranges, HolidayFile};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// 主源：NateScarlet/holiday-cn（jsDelivr CDN）
// ---------------------------------------------------------------------------

const JSDELIVR_URL_TEMPLATE: &str =
    "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json";

/// holiday-cn 顶层形状。仅声明 xtask 实际用到的字段——其它字段(papers /
/// regions / ...)忽略。
#[derive(Debug, Clone, Deserialize)]
struct HolidayCnFile {
    #[serde(default)]
    days: Vec<HolidayCnDay>,
}

#[derive(Debug, Clone, Deserialize)]
struct HolidayCnDay {
    /// holiday-cn 给出的逐日名（可能是「除夕」「初一」等子别名）。
    name: String,
    /// `"YYYY-MM-DD"`。
    date: String,
    /// `true` = 法定节假日；`false` = 调休工作日。
    #[serde(rename = "isOffDay")]
    is_off_day: bool,
}

// ---------------------------------------------------------------------------
// 备源：date.nager.at PublicHolidays
// ---------------------------------------------------------------------------

const NAGER_AT_URL_TEMPLATE: &str =
    "https://date.nager.at/api/v3/PublicHolidays/{year}/CN";

#[derive(Debug, Deserialize)]
struct NagerAtHoliday {
    date: String,
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("fetch-holidays") => match fetch_holidays(&args[2..]) {
            Ok(summary) => {
                println!("{summary}");
                ExitCode::SUCCESS
            }
            Err(err) => {
                eprintln!("fetch-holidays 失败：{err}");
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("用法：cargo xtask fetch-holidays <year>");
            eprintln!();
            eprintln!("示例：cargo xtask fetch-holidays 2027");
            ExitCode::FAILURE
        }
    }
}

fn fetch_holidays(args: &[String]) -> Result<String, XtaskError> {
    fetch_holidays_at(args, &holidays_dir_for(&repo_root()))
}

/// `cargo xtask` 运行时 cargo 把 cwd 钉在 package 根 (`src-tauri/`)，
/// 节假日数据得写到仓库根 `holidays/`——也就是 Tauri bundle
/// `bundle.resources: ["../holidays/*"]` 指向的那一处。`CARGO_MANIFEST_DIR`
/// 在编译期钉死,无视 cwd,这是唯一可靠的写法。
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// `holidays/` 目录相对 `repo_root()` 的位置——`src-tauri/` 的兄弟目录。
/// 抽成纯函数是为了让测试能用 tempdir 替换而不污染真仓库。
fn holidays_dir_for(base: &Path) -> PathBuf {
    base.join("..").join("holidays")
}

fn fetch_holidays_at(args: &[String], holidays_dir: &Path) -> Result<String, XtaskError> {
    let year: i32 = args
        .first()
        .ok_or_else(|| XtaskError::Usage("缺少年份参数".into()))?
        .parse()
        .map_err(|_| XtaskError::Usage(format!("年份应为整数,收到 {:?}", args[0])))?;

    if !(1900..=2200).contains(&year) {
        return Err(XtaskError::Usage(format!(
            "年份 {year} 不在合理范围 1900..=2200"
        )));
    }

    let output_path = holidays_dir.join(format!("cn-{year}.json"));
    if output_path.exists() {
        return Ok(format!(
            "文件 {} 已存在,跳过——避免冲掉人工编辑;若要重抓请先删除",
            output_path.display()
        ));
    }

    let file = match fetch_primary(year) {
        Ok(file) => file,
        // ADR 0003 §响应映射 point 6: 只有「主源当前年份文件不存在」才
        // 降级到备源;网络 5xx / 解析错等其它失败应当 fatal,不掩盖。
        Err(XtaskError::PrimaryMissing(url)) => {
            eprintln!("主源 {url} 返回 404;降级到 date.nager.at");
            fetch_fallback(year)?
        }
        Err(other) => return Err(other),
    };

    write_to_disk(&output_path, &file)?;
    Ok(format!(
        "已生成 {}（{} 条 holiday、{} 条 workday）",
        output_path.display(),
        file.holidays.len(),
        file.workdays.len(),
    ))
}

// ---------------------------------------------------------------------------
// 拉取 + 映射
// ---------------------------------------------------------------------------

fn fetch_primary(year: i32) -> Result<HolidayFile, XtaskError> {
    let url = JSDELIVR_URL_TEMPLATE.replace("{year}", &year.to_string());
    let response = match ureq::get(&url).call() {
        Ok(resp) => resp,
        Err(ureq::Error::Status(404, _resp)) => {
            // ADR 0003 §响应映射 point 6: 备源仅在主源「当前年份文件缺失」
            // 时介入——只有 404 才是缺失。5xx / 网络故障应是 fatal。
            return Err(XtaskError::PrimaryMissing(url));
        }
        Err(err) => return Err(XtaskError::Network(format!("GET {url} 失败：{err}"))),
    };
    let parsed: HolidayCnFile = response
        .into_json()
        .map_err(|err| XtaskError::Parse(format!("主源 {url} JSON 解析失败：{err}")))?;
    Ok(map_holiday_cn_to_file(year, parsed))
}

fn fetch_fallback(year: i32) -> Result<HolidayFile, XtaskError> {
    let url = NAGER_AT_URL_TEMPLATE.replace("{year}", &year.to_string());
    let response = ureq::get(&url)
        .call()
        .map_err(|err| XtaskError::Network(format!("GET {url} 失败：{err}")))?;
    let holidays: Vec<NagerAtHoliday> = response
        .into_json()
        .map_err(|err| XtaskError::Parse(format!("备源 {url} JSON 解析失败：{err}")))?;
    Ok(map_nager_at_to_file(year, holidays))
}

fn map_holiday_cn_to_file(year: i32, parsed: HolidayCnFile) -> HolidayFile {
    let mut holiday_dates: BTreeMap<String, Vec<NaiveDate>> = BTreeMap::new();
    let mut workday_dates: BTreeMap<String, Vec<NaiveDate>> = BTreeMap::new();
    let mut unknown_aliases: BTreeMap<String, u32> = BTreeMap::new();

    for day in parsed.days {
        let date = match NaiveDate::parse_from_str(&day.date, "%Y-%m-%d") {
            Ok(date) => date,
            Err(_) => continue, // 抓取脚本不会出,真出了跳过这一条而非全局崩
        };
        if date.year() != year {
            // 跨年条目截断:文件名是 cn-<year>.json,区间不跨年(ADR 0003)。
            // 该日不进本年文件,留给相邻年份抓取时再处理。
            continue;
        }
        let main_name = main_festival_name(&day.name);
        if main_name != day.name {
            // 折叠到了主名——记录一下,stderr 提示维护者检查。
            *unknown_aliases.entry(day.name.clone()).or_insert(0) += 1;
        }
        let bucket = if day.is_off_day {
            &mut holiday_dates
        } else {
            &mut workday_dates
        };
        bucket.entry(main_name).or_default().push(date);
    }

    let mut holidays = Vec::new();
    for (name, mut dates) in holiday_dates {
        dates.sort();
        dates.dedup();
        holidays.extend(merge_into_ranges(&dates, &name));
    }
    let mut workdays = Vec::new();
    for (name, mut dates) in workday_dates {
        dates.sort();
        dates.dedup();
        workdays.extend(merge_into_ranges(&dates, &name));
    }

    if !unknown_aliases.is_empty() {
        // ADR 0003 §响应映射 point 3: 未知别名应**静默保留原文**(不强行
        // 折叠),维护者下一年开工前手动补 `main_festival_name` 表——只
        // 在 stderr 打一行汇总,供 git diff review 时瞥一眼即可。
        eprintln!(
            "主源别名折叠统计（年={year}）: {unknown_aliases:?}"
        );
    }

    // 区间按 start 升序,git diff 友好。
    holidays.sort_by_key(|entry| entry.start);
    workdays.sort_by_key(|entry| entry.start);

    HolidayFile { holidays, workdays }
}

fn map_nager_at_to_file(year: i32, holidays: Vec<NagerAtHoliday>) -> HolidayFile {
    let mut dates: Vec<NaiveDate> = holidays
        .into_iter()
        .filter_map(|h| NaiveDate::parse_from_str(&h.date, "%Y-%m-%d").ok())
        .filter(|d| d.year() == year)
        .collect();
    dates.sort();
    dates.dedup();

    // date.nager.at 仅给「法定假首日」，无调休、无节日名——workdays 为空。
    let mut holidays = Vec::new();
    let mut by_name: BTreeMap<String, Vec<NaiveDate>> = BTreeMap::new();
    // 备源无 name 字段；按月份粗分（1=元旦,4=清明,5=劳动,6=端午,9=中秋,10=国庆）
    // ——仅为调试可读;实际合并只看日期,不依赖 name。
    for date in &dates {
        let guess = guess_nager_at_name(*date);
        by_name.entry(guess).or_default().push(*date);
    }
    for (name, days) in &mut by_name {
        days.sort();
        days.dedup();
        holidays.extend(merge_into_ranges(days, name));
    }
    holidays.sort_by_key(|entry| entry.start);

    HolidayFile {
        holidays,
        workdays: Vec::new(),
    }
}

fn guess_nager_at_name(date: NaiveDate) -> String {
    match (date.month(), date.day()) {
        (1, 1) => "元旦".into(),
        (_, d) if date.month() == 4 && (d == 4 || d == 5 || d == 6) => "清明节".into(),
        (5, _) => "劳动节".into(),
        (_, _) if date.month() == 6 => "端午节".into(),
        (_, _) if date.month() == 9 && date.day() >= 15 && date.day() <= 21 => "中秋节".into(),
        (10, _) => "国庆节".into(),
        (2, _) => "春节".into(),
        _ => format!("{}-{}", date.format("%m-%d"), date.year()),
    }
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

fn write_to_disk(path: &std::path::Path, file: &HolidayFile) -> Result<(), XtaskError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            XtaskError::Write(format!("创建目录 {} 失败：{err}", parent.display()))
        })?;
    }
    let json = serde_json::to_string_pretty(file)
        .map_err(|err| XtaskError::Write(format!("序列化失败：{err}")))?;
    let mut f = fs::File::create(path)
        .map_err(|err| XtaskError::Write(format!("创建文件 {} 失败：{err}", path.display())))?;
    f.write_all(json.as_bytes())
        .map_err(|err| XtaskError::Write(format!("写入 {} 失败：{err}", path.display())))?;
    f.write_all(b"\n")
        .map_err(|err| XtaskError::Write(format!("写入 {} 失败：{err}", path.display())))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum XtaskError {
    Usage(String),
    /// 主源当前年份文件 404——降级到备源前由 fetch_holidays 显式消费。
    PrimaryMissing(String),
    Network(String),
    Parse(String),
    Write(String),
}

impl std::fmt::Display for XtaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Usage(msg) => write!(f, "{msg}"),
            Self::PrimaryMissing(url) => write!(f, "{url} 不存在"),
            Self::Network(msg) => write!(f, "{msg}"),
            Self::Parse(msg) => write!(f, "{msg}"),
            Self::Write(msg) => write!(f, "{msg}"),
        }
    }
}

// ---------------------------------------------------------------------------
// 单元测试：映射 + 合并 + 跨年截断
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn day(date: &str, name: &str, is_off_day: bool) -> HolidayCnDay {
        HolidayCnDay {
            date: date.into(),
            name: name.into(),
            is_off_day,
        }
    }

    #[test]
    fn 主源映射_相邻春节_合并为一条区间() {
        // holiday-cn 的春节通常给出 8~9 天连续 offDay=true,日名是
        // 「除夕/初一/初七」之类——映射后应合并为单条 (2/15, 2/23, 春节)。
        let parsed = HolidayCnFile {
            days: vec![
                day("2026-02-15", "除夕", true),
                day("2026-02-16", "春节", true),
                day("2026-02-17", "初二", true),
                day("2026-02-18", "初三", true),
                day("2026-02-19", "初四", true),
                day("2026-02-20", "初五", true),
                day("2026-02-21", "初六", true),
                day("2026-02-22", "初七", true),
                day("2026-02-23", "初八", true),
            ],
        };

        let file = map_holiday_cn_to_file(2026, parsed);

        assert_eq!(file.holidays.len(), 1);
        assert_eq!(file.holidays[0].name.as_deref(), Some("春节"));
        assert_eq!(
            file.holidays[0].start,
            NaiveDate::from_ymd_opt(2026, 2, 15).unwrap()
        );
        assert_eq!(
            file.holidays[0].end,
            NaiveDate::from_ymd_opt(2026, 2, 23).unwrap()
        );
        assert!(file.workdays.is_empty());
    }

    #[test]
    fn 主源映射_gap_大于_1_断开成两条区间() {
        // 跨节之间的 gap > 1（如清明 4/4-4/6,劳动节 5/1-5/5）→ 两条区间。
        let parsed = HolidayCnFile {
            days: vec![
                day("2026-04-04", "清明节", true),
                day("2026-04-05", "清明节", true),
                day("2026-04-06", "清明节", true),
                // gap = 24 天,远大于 1
                day("2026-05-01", "劳动节", true),
                day("2026-05-02", "劳动节", true),
            ],
        };

        let file = map_holiday_cn_to_file(2026, parsed);

        assert_eq!(file.holidays.len(), 2);
        assert_eq!(file.holidays[0].name.as_deref(), Some("清明节"));
        assert_eq!(file.holidays[1].name.as_deref(), Some("劳动节"));
        assert_eq!(
            file.holidays[0].start,
            NaiveDate::from_ymd_opt(2026, 4, 4).unwrap()
        );
        assert_eq!(
            file.holidays[1].end,
            NaiveDate::from_ymd_opt(2026, 5, 2).unwrap()
        );
    }

    #[test]
    fn 主源映射_调休_workday_被分到_workdays_而非_holidays() {
        let parsed = HolidayCnFile {
            days: vec![
                day("2026-02-14", "春节", false), // 调休
                day("2026-02-15", "除夕", true),  // 假
                day("2026-02-16", "春节", true),
                day("2026-02-28", "春节", false), // 调休
            ],
        };

        let file = map_holiday_cn_to_file(2026, parsed);

        // holidays: 春节假 2/15-2/16（不是 2/15 整天,因为 2/17 不在 days 里）
        assert_eq!(file.holidays.len(), 1);
        assert_eq!(file.holidays[0].name.as_deref(), Some("春节"));
        assert_eq!(
            file.holidays[0].start,
            NaiveDate::from_ymd_opt(2026, 2, 15).unwrap()
        );
        assert_eq!(
            file.holidays[0].end,
            NaiveDate::from_ymd_opt(2026, 2, 16).unwrap()
        );

        // workdays: 调休单条（相邻不同日不合并）
        assert_eq!(file.workdays.len(), 2);
        let dates: Vec<NaiveDate> = file
            .workdays
            .iter()
            .flat_map(|e| {
                let mut v = Vec::new();
                let mut current = e.start;
                loop {
                    v.push(current);
                    if current == e.end {
                        break;
                    }
                    current = current.succ_opt().unwrap();
                }
                v
            })
            .collect();
        assert!(dates.contains(&NaiveDate::from_ymd_opt(2026, 2, 14).unwrap()));
        assert!(dates.contains(&NaiveDate::from_ymd_opt(2026, 2, 28).unwrap()));
    }

    #[test]
    fn 主源映射_跨年日期被截断() {
        // 春节偶尔会跨年（2027 春节始于 2026-02-? 不太可能;但 2027 元旦
        // 区间 12/30-1/1 跨年），跨年的另一天属于相邻年份文件。
        let parsed = HolidayCnFile {
            days: vec![
                day("2026-12-31", "元旦", true),
                day("2027-01-01", "元旦", true),
            ],
        };

        let file_2026 = map_holiday_cn_to_file(2026, parsed.clone());
        let file_2027 = map_holiday_cn_to_file(2027, parsed);

        // 2026 文件只含 12/31
        assert_eq!(file_2026.holidays.len(), 1);
        assert_eq!(
            file_2026.holidays[0].start,
            NaiveDate::from_ymd_opt(2026, 12, 31).unwrap()
        );
        assert_eq!(
            file_2026.holidays[0].end,
            NaiveDate::from_ymd_opt(2026, 12, 31).unwrap()
        );

        // 2027 文件只含 1/1
        assert_eq!(file_2027.holidays.len(), 1);
        assert_eq!(
            file_2027.holidays[0].start,
            NaiveDate::from_ymd_opt(2027, 1, 1).unwrap()
        );
    }

    #[test]
    fn 主源映射_日期格式非法_跳过该天_而非全局崩() {
        let parsed = HolidayCnFile {
            days: vec![
                day("2026-13-01", "元旦", true), // 月份非法
                day("2026-05-01", "劳动节", true),
            ],
        };

        let file = map_holiday_cn_to_file(2026, parsed);

        // 只保留合法日期
        assert_eq!(file.holidays.len(), 1);
        assert_eq!(file.holidays[0].name.as_deref(), Some("劳动节"));
    }

    #[test]
    fn 备源_无调休_workdays_为空() {
        let holidays = vec![
            NagerAtHoliday {
                date: "2026-01-01".into(),
            },
            NagerAtHoliday {
                date: "2026-05-01".into(),
            },
        ];
        let file = map_nager_at_to_file(2026, holidays);

        assert!(file.workdays.is_empty());
        // 至少两条 holiday（元旦、劳动节）
        assert!(file.holidays.len() >= 2);
    }

    #[test]
    fn 已存在的输出文件_跳过_不冲掉() {
        // 把 holidays 目录放到 tempdir 里,放一个 cn-2099.json 后调
        // fetch——应当返回「已存在,跳过」,且原文件内容不被冲掉。
        let dir = tempfile::tempdir().expect("临时目录");
        let sentinel = "{}\n";
        let existing = dir.path().join("cn-2099.json");
        std::fs::write(&existing, sentinel).expect("写哨兵");

        let args = ["2099".to_string()];
        let summary = fetch_holidays_at(&args, dir.path()).expect("skip 路径");

        assert!(
            summary.contains("已存在"),
            "summary 应说明跳过,实际: {summary}",
        );
        let after = std::fs::read_to_string(&existing).expect("读回哨兵");
        assert_eq!(after, sentinel, "哨兵文件不应被 fetch 覆盖");
    }
}