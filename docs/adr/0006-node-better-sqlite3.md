# 后端运行时 + SQLite 库：Node + better-sqlite3

**Status**: superseded by [ADR 0010](./0010-node-sqlite.md)

承接 spec #37 与 ADR 0005（Electron 壳），定义 Electron 主进程侧的运行时与 SQLite 客户端。**SQLite 客户端（better-sqlite3 → `node:sqlite`）** 与 **Node 运行时（20 LTS → 24.21.0 LTS）** 两项决定已被 [ADR 0010](./0010-node-sqlite.md) 部分取代；其余决定（TS 严格模式 / 命令层 seam / vitest fixture）继续生效。

## 决策

- **Node.js 20 LTS**（与 Electron 内嵌 Node 版本对齐到主版本号 20.x；具体 patch 随 Electron release notes 锁定）。
- **TypeScript 严格模式**（`strict: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true`），继承 Tauri 端的纪律（DTO 是契约、严格 null）。
- **`better-sqlite3`** 作为 SQLite 客户端。同步 API（不引连接池；单写者本机场景与原来 `Mutex<Connection>` 同形）、自带 FTS5 + trigram 表落 `tokenize = 'trigram'` 直接可用、bundled SQLite 与原来 `rusqlie bundled` 都是 SQLite3 主流版本，schema 兼容。
- 主进程入口 = `src/main/index.ts`；命令层 = `src/main/<entity>/index.ts`；测试 = `vitest`，fixture 在 `src/main/test/commands/fresh_db.ts`。

## 上下文

- 原 Rust 端用 `rusqlie 0.40.x + bundled feature`，连接 `tauri::State<Connection>` + `Mutex`，事务边界由 `Transaction` 显式控制；命令层 `forward-only` 迁移用 `refinery`。
- 改写后：单连接 + 显式 `db.transaction(() => { ... })()`；事务边界与原 Rust 端同语义。
- 后端运行时候选：Node（已选）、`node-sqlite-23`（异步 API / 慢）、`libsql-client`（异步 + 协议栈）。
- DB 客户端候选：`better-sqlite3`（已选）、`node-sqlite-23`（async）、`@libsql/client`（libsql 协议）。

## 不做的事

- **不引连接池 / 单例全局连接**：单写者本机 1 个 `Connection` 实例就够。
- **不引 ORM / 查询构建器**：raw SQL + 手写 repository 函数；与 Rust 端零 ORM 决定保持一致。
- **不用 WAL 之外的 journal 模式**：与 ADR 0001 §运行时 PRAGMA 一致——`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`。每次 `new Connection(...)` 后立即在同一个连接上跑这 4 条 PRAGMA。
- **不开 better-sqlite3 的 `unsafe` 模式**：默认就是非 unsafe，无 `PRAGMA journal_mode = MEMORY` 之类的全局快路径。
- **不引 libsql fork / 本地 Replica**：本项目是单文件 SQLite，libsql 的多端同步特性不需要。

## 备选方案（已 reject）

- **Bun** —— 内嵌 SQLite、无 electron-rebuild 问题；但 Electron 主进程不是 Bun，跑 Bun embed 在 Electron 里要 fork 或 IPC shim，迁移阻力大于 Node。
- **Deno** —— 自带 SQLite 但 Electron 主进程不是 Deno；fork Deno 二进制后 IPC 接入调用，Deno 主进程写业务也违背「业务全在 Electron 主进程」。
- **napi-rs / node-rs Rust 业务** —— spec #37 明确不留 Rust。
- **node-sqlite-23**（async / callback）—— 同步 `better-sqlite3` 在事务嵌套、循环批量写场景更接近原 `Transaction` 语义。
- **`@libsql/client`** —— libsql 协议栈；本项目用不上 client/server 模式，徒增包体积。

## 后果

### 包管理

- `package.json` dependencies：`better-sqlite3`（runtime）。devDependencies：`@types/better-sqlite3`、`electron`、`electron-vite`、`electron-builder`、`electron-rebuild`（build 阶段跑）。
- 跨平台：macOS / Windows / Linux 各一份 prebuilt binary；CI 4-runner 矩阵无 native build 压力。如某 prebuilt 缺失，回退到 `electron-builder install-app-deps`（npm 脚本 `postinstall`）。

### 模块布局

