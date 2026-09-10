//! 数据层地基的集成测试：PRAGMA、迁移、`fresh_db()` fixture。

use kewutong_lib::db;
use kewutong_lib::testing::{fresh_db, fresh_db_file};

#[test]
fn 空_migration_集也能干净建库() {
    let state = fresh_db();
    let conn = state.db().expect("应当拿得到连接");

    // refinery 建好了自己的历史表，只是一条都没跑
    let applied: i64 = conn
        .query_row("SELECT count(*) FROM refinery_schema_history", [], |r| {
            r.get(0)
        })
        .expect("迁移历史表应当存在");
    assert_eq!(applied, 0);
    assert_eq!(db::schema_version(&conn).expect("应当能读版本"), None);
}

#[test]
fn 重复跑迁移是幂等的() {
    let dir = tempfile::tempdir().expect("临时目录");
    let path = dir.path().join("kewutong.db");

    let first = db::open(&path).expect("第一次打开");
    drop(first);
    let second = db::open(&path).expect("第二次打开");

    let applied: i64 = second
        .query_row("SELECT count(*) FROM refinery_schema_history", [], |r| {
            r.get(0)
        })
        .expect("迁移历史表应当存在");
    assert_eq!(applied, 0);
}

#[test]
fn 文件库打开后四条运行时_pragma_都生效() {
    let dir = tempfile::tempdir().expect("临时目录");
    let state = fresh_db_file(&dir.path().join("kewutong.db"));
    let conn = state.db().expect("应当拿得到连接");

    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    let synchronous: i64 = conn
        .query_row("PRAGMA synchronous", [], |r| r.get(0))
        .unwrap();
    let foreign_keys: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    let busy_timeout: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
        .unwrap();

    assert_eq!(journal_mode, "wal");
    assert_eq!(synchronous, 1); // NORMAL
    assert_eq!(foreign_keys, 1); // ON
    assert_eq!(busy_timeout, 5000);
}

#[test]
fn 内存库同样打开外键与_busy_timeout() {
    // 内存库的 journal_mode 恒为 `memory`，WAL 对它无意义；其余三条照旧生效
    let state = fresh_db();
    let conn = state.db().expect("应当拿得到连接");

    let foreign_keys: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    let busy_timeout: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
        .unwrap();

    assert_eq!(foreign_keys, 1);
    assert_eq!(busy_timeout, 5000);
}

#[test]
fn 两次_fresh_db_之间互不串数据() {
    let a = fresh_db();
    a.db()
        .unwrap()
        .execute_batch("CREATE TABLE 便签 (内容 TEXT); INSERT INTO 便签 VALUES ('甲');")
        .expect("建表");

    let b = fresh_db();
    let leaked: i64 = b
        .db()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = '便签'",
            [],
            |r| r.get(0),
        )
        .unwrap();

    assert_eq!(leaked, 0);
}
