/**
 * SQLite 连接：打开、设运行时 PRAGMA、跑 migrations。
 *
 * 全 app 只从这里拿连接——PRAGMA 是每连接（不是每库）生效的，绕过
 * [`openDatabase`] 直接 `new Database(...)` 会得到一个外键不检查、
 * 没有 busy timeout 的连接。
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "./error.js";
import { runMigrations, schemaVersion } from "./migrations/runner.js";

/** ADR 0001 §运行时 PRAGMA：每次 `new Database(...)` 后立即执行。 */
const RUNTIME_PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
] as const;

/** 打开（必要时新建）数据库文件，设好 PRAGMA 并把迁移跑到最新。 */
export function openDatabase(filePath: string, migrationsDir: string): Database.Database {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (cause) {
      throw AppError.fromIo(cause);
    }
  }
  let db: Database.Database;
  try {
    db = new Database(filePath);
  } catch (cause) {
    throw AppError.fromIo(cause);
  }
  prepare(db, migrationsDir);
  return db;
}

/** 内存库版本，用于测试。注意内存库的 `journal_mode` 恒为 `memory`，WAL 对它无意义。 */
export function openInMemoryDatabase(migrationsDir: string): Database.Database {
  const db = new Database(":memory:");
  prepare(db, migrationsDir);
  return db;
}

function prepare(db: Database.Database, migrationsDir: string): void {
  for (const pragma of RUNTIME_PRAGMAS) {
    db.pragma(pragma);
  }
  try {
    runMigrations(db, migrationsDir);
  } catch (cause) {
    throw AppError.fromMigration(cause);
  }
}

/** 已应用的最高迁移版本；一条都没跑过则为 `null`。 */
export { schemaVersion };