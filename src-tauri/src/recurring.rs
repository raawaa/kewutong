//! 周期性模板的**纯函数**层（ticket #24）。
//!
//! 只做结构化字段 ↔ RRULE 字符串的双向映射,以及单字段的归一化校验。
//! 不碰 SQLite、不碰 [`crate::state::AppState`]——任何命令模块都可以拿这
//! 一组函数算 `rrule_text`,测试也能在没有数据库的条件下把四个用例钉死。
//!
//! 设计要点（承接 ADR 0002 §表示形式）：
//! - **结构化字段优先**：`rrule_text` 仅作 sanity check 用途;解析 RRULE
//!   字符串时若与结构化字段不一致,以结构化字段为准。
//! - **App 层派生,DB 不重算**：`upsert` 入口拿结构化字段跑 [`derive_rrule`]
//!   拼出 RRULE 字符串,落库与读回都不再二次解析。
//! - **规则存墙钟 + `iana_zone`**：不引 `chrono-tz`（中国自 1991 年起不实行
//!   夏令时,UTC+8 固定偏移与 IANA 规则等价）。本模块不涉及墙钟→UTC 换算;
//!   那是 ticket #10 物化层的职责。
//!
//! 字段映射（RFC 5545 子集；详见 ADR 0002）：
//!
//! | 结构化字段      | RRULE 关键字                       |
//! |-----------------|-------------------------------------|
//! | `freq`          | `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` |
//! | `byday_mask`    | `BYDAY=MO,TU,...,SU`（按位展开）    |
//! | `bymonthday`    | `BYMONTHDAY=1,15,-1`（`0` → `-1`）   |
//! | `bymonth`       | `BYMONTH=1,4,7,10`                  |
//! | `byhour`        | `BYHOUR=9`                          |
//! | `byminute`      | `BYMINUTE=0`                        |
//! | `ends_on`       | `UNTIL=20261231T000000Z`（UTC 末日）|
//! | `ends_after_n`  | `COUNT=12`                          |
//!
//! `BYDAY=-1MO`（"月末周五"）这种**位移星期**的写法本票不收——v1 不做
//! 「每月最后一个周五」之类的位置限定,只支持「每周一/三」「每月 1/15 号」
//! 「每月末」「每年 1/4/7/10 月」这四类（票面 AC + 验收标准）。后续 v2 如
//! 要扩,再加 `bysetpos` / 负值 BYDAY。

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 字段枚举 + 编码常量
// ---------------------------------------------------------------------------

/// 频率四值。DB CHECK 与 JS 端 `kebab-case` 都对齐到这四个字面量。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Freq {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "DAILY",
            Self::Weekly => "WEEKLY",
            Self::Monthly => "MONTHLY",
            Self::Yearly => "YEARLY",
        }
    }

    fn as_rrule(self) -> &'static str {
        match self {
            Self::Daily => "DAILY",
            Self::Weekly => "WEEKLY",
            Self::Monthly => "MONTHLY",
            Self::Yearly => "YEARLY",
        }
    }
}

/// 节假日行为二值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HolidayBehavior {
    Skip,
    Shift,
}

impl HolidayBehavior {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skip => "SKIP",
            Self::Shift => "SHIFT",
        }
    }
}

/// `byday_mask` 位编码常量（ADR 0002）。`MO = 1 << 0` … `SU = 1 << 6`，
/// 共占低 7 位。`MO..SU` 顺序与 RFC 5545 `BYDAY` 字面量顺序一致。
pub mod byday {
    pub const MO: i32 = 1 << 0;
    pub const TU: i32 = 1 << 1;
    pub const WE: i32 = 1 << 2;
    pub const TH: i32 = 1 << 3;
    pub const FR: i32 = 1 << 4;
    pub const SA: i32 = 1 << 5;
    pub const SU: i32 = 1 << 6;

    /// 全部 7 位掩码（`0b0111_1111` = 127）。
    pub const ALL: i32 = MO | TU | WE | TH | FR | SA | SU;

