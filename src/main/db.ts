/**
 * SQLite 连接：打开、设运行时 PRAGMA、跑 migrations。
 *
 * 全 app 只从这里拿连接——PRAGMA 是每连接（不是每库）生效的，绕过
 * [`openDatabase`] 直接 `new DatabaseSync(...)` 会得到一个外键不检查、
 * 没有 busy timeout 的连接。
 *
 * 用的 `node:sqlite` `DatabaseSync`（Node 24 内建）——`Database` /
 * `Statement` 是 Node 25+ async API 的别名，不要混用。
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "./error.js";
import { runMigrations, schemaVersion } from "./migrations/runner.js";
// 副作用导入：给 `node:sqlite` 补上泛型 `prepare`，让仓储层 105 处
// `db.prepare<[参数], 行>(sql)` 原样编译。详见该文件头注释。
import "./sqlite.js";

/** ADR 0001 §运行时 PRAGMA：每次 `new DatabaseSync(...)` 后立即执行。
 *
 * `node:sqlite` 没有 better-sqlite3 的 `db.pragma(source)`（后者会自动在
 * 前面拼 `PRAGMA ` 关键字）。这里统一走 `db.exec()`，所以常量里**不含**
 * `PRAGMA ` 前缀——由 `prepare()` 拼上，否则会变成
 * `PRAGMA PRAGMA journal_mode = ...`,SQLite 报 syntax error。
 */
const RUNTIME_PRAGMAS = [
  "journal_mode = WAL",
  "synchronous = NORMAL",
  "foreign_keys = ON",
  "busy_timeout = 5000",
] as const;

/** 打开（必要时新建）数据库文件，设好 PRAGMA 并把迁移跑到最新。 */
export function openDatabase(filePath: string, migrationsDir: string): DatabaseSync {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (cause) {
      throw AppError.fromIo(cause);
    }
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(filePath);
  } catch (cause) {
    throw AppError.fromIo(cause);
  }
  prepare(db, migrationsDir, true);
  return db;
}

/** 内存库选项。
 *
 * - `enableForeignKeyConstraints`：默认 `true`（= `node:sqlite` 内建默认）。
 *   测试用例里若 fixture 不便搭外键树（沿用 better-sqlite3 旧默认的
 *   "FK off"），可显式传 `false`。
 */
export interface OpenInMemoryOptions {
  enableForeignKeyConstraints?: boolean;
}

/** 内存库版本，用于测试。注意内存库的 `journal_mode` 恒为 `memory`，WAL 对它无意义。 */
export function openInMemoryDatabase(
  migrationsDir: string,
  options: OpenInMemoryOptions = {},
): DatabaseSync {
  const fk = options.enableForeignKeyConstraints ?? true;
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: fk });
  prepare(db, migrationsDir, fk);
  return db;
}

function prepare(db: DatabaseSync, migrationsDir: string, fkEnabled: boolean): void {
  for (const pragma of RUNTIME_PRAGMAS) {
    // FK 已由构造器选项控了——不再二次 `PRAGMA foreign_keys = ...`，否则
    // 在 fkEnabled=false 时把 FK 打开，与调用方意图相悖。
    if (pragma.startsWith("foreign_keys") && !fkEnabled) continue;
    db.exec(`PRAGMA ${pragma}`);
  }
  try {
    runMigrations(db, migrationsDir);
  } catch (cause) {
    throw AppError.fromMigration(cause);
  }
}

/** 已应用的最高迁移版本；一条都没跑过则为 `null`。 */
export { schemaVersion };