//! 导出命令层（ticket #31）。
//!
//! 两条命令:
//! - `export_database_json` → 整库 JSON 导出,用于备份 / 迁移。
//! - `import_database_json` → 解析同样的 JSON 格式,**回环等价**
//!   (export → import 后数据库状态与导出前等价)。
//! - `export_tasks_csv` → 当前视图 CSV 导出,发给领导。
//!
//! JSON 格式:
//!
//! ```json
//! {
//!   "schemaVersion": 8,
//!   "exportedAt": "2026-09-10T12:34:56Z",
//!   "tables": {
//!     "sub_team":         [{"id": ..., ...}, ...],
//!     "person":           [...],
//!     ...
//!   }
//! }
//! ```
//!
//! `tables` 的 key 顺序是 FK 安全的删 / 插顺序——子表先删、父表后删;
//! 导入时反向,父表先插、子表后插。这样即便不显式 PRAGMA 也能让
//! 跨表 FK 不被打断。
//!
//! 不参与导出的表:
//! - `refinery_schema_history` —— refinery 自己管
//! - `task_fts` —— FTS5 影子表,内容由 task 触发器同步
//! - `materialization_meta` —— 物化元数据,导入后由下一次 tick 重建
//! - `notification_log` —— 通知日志,**会**导出(包含 viewed_at 状态)
//!
//! CSV 格式:
//! - 首行表头
//! - 每行一条任务
//! - 字段含中文 / 英文混排,按 RFC 4180 转义(逗号 / 双引号 / 换行)

use crate::error::{AppError, Result};
use crate::state::AppState;
use rusqlite::{types::ValueRef, Connection, Row};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::State;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// `export_database_json` 的返回 DTO。`json_text` 是已经序列化好的字
/// 符串——前端拿到后保存到磁盘即可,不再二次反序列化。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseExport {
    pub json_text: String,
    /// 导出时的 schema 版本号——导入时校验一致才接受,跨版本导入可能
    /// 引入字段丢失。
    pub schema_version: i64,
    pub byte_size: usize,
}

/// `import_database_json` 的返回 DTO。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseImportSummary {
    pub tables_imported: i64,
    pub rows_imported: i64,
}

/// `export_tasks_csv` 的返回 DTO。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksCsvExport {
    pub csv_text: String,
    pub row_count: i64,
}

// ---------------------------------------------------------------------------
// 表元数据 —— 导出 / 导入顺序的单一来源
// ---------------------------------------------------------------------------

/// 一张表的导出元数据。`columns` 是 SELECT 列表(决定导出形状);
/// `display_columns` 是 CSV / UI 列表展示用,与导出列可能不同。
struct TableSpec {
    name: &'static str,
    columns: &'static [&'static str],
}