    /// 给定字面量 → 位掩码。未知字面量返回 `None`。
    pub fn mask_of(token: &str) -> Option<i32> {
        match token {
            "MO" => Some(MO),
            "TU" => Some(TU),
            "WE" => Some(WE),
            "TH" => Some(TH),
            "FR" => Some(FR),
            "SA" => Some(SA),
            "SU" => Some(SU),
            _ => None,
        }
    }

    /// 给定位掩码 → 字面量（按 MO→SU 顺序拼接）。掩码为 0 时返空串。
    pub fn tokens_of(mask: i32) -> String {
        const TABLE: [(&str, i32); 7] = [
            ("MO", MO),
            ("TU", TU),
            ("WE", WE),
            ("TH", TH),
            ("FR", FR),
            ("SA", SA),
            ("SU", SU),
        ];
        TABLE
            .iter()
            .filter_map(|(tok, bit)| if mask & *bit != 0 { Some(*tok) } else { None })
            .collect::<Vec<_>>()
            .join(",")
    }
}

/// 结构化字段集合。`bymonthday` / `bymonth` 走 `serde_json::Value`，便于
/// 直接落 `TEXT` JSON 列；`None` 对应 SQL NULL。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredRule {
    pub freq: Freq,
    pub byday_mask: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bymonthday: Option<Vec<i32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bymonth: Option<Vec<i32>>,
    pub byhour: i32,
    pub byminute: i32,
    pub iana_zone: String,
    pub ends: EndsSpec,
    pub holiday_behavior: HolidayBehavior,
}

/// 终止条件二选一。SQL CHECK 用 XOR 直接判。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum EndsSpec {
    /// 持续到 `date`（含）。DATE 字符串,UTC 末日 `23:59:59.999` 视为当日。
    On { date: String },
    /// 出现 `n` 次后停止（`n >= 1`）。
    After { n: i32 },
}

// ---------------------------------------------------------------------------
// 校验 + 派生
// ---------------------------------------------------------------------------

/// 校验结构化字段的内在一致性,然后派生 RRULE 字符串。
///
/// 校验失败返回 `AppError::InvalidArgument`——给科长看的中文消息。`freq`
/// 与 `byday_mask` / `bymonthday` / `bymonth` 的关系：
/// - `Weekly`：`byday_mask` 至少 1 位；`bymonthday` / `bymonth` 必须为
///   `None`（按设计,WEEKLY 不收 BYMONTHDAY / BYMONTH）。
/// - `Monthly`：`bymonthday` 必须给出（至少 1 项,1-31,`0` = 月末）；
///   `bymonth` 必须为 `None`（YEARLY 限定）。
/// - `Yearly`：`bymonth` 必须给出（1-12）；`bymonthday` 可选（若不给,RRULE
///   走默认"该月 1 号",但更稳是要求给出 1-31）。
/// - `Daily`：`bymonthday` / `bymonth` / `byday_mask` 都按 0 / None 收。
///
/// 终止条件由 [`validate_ends`] 单独负责（XOR 二选一 + 范围）。
pub fn derive_rrule(rule: &StructuredRule) -> Result<String> {
    validate_iana_zone(&rule.iana_zone)?;
    validate_byhour(rule.byhour)?;
    validate_byminute(rule.byminute)?;
    validate_byday_mask_for_freq(rule.freq, rule.byday_mask)?;
    validate_bymonthday_for_freq(rule.freq, rule.bymonthday.as_deref())?;
    validate_bymonth_for_freq(rule.freq, rule.bymonth.as_deref())?;
    validate_ends(&rule.ends)?;

    // 各分句之间用 `;` 拼接,RFC 5545 标准格式。
    let mut parts: Vec<String> = Vec::with_capacity(8);
    parts.push(format!("FREQ={}", rule.freq.as_rrule()));

    if rule.freq == Freq::Weekly {
        let tokens = byday::tokens_of(rule.byday_mask);
        // 校验已确保 mask 至少 1 位,故 tokens 非空。
        parts.push(format!("BYDAY={tokens}"));
    }

    if let Some(days) = rule.bymonthday.as_deref() {
        parts.push(format!("BYMONTHDAY={}", encode_bymonthday_list(days)));
    }

    if let Some(months) = rule.bymonth.as_deref() {
        parts.push(format!("BYMONTH={}", encode_int_list(months, "BYMONTH", 1, 12)));
    }

    if rule.byhour != 9 {
        // RRULE 全写出来更便于 sanity check;BYHOUR=9 也写出来仍合法,
        // 这里只在"非默认值"时省略——但为了落库可读性,统一写。
        parts.push(format!("BYHOUR={}", rule.byhour));
    } else {
        parts.push(format!("BYHOUR={}", rule.byhour));
    }
    parts.push(format!("BYMINUTE={}", rule.byminute));

    match &rule.ends {
        EndsSpec::On { date } => {
            // date 形如 "2026-12-31"；RRULE UNTIL 写成 "20261231T000000Z"。
            // UTC 末日 23:59:59.999 视为"包含"——比 wall-clock 多写一
            // 整天反而让 UNTIL 提前一天结束。
            let until = date_to_until(date)?;
            parts.push(format!("UNTIL={until}"));
        }
        EndsSpec::After { n } => {
            parts.push(format!("COUNT={n}"));
        }
    }

    Ok(parts.join(";"))
}

