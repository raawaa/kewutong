import { describe, expect, it } from "vitest";

import { freshDb } from "./commands/fresh_db.js";
import { schemaVersion } from "../db.js";
import { runMigrations } from "../migrations/runner.js";

describe("M1 基础（#38 / #39 / #40）", () => {
  it("fresh_db() 跑通 8 条迁移并把 user_version 同步到最大 version", () => {
    const { db, state, close } = freshDb({ now: "2026-09-10 08:00:00" });
    try {
      const version = schemaVersion(db);
      expect(version).toBe(8);

      // 探活 DTO 形态——不在这里调 IPC handle（那是 main 进程），只
      // 验证 schemaVersion / now 的连接与组装正确。
      expect(state.clock.nowSql()).toBe("2026-09-10 08:00:00");
    } finally {
      close();
    }
  });

  it("fresh_db() 多次创建相互隔离（每个 :memory: 独立）", () => {
    const a = freshDb();
    const b = freshDb();
    try {
      a.db.exec("CREATE TABLE foo (id INTEGER PRIMARY KEY)");
      const fooInB = b.db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='foo'",
        )
        .get();
      expect(fooInB).toBeUndefined();
    } finally {
      a.close();
      b.close();
    }
  });

  it("Tauri → Electron 胶水：refinery_schema_history → _migrations 移植", () => {
    const { db, close } = freshDb();
    try {
      // 模拟 Tauri 端已经跑过 migrations V001-V004 的库。
      db.exec(`
        CREATE TABLE refinery_schema_history (
          version        INTEGER PRIMARY KEY,
          name           TEXT    NOT NULL,
          checksum       BLOB    NOT NULL,
          execution_time INTEGER
        );
        INSERT INTO refinery_schema_history (version, name, checksum, execution_time)
        VALUES (1, 'V001__initial.sql', X'', 0),
               (2, 'V002__project.sql', X'', 0),
               (4, 'V004__recurring_template.sql', X'', 0);
      `);

      // 现在跑 migrations runner——它应当把已应用版本搬到 _migrations，
      // 然后 DROP refinery_schema_history。
      // 注意：fresh_db 已经跑过全部 migrations 了；这里要测的是 bootstrap
      // 一次性路径，所以手动重建一个简化的 runner 调用场景：
      const emptyDb = openEmpty();
      emptyDb.exec(`
        CREATE TABLE refinery_schema_history (
          version        INTEGER PRIMARY KEY,
          name           TEXT    NOT NULL,
          checksum       BLOB    NOT NULL,
          execution_time INTEGER
        );
        INSERT INTO refinery_schema_history (version, name, checksum, execution_time)
        VALUES (1, 'V001__initial.sql', X'', 0),
               (2, 'V002__project.sql', X'', 0),
               (4, 'V004__recurring_template.sql', X'', 0);
      `);
      runMigrations(emptyDb, "");

      const migrated = emptyDb
        .prepare<[], { version: number }>("SELECT version FROM _migrations ORDER BY version")
        .all();
      expect(migrated.map((r) => r.version)).toEqual([1, 2, 4]);
      const refineryStillThere = emptyDb
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='refinery_schema_history'",
        )
        .get();
      expect(refineryStillThere).toBeUndefined();
      emptyDb.close();
    } finally {
      close();
    }
  });
});

import Database from "better-sqlite3";
function openEmpty(): Database.Database {
  const db = new Database(":memory:");
  return db;
}