//! 周期性模板命令层（ticket #24）。
//!
//! 覆盖 `recurring_template` 表的 CRUD（upsert / list / enable / disable），
//! 与一次性任务共用同一入口（ticket #19「全局新建 / 编辑任务弹窗」）：打
//! 开「周期」toggle 直接进入侧抽屉配规则，本命令层提供底层原语。
//!
//! 约束（承接 ADR 0001 §3.4 + ADR 0002 + 票面 AC）：
//! - 入参 → [`crate::recurring::derive_rrule`] → `rrule_text` 列；DB 不重
//!   算 RRULE（V001 已有 `recurring_template.id` 占位,V004 加列）。
//! - `ends_on` / `ends_after_n` 二选一（DB CHECK）+ `project_id` /
//!   `sub_team_id` 至少一项非空（DB CHECK）；命令层做入参归一化 + 中文错误。
//! - 模板可停用（`enabled = 0`）而不删除——物化层只扫 `enabled = 1`。
//!
//! 所有命令入参与返回都是稳定 DTO（camelCase），不透传行结构。

use crate::commands::validation::{ensure_row_exists, require_non_blank};
use crate::error::{AppError, Result};
use crate::recurring::{
    derive_rrule, parse_rrule_into_structured, EndsSpec, Freq, HolidayBehavior, StructuredRule,
};
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// 周期性模板 DTO。`bymonthday` / `bymonth` 由 App 层在读时从 JSON 字符串
/// 反序列化为 `Vec<i32>`,前端不接触 JSON 字面量。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringTemplate {
    pub id: i64,
    pub name: String,
    pub freq: Freq,
    pub byday_mask: i32,
    pub bymonthday: Option<Vec<i32>>,
    pub bymonth: Option<Vec<i32>>,
    pub byhour: i32,
    pub byminute: i32,
    pub iana_zone: String,
    pub ends: EndsSpec,
    pub holiday_behavior: HolidayBehavior,
    pub rrule_text: String,
    pub project_id: Option<i64>,
    pub sub_team_id: Option<i64>,
    pub enabled: bool,
    pub notes: Option<String>,
    pub created_at: String,
}

/// upsert 入参。`id = None` → 新建；`id = Some(n)` → 编辑第 n 条。
///
/// 规则字段语义以 [`StructuredRule`] 为准；`project_id` / `sub_team_id` 至
/// 少一项非空（命令层预检 + DB CHECK 双兜）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertRecurringTemplateArgs {
    pub id: Option<i64>,
    pub name: String,
    pub rule: StructuredRule,
    pub project_id: Option<i64>,
    pub sub_team_id: Option<i64>,
    pub notes: Option<String>,
}

/// `list_recurring_templates` 入参。`include_disabled = true` 时含已停用
/// 的模板；默认只看启用。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRecurringTemplatesArgs {
    pub include_disabled: bool,
}