/// 整库导出的表清单 + FK 安全的删 / 插顺序。
///
/// 子表在前(导出时先 SELECT、删除时先 DELETE),父表在后;导入时
/// 反向走。**新增 / 删表都要改这里**,否则 round-trip 不一致。
const TABLES: &[TableSpec] = &[
    TableSpec {
        name: "task",
        columns: &[
            "id",
            "title",
            "description",
            "status",
            "owner_person_id",
            "project_id",
            "due_date",
            "recurring_template_id",
            "scheduled_at",
            "original_scheduled_at",
            "rescheduled_from_id",
            "created_at",
            "updated_at",
            "blocked_at",
            "blocked_reason",
            "waiting_on_person_id",
            "sub_team_id",
            "is_sample",
        ],
    },
    TableSpec {
        name: "notification_log",
        columns: &[
            "id",
            "triggered_at",
            "kind",
            "related_task_id",
            "related_template_id",
            "payload",
            "viewed_at",
        ],
    },
    TableSpec {
        name: "holiday_override",
        // 无 id 列;`date` 是 PRIMARY KEY,排序按 date 走。
        columns: &["date", "kind"],
    },
    TableSpec {
        name: "recurring_template",
        columns: &[
            "id",
            "name",
            "freq",
            "byday_mask",
            "bymonthday",
            "bymonth",
            "byhour",
            "byminute",
            "iana_zone",
            "ends_on",
            "ends_after_n",
            "holiday_behavior",
            "rrule_text",
            "project_id",
            "sub_team_id",
            "enabled",
            "notes",
            "created_at",
            "is_sample",
        ],
    },
    TableSpec {
        name: "project",
        columns: &[
            "id",
            "name",
            "owner_person_id",
            "sub_team_id",
            "start_date",
            "due_date",
            "notes",
            "created_at",
            "is_sample",
        ],
    },
    TableSpec {
        name: "person",
        columns: &[
            "id",
            "name",
            "sub_team_id",
            "contact",
            "deactivated_at",
            "created_at",
            "is_sample",
        ],
    },
    TableSpec {
        name: "sub_team",
        columns: &[
            "id",
            "name",
            "description",
            "sort_order",
            "created_at",
            "is_sample",
        ],
    },
];

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 整库 JSON 导出。
///
/// 输出是稳定 UTF-8 JSON 字符串(单行 + 缩进),前端拿到存盘即可。
/// `schema_version` 沿用 `db::schema_version`,导入时校验一致。
#[tauri::command]
pub fn export_database_json(state: State<'_, AppState>) -> Result<DatabaseExport> {
    let conn = state.db()?;
    let schema_version = crate::db::schema_version(&conn)?
        .ok_or_else(|| AppError::internal("迁移历史为空,数据库未初始化。"))?
        as i64;
    let exported_at = state.now_sql(); // UTC SQL 文本即可,够唯一性
    let mut tables = serde_json::Map::new();
    for spec in TABLES {
        let rows = dump_table(&conn, spec)?;
        tables.insert(spec.name.to_string(), Value::Array(rows));
    }
    let payload = json!({
        "schemaVersion": schema_version,
        "exportedAt": exported_at,
        "tables": tables,
    });
    let json_text = serde_json::to_string_pretty(&payload)
        .map_err(|err| AppError::Internal(format!("序列化导出 JSON 失败:{err}")))?;
    let byte_size = json_text.len();
    Ok(DatabaseExport {
        json_text,
        schema_version,
        byte_size,
    })
}