/// 已知集合内的字段一对一翻译（仅本模块用,公开通过 [`derive_rrule`]）。
pub fn parse_rrule_into_structured(text: &str) -> Result<StructuredRule> {
    // RRULE 解析路径仅做 sanity check,不是真理来源——结构化字段才
    // 是真。本函数用来在解析 RRULE 时做一致性比对;若发现不一致,返
    // 回 `Err` 让调用方明确以结构化字段为准。
    let mut freq: Option<Freq> = None;
    let mut byday_mask: i32 = 0;
    let mut bymonthday: Option<Vec<i32>> = None;
    let mut bymonth: Option<Vec<i32>> = None;
    let mut byhour: i32 = 9;
    let mut byminute: i32 = 0;
    let mut ends: Option<EndsSpec> = None;
    for part in text.split(';') {
        let (key, value) = part.split_once('=').ok_or_else(|| {
            AppError::Internal(format!("RRULE 分句形如 KEY=VALUE，收到 {part:?}"))
        })?;
        match key {
            "FREQ" => {
                freq = Some(match value {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    other => {
                        return Err(AppError::Internal(format!(
                            "RRULE FREQ 未知取值：{other:?}"
                        )))
                    }
                });
            }
            "BYDAY" => {
                byday_mask = 0;
                for token in value.split(',') {
                    let bit = byday::mask_of(token).ok_or_else(|| {
                        AppError::Internal(format!("RRULE BYDAY 未知字面量：{token:?}"))
                    })?;
                    byday_mask |= bit;
                }
            }
            "BYMONTHDAY" => {
                let mut v = Vec::new();
                for token in value.split(',') {
                    let parsed: i32 = token.parse().map_err(|_| {
                        AppError::Internal(format!("RRULE BYMONTHDAY 非整数：{token:?}"))
                    })?;
                    // RRULE 的 -1 = 域内的"末"（RFC 5545 BYMONTHDAY 接受
                    // -1..-31），回填到结构化字段时折叠回 0，让业务层只
                    // 见一种表示——`v1` 不收其它负值。
                    v.push(if parsed == -1 { 0 } else { parsed });
                }
                bymonthday = Some(v);
            }
            "BYMONTH" => {
                let mut v = Vec::new();
                for token in value.split(',') {
                    let parsed: i32 = token.parse().map_err(|_| {
                        AppError::Internal(format!("RRULE BYMONTH 非整数：{token:?}"))
                    })?;
                    v.push(parsed);
                }
                bymonth = Some(v);
            }
            "BYHOUR" => {
                byhour = value.parse().map_err(|_| {
                    AppError::Internal(format!("RRULE BYHOUR 非整数：{value:?}"))
                })?;
            }
            "BYMINUTE" => {
                byminute = value.parse().map_err(|_| {
                    AppError::Internal(format!("RRULE BYMINUTE 非整数：{value:?}"))
                })?;
            }
            "UNTIL" => {
                // "20261231T000000Z" → date "2026-12-31"
                if value.len() != 16
                    || !value.ends_with('Z')
                    || value[8..9] != *"T"
                {
                    return Err(AppError::Internal(format!(
                        "RRULE UNTIL 应为 YYYYMMDDTHHMMSSZ，收到 {value:?}"
                    )));
                }
                let date = format!("{}-{}-{}", &value[0..4], &value[4..6], &value[6..8]);
                ends = Some(EndsSpec::On { date });
            }
            "COUNT" => {
                let n: i32 = value
                    .parse()
                    .map_err(|_| AppError::Internal(format!("RRULE COUNT 非整数：{value:?}")))?;
                ends = Some(EndsSpec::After { n });
            }
            other => {
                return Err(AppError::Internal(format!(
                    "RRULE 含未知关键字：{other:?}（v1 子集之外的扩展字段未启用）"
                )));
            }
        }
    }
    let freq = freq.ok_or_else(|| AppError::Internal("RRULE 缺 FREQ".into()))?;
    let ends = ends.ok_or_else(|| AppError::Internal("RRULE 缺 UNTIL 或 COUNT".into()))?;
    Ok(StructuredRule {
        freq,
        byday_mask,
        bymonthday,
        bymonth,
        byhour,
        byminute,
        iana_zone: "Asia/Shanghai".to_string(),
        ends,
        holiday_behavior: HolidayBehavior::Skip,
    })
}