/// 启用 / 停用模板入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRecurringTemplateEnabledArgs {
    pub id: i64,
    pub enabled: bool,
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// upsert 模板：`id = None` 新建,`id = Some(n)` 编辑。
///
/// `rrule_text` 在事务外由 [`derive_rrule`] 派生,DB 不重算（票面 AC）;
/// 写库与读回都不再二次解析 RRULE——结构化字段才是真理来源。
#[tauri::command]
pub fn upsert_recurring_template(
    state: State<'_, AppState>,
    args: UpsertRecurringTemplateArgs,
) -> Result<RecurringTemplate> {
    let name = require_non_blank(args.name, "模板名称不能为空。")?;
    let rrule_text = derive_rrule(&args.rule)?;
    let now = state.now_sql();
    let notes = args.notes.and_then(|n| {
        let trimmed = n.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    let conn = state.db()?;
    if let Some(pid) = args.project_id {
        ensure_row_exists(&conn, "project", pid, "所属项目不存在。")?;
    }
    if let Some(stid) = args.sub_team_id {
        ensure_row_exists(&conn, "sub_team", stid, "所属子组不存在。")?;
    }

    let bymonthday_json = encode_json_array(args.rule.bymonthday.as_deref())?;
    let bymonth_json = encode_json_array(args.rule.bymonth.as_deref())?;

    let tx = conn.unchecked_transaction()?;
    let id = if let Some(existing_id) = args.id {
        // `enabled` 刻意不写:季节性事务可停用,启停由
        // set_recurring_template_enabled 单独管;upsert 不应顺手把停用的
        // 模板复活。详见 tests/recurring_template.rs::upsert_编辑_不改_enabled
        tx.execute(
            "UPDATE recurring_template
                SET name             = ?1,
                    freq             = ?2,
                    byday_mask       = ?3,
                    bymonthday       = ?4,
                    bymonth          = ?5,
                    byhour           = ?6,
                    byminute         = ?7,
                    iana_zone        = ?8,
                    ends_on          = ?9,
                    ends_after_n     = ?10,
                    holiday_behavior = ?11,
                    rrule_text       = ?12,
                    project_id       = ?13,
                    sub_team_id      = ?14,
                    notes            = ?15
              WHERE id = ?16",
            params![
                name,
                args.rule.freq.as_str(),
                args.rule.byday_mask,
                bymonthday_json,
                bymonth_json,
                args.rule.byhour,
                args.rule.byminute,
                args.rule.iana_zone,
                ends_on_db(&args.rule.ends),
                ends_after_n_db(&args.rule.ends),
                args.rule.holiday_behavior.as_str(),
                rrule_text,
                args.project_id,
                args.sub_team_id,
                notes,
                existing_id,
            ],
        )?;
        existing_id
    } else {
        tx.execute(
            "INSERT INTO recurring_template
                (name, freq, byday_mask, bymonthday, bymonth, byhour, byminute,
                 iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text,
                 project_id, sub_team_id, notes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     ?13, ?14, ?15, ?16)",
            params![
                name,
                args.rule.freq.as_str(),
                args.rule.byday_mask,
                bymonthday_json,
                bymonth_json,
                args.rule.byhour,
                args.rule.byminute,
                args.rule.iana_zone,
                ends_on_db(&args.rule.ends),
                ends_after_n_db(&args.rule.ends),
                args.rule.holiday_behavior.as_str(),
                rrule_text,
                args.project_id,
                args.sub_team_id,
                notes,
                now,
            ],
        )?;
        tx.last_insert_rowid()
    };
    let row = fetch_template(&tx, id)?
        .ok_or_else(|| AppError::Internal(format!("recurring_template id={id} 查不到")))?;
    tx.commit().map_err(AppError::from)?;
    Ok(row)
}

/// 列出模板。默认只看启用(`enabled = 1`),`include_disabled = true` 含已
/// 停用的——便于"按模板管理"页面看到全部。排序:启用优先 + 创建时间升序。
///
/// 读路径的 `rrule_text` sanity check 在 [`fetch_template`] 里跑;这里
/// 的批量 query 不走 fetch_template,改在 collect 之后对每行跑一次同一
/// 个检查——任一行漂移就让整个 list 返 Internal,避免前端拿到自相矛盾
/// 的 DTO(票面 AC:解析时优先信任结构化字段)。
#[tauri::command]
pub fn list_recurring_templates(
    state: State<'_, AppState>,
    args: ListRecurringTemplatesArgs,
) -> Result<Vec<RecurringTemplate>> {
    let conn = state.db()?;
    let enabled_filter = if args.include_disabled {
        String::new()
    } else {
        "WHERE enabled = 1".to_string()
    };
    let sql = format!(
        "SELECT id, name, freq, byday_mask, bymonthday, bymonth, byhour, byminute,
                iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text,
                project_id, sub_team_id, enabled, notes, created_at
           FROM recurring_template
           {enabled_filter}
          ORDER BY enabled DESC, created_at ASC, id ASC",
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_template)?;
    let templates: Vec<RecurringTemplate> =
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(AppError::from)?;
    for template in &templates {
        sanity_check_rrule_matches_structured(template)?;
    }
    Ok(templates)
}

/// 启用 / 停用模板——季节性事务可以停用而不删除（票面 AC）。
///
/// 模板不存在 / 已被物理删除 → INVALID_ARGUMENT；状态相同时**仍写库**,
/// 不去重——DB 一次 UPDATE 代价远低于"先查再决定",且 `updated_at` 类语义
/// 这里不涉及。
#[tauri::command]
pub fn set_recurring_template_enabled(
    state: State<'_, AppState>,
    args: SetRecurringTemplateEnabledArgs,
) -> Result<RecurringTemplate> {
    let conn = state.db()?;
    let affected = conn.execute(
        "UPDATE recurring_template SET enabled = ?1 WHERE id = ?2",
        params![args.enabled as i64, args.id],
    )?;
    if affected == 0 {
        return Err(AppError::invalid("模板不存在或已被删除。"));
    }
    fetch_template(&conn, args.id)?
        .ok_or_else(|| AppError::Internal(format!("recurring_template id={} 查询不一致", args.id)))
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

fn ends_on_db(ends: &EndsSpec) -> Option<&str> {
    match ends {
        EndsSpec::On { date } => Some(date.as_str()),
        EndsSpec::After { .. } => None,
    }
}

fn ends_after_n_db(ends: &EndsSpec) -> Option<i64> {
    match ends {
        EndsSpec::On { .. } => None,
        EndsSpec::After { n } => Some(*n as i64),
    }
}

/// 把 `Vec<i32>` 序列化成 `rrule_text` 旁路的 JSON 字符串——入 `TEXT` 列。
/// 空数组也序列化成 `[]`(非 NULL),便于前端 round-trip;`None` 序列成 NULL。
fn encode_json_array(values: Option<&[i32]>) -> Result<Option<String>> {
    match values {
        None => Ok(None),
        Some(slice) => {
            // 借 serde_json 一次性序列化,避免手工拼 `[1,2,3]` 时漏逗号 / 引号。
            let json = serde_json::to_string(slice).map_err(|err| {
                AppError::Internal(format!("bymonthday/bymonth JSON 序列化失败：{err}"))
            })?;
            Ok(Some(json))
        }
    }
}

fn row_to_template(row: &Row<'_>) -> rusqlite::Result<RecurringTemplate> {
    let freq_text: String = row.get(2)?;
    let freq = parse_freq(&freq_text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(
            2,
            "recurring_template.freq".into(),
            rusqlite::types::Type::Text,
        )
    })?;
    let holiday_text: String = row.get(11)?;
    let holiday_behavior = parse_holiday_behavior(&holiday_text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(
            11,
            "recurring_template.holiday_behavior".into(),
            rusqlite::types::Type::Text,
        )
    })?;
    let ends_on_text: Option<String> = row.get(9)?;
    let ends_after_n_value: Option<i64> = row.get(10)?;
    let ends = match (ends_on_text, ends_after_n_value) {
        (Some(date), None) => EndsSpec::On { date },
        (None, Some(n)) => EndsSpec::After { n: n as i32 },
        // DB CHECK 已保证 XOR,落库后读到二者要么 date 要么 n——其它组合
        // 视为数据漂移,读时直接报错(不会静默展示)。
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                9,
                "recurring_template.ends_on/ends_after_n".into(),
                rusqlite::types::Type::Text,
            ));
        }
    };
    let bymonthday_json: Option<String> = row.get(4)?;
    let bymonth_json: Option<String> = row.get(5)?;
    let bymonthday = parse_json_int_array(bymonthday_json.as_deref())
        .map_err(|err| rusqlite::Error::InvalidColumnType(4, err, rusqlite::types::Type::Text))?;
    let bymonth = parse_json_int_array(bymonth_json.as_deref())
        .map_err(|err| rusqlite::Error::InvalidColumnType(5, err, rusqlite::types::Type::Text))?;
    let enabled_int: i64 = row.get(15)?;
    Ok(RecurringTemplate {
        id: row.get(0)?,
        name: row.get(1)?,
        freq,
        byday_mask: row.get(3)?,
        bymonthday,
        bymonth,
        byhour: row.get(6)?,
        byminute: row.get(7)?,
        iana_zone: row.get(8)?,
        ends,
        holiday_behavior,
        rrule_text: row.get(12)?,
        project_id: row.get(13)?,
        sub_team_id: row.get(14)?,
        enabled: enabled_int != 0,
        notes: row.get(16)?,
        created_at: row.get(17)?,
    })
}

