/**
 * `fresh_db()` 测试 fixture（ADR 0006 §测试 seam）。
 *
 * - `new DatabaseSync(':memory:')` 开内存库；
 * - 跑 `migrations/*.sql` + 4 条 PRAGMA（与 [`openDatabase`] 同样的准备路径）；
 * - 返回 `{ db, clock: new FixedClock(now) }`，让 `withState(...)` helper
 *   注入进任意命令函数。
 *
 * 与原 Rust 端 `fresh_db()` 同精神——命令函数 `command(state, args)` 直
 * 接拿 DTO，不经 ipcMain、不经 preload、不经 Electron 进程边界。
 */

import type { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as url from "node:url";

import { openInMemoryDatabase, type OpenInMemoryOptions } from "../../db.js";
import { FixedClock } from "../../clock.js";
import { newAppState, type AppState } from "../../state.js";
import { withTx } from "../../sqlite.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 从测试文件位置回溯到 migrations 目录。
 *
 * `__dirname` = `<repo>/src/main/test/commands/`；目标 = `<repo>/src/
 * main/migrations/`。需要向上两级（去掉 `commands/` + `test/`）。
 */
function resolveMigrationsDir(): string {
  return path.resolve(__dirname, "../../migrations");
}

/** `now` = 当前时刻字符串（UTC）；`null` = 用 epoch 起点 1970-01-01。 */
export interface FreshDbOptions {
  now?: string;
  /**
   * 是否开启外键约束检查。默认 `true`（= `node:sqlite` 内建默认，也对齐
   * [`openDatabase`] 走文件库时的行为）。
   *
   * 沿用 better-sqlite3 旧默认（FK off）的 fixture 可显式传 `false`——
   * 详见 [`openInMemoryDatabase`]。
   */
  enableForeignKeyConstraints?: boolean;
}

export interface FreshDb {
  db: DatabaseSync;
  clock: FixedClock;
  state: AppState;
  /** 测试结束时调一下关 db——node:sqlite 的 DatabaseSync 由 GC + close 显式收尾。 */
  close: () => void;
}

export function freshDb(options: FreshDbOptions = {}): FreshDb {
  // 严格模式 `exactOptionalPropertyTypes: true` 下,undefined 与「未指定」
  // 不可互换——只有调用方明确传值才把键放进去。
  const passOptions: OpenInMemoryOptions = {};
  if (options.enableForeignKeyConstraints !== undefined) {
    passOptions.enableForeignKeyConstraints = options.enableForeignKeyConstraints;
  }
  const db = openInMemoryDatabase(resolveMigrationsDir(), passOptions);
  // V007 在 migration 里塞了示例数据（is_sample = 1）——测试用例假设的
  // 「空库」语义是「无任何行」,所以 fixture 末尾清一遍。FK 子 → 父顺序
  // 与 `clearSampleData` 命令同源。
  withTx(db, () => {
    db.exec("DELETE FROM task WHERE is_sample = 1");
    db.exec("DELETE FROM recurring_template WHERE is_sample = 1");
    db.exec("DELETE FROM project WHERE is_sample = 1");
    db.exec("DELETE FROM person WHERE is_sample = 1");
    db.exec("DELETE FROM sub_team WHERE is_sample = 1");
  });
  const clock = options.now ? FixedClock.at(options.now) : new FixedClock(new Date(0));
  const state = newAppState(db, clock);
  return {
    db,
    clock,
    state,
    close: () => db.close(),
  };
}