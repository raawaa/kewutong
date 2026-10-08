/**
 * Migrations runner（ADR 0007）。
 *
 * 扫 `migrations/V<NNN>__<name>.sql` 文件，按文件名字典序增量应用；
 * `_migrations` 表记录已应用版本。一次性的 Tauri → Electron 胶水：当检测到
 * `refinery_schema_history` 表存在时，把已应用版本搬到 `_migrations` 再
 * DROP，避免重跑 CREATE 报错。
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR_GLOB = /^V(\d+)__(.+)\.sql$/;

/**
 * 跑 migrations 目录下所有 `.sql` 文件（按文件名字典序）。
 *
 * 幂等——重跑不会重复应用。
 */
export function runMigrations(db: Database.Database, dir: string): void {
  // 1. 建 _migrations 表（如不存在）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 2. 一次性 Tauri → Electron 胶水：检测 refinery_schema_history 表。
  const tauriHistory = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='refinery_schema_history'",
    )
    .get();
  if (tauriHistory) {
    bootstrapFromTauriRefineryHistory(db);
    db.exec("DROP TABLE refinery_schema_history;");
  }

  // 3. 扫 migrations/ 目录。
  if (!fs.existsSync(dir)) {
    // 没有 migrations 目录时（如测试场景）——只跑第 1 步建表即可。
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => MIGRATIONS_DIR_GLOB.test(f))
    .sort();

  // 4. 拿 _migrations 已应用版本集合。
  const applied = new Set(
    db
      .prepare<[], { version: number }>("SELECT version FROM _migrations")
      .all()
      .map((r) => r.version),
  );

  // 5. 跑增量。
  for (const file of files) {
    const match = MIGRATIONS_DIR_GLOB.exec(file);
    if (!match) continue;
    const version = Number(match[1]);
    if (applied.has(version)) continue;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(text);
      db.prepare("INSERT INTO _migrations(version, name) VALUES (?, ?)").run(version, file);
    })();
  }

  // 6. 同步 PRAGMA user_version 为 _migrations 最大 version（sanity）。
  const maxApplied = db
    .prepare<[], { v: number | null }>("SELECT MAX(version) AS v FROM _migrations")
    .get();
  if (maxApplied?.v != null) {
    db.pragma(`user_version = ${maxApplied.v}`);
  }
}

/**
 * 把 `refinery_schema_history` 表里的已应用版本搬到 `_migrations`。
 *
 * `refinery` 的 schema：version INTEGER PK, name TEXT, checksum BLOB,
 * execution_time INTEGER。`version` 列与 `_migrations.version` 都是
 * INTEGER，无精度问题。
 */
function bootstrapFromTauriRefineryHistory(db: Database.Database): void {
  const tauriApplied = db
    .prepare<[], { version: number; name: string }>(
      "SELECT version, name FROM refinery_schema_history ORDER BY version",
    )
    .all();
  db.transaction(() => {
    const insert = db.prepare("INSERT OR IGNORE INTO _migrations(version, name) VALUES (?, ?)");
    for (const row of tauriApplied) {
      insert.run(row.version, row.name);
    }
  })();
}

/** 已应用的最高迁移版本；一条都没跑过则为 `null`。 */
export function schemaVersion(db: Database.Database): number | null {
  const row = db
    .prepare<[], { v: number | null }>("SELECT MAX(version) AS v FROM _migrations")
    .get();
  return row?.v ?? null;
}