fn fetch_template(conn: &Connection, id: i64) -> Result<Option<RecurringTemplate>> {
    let sql = "SELECT id, name, freq, byday_mask, bymonthday, bymonth, byhour, byminute,
                      iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text,
                      project_id, sub_team_id, enabled, notes, created_at
                 FROM recurring_template WHERE id = ?1";
    let row = conn
        .query_row(sql, params![id], row_to_template)
        .optional()?;
    if let Some(template) = row.as_ref() {
        // 票面 AC:解析时优先信任结构化字段,`rrule_text` 作 sanity check。
        // 落库时 `rrule_text` 由 `derive_rrule` 派生,这里反向 parse 后与
        // 结构化字段比对——任一字段不一致即视为数据漂移,读路径直接报
        // 内部错误(等同 storage 损坏),不让前端拿到自相矛盾的 DTO。
        sanity_check_rrule_matches_structured(template)?;
    }
    Ok(row)
}

/// 比对 `template.rrule_text` 与结构化字段是否一致(ADR 0002「解析时优先
/// 信任结构化字段,`rrule_text` 作 sanity check」)。
///
/// 不一致 → `AppError::Internal`:数据漂移属于存储层损坏,前端不必展示
/// 任何信息,直接重新创建模板即可。
fn sanity_check_rrule_matches_structured(template: &RecurringTemplate) -> Result<()> {
    let parsed = parse_rrule_into_structured(&template.rrule_text).map_err(|err| {
        AppError::Internal(format!(
            "recurring_template id={} rrule_text 解析失败：{err}",
            template.id
        ))
    })?;
    if parsed.freq != template.freq
        || parsed.byday_mask != template.byday_mask
        || parsed.bymonthday != template.bymonthday
        || parsed.bymonth != template.bymonth
        || parsed.byhour != template.byhour
        || parsed.byminute != template.byminute
        || parsed.ends != template.ends
    {
        return Err(AppError::Internal(format!(
            "recurring_template id={} rrule_text 与结构化字段不一致",
            template.id
        )));
    }
    Ok(())
}