```
src/main/
├── index.ts                   Electron app 入口；初始化 db、IPC handlers、tray / window / globalShortcut、materialization tick
├── db.ts                      `openDatabase(filePath)` → Connection + 4 条 PRAGMA；
│                              内存库走 `openInMemoryDatabase(dir, options)`，
│                              options = `OpenInMemoryOptions { enableForeignKeyConstraints?: boolean }`
│                              （[ADR 0010 §测试 seam](./0010-node-sqlite.md#测试-seam) 增量）
├── sqlite.ts                  `node:sqlite` 与调用层之间的类型 + 事务适配层：
│                              `TypedStatement<Row>` 声明合并（把泛型 `prepare<Params, Row>()` 补回 `DatabaseSync`）+
│                              `withTx<T>(db, body)` 事务包装（`db.transaction(fn)()` 的等价物）。
│                              详见 [ADR 0010 §模块布局](./0010-node-sqlite.md#模块布局)。
├── clock.ts                   可注入 Clock 接口 + SystemClock + FixedClock（与 Rust 端 FixedClock 同 API）
├── state.ts                   AppState（Clock + Connection + HolidayCalendar + trayStatus + dbPath）
├── error.ts                   AppError → 序列化为 { code, message, detail }
├── util/
│   ├── sql.ts                 escapeLike() 单源
│   ├── strings.ts             requireNonBlank() / trimToOption() 单源
│   └── fk.ts                  ensurePersonExists / ensureSubTeamExists / ensureProjectExists 单源
├── ipc/
│   └── register.ts            ipcMain.handle 的注册中心（按 domain 拆 registerPersonnel、registerTask ...）
├── personnel/                 子组 / 人员 CRUD + 矩阵视图
├── project/                   项目 CRUD + 派生 status
├── task/                      任务 CRUD + 6 状态机 + search + today/week + due chips
├── recurring_template/        模板 CRUD + enable toggle + RRULE 派生/解析
├── instance/                  reschedule / override / chain / 模板级 zone 更新
├── wayfinder/                 全局命令面板 search
├── materialization/           物化触发 + 12 周窗口 + 跨周 gate
├── holiday/                   节假日查询 / 加载 / override
├── notification/              三规则扫描 + 已读标记 + NotificationRunSummary
├── tray/                      tray 状态查询（dto.ts 剥 Electron 依赖）
├── sample/                    示例数据 seed / 清除
├── export/                    JSON / CSV / data file location
├── shortcut/                  ⌘K / Ctrl+K 全局快捷键
└── test/
    ├── ping.test.ts           IPC ping 端到端
    ├── smoke.test.ts          5 核心场景（人员 / 任务 / 项目 / 模板 / 物化）
    ├── startup-tick.test.ts   materialization + scheduler 启动 + 跨周 tick 接线
    └── commands/fresh_db.ts    fresh_db()：开 mem + 跑 migrations + PRAGMA + 注入 AppState
```

注：原 spec §ADR 0006 起草的布局是 `src/main/commands/<entity>/<sub>.ts`——
实操时 12 个 domain 全部走单文件 `index.ts` 已经够薄,无需再开多一层
`<sub>.ts`,且测试 fixture 同步简化为 `src/main/test/commands/`。
本 ADR 实际落地布局如上,与 spec 文字表述存在偏差——M3 复审时把
这条偏差纳入决定。

### 测试 seam

- `fresh_db()`（`src/main/test/commands/fresh_db.ts`）：
    - `new Connection(':memory:')`；
    - 跑所有 `migrations/*.sql`（按文件名字典序，事务内执行）；
    - 跑 4 条 PRAGMA；
    - 返回 `{ db, clock: new FixedClock(now) }`，让 `withState(...)` helper 注入进任意命令函数。
- `withState({ db, clock })` 是测试的入口 seam：调用 `personnel::listSubTeams(state)` 直接拿 DTO，不经 ipcMain、不经 preload、不经 Electron 进程边界。
- 业务函数 `personnel::listSubCommands(state)` 与 main 进程 IPC glue 是两个不同的代码段——main 只做参数接收 + DTO 序列化 + 错误收敛。

### 行为契约

- 命令入参 / 返回值 = DTO（camelCase JSON）—— 与 Rust 端 DTO 同形；契约文档在 `src/main/types.ts`。
- `AppError` shape = `{ code, message, detail }`（与 Rust `AppError` 同）；renderer 端 `toAppError(thrown)` helper 继续生效。
- 6 状态 `TaskStatus` = `'Open' | 'In-progress' | 'Blocked' | 'Waiting-on' | 'Done' | 'Cancelled'`（与原 `src/lib/ipc.ts` 表面完全相同,现在从 `src/lib/api.ts` 暴露）。

## ADR 衔接链

- 上游：[ADR 0005](./0005-electron-as-shell.md) Electron 壳
- 上游：[ADR 0001](./0001-sqlite-schema.md) SQLite Schema（含 PRAGMA / FTS5 / 索引）
- 部分取代（本 ADR）：[ADR 0010](./0010-node-sqlite.md) — Node 24 + `node:sqlite` 内建；替换本 ADR 的 SQLite 客户端 + Node 运行时两项决定
- 下游：[ADR 0007](./0007-sql-migrations-runner.md) raw SQL + 自写 migrations runner
- 下游：[ADR 0008](./0008-preload-contextbridge-ipc.md) preload + ipcMain.handle IPC 形状