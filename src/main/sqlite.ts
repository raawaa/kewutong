/**
 * `node:sqlite` 与调用层之间的类型 + 事务适配层（#68 T2）。
 *
 * `node:sqlite` 的 `StatementSync` **不是泛型**——`.get()` / `.all()` 一律返回
 * `Record<string, SQLOutputValue>`。而本仓库的仓储代码统一按
 * `db.prepare<[参数], 行>(sql)` 标注行形状（105 处）。若逐处加 `as` 断言，
 * 连 8 个测试文件都要改测试体；这里用一次声明合并把泛型 `prepare` 补回
 * `node:sqlite`，让 105 处调用点原样编译，类型信息与迁移前完全一致。
 *
 * 同理，better-sqlite3 的 `db.transaction(fn)()` 在 `node:sqlite` 没有对应
 * 方法（只有 `exec`），统一走 [`withTx`]。
 */

import type { DatabaseSync } from "node:sqlite";

/** `run()` 的返回值——对齐 better-sqlite3 的 `RunResult` 形状。 */
export interface RunResult {
  /**
   * 受影响行数。
   *
   * `node:sqlite` 的 `StatementResultingChanges.changes` 类型是
   * `number | bigint`，但那是 `readBigInts` 开启后的形态；本仓库从未开启
   * 该选项（见 [`openDatabase`]），运行期恒为 `number`。这里按运行期事实
   * 收窄，避免 23 处 `.run().changes` 全部退化成 `Number(...)` 包装。
   */
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/** 带行类型的预编译语句——泛型由下方 `declare module` 补进 `DatabaseSync`。 */
export interface TypedStatement<Row> {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
  iterate(...params: unknown[]): IterableIterator<Row>;
}

declare module "node:sqlite" {
  interface DatabaseSync {
    /**
     * 泛型版 `prepare`——第一个类型参数是绑定参数元组（仅用于文档化，
     * 与 better-sqlite3 一致），第二个是行形状。
     *
     * 与 `StatementSync` 原生签名的区别只在返回值：这里返回按调用方标注
     * 收窄的 [`TypedStatement`]，运行期仍是同一个 `StatementSync` 实例。
     *
     * 绑定参数沿用 better-sqlite3 的宽松 `unknown[]`（而非 node:sqlite
     * 原生的 `SQLInputValue[]`）——仓储层有 6 处先攒 `unknown[]` 再展开
     * 传入，收紧会把它们变成逐处加断言。
     */
    prepare<Params extends unknown[] = unknown[], Row = Record<string, SQLOutputValue>>(
      sql: string,
      options?: PrepareOptions,
    ): TypedStatement<Row>;
  }
}

/**
 * 事务包装——`db.transaction(fn)()` 的等价物。
 *
 * `node:sqlite` 不提供 `transaction()`，事务需显式 `BEGIN` / `COMMIT`。
 * 语义与 better-sqlite3 默认（deferred `BEGIN`）一致：异常时 `ROLLBACK`
 * 后原样抛出。
 *
 * 与 better-sqlite3 的唯一能力差异：后者支持嵌套（内层自动退化为
 * `SAVEPOINT`），这里不支持——嵌套调用会撞上 SQLite 的
 * "cannot start a transaction within a transaction"。本仓库 28 个调用点
 * 经核查全部是顶层调用，无嵌套。
 *
 * 泛型保留返回值：`clearSampleData` 等命令把结果对象从事务体里带出来。
 */
export function withTx<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}