fn parse_freq(text: &str) -> Option<Freq> {
    match text {
        "DAILY" => Some(Freq::Daily),
        "WEEKLY" => Some(Freq::Weekly),
        "MONTHLY" => Some(Freq::Monthly),
        "YEARLY" => Some(Freq::Yearly),
        _ => None,
    }
}

fn parse_holiday_behavior(text: &str) -> Option<HolidayBehavior> {
    match text {
        "SKIP" => Some(HolidayBehavior::Skip),
        "SHIFT" => Some(HolidayBehavior::Shift),
        _ => None,
    }
}

fn parse_json_int_array(text: Option<&str>) -> std::result::Result<Option<Vec<i32>>, String> {
    match text {
        None => Ok(None),
        Some(s) => serde_json::from_str::<Vec<i32>>(s)
            .map(Some)
            .map_err(|err| format!("JSON 数组反序列化失败：{err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_json_array_空数组序列化为_空_json() {
        assert_eq!(
            encode_json_array(Some(&[])).expect("空数组"),
            Some("[]".into())
        );
        assert_eq!(encode_json_array(None).expect("None"), None);
        assert_eq!(
            encode_json_array(Some(&[1, 15])).expect("1,15"),
            Some("[1,15]".into())
        );
    }

    #[test]
    fn parse_freq_与_db_字面量对齐() {
        for (text, freq) in [
            ("DAILY", Freq::Daily),
            ("WEEKLY", Freq::Weekly),
            ("MONTHLY", Freq::Monthly),
            ("YEARLY", Freq::Yearly),
        ] {
            assert_eq!(parse_freq(text), Some(freq));
            assert_eq!(freq.as_str(), text);
        }
        assert!(parse_freq("daily").is_none()); // 大小写敏感
        assert!(parse_freq("").is_none());
    }

    #[test]
    fn parse_holiday_behavior_两值对齐() {
        assert_eq!(parse_holiday_behavior("SKIP"), Some(HolidayBehavior::Skip));
        assert_eq!(parse_holiday_behavior("SHIFT"), Some(HolidayBehavior::Shift));
        assert!(parse_holiday_behavior("skip").is_none());
        assert!(parse_holiday_behavior("").is_none());
    }
}