// ---------------------------------------------------------------------------
// 内部校验小函数
// ---------------------------------------------------------------------------

fn validate_iana_zone(zone: &str) -> Result<()> {
    if zone.trim().is_empty() {
        return Err(AppError::invalid("时区不能为空。"));
    }
    // v1 不引 chrono-tz——只允许 Asia/Shanghai,跨时区场景留给 v2。
    if zone != "Asia/Shanghai" {
        return Err(AppError::invalid(
            "本票仅支持 Asia/Shanghai 时区,跨时区场景归后续票。",
        ));
    }
    Ok(())
}

fn validate_byhour(h: i32) -> Result<()> {
    if !(0..=23).contains(&h) {
        return Err(AppError::invalid("小时须在 0–23 之间。"));
    }
    Ok(())
}

fn validate_byminute(m: i32) -> Result<()> {
    if !(0..=59).contains(&m) {
        return Err(AppError::invalid("分钟须在 0–59 之间。"));
    }
    Ok(())
}

fn validate_byday_mask_for_freq(freq: Freq, mask: i32) -> Result<()> {
    if !(0..128).contains(&mask) {
        return Err(AppError::invalid("星期掩码非法。"));
    }
    match freq {
        Freq::Weekly => {
            if mask == 0 {
                return Err(AppError::invalid("每周规则必须至少选一天。"));
            }
        }
        Freq::Daily | Freq::Monthly | Freq::Yearly => {
            if mask != 0 {
                return Err(AppError::invalid("仅每周规则能选星期;其它频率请留空。"));
            }
        }
    }
    Ok(())
}

fn validate_bymonthday_for_freq(freq: Freq, days: Option<&[i32]>) -> Result<()> {
    match freq {
        Freq::Monthly => {
            let Some(days) = days else {
                return Err(AppError::invalid("每月规则必须指定日期。"));
            };
            if days.is_empty() {
                return Err(AppError::invalid("每月规则至少指定一个日期。"));
            }
            for &d in days {
                // 0 = 月末（独占一项时合法,与其它日期混填则拒）;
                // 1-31 = 正常日期;其它一律拒。
                match d {
                    0 => {
                        if days.len() != 1 {
                            return Err(AppError::invalid("「月末」只能单独使用,不能与其它日期混填。"));
                        }
                    }
                    1..=31 => {}
                    _ => {
                        return Err(AppError::invalid("日期须在 1–31 之间或填 0 表示月末。"));
                    }
                }
            }
        }
        Freq::Yearly => {
            // YEARLY 下 bymonthday 可选;若给则校验范围。
            if let Some(days) = days {
                for &d in days {
                    if !(1..=31).contains(&d) {
                        return Err(AppError::invalid("日期须在 1–31 之间(年末规则不支持 0/月末)。"));
                    }
                }
            }
        }
        Freq::Daily | Freq::Weekly => {
            if days.is_some() {
                return Err(AppError::invalid("仅每月/每年规则能指定日期。"));
            }
        }
    }
    Ok(())
}