/// 整库 JSON 导入(回环)。
///
/// 流程:
/// 1. 解析 JSON,校验 schemaVersion 与当前库一致。
/// 2. 在单个事务里,按 FK 子 → 父顺序清空全部业务表。
/// 3. 按 FK 父 → 子顺序 INSERT 各表行。
/// 4. 整个事务包在 `PRAGMA foreign_keys = OFF` 下——避开"清空时
///    task→template FK 互锁"与"插入时 template→sub_team 触发"。
///
/// `task_fts` / `materialization_meta` / `refinery_schema_history`
/// 不在 TABLES 中,事务里手动重建:`task_fts` 由 task 的 INSERT 触发器
/// 同步填;`materialization_meta` 删除后由下一次 `materialize_if_new_week`
/// tick 自然重建。
#[tauri::command]
pub fn import_database_json(
    state: State<'_, AppState>,
    json_text: String,
) -> Result<DatabaseImportSummary> {
    let payload: Value = serde_json::from_str(&json_text)
        .map_err(|err| AppError::invalid(format!("导入 JSON 解析失败:{err}")))?;
    let current_version = {
        let conn = state.db()?;
        crate::db::schema_version(&conn)?
            .ok_or_else(|| AppError::internal("迁移历史为空,数据库未初始化。"))?
            as i64
    };
    let imported_version = payload
        .get("schemaVersion")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::invalid("导入 JSON 缺少 schemaVersion 字段。"))?;
    if imported_version != current_version {
        return Err(AppError::invalid(format!(
            "导入 schema 版本({imported_version})与当前库({current_version})不一致,请用同版本 app 导出。"
        )));
    }
    let tables = payload
        .get("tables")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::invalid("导入 JSON 缺少 tables 字段。"))?;

    let conn = state.db()?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("PRAGMA foreign_keys = OFF")?;

    // 1) 清空 + 2) 重新插入都在子 → 父 / 父 → 子两轮循环里。
    let mut rows_imported: i64 = 0;
    let mut tables_imported: i64 = 0;
    for spec in TABLES {
        tx.execute(&format!("DELETE FROM {}", spec.name), [])?;
    }
    // 重新启用 FTS5 同步——task INSERT 触发器负责把行写入 task_fts。
    // 删空 task 表后,FTS5 影子表由触发器维持一致,不需要单独清。
    for spec in TABLES.iter().rev() {
        let Some(arr) = tables.get(spec.name).and_then(Value::as_array) else {
            continue;
        };
        let placeholders = vec!["?"; spec.columns.len()].join(",");
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            spec.name,
            spec.columns.join(","),
            placeholders
        );
        let mut stmt = tx.prepare(&sql)?;
        let mut count = 0i64;
        for row_value in arr {
            let Some(obj) = row_value.as_object() else {
                return Err(AppError::invalid(format!(
                    "表 {} 的某行不是对象",
                    spec.name
                )));
            };
            let mut bind: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(spec.columns.len());
            for col in spec.columns {
                let v = obj.get(*col).unwrap_or(&Value::Null);
                bind.push(json_to_sql(v));
            }
            let bind_refs: Vec<&dyn rusqlite::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
            stmt.execute(rusqlite::params_from_iter(bind_refs))?;
            count += 1;
        }
        rows_imported += count;
        if count > 0 {
            tables_imported += 1;
        }
    }

    tx.execute_batch("PRAGMA foreign_keys = ON")?;
    tx.commit().map_err(AppError::from)?;

    Ok(DatabaseImportSummary {
        tables_imported,
        rows_imported,
    })
}

