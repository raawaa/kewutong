# 后端运行时 + SQLite 库：Node 24 + node:sqlite

**Status**: accepted

承接 PR #68（T1 #69 / T2 #70 / T3 #71）— Electron 33 → 44 + better-sqlite3 → `node:sqlite` 内建的反转决策；部分**取代** [ADR 0006](./0006-node-better-sqlite3.md) 的 SQLite 客户端 + Node 运行时两项决定，其余部分（TS 严格模式 / 命令层 seam / vitest fixture）继续生效。

## 决策

- **Node.js 24.21.0 LTS**——由 Electron 44.7.0 内嵌。vitest 测试 runtime 与主进程 runtime 共用同一 Node ABI（modules 137 ↔ N-API 8）。
- **`node:sqlite` 内建模块**（Node 22 LTS 起标记 stable、Node 24 LTS 默认开）作为 SQLite 客户端；不引任何第三方 SQLite 包。
- **适配层 shim**：`src/main/sqlite.ts`。
    - `TypedStatement<Row>` 声明合并（`declare module "node:sqlite"`）——`node:sqlite` 的 `StatementSync` 非泛型，`.get() / .all()` 一律返回 `Record<string, SQLOutputValue>`；用声明合并把泛型 `prepare<Params, Row>()` 补回 `DatabaseSync`，让仓储层 **105 处** `db.prepare<[P], R>(sql)` 调用点零改动编译。
    - `withTx<T>(db, body)` 事务包装——等价于 better-sqlite3 的 `db.transaction(fn)()`；语义 = deferred `BEGIN`、异常时 `ROLLBACK` 后原样抛出。覆盖**28 处**事务调用点。
    - **能力差异（且承认）**：`withTx` 不支持嵌套（`SAVEPOINT` 退化为抛 `cannot start a transaction within a transaction`）。仓库 28 处调用点经核查全部顶层，无嵌套。
- **lesson learned**（来自 spec #68 §Further Notes #7）：
  > "Third-party SQLite client selected in 2024 became a maintenance burden within 18 months when its prebuilt coverage moved past Node 20. The lesson is to check Node LTS built-in availability before adopting any third-party native module."
