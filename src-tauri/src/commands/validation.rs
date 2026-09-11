//! 命令层共享的输入校验 / 字符串 / 存在性预检查小工具。
//!
//! 集中放这里,避免 `task.rs` / `project.rs` / 后续 `recurring_template.rs`
//! 各自再写一遍 `require_non_blank` / `trim_to_option` / `ensure_*_exists`。
//!
//! 函数命名按"动作 + 形式":`require_*` 会失败（返回 `Err`）、`ensure_*`
//! 会失败、`to_*` 是转换、`parse_*` 是解析。带字段名的中文消息一律由调用
//! 方传进来——这里不替任何特定命令决定字段怎么说。

use crate::error::{AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};

/// `value` 经 `trim()` 后空串视为缺失,返回面向科长的中文 `AppError`。
pub fn require_non_blank(value: String, message: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid(message));
    }
    Ok(trimmed.to_string())
}

/// 字符串字段 trim 后空串折叠为 `None`,非空则保留 trim 后的值。
///
/// 主要用于 description / notes（可空、空白不写入）。
pub fn trim_to_option(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// 把 `LIKE` 模式里的元字符（`%` / `_` / 反斜杠本身）转义掉,配合 SQL 里的
/// `ESCAPE '\\'` 使用。`%` / `_` 是 LIKE 通配符,反斜杠是我们选的转义符;
/// 不转义的话用户打一个 `%` 就把全员刷出来了。
pub fn escape_like(raw: &str) -> String {
    let mut escaped = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

/// 通用「指定表里 id 存在否」预检查——把 `ensure_sub_team_exists`
/// (personnel.rs) / `ensure_person_exists` / `ensure_project_exists` 三个
/// 同形状助手合并成一处。表名走参数传入,SQL 仍按白名单写法写死,杜绝注入。
///
/// `message` 是表名不匹配时给科长看的中文提示。
pub fn ensure_row_exists(
    conn: &Connection,
    table: &'static str,
    id: i64,
    message: &'static str,
) -> Result<()> {
    let sql = format!("SELECT id FROM {table} WHERE id = ?1");
    let exists: Option<i64> = conn
        .query_row(&sql, params![id], |row| row.get(0))
        .optional()?;
    if exists.is_none() {
        return Err(AppError::invalid(message));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_non_blank_空白被拒() {
        let err = require_non_blank("   ".into(), "项目名不能为空。")
            .expect_err("空白应当被拒");
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert!(err.message().contains("项目名"));
    }

    #[test]
    fn require_non_blank_前后空白被裁掉() {
        let trimmed = require_non_blank("  综合楼改造  ".into(), "项目名不能为空。")
            .expect("前后空白应当被裁");
        assert_eq!(trimmed, "综合楼改造");
    }

    #[test]
    fn trim_to_option_空白折叠为_none() {
        assert_eq!(trim_to_option(None), None);
        assert_eq!(trim_to_option(Some("   ".into())), None);
        assert_eq!(trim_to_option(Some("  内容  ".into())), Some("内容".into()));
    }

    #[test]
    fn escape_like_把元字符转义() {
        let escaped = escape_like("a%b_c\\d");
        assert_eq!(escaped, "a\\%b\\_c\\\\d");
    }

    #[test]
    fn escape_like_普通字符原样保留() {
        assert_eq!(escape_like("综合楼改造"), "综合楼改造");
    }

    #[test]
    fn ensure_row_exists_存在返回_ok_不存在给中文提示() {
        let conn = Connection::open_in_memory().expect("内存库");
        conn.execute_batch("CREATE TABLE test_row (id INTEGER PRIMARY KEY); INSERT INTO test_row VALUES (42);")
            .expect("建表");

        ensure_row_exists(&conn, "test_row", 42, "应当存在")
            .expect("存在应当 OK");
        let err = ensure_row_exists(&conn, "test_row", 9999, "不存在").expect_err("不存在应当被拒");
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert_eq!(err.message(), "不存在");
    }
}