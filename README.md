# 科室任务管理

给科长一个人用的本地优先桌面 app：一次性项目任务 + 周期性事务，跨 Linux / Windows / macOS，数据落在本地 SQLite，跨机器同步交给 Syncthing。

- 领域词汇表：[`CONTEXT.md`](CONTEXT.md)
- 决策记录：[`docs/adr/`](docs/adr/)
- 规格与工单：[GitHub issues](https://github.com/raawaa/kewutong/issues)

## 环境要求

- Node 20+ 与 npm
- Electron 33 的原生模块（`better-sqlite3`）由 `electron-builder install-app-deps`
  自动按当前 Electron 的 ABI 重新构建（`postinstall` 钩子已配好）

## 常用命令

```bash
npm install              # 装前端 + Electron 依赖（postinstall 会跑 install-app-deps）
npm run dev              # 起 app（electron-vite：主进程 + preload + renderer 三段热重载）
npm run build            # electron-vite 产物 + electron-builder 出安装包
npm run typecheck        # 三段 tsc --noEmit（node / web / main / preload）
npm test                 # vitest 全量（主进程 .test.ts + renderer .test.tsx）
```

想直接出可分发的安装包：

```bash
npm run build:app        # 仅 electron-vite 三段打包（不调 electron-builder）
```

## 目录

```
├── src/                    前端 + 主进程（TypeScript，electron-vite 三段产物）
│   ├── main/               主进程：db、migrations runner、领域命令、IPC 注册
│   ├── preload/            contextBridge 暴露 window.api 给 renderer
│   ├── lib/                renderer 共享：api-types（IPC typed wrapper）、utils、...
│   ├── components/         React 组件（task 弹窗、ui 基础件、wayfinder、tray、...）
│   ├── views/              各 tab 的界面
│   └── test/setup.ts       vitest 全局 setup
├── electron-builder.yml   多平台打包配置（mac/win/linux + portable）
├── electron.vite.config.ts
└── research/               选型调研
```

## 工程惯例

这些惯例由 [#16](https://github.com/raawaa/kewutong/issues/16) 确立，后续每一票沿用。

**业务逻辑全在主进程。** renderer 不算派生状态、不判节假日、不拼 SQL；它只调命令、显示 DTO。命令一律经 `src/lib/api-types.ts`（或兼容 shim `src/lib/ipc.ts`）包一层带类型的函数，组件不直接写 `window.api.*`。

**命令层是唯一的测试缝。** 行为测试直接调 `src/main/<domain>/index.ts` 里的命令函数（绕过 IPC 传输但走完整业务路径），配一个真实的临时 SQLite。只断言外部可观察行为：给定 DB 状态 + 一次命令调用，断言返回的 DTO 与库里可查询到的后果。不断言私有函数、不断言 SQL 文本。

**`freshDb()` 建库。** 内存库 + 跑真实 migrations + 设 4 条运行时 PRAGMA，一行拿到可注入的连接。不 mock 数据库。要断言 WAL 这类只在真实文件上成立的行为，用 `freshDbFile(path)`。

```typescript
const state = freshDb();
const reply = ping(state, null);
```

**时间只从时钟来。** 业务代码不直接读宿主时间，一律走 `AppState.clock.now()` / `nowSql()`。测试用 `FixedClock` 把「现在」钉在任意时刻，再拨到任意时刻：

```typescript
const clock = new FixedClock("2026-09-10T08:00:00Z");
const state = freshDbWithClock(clock);
clock.advance(TimeDelta.days(4));   // 验「阻塞超过 3 天」这类逻辑
```

**错误只有一个类型。** 命令返回 `Result<T, AppError>`（`neverthrow` 风格手写 `Result` / 直接抛 `AppError`）；`AppError` 序列化成 `{ code, message, detail }`——`code` 给前端分支，`message` 是能直接展示给科长的中文，`detail` 给维护者排查。

**DTO 是契约。** 命令的入参与返回值都是 TS interface，`@/main/types.ts` 是唯一的契约源；IPC 通道名（`personnel.list_sub_teams` 等）在 `src/main/ipc/register.ts` 里集中注册，preload typed wrapper 在 `src/preload/index.ts` 同步定义。
