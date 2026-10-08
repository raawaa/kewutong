/**
 * SQL 字符串工具——在命令层多处复用的字符处理单源。
 *
 * 与原 Rust 端 `sql::escape_like` 同形：`%` / `_` / 反斜杠转义后配合
 * `ESCAPE '\\'` 使用，否则用户输入 `%` 会被解析为 SQL 通配符。
 */

/** LIKE 元字符（`%` / `_` / 反斜杠本身）转义，配合 SQL `ESCAPE '\\'` 使用。 */
export function escapeLike(raw: string): string {
  let escaped = "";
  for (const ch of raw) {
    if (ch === "\\" || ch === "%" || ch === "_") escaped += "\\";
    escaped += ch;
  }
  return escaped;
}