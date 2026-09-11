# 科室任务管理

给科长一个人用的本地优先桌面 app：一次性项目任务 + 周期性事务，跨 Linux / Windows / macOS，数据落在本地 SQLite，跨机器同步交给 Syncthing。

- 领域词汇表：[`CONTEXT.md`](CONTEXT.md)
- 决策记录：[`docs/adr/`](docs/adr/)
- 规格与工单：[GitHub issues](https://github.com/raawaa/kewutong/issues)

## 环境要求

- Rust stable（`rustup` 装即可；`rusqlite` 走 `bundled`，会用 `cc` 编一次 SQLite，首次冷构建慢是正常的）
- Node 20+ 与 npm
- 各平台的 Tauri 系统依赖：<https://tauri.app/start/prerequisites/>

## 常用命令

```bash
npm install              # 装前端依赖（含 @tauri-apps/cli）
npm run tauri dev        # 起 app（前端 Vite dev server + Rust 端热重载）
npm run tauri build      # 出安装包

npm run typecheck        # 前端类型检查
npm run build            # 前端构建产物到 dist/
npm test                 # 前端组件级测试（vitest + testing-library）

cd src-tauri && cargo test    # Rust 全量测试
cd src-tauri && cargo clippy --all-targets
```

想直接用 `cargo tauri dev` 而不是 `npm run tauri dev`，先装一次 CLI：

```bash
cargo install tauri-cli --version "^2" --locked
```

> `cargo test` 会编译 `tauri::generate_context!`，它要求 `dist/` 存在。全新克隆后先跑一次 `npm run build`。

## 目录

```
├── src/                    前端（React + TypeScript + Tailwind v4 + shadcn/ui）
│   ├── components/task/    新建 / 编辑任务弹窗及其零件
│   ├── components/ui/      shadcn 组件
│   ├── views/              各 tab 的界面
│   ├── test/setup.ts       vitest 全局 setup
│   └── lib/ipc.ts          调 Rust 命令的唯一入口（带类型）
├── src-tauri/
│   ├── migrations/         refinery 的 .sql 迁移（forward-only，无 down）
│   ├── src/
│   │   ├── clock.rs        可注入时钟
│   │   ├── commands/       命令层，按领域分子模块
│   │   ├── db.rs           连接、运行时 PRAGMA、迁移
│   │   ├── error.rs        统一错误类型
│   │   ├── state.rs        注入 tauri::State 的应用状态
│   │   └── testing.rs      测试 fixture（fresh_db）
│   └── tests/              命令层集成测试
├── prototype/              交互原型（视觉与交互的权威参考）
└── research/               选型调研
```

## 工程惯例

这些惯例由 [#16](https://github.com/raawaa/kewutong/issues/16) 确立，后续每一票沿用。

**业务逻辑全在 Rust。** 前端不算派生状态、不判节假日、不拼 SQL；它只调命令、显示 DTO。命令一律经 `src/lib/ipc.ts` 包一层带类型的函数，组件不直接 `invoke`。

**命令层是唯一的测试缝。** 行为测试直接调 `#[tauri::command]` 标注的 Rust 函数（绕过 IPC 传输但走完整业务路径），配一个真实的临时 SQLite。只断言外部可观察行为：给定 DB 状态 + 一次命令调用，断言返回的 DTO 与库里可查询到的后果。不断言私有函数、不断言 SQL 文本。

**`fresh_db()` 建库。** 内存库 + 跑真实 migrations + 设 4 条运行时 PRAGMA，一行拿到可注入 `tauri::State` 的连接。不 mock 数据库。要断言 WAL 这类只在真实文件上成立的行为，用 `fresh_db_file(path)`。

```rust
let app = mock_app(fresh_db());
let reply = ping(app.state(), None)?;
```

**时间只从时钟来。** 业务代码不直接读宿主时间，一律走 `AppState::now()` / `now_sql()`。测试用 `FixedClock` 把「现在」钉在任意时刻，再拨到任意时刻：

```rust
let clock = Arc::new(FixedClock::at("2026-09-10 08:00:00"));
let app = mock_app(fresh_db_with_clock(clock.clone()));
clock.advance(TimeDelta::days(4));   // 验「阻塞超过 3 天」这类逻辑
```

**错误只有一个类型。** 命令返回 `Result<T, AppError>`；`AppError` 序列化成 `{ code, message, detail }`——`code` 给前端分支，`message` 是能直接展示给科长的中文，`detail` 给维护者排查。

**DTO 是契约。** 命令的入参与返回值都是 `serde` 结构，`#[serde(rename_all = "camelCase")]` 上线，不透传行结构。