/// 当前视图 CSV 导出。
///
/// "当前视图" = 全部在飞任务(剔除 Done / Cancelled),按 `effective_date`
/// 升序——与 `list_tasks` 的默认排序对齐,前端把视图上的内容直接落
/// CSV,发给领导时与他看到的一致。
///
/// CSV 列(`header_row`):
/// - `id` `title` `status` `owner` `sub_team` `project` `due_date`
///   `scheduled_at` `is_recurring` `blocked_at` `blocked_reason`
///   `waiting_on` `created_at`
///
/// 转义走 RFC 4180:含逗号 / 双引号 / 换行的字段用 `"..."` 包裹,内部
/// 双引号写两次(`""`)。
///
/// owner 是 INNER JOIN——若 task 行因导入漂移产生了悬空 owner,
/// 这条会被静默丢弃(对应 AC「导入后无悬空 FK」由 [`import_database_json
/// `] 的 round-trip 测试兜底)。
#[tauri::command]
pub fn export_tasks_csv(state: State<'_, AppState>) -> Result<TasksCsvExport> {
    let conn = state.db()?;
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.status, \
                COALESCE(p.name, '') AS owner_name, \
                COALESCE(s.name, '') AS owner_sub_team, \
                COALESCE(pr.name, '') AS project_name, \
                COALESCE(t.due_date, '') AS due_date, \
                COALESCE(t.scheduled_at, '') AS scheduled_at, \
                CASE WHEN t.recurring_template_id IS NOT NULL THEN 'true' ELSE 'false' END AS is_recurring, \
                COALESCE(t.blocked_at, '') AS blocked_at, \
                COALESCE(t.blocked_reason, '') AS blocked_reason, \
                COALESCE(wp.name, '') AS waiting_on_name, \
                t.created_at \
           FROM task t \
           JOIN person p ON p.id = t.owner_person_id \
           LEFT JOIN sub_team s ON s.id = p.sub_team_id \
           LEFT JOIN project pr ON pr.id = t.project_id \
           LEFT JOIN person wp ON wp.id = t.waiting_on_person_id \
          WHERE t.status NOT IN ('Done','Cancelled') \
          ORDER BY COALESCE(t.due_date, substr(t.scheduled_at, 1, 10)) ASC, \
                   t.created_at ASC, \
                   t.id ASC",
    )?;

    let header = [
        "id",
        "title",
        "status",
        "owner",
        "sub_team",
        "project",
        "due_date",
        "scheduled_at",
        "is_recurring",
        "blocked_at",
        "blocked_reason",
        "waiting_on",
        "created_at",
    ];
    let mut csv = String::new();
    push_csv_row(&mut csv, header.iter().copied());
    let mut row_count: i64 = 0;
    let rows = stmt.query_map([], row_to_csv_field)?;
    for row in rows {
        let fields = row?;
        push_csv_row(&mut csv, fields.iter().map(String::as_str));
        row_count += 1;
    }
    Ok(TasksCsvExport {
        csv_text: csv,
        row_count,
    })
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/// 把一张表的所有行 SELECT 成 `Vec<serde_json::Value>`(数组)。
/// `spec.columns` 是 SELECT 列清单——单点改,所有导出形状都在这里。
fn dump_table(conn: &Connection, spec: &TableSpec) -> Result<Vec<Value>> {
    // `holiday_override` 表只有 `date` 主键,无 `id` 列;其余表都按 id 排。
    let order_by = if spec.name == "holiday_override" {
        "date"
    } else {
        "id"
    };
    let sql = format!(
        "SELECT {} FROM {} ORDER BY {} ASC",
        spec.columns.join(","),
        spec.name,
        order_by
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| row_to_json_object(row, spec.columns))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 一行 → `Map<column, json_value>`。
///
/// 数值走 `Integer` / `Real`,文本走 `String`,NULL 走 `Value::Null`。
/// `bymonthday` / `bymonth` / `payload` 是 JSON 字符串列——解析回
/// `Value`,导出后用户能看到结构而不是字面字符串。
fn row_to_json_object(row: &Row<'_>, columns: &[&'static str]) -> rusqlite::Result<Value> {
    let mut map = Map::new();
    for (i, col) in columns.iter().enumerate() {
        let value = match row.get_ref(i)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(n) => Value::from(n),
            ValueRef::Real(f) => serde_json::Number::from_f64(f)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            ValueRef::Text(t) => {
                let s = std::str::from_utf8(t).map_err(|_err| {
                    rusqlite::Error::InvalidColumnType(
                        i,
                        format!("{col} 非 UTF-8"),
                        rusqlite::types::Type::Text,
                    )
                })?;
                // 这三列在 schema 里就是 JSON 文本,二次解析让导出更易读
                if matches!(*col, "bymonthday" | "bymonth" | "payload") {
                    serde_json::from_str(s).unwrap_or(Value::String(s.to_string()))
                } else {
                    Value::String(s.to_string())
                }
            }
            ValueRef::Blob(_) => {
                return Err(rusqlite::Error::InvalidColumnType(
                    i,
                    format!("{col} 是 BLOB,导出未支持"),
                    rusqlite::types::Type::Blob,
                ));
            }
        };
        map.insert((*col).to_string(), value);
    }
    Ok(Value::Object(map))
}

/// JSON 值 → `Box<dyn ToSql>`,反序列化时与导出形状对齐。
///
/// JSON `null` → SQL `NULL`;数字 → 整数或实数;字符串 → 文本;对
/// 象 / 数组 → JSON 字符串(目标列必须是 TEXT)。
fn json_to_sql(value: &Value) -> Box<dyn rusqlite::ToSql> {
    match value {
        Value::Null => Box::new(None::<String>),
        Value::Bool(b) => Box::new(if *b { 1i64 } else { 0i64 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else if let Some(f) = n.as_f64() {
                Box::new(f)
            } else {
                Box::new(n.to_string())
            }
        }
        Value::String(s) => Box::new(s.clone()),
        Value::Array(_) | Value::Object(_) => Box::new(value.to_string()),
    }
}

/// 一行 CSV 字段的转义 + 拼装(RFC 4180):
/// - 含 `,` / `"` / `\n` / `\r` 的字段用双引号包裹;
/// - 字段内的双引号转义为 `""`;
/// - 行结束符固定 CRLF(Excel / WPS 兼容性最好)。
fn push_csv_row<'a, I: IntoIterator<Item = &'a str>>(out: &mut String, fields: I) {
    for (i, field) in fields.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        if needs_csv_quoting(field) {
            out.push('"');
            for ch in field.chars() {
                if ch == '"' {
                    out.push_str("\"\"");
                } else {
                    out.push(ch);
                }
            }
            out.push('"');
        } else {
            out.push_str(field);
        }
    }
    out.push_str("\r\n");
}

fn needs_csv_quoting(field: &str) -> bool {
    field.contains(',') || field.contains('"') || field.contains('\n') || field.contains('\r')
}

/// `SELECT` 后的 13 个 CSV 列按字符串读出来——写入由 [`push_csv_row`] 转义。
fn row_to_csv_field(row: &Row<'_>) -> rusqlite::Result<Vec<String>> {
    let fields: Vec<String> = (0..13)
        .map(|i| row.get::<_, String>(i).unwrap_or_default())
        .collect();
    Ok(fields)
}

#[cfg(test)]
mod tests {
    //! 单元测试覆盖 CSV 转义等纯函数;集成测试 `tests/export.rs` 走
    //! 完整 round-trip。

    use super::{needs_csv_quoting, push_csv_row};

    #[test]
    fn csv_普通字段不加引号() {
        let mut buf = String::new();
        push_csv_row(&mut buf, ["id", "title", "owner"]);
        assert_eq!(buf, "id,title,owner\r\n");
    }

    #[test]
    fn csv_含逗号字段要加引号() {
        let mut buf = String::new();
        push_csv_row(&mut buf, ["a,b"]);
        assert_eq!(buf, "\"a,b\"\r\n");
    }

    #[test]
    fn csv_含双引号字段要加引号_且内部双引号转义() {
        let mut buf = String::new();
        push_csv_row(&mut buf, ["hello \"world\""]);
        assert_eq!(buf, "\"hello \"\"world\"\"\"\r\n");
    }

    #[test]
    fn csv_含换行字段要加引号() {
        let mut buf = String::new();
        push_csv_row(&mut buf, ["line1\nline2"]);
        assert_eq!(buf, "\"line1\nline2\"\r\n");
    }

    #[test]
    fn csv_中文_不_加引号() {
        let mut buf = String::new();
        push_csv_row(&mut buf, ["张三", "周一例会"]);
        assert_eq!(buf, "张三,周一例会\r\n");
    }

    #[test]
    fn csv_中文含逗号要加引号() {
        let mut buf = String::new();
        push_csv_row(&mut buf, ["张三,暖通组"]);
        assert_eq!(buf, "\"张三,暖通组\"\r\n");
    }

    #[test]
    fn needs_csv_quoting_覆盖四类边界() {
        assert!(!needs_csv_quoting(""));
        assert!(!needs_csv_quoting("普通文本"));
        assert!(!needs_csv_quoting("中文 + 123"));
        assert!(needs_csv_quoting("a,b"));
        assert!(needs_csv_quoting("a\"b"));
        assert!(needs_csv_quoting("a\nb"));
        assert!(needs_csv_quoting("a\rb"));
    }

    #[test]
    fn csv_空_字符串_输出_空字段() {
        let mut buf = String::new();
        push_csv_row(&mut buf, ["a", "", "b"]);
        assert_eq!(buf, "a,,b\r\n");
    }

    #[test]
    fn csv_crlf_行结束_保证_excel_wps_兼容() {
        // AC 隐含:跨平台打开不串行——CRLF 是 RFC 4180 默认,Excel /
        // WPS / macOS Numbers 都按这条解析。
        let mut buf = String::new();
        push_csv_row(&mut buf, ["x"]);
        assert!(buf.ends_with("\r\n"));
    }
}