fn validate_bymonth_for_freq(freq: Freq, months: Option<&[i32]>) -> Result<()> {
    match freq {
        Freq::Yearly => {
            let Some(months) = months else {
                return Err(AppError::invalid("每年规则必须指定月份。"));
            };
            if months.is_empty() {
                return Err(AppError::invalid("每年规则至少指定一个月份。"));
            }
            for &m in months {
                if !(1..=12).contains(&m) {
                    return Err(AppError::invalid("月份须在 1–12 之间。"));
                }
            }
        }
        Freq::Daily | Freq::Weekly | Freq::Monthly => {
            if months.is_some() {
                return Err(AppError::invalid("仅每年规则能指定月份。"));
            }
        }
    }
    Ok(())
}

fn validate_ends(ends: &EndsSpec) -> Result<()> {
    match ends {
        EndsSpec::On { date } => {
            if date.len() != 10 {
                return Err(AppError::invalid("终止日格式应为 YYYY-MM-DD。"));
            }
            // 简单形态校验——具体是否合法交给 chrono::NaiveDate。
            if NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
                return Err(AppError::invalid("终止日格式不对,应形如 2026-12-31。"));
            }
        }
        EndsSpec::After { n } => {
            if *n < 1 {
                return Err(AppError::invalid("出现次数须 ≥ 1。"));
            }
        }
    }
    Ok(())
}

fn encode_bymonthday_list(days: &[i32]) -> String {
    let mut parts = Vec::with_capacity(days.len());
    for &d in days {
        if d == 0 {
            parts.push("-1".to_string());
        } else {
            // 范围 1–31 已在校验时拒掉——这里只跑合法输入。
            parts.push(d.to_string());
        }
    }
    parts.join(",")
}

fn encode_int_list(values: &[i32], _label: &str, lo: i32, hi: i32) -> String {
    let mut parts = Vec::with_capacity(values.len());
    for &v in values {
        // 范围 [lo, hi] 已在校验时拒掉——这里只跑合法输入。
        debug_assert!(v >= lo && v <= hi, "encode_int_list 越界 {v} not in {lo}..={hi}");
        parts.push(v.to_string());
    }
    parts.join(",")
}

fn date_to_until(date: &str) -> Result<String> {
    use chrono::NaiveDate;
    // validate_ends 已保证 date 形如 YYYY-MM-DD 且能 parse;这里
    // `parse_from_str` 仍取 Option<NaiveDate> 而非 `unwrap`——万一有
    // 人误调,得到 `Err` 比 panic 友好。
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|err| {
        AppError::Internal(format!("date_to_until 解析 {date:?} 失败：{err}"))
    })?;
    let stamp = parsed
        .and_hms_opt(23, 59, 59)
        .expect("23:59:59 永远合法");
    Ok(format!("{}T235959Z", stamp.format("%Y%m%d")))
}

// `chrono::NaiveDate` 仅本函数需要——前向声明避免污染顶部 use 列表。
use chrono::NaiveDate;