- **structural invariant**（迁移建立的、未来的硬约束）：**zero third-party SQLite deps, zero native rebuild step**。`node:sqlite` 是 Node 24 built-in、由 Electron 44.7.0 bundled；以后升 Electron 或 Node 不再做 SQLite 兼容检查——`napi_register_module_v1` 那一类原生 ABI 漂移失败（[#66](https://github.com/raawaa/kewutong/issues/66) 触发的 SIGSEGV 属此）**结构上消除**。

## 上下文

- ADR 0006 当时（2024 年）选 `better-sqlite3` 的理由：同步 API / 单连接无连接池 / FTS5 + trigram `tokenize = 'trigram'` 直接可用 / prebuilt N-API binary。**prebuilt 覆盖矩阵当时是合理依据**。
- 2026 年栈升级到 Electron 33 → 44：better-sqlite3 13.0.3 的 N-API prebuilt 仍能覆盖 Electron 44（prebuilds/darwin-arm64.node 直接加载），**但跨 Electron / Node ABI 漂移的脆弱性已成事实**——[#66](https://github.com/raawaa/kewutong/issues/66) 在更早一次升级时就出现过 SIGSEGV。
- 候选栈走到 Electron 44.7.0 时附带的 Node 24.21.0 LTS 已经把 `node:sqlite`（`DatabaseSync` / `StatementSync` 同步 API）作为 stable 内建模块——Node 22 LTS 起标记 stable、Node 24 默认开。原 better-sqlite3 选型时 `node:sqlite` 尚未到达「默认可用」线。

## 不做的事

- **不引任何第三方 SQLite 包**（`better-sqlite3` / `@libsql/client` / `node-sqlite-23` / `sql.js`）：structural invariant 的一部分。
- **不引 `electron-rebuild` / `@electron/rebuild` / `electron-builder install-app-deps`**：仓库没有原生模块需要 rebuild，`package.json` 不再有 `postinstall` 脚本（[#71](https://github.com/raawaa/kewutong/issues/71) 删除）。
- **不开 better-sqlite3 风格的 `unsafe` 模式**：本 ADR 已不再涉及 better-sqlite3；`node:sqlite` 默认不开 `readBigInts`、不挂 hook。
- **不开 `withTx` 嵌套事务**：不动 `SAVEPOINT` 包装；调用方约定保持「顶层调用」即可（仓库现状）。
- **不暴露 `node:sqlite` 的 async API（`Database` / `Statement`）**：本仓库是同步模型（与 Rust 端 `Transaction::new()` 同语义）；async 会把 105 处调用点全部改成 `await`。
- **不写 `node:sqlite` 的 `unsafe` flags**（如 `allowExtension` / `enableLoadExtension`）：默认就关。

## 备选方案（已 reject）

- **留在 better-sqlite3 13.x** —— N-API prebuilt 暂时覆盖到 Electron 44，但每次升 Electron / Node 都得做一次「prebuilt 是否覆盖」核对 + 必要时等 better-sqlite3 release。是 ADR 0006 选型时的同一类风险——只是把 18 个月后的事实风险延后。
- **`@libsql/client`** —— libsql 协议栈；本项目单文件 SQLite，无 client/server 模式需求，徒增包体积与一组网络层（连不上时降级）。
- **`node-sqlite-23`** —— 异步 callback API；仓库 105 处同步仓储代码全部要改成 promise/callback 链。
- **`sql.js`** —— WebAssembly SQLite；同步但要走 WASM heap ↔ JS heap 数据拷贝，循环批量写场景性能退化；不适合本仓库的体量。
- **`bun:sqlite`**（Bun 内建）—— Electron 主进程不是 Bun；要 fork Bun embed + IPC shim 才能跑（与 ADR 0006 拒 Bun 的同一理由）。

## 后果

### 包管理

- `package.json` dependencies：**无 SQLite 包**（[ADR 0006](./0006-node-better-sqlite3.md) 的 `better-sqlite3` runtime + `@types/better-sqlite3` dev 均移除，[#71](https://github.com/raawaa/kewutong/issues/71)）。
- `package.json` scripts：**无 `postinstall`**——`electron-builder install-app-deps` 删除，因为没有原生模块要 rebuild。
- `electron-builder.yml` 的 `asarUnpack: ["**/node_modules/better-sqlite3/**/*"]` 删除；`npmRebuild: true` 默认值已无关（无 native 模块）。
- 跨平台：electron-builder 4-runner 矩阵（ubuntu-22.04 / windows-latest / macos-latest / macos-15-intel）各自跑同一份 TS 代码 + Node 24 内建 SQLite；**不再有 per-runner 原生构建**。

### 模块布局

```
src/main/
├── index.ts                   Electron app 入口
├── db.ts                      openDatabase(filePath) / openInMemoryDatabase(dir, options) ——
│                              `OpenInMemoryOptions { enableForeignKeyConstraints?: boolean }` 测试 seam
├── sqlite.ts                  NEW — node:sqlite 与调用层之间的类型 + 事务适配层：
│                              ├── `TypedStatement<Row>` 声明合并，把泛型 `prepare<Params, Row>()` 补回 `DatabaseSync`
│                              ├── `RunResult` shape 对齐 better-sqlite3 的 `RunResult`（changes / lastInsertRowid）
│                              └── `withTx<T>(db, body)` 事务包装（deferred BEGIN + ROLLBACK on throw）
├── clock.ts                   可注入 Clock 接口
├── state.ts                   AppState（Clock + DatabaseSync + HolidayCalendar + ...）
├── error.ts                   AppError → { code, message, detail }
├── ...
```

注：[ADR 0006 §模块布局](./0006-node-better-sqlite3.md#模块布局) 的其余部分（命令层 seam / 测试 fixture / 命令名点号分）继续生效。

### 行为契约

- 命令入参 / 返回值 = DTO（camelCase JSON）。
- `AppError` shape = `{ code, message, detail }`；迁移失败 → `code: 'MIGRATION_FAILED'`。
- `db.transaction(fn)()` → `withTx(db, fn)`；调用点全部是顶层（已核查 28 处）。
- `db.pragma('journal_mode = WAL')` 风格 → `db.exec('PRAGMA journal_mode = WAL')`（`node:sqlite` 没有 `db.pragma(source)` 这个简写；`PRAGMA` 关键字由调用方显式拼，构造器 `enableForeignKeyConstraints` 由 `OpenInMemoryOptions` 显式传）。

### 测试 seam

- `fresh_db()` 改用 `openInMemoryDatabase(migrationsDir, { enableForeignKeyConstraints: false })`——仓库 fixtures 沿用 better-sqlite3 旧默认（FK off），不再被 `node:sqlite` 内建默认（FK on）反向打破。
- 2 处直接绕过 `openInMemoryDatabase` 的 `new DatabaseSync(':memory:')`（`ping.test.ts` / `scheduler.test.ts`）显式 pin `enableForeignKeyConstraints: false`——[T2 (#70)](https://github.com/raawaa/kewutong/issues/70) 落地。
- vitest 与 Electron 主进程共用 Node 24 ABI（N-API 8 / modules 137）——同一份 prebuilt 兼容性矩阵消失，但**两边都跑同一份 TS 代码 + `node:sqlite`**。

### structural invariant 的执行边界

- 任何**新增** SQLite 客户端依赖需重新打开本 ADR：仓库结构上不再允许 `dependencies.n` 出现 `better-sqlite3` / `@libsql/client` / `sql.js` / `node-sqlite-23` 等任一第三方 SQLite 包名。
- 任何**重新引入** `postinstall` 跑 native rebuild 的脚本需重新打开本 ADR：仓库结构上不再允许 `scripts.postinstall` 跑 `electron-rebuild` / `@electron/rebuild` / `electron-builder install-app-deps`。
- `node:sqlite` 是 Node 22 LTS 起标记 stable；继续升 Node（25 / 27 ...）或 Electron（45 / 46 ...）无需重审本 ADR——直到 Node 把 `node:sqlite` 标 deprecated 或移除（暂无此信号）。

## ADR 衔接链

- 上游：[ADR 0005](./0005-electron-as-shell.md) Electron 壳（44.x — 本 ADR 落地时已升）
- 上游：[ADR 0001](./0001-sqlite-schema.md) SQLite Schema（含 PRAGMA / FTS5 / 索引）
- 部分取代：[ADR 0006](./0006-node-better-sqlite3.md)（**SQLite 客户端** + **Node 运行时**两项决定；其余部分继续生效）
- 下游：[ADR 0007](./0007-sql-migrations-runner.md) raw SQL + 自写 runner（`runMigrations` 已迁到 `node:sqlite`，[T2 (#70)](https://github.com/raawaa/kewutong/issues/70)）
- 下游：[ADR 0008](./0008-preload-contextbridge-ipc.md) preload + ipcMain.handle IPC 形状（不变）
- 关联 spec：[#68](https://github.com/raawaa/kewutong/issues/68) Electron 33 → 44 + better-sqlite3 → node:sqlite 迁移 spec
- 关联 ticket：[#69](https://github.com/raawaa/kewutong/issues/69) T1 / [#70](https://github.com/raawaa/kewutong/issues/70) T2 / [#71](https://github.com/raawaa/kewutong/issues/71) T3 — 实施拆分
- 关联 ticket：[#66](https://github.com/raawaa/kewutong/issues/66) — 早先一次 Electron 升级时 `napi_register_module_v1` 的 SIGSEGV，是本 ADR 的「教训来源」案例