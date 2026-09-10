//! SQLite 连接：打开、设运行时 PRAGMA、跑 `refinery` 迁移。
//!
//! 全 app 只从这里拿连接——PRAGMA 是每连接（不是每库）生效的，绕过 [`open`] 直接
//! `Connection::open` 会得到一个外键不检查、没有 busy timeout 的连接。

use crate::error::Result;
use rusqlite::Connection;
use std::path::Path;

mod embedded {
    // 路径相对 CARGO_MANIFEST_DIR（即 src-tauri/）。目录必须存在，否则编译期就报错；
    // 目录空着则生成一个空 runner，建库时只建历史表，不跑任何迁移。
    refinery::embed_migrations!("migrations");
}

/// refinery 记录已应用迁移的表。
const MIGRATION_HISTORY_TABLE: &str = "refinery_schema_history";

/// ADR 0001 §运行时 PRAGMA：每次 `Connection::open` 后立即执行。
const RUNTIME_PRAGMAS: &str = "\
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
";

/// 打开（必要时新建）数据库文件，设好 PRAGMA 并把迁移跑到最新。
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    prepare(Connection::open(path)?)
}

/// 内存库版本，用于测试。注意内存库的 `journal_mode` 恒为 `memory`，WAL 对它无意义。
pub fn open_in_memory() -> Result<Connection> {
    prepare(Connection::open_in_memory()?)
}

fn prepare(mut conn: Connection) -> Result<Connection> {
    conn.execute_batch(RUNTIME_PRAGMAS)?;
    embedded::migrations::runner().run(&mut conn)?;
    Ok(conn)
}

/// 已应用的最高迁移版本；一条都没跑过则为 `None`。
pub fn schema_version(conn: &Connection) -> Result<Option<u32>> {
    let version: Option<i64> = conn.query_row(
        &format!("SELECT MAX(version) FROM {MIGRATION_HISTORY_TABLE}"),
        [],
        |row| row.get(0),
    )?;
    Ok(version.map(|version| version as u32))
}
