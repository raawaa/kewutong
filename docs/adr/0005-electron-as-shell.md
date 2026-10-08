# 桌面壳层迁到 Electron

**Status**: accepted

承接 spec #37（Tauri → Electron 迁移）的「敏捷 dev 周期」诉求与「业务逻辑全在 Node」目标，把本项目的桌面壳层从 Tauri 2.x 切到 Electron。

## 决策

- 桌面壳层 = **Electron**（最新稳定 major，本票落地时锁版本到 33.x）。
- 工作流：业务代码迁到 Electron 主进程（Node + TypeScript），渲染进程保持现有 Vite + React + Tailwind v4 + shadcn/ui。dev 工具 = `electron-vite`。
- 「业务逻辑全在主进程」的纪律承接原来 README「业务逻辑全在 Rust」的同一份精神——只是持有者从 Rust 改成了 TS。
- 「命令层是唯一的测试缝」也承接，但命令函数从 `src-tauri/src/commands/*` 迁到 `src/main/commands/*`。
- 现有 renderer 代码（`src/components/*`、`src/views/*`、`src/lib/ipc.ts`）几乎**整体保留**，仅替换 IPC seam 的导入：`@tauri-apps/api/core` 的 `invoke` → preload 暴露的 `window.api`。
- 一刀切：迁移期间两套壳并存（构建流水线仍可 build Tauri），行为对照绿灯后**单 PR 删除** `src-tauri/`、`Cargo.toml`、`Cargo.lock`、`@tauri-apps/*`、`tauri.conf.json`、`capabilities/`、`src-tauri/migrations/`。

## 上下文

- 现 Tauri 2.x 的 `npm run tauri dev` 首次冷构 + Rust 重编译在前端日常迭代中成为瓶颈；这条被 spec #37 列为迁移首要驱动。
- 体积代价被接受（Electron 安装包 ≈ 150–200 MB / 内存基线 100–300 MB vs Tauri 5–10 MB）。
- 「Electron 更成熟」的判断是直觉性的（生态更广、用户基数更大），并非基于具体 Tauri 痛点清单——这是该决策的真实弱点，已记录但不改方向。

## 不做的事

- **不引 Tauri v3**：切 Tauri 的版本号没解决问题，仍要重写后端到 Node 才能换 dev 周期。
- **不保留 Rust 业务逻辑（napi-rs / node-rs 混血）**：spec #37 明确「不留 Rust」。
- **不做代码签名 / 公证**：与 ADR 0004 同档，Gatekeeper / SmartScreen 警告继续接受。
- **不引 `electron-updater` / 自动更新**：v1 升级仍是「下载新版手动装」。
- **不做 IPC 走 HTTP / ws**：见 ADR 0008，纯标准 `ipcMain.handle` + `contextBridge` 足够。

## 备选方案（已 reject）

- **留在 Tauri 2.x（patch / 替换个别插件）** —— 不解决 dev 周期问题，业务逻辑仍是 Rust，重编译仍是瓶颈。
- **Wails** —— Go 后端 + 系统 Webview；体积小但本项目业务已不再用编译型后端语言。
- **Neutralino** —— 超轻量；无 Node 运行时但生态薄，本项目要 FTS5 中文 trigram、丰富 npm 工具链，Neutralino 不够。
- **Pake / Webview 自包** —— 体积更小但生态 / 调试 / 打包矩阵都比 Electron 弱，不值。

## 后果

### 代码层

- 整个 `src-tauri/` 目录（Rust 后端、migrations、capabilities、build.rs）迁移完成后被一次性删除。
- `package.json` 移除 `@tauri-apps/api` / `@tauri-apps/cli`，新增 `electron`、`electron-vite`、`electron-builder`、`better-sqlite3`（runtime）、`@types/better-sqlite3`（dev）。
- `vite.config.ts` 现有 Vite 配置作为 renderer 配置被 `electron-vite` 接管；新增 `electron.vite.config.ts` 描述 main + preload 的 esbuild 配置。
- `index.html` 渲染入口保持不变；前端 0 业务逻辑约束遵守。
- README 中「业务逻辑全在 Rust」一段改为「业务逻辑全在 Node (主进程)」；其它工程惯例（命令层是测试缝、可注入时钟、错误统一类型、DTO 是契约）原样沿用。

### 分发层

- 4-runner 矩阵（ubuntu-22.04 / windows-latest / macos-latest / macos-15-intel）从 `tauri-apps/tauri-action@v1` 切到 `electron-builder` + GitHub Actions；详见 ADR 0009。
- 产物格式不变：`.deb` / `.AppImage` / `.msi` / `.dmg`。
- 资源打包：原 `tauri.conf.json` 的 `bundle.resources: ["../holidays/*"]` 改成 `electron-builder` 的 `extraResources`。

### 安全层

- BrowserWindow：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`（详见 ADR 0008）。
- CSP：原 `tauri.conf.json` `security.csp: null` 改为真实的 CSP（renderer 加载本地 bundle，无远程脚本）。
- 卸载 `tauri-plugin-permission` 类能力系统（Electron 不需要）；能力由 preload 暴露的 API 列表替代。

### 测试层

- `cargo test` 全量测试迁移到 vitest（见 ADR 0006 / spec #37 测试段）。
- 主进程启动 / 关闭主窗口不受 Tauri 测试，Electron 端用 `playwright` for Electron（spec #37 M3 阶段决定是否引入）。

## ADR 衔接链

- 上游：[spec #37](https://github.com/raawaa/kewutong/issues/37) Tauri → Electron 迁移 spec
- 上游：[ADR 0004](./0004-distribution-pipeline.md) 三平台原生安装包 + 4-runner 矩阵（保留）
- 下游：[ADR 0006](./0006-node-better-sqlite3.md) 后端运行时 + SQLite 库
- 下游：[ADR 0007](./0007-sql-migrations-runner.md) raw .sql + 自写 runner
- 下游：[ADR 0008](./0008-preload-contextbridge-ipc.md) preload + contextBridge IPC 形状
- 下游：[ADR 0009](./0009-electron-builder-distribution.md) electron-builder + 4-runner 矩阵沿用