// ---------------------------------------------------------------------------
// 单元测试：bitmask + 双向一致性 + 边界
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn weekly_rule() -> StructuredRule {
        StructuredRule {
            freq: Freq::Weekly,
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

    fn monthly_rule() -> StructuredRule {
        StructuredRule {
            freq: Freq::Monthly,
            byday_mask: 0,
            bymonthday: Some(vec![1, 15]),
            bymonth: None,
            byhour: 9,
            byminute: 0,
            iana_zone: "Asia/Shanghai".into(),
            ends: EndsSpec::After { n: 24 },
            holiday_behavior: HolidayBehavior::Shift,
        }
    }

    fn monthly_last_day_rule() -> StructuredRule {
        StructuredRule {
            freq: Freq::Monthly,
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

    fn quarterly_rule() -> StructuredRule {
        StructuredRule {
            freq: Freq::Yearly,
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

    // ----- bitmask 编码 -----

    #[test]
    fn bitmask_七位常量与_文档一致() {
        assert_eq!(byday::MO, 1);
        assert_eq!(byday::TU, 2);
        assert_eq!(byday::WE, 4);
        assert_eq!(byday::TH, 8);
        assert_eq!(byday::FR, 16);
        assert_eq!(byday::SA, 32);
        assert_eq!(byday::SU, 64);
        assert_eq!(byday::ALL, 127);
    }

    #[test]
    fn bitmask_mask_of_与_tokens_of_互逆() {
        let cases = [
            ("MO", byday::MO),
            ("MO,WE,FR", byday::MO | byday::WE | byday::FR),
            ("SU", byday::SU),
            ("", 0),
        ];
        for (text, expected_mask) in cases {
            let mut mask = 0;
            if !text.is_empty() {
                for tok in text.split(',') {
                    mask |= byday::mask_of(tok).unwrap();
                }
            }
            assert_eq!(mask, expected_mask, "text={text:?}");
            assert_eq!(byday::tokens_of(expected_mask), text, "roundtrip text={text:?}");
        }
    }

    #[test]
    fn bitmask_mask_of_未知字面量返回_none() {
        assert!(byday::mask_of("XX").is_none());
        assert!(byday::mask_of("mo").is_none()); // 大小写敏感
        assert!(byday::mask_of("").is_none());
    }

    // ----- 派生 RRULE 字符串 -----

    #[test]
    fn weekly_多日_派生_rrule_含_byday_与_until() {
        let text = derive_rrule(&weekly_rule()).expect("合法规则应派生");
        assert_eq!(
            text,
            "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=0;UNTIL=20261231T235959Z"
        );
    }

    #[test]
    fn monthly_1_15_派生_rrule_含_bymonthday_与_count() {
        let text = derive_rrule(&monthly_rule()).expect("合法规则应派生");
        assert_eq!(
            text,
            "FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0;COUNT=24"
        );
    }

    #[test]
    fn monthly_月末_0_派生_rrule_bymonthday_负_1() {
        let text = derive_rrule(&monthly_last_day_rule()).expect("合法规则应派生");
        assert_eq!(
            text,
            "FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=16;BYMINUTE=30;UNTIL=20270630T235959Z"
        );
    }

    #[test]
    fn quarterly_1_4_7_10_派生_rrule_含_bymonth_与_bymonthday() {
        let text = derive_rrule(&quarterly_rule()).expect("合法规则应派生");
        assert_eq!(
            text,
            "FREQ=YEARLY;BYMONTHDAY=1;BYMONTH=1,4,7,10;BYHOUR=10;BYMINUTE=0;UNTIL=20300101T235959Z"
        );
    }

    // ----- 双向一致 -----

    #[test]
    fn 四类规则_结构化字段_与_派生_rrule_互逆() {
        // 派生 → 解析回来 → 结构化字段应一致。
        for rule in [
            weekly_rule(),
            monthly_rule(),
            monthly_last_day_rule(),
            quarterly_rule(),
        ] {
            let text = derive_rrule(&rule).expect("派生");
            let parsed = parse_rrule_into_structured(&text).expect("解析");
            // 解析路径不携带 holiday_behavior/iana_zone（RRULE 不含）,
            // 这两列单独断言:
            assert_eq!(parsed.freq, rule.freq, "freq 不一致");
            assert_eq!(parsed.byday_mask, rule.byday_mask, "byday_mask 不一致");
            assert_eq!(parsed.bymonthday, rule.bymonthday, "bymonthday 不一致");
            assert_eq!(parsed.bymonth, rule.bymonth, "bymonth 不一致");
            assert_eq!(parsed.byhour, rule.byhour, "byhour 不一致");
            assert_eq!(parsed.byminute, rule.byminute, "byminute 不一致");
            assert_eq!(parsed.ends, rule.ends, "ends 不一致");
        }
    }

    // ----- 校验拒绝 -----

    #[test]
    fn weekly_缺_day_被拒() {
        let mut rule = weekly_rule();
        rule.byday_mask = 0;
        let err = derive_rrule(&rule).expect_err("0 位掩码应被拒");
        assert!(err.message().contains("每周"));
    }

    #[test]
    fn monthly_缺日期_被拒() {
        let mut rule = monthly_rule();
        rule.bymonthday = None;
        let err = derive_rrule(&rule).expect_err("MONTHLY 无日期应被拒");
        assert!(err.message().contains("日期"));
    }

    #[test]
    fn monthly_0_与_其它日期混填_被拒() {
        let mut rule = monthly_rule();
        rule.bymonthday = Some(vec![0, 1]);
        let err = derive_rrule(&rule).expect_err("混填应被拒");
        assert!(err.message().contains("月末"));
    }

    #[test]
    fn yearly_缺月份_被拒() {
        let mut rule = quarterly_rule();
        rule.bymonth = None;
        let err = derive_rrule(&rule).expect_err("YEARLY 无月份应被拒");
        assert!(err.message().contains("月份"));
    }

    #[test]
    fn ends_非法日期被拒() {
        let mut rule = weekly_rule();
        rule.ends = EndsSpec::On {
            date: "2026-13-40".into(),
        };
        let err = derive_rrule(&rule).expect_err("非法日期应被拒");
        assert!(err.message().contains("终止日"));
    }

    #[test]
    fn ends_after_0_被拒() {
        let mut rule = weekly_rule();
        rule.ends = EndsSpec::After { n: 0 };
        let err = derive_rrule(&rule).expect_err("0 次应被拒");
        assert!(err.message().contains("次数"));
    }

    #[test]
    fn byhour_越界被拒() {
        let mut rule = weekly_rule();
        rule.byhour = 24;
        let err = derive_rrule(&rule).expect_err("24 时应被拒");
        assert!(err.message().contains("小时"));
    }

    #[test]
    fn byminute_越界被拒() {
        let mut rule = weekly_rule();
        rule.byminute = 60;
        let err = derive_rrule(&rule).expect_err("60 分应被拒");
        assert!(err.message().contains("分钟"));
    }

    #[test]
    fn 时区非_asia_shanghai_被拒() {
        let mut rule = weekly_rule();
        rule.iana_zone = "America/New_York".into();
        let err = derive_rrule(&rule).expect_err("非本票时区应被拒");
        assert!(err.message().contains("Asia/Shanghai"));
    }

    #[test]
    fn daily_规则带_bymonthday_被拒() {
        let rule = StructuredRule {
            freq: Freq::Daily,
            byday_mask: 0,
            bymonthday: Some(vec![1]),
            bymonth: None,
            byhour: 9,
            byminute: 0,
            iana_zone: "Asia/Shanghai".into(),
            ends: EndsSpec::After { n: 7 },
            holiday_behavior: HolidayBehavior::Skip,
        };
        let err = derive_rrule(&rule).expect_err("DAILY 不应收 bymonthday");
        assert!(err.message().contains("日期"));
    }

    /// 修复 Standards review finding: 旧实现下,out-of-range 值(负数 / > 31)
    /// 会从 `validate_bymonthday_for_freq` 静默通过,然后让 `encode_*` 抛
    /// 内部断言。匹配错误条件（negative,32,50）应直接被拒为 INVALID_ARGUMENT。
    #[test]
    fn monthly_bymonthday_越界值被拒() {
        for bad in [-1, 32, 50, -100] {
            let rule = StructuredRule {
                freq: Freq::Monthly,
                byday_mask: 0,
                bymonthday: Some(vec![bad]),
                bymonth: None,
                byhour: 9,
                byminute: 0,
                iana_zone: "Asia/Shanghai".into(),
                ends: EndsSpec::After { n: 1 },
                holiday_behavior: HolidayBehavior::Skip,
            };
            let err = derive_rrule(&rule).expect_err("越界应被拒");
            assert_eq!(err.code(), "INVALID_ARGUMENT", "bad={bad}");
            assert!(err.message().contains("1"), "bad={bad}: {}", err.message());
        }
    }
}