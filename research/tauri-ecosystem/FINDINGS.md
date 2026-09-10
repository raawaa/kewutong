# Tauri 2.x 生态现状与插件短名单

**调查范围**：Tauri 2.x 当前稳定版本、SQLite 集成方式、notification/tray/autostart/single-instance 插件状态、跨平台表现与已知坑。
**调查日期**: 2026-09-10
**目标项目**：科室任务管理桌面 app（单人单写者、本地优先、跨 Linux/Windows/macOS；移动端不在本期范围）

---

## 1. 当前稳定版本与版本策略

| 组件 | 稳定版本 | 最近发布日期 | 来源 |
|---|---|---|---|
| `tauri` (core) | **2.11.5** | 2026-07-01 | https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.11.5 |
| `@tauri-apps/api` (JS) | 2.11.1 | 2026-06-17 | https://github.com/tauri-apps/tauri/releases/tag/@tauri-apps/api-v2.11.1 |
| `@tauri-apps/cli` | 2.11.4 | 2026-06-28 | https://github.com/tauri-apps/tauri/releases/tag/@tauri-apps/cli-v2.11.4 |
| `tauri-cli` | 2.11.4 | 2026-06-28 | https://github.com/tauri-apps/tauri/releases/tag/tauri-cli-v2.11.4 |
| `tauri-build` | 2.6.3 | 2026-06-17 | https://github.com/tauri-apps/tauri/releases/tag/tauri-build-v2.6.3 |
| `tauri-runtime-wry` | 2.11.4 | 2026-06-30 | https://github.com/tauri-apps/tauri/releases/tag/tauri-runtime-wry-v2.11.4 |
| `tauri-bundler` | 2.9.4 | 2026-06-28 | https://github.com/tauri-apps/tauri/releases/tag/tauri-bundler-v2.9.4 |

**版本策略**：Tauri 2.0 stable 在 2024-10-02 发布（[博客](https://v2.tauri.app/blog/tauri-20/)），自此持续小版本滚动升级。`dev` 分支是 v2 的活跃开发线，最近一次 commit 在 2026-09-10（`gh api repos/tauri-apps/tauri/commits?per_page=1`），主线维护活跃。截至调查日，未发现 3.0 路线图公告。

**结论**：Tauri 2.x 是当前主版本线，「优先稳定性、不追新」可直接 pin 到 2.11.x（最新次版本号）即可；2.11.x 与更早的 2.x 互相兼容，无需大规模重写。

---

## 2. SQLite 集成方式

可选三条路径，逐一评估：

### 路径 A：`tauri-plugin-sql`（JS API + sqlx）
- **版本**：`tauri-plugin-sql` v2.4.1（2026-08-31，[crates.io](https://crates.io/crates/tauri-plugin-sql) / [README](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/README.md)）
- **底层**：`sqlx` v0.9.0（2026-05-21）
- **优点**：内置 schema migration 工具（`Migration` struct + `Builder::add_migrations`）、JS 端可直接 `Database.load("sqlite:foo.db")`，跨进程契约清晰
- **缺点**：
  - iOS 不支持（[README 表格](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/README.md) 列 `iOS: x`）—— 本项目用不上，但需注意
  - BLOB 字段在 TS 端曾返回 JSON 字符串而不是数组（issue [#3476](https://github.com/tauri-apps/plugins-workspace/issues/3476)）
  - sqlite extension（custom functions）支持仍是个痛点（issue [#2622](https://github.com/tauri-apps/plugins-workspace/issues/2622) 长期 open）
  - 事务支持在 [#886](https://github.com/tauri-apps/plugins-workspace/issues/886) 上仍是 open 状态——若前端要显式事务则不便

### 路径 B：`rusqlite`（bundled feature）直接嵌入
- **版本**：`rusqlite` v0.40.2（2026-08-08，[crates.io](https://crates.io/crates/rusqlite) / [GitHub](https://github.com/rusqlite/rusqlite)）
- **优点**：
  - `bundled` feature 自动编进与平台无关的 SQLite，避免因用户机器上 sqlite 版本过老/缺失带来的二进制兼容性
  - 完全控制 schema、事务、索引；SQL 可集中放在 Rust 端，方便审计
  - 跨 Linux/Windows/macOS 一致；无 JS ↔ Rust 边界序列化开销
- **缺点**：
  - 需要自己写 migration runner（`rusqlite_migration` crate 可选），或简单 `PRAGMA user_version` 自管
  - 表不能直接从 JS 端访问，必须通过 `#[tauri::command]` 暴露

### 路径 C：`sqlx` 直接用
- 适合需要 PG/MySQL 的项目；本项目只用 SQLite，等于把 sqlx 的复杂度带进来但只用其子集，**不推荐**。

**推荐**：**路径 B（rusqlite + `bundled`）**。
**理由**：
1. 单人单写者场景下 schema 与查询都在 Rust 端集中维护，反而比把 SQL 散落在 JS 更可控
2. bundled feature 跨平台一致，避免「开发机 sqlite 3.39 vs 用户机 3.30」这类版本漂移问题
3. 对 Syncthing 同步的场景，写路径都在 Rust 端，事务边界明确，**没有「跨 IPC 半提交」的边界条件**
4. 迁移方案可选 `rusqlite_migration`（独立 crate），与 Tauri 版本无关、长期稳定

**暂不推荐**：`tauri-plugin-sql`。它真正的价值是让 JS 端能直接写 SQL；对本项目这种「前端只展示，业务逻辑全在 Rust」的分工模型，反而增加 surface 与版本耦合。

---

## 3. 推荐插件短名单

| 用途 | 包名 (Rust) | JS 包 | 当前版本 | Linux | Windows | macOS | 已知 issue / 风险 |
|---|---|---|---|---|---|---|---|
| OS 通知 | `tauri-plugin-notification` | `@tauri-apps/plugin-notification` | **2.4.0** (2026-08-31) | ✓ | ✓ | ✓ | Linux 需要 `libnotify` / `libayatana-appindicator`；macOS 需在 bundle 里勾选通知权限；首次调用需 `requestPermission()`（[README](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/notification/README.md)） |
| 系统托盘 / 菜单栏 | **内置 `tauri::tray`**，底层 `tray-icon` crate | `WebviewWindow.tray` (来自 `@tauri-apps/api`) | tauri 2.11.5 / `tray-icon` 0.24.2 (2026-07-27) | ✓（GTK 3 + libappindicator） | ✓ | ✓ | **Linux 不会发出 click 事件**，只显示右键菜单（见 `tauri/src/tray/mod.rs` doc 注释）；Wayland 下某些 DE 缺失托盘槽位 [#14234](https://github.com/tauri-apps/tauri/issues/14234)；macOS 重设 title/icon 时偶发消失 [#12060](https://github.com/tauri-apps/tauri/issues/12060)；Linux 重影 [#14226](https://github.com/tauri-apps/tauri/issues/14226) |
| 托盘定位 | `tauri-plugin-positioner` | `@tauri-apps/plugin-positioner` | 2.3.4 (2026-08-31) | ✓（但 Linux 上 `Position::Tray*` 可能 panic，见 [#2927](https://github.com/tauri-apps/plugins-workspace/issues/2927)） | ✓ | ✓ | Linux 上使用 `Tray*` 系列位置策略需谨慎，可考虑按平台分支 |
| 开机自启 | `tauri-plugin-autostart` | `@tauri-apps/plugin-autostart` | **2.5.1** (2025-10-27) | ✓（写 `.desktop` 到 `~/.config/autostart/`） | ✓（写 `HKCU\...\Run`） | ✓（LaunchAgent） | Windows 注册项偶发被覆盖 [#771](https://github.com/tauri-apps/plugins-workspace/issues/771)；Flatpak/Snap 下 Exec 字段需用 flatpak app id [#3166](https://github.com/tauri-apps/plugins-workspace/issues/3166) |
| 单实例锁 | `tauri-plugin-single-instance` | （无 JS API，事件发到 Rust） | **2.4.4** (2026-08-31) | ✓ | ✓ | ✓ | 必须 **第一个** 注册插件（README 强调插件按注册顺序初始化）；Windows 上 secondary 启动需请求 foreground 权限 [#3548](https://github.com/tauri-apps/plugins-workspace/issues/3548) |

> **注**：不存在 `tauri-plugin-tray-icon` 这个 crate（[crates.io 404](https://crates.io/crates/tauri-plugin-tray-icon)），托盘是 Tauri **core 自带** 的能力（`tauri::tray::TrayIconBuilder`，实现见 [`crates/tauri/src/tray/`](https://github.com/tauri-apps/tauri/tree/dev/crates/tauri/src/tray)），底层使用 `tauri-apps/tray-icon` v0.24.x。

**是否纳入 v1**：autostart 在 standing context 里写明「not required for v1 but should be surveyable」。本表已覆盖，**v1 可不引入**，依赖时再启用。其它四个（notification、tray、positioner、single-instance）建议在 v1 一起接入，因为 Syncthing 场景下「主进程不退出、点击系统托盘唤起窗口、误开第二个实例被合并」是一组连贯的体验。

---

## 4. 跨平台差异与已知坑

### Linux
- **托盘**：默认后端依赖 GTK 3 + `libappindicator`（或 `libayatana-appindicator`）+ `libxdo`（见 [tray-icon README](https://github.com/tauri-apps/tray-icon)）。Debian/Ubuntu：`sudo apt install libgtk-3-dev libxdo-dev libappindicator3-dev`；Arch：`pacman -S gtk3 xdotool libappindicator-gtk3`。KSNI 后端可作为不依赖 GTK 的替代
- **托盘 click 事件不触发**：Tauri 核心代码 `crates/tauri/src/tray/mod.rs` 注释明确「**Linux: Unsupported. The event is not emitted even though the icon is shown and will still show a context menu on right click**」。这意味着左键单击唤起主窗口的逻辑必须靠「窗口已隐藏 → 检测焦点」之类的方式在 Rust 端轮询，而不是监听 click 事件
- **Wayland 兼容**：[#14234](https://github.com/tauri-apps/tauri/issues/14234) Wayland 下 `.deb` 包看不到托盘图标（X11 OK，AppImage OK）；AppImage 在新版 Mesa 上有 hard crash（[#15976](https://github.com/tauri-apps/tauri/issues/15976), [#15902](https://github.com/tauri-apps/tauri/issues/15902)）
- **autostart**：写 `~/.config/autostart/*.desktop`；Flatpak 包要单独处理（[#3166](https://github.com/tauri-apps/plugins-workspace/issues/3166)）
- **single-instance**：通过 D-Bus / Unix socket 实现，机制透明但要注意 sandbox 包需要 `DBUS_ID`

### Windows
- **autostart**：写 `HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`；[#771](https://github.com/tauri-apps/plugins-workspace/issues/771) 报告偶发被清空的 case（open 状态，长期未复现）
- **托盘**：依赖系统托盘 API，工作正常；最小化到托盘时若使用 `Show` 触发 `set_focus`，偶发焦点在其它窗口后面（[#14795](https://github.com/tauri-apps/tauri/issues/14795)）
- **single-instance**：用 named mutex；[#3548](https://github.com/tauri-apps/plugins-workspace/issues/3548) Windows secondary 启动时需调用 `AllowSetForegroundWindow` 才能把主窗口拉到前台；plugin 已在 v2.4.x 中处理，但写自定义逻辑时要留意
- **App::cleanup_before_exit 崩溃**：[#12534](https://github.com/tauri-apps/tauri/issues/12534) 在非主线程触发清理会 crash，tray 资源释放要确保在主线程

### macOS
- **托盘**：依赖 `NSStatusItem`；[#12060](https://github.com/tauri-apps/tauri/issues/12060) 报告 `set_title` / 切换 icon 时偶发消失（open，未稳定复现）
- **autostart**：写 LaunchAgent（`~/Library/LaunchAgents/`）；sandbox 包需用 `SMAppService` ([#2720](https://github.com/tauri-apps/plugins-workspace/issues/2720))，open 中
- **通知**：bundle 必须勾选通知权限；`Info.plist` 里需要 `NSUserNotificationAlertStyle` 与 entitlement；首次调用前必须 `requestPermission()`
- **single-instance**：用 named port；逻辑与 Linux/Windows 一致

### 共性 / 全平台
- 插件必须按注册顺序初始化，**`tauri-plugin-single-instance` 必须第一个注册**（[README 强调](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/README.md)），否则 secondary 启动时主进程未必在
- 所有 v2.x 插件 require Rust ≥ 1.77.2（各 README）
- capabilities 文件必须显式声明权限，如 `"notification:default"`、`"tray:default"`

---

## 5. 推荐方案

**推荐（v1 集成）**：
- 核心：`tauri` 2.11.5 + `tauri-cli` 2.11.4 + `@tauri-apps/api` 2.11.1 + `@tauri-apps/cli` 2.11.4
- SQLite：**`rusqlite` 0.40.2 + `bundled` feature**，搭配 `rusqlite_migration`（独立 crate，schema 与 Tauri 版本解耦）
- 通知：`tauri-plugin-notification` 2.4.0 / `@tauri-apps/plugin-notification` 2.4.0
- 托盘：**内置 `tauri::tray`**（不引入额外插件），定位用 `tauri-plugin-positioner` 2.3.4，**Linux 上避免 `Position::Tray*`**
- 单实例：`tauri-plugin-single-instance` 2.4.4，必须第一个注册
- 开机自启：v1 **不引入**；v2 评估时再启用 `tauri-plugin-autostart` 2.5.1

**理由**：
1. **稳定性优先**：上述都是 2.x 主线当前最新稳定版（2026-06~08 发布），与 Rust ≥ 1.77.2 兼容；核心与插件都同属 `tauri-apps` 官方组织，发布节奏一致
2. **跨平台一致**：Linux/Windows/macOS 均原生覆盖（移动端不在本项目范围）
3. **数据完整性**：rusqlite + bundled + Syncthing 同步 = 没有 JS ↔ Rust 半提交边界；所有 schema 与事务集中在 Rust 端，审计面小
4. **Syncthing 友好**：单 SQLite 文件，bundled 后无外部动态库版本耦合，Syncthing 同步时只关心文件一致性即可

**暂不推荐**：
- `tauri-plugin-sql`：JS 端直写 SQL 对本项目没有收益，反而引入 sqlx 大版本升级窗口与 BLOB/事务等已知限制
- 第三方托盘 crate（如 `tray-icon` 直接调用而绕过 Tauri）：Tauri core 已封装，省一份集成成本
- 移动端插件（Android/iOS 通知、autostart）：本项目桌面 only，不增加 surface

---

## 6. 来源清单

- https://v2.tauri.app/ — Tauri 2.x 官网首页，确认 2.0 为主版本线
- https://v2.tauri.app/blog/tauri-20/ — Tauri 2.0 Stable Release 博客（2024-10-02），建立 2.0 时间锚点
- https://v2.tauri.app/learn/system-tray/ — 系统托盘文档，确认 tray 为 core 内置
- https://github.com/tauri-apps/tauri/releases — 核心 crate 版本节奏
- https://crates.io/crates/tauri — 当前 max stable 2.11.5 (2026-07-01)
- https://crates.io/crates/tauri-plugin-notification — 2.4.0 (2026-08-31)
- https://crates.io/crates/tauri-plugin-autostart — 2.5.1 (2025-10-27)
- https://crates.io/crates/tauri-plugin-single-instance — 2.4.4 (2026-08-31)
- https://crates.io/crates/tauri-plugin-sql — 2.4.1 (2026-08-31)
- https://crates.io/crates/tauri-plugin-positioner — 2.3.4 (2026-08-31)
- https://crates.io/crates/tray-icon — 0.24.2 (2026-07-27)，托盘底层库
- https://crates.io/crates/rusqlite — 0.40.2 (2026-08-08)
- https://crates.io/crates/sqlx — 0.9.0 (2026-05-21)
- https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/notification/README.md — notification 跨平台表格 + 安装文档
- https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/autostart/README.md — autostart 跨平台表格 + 安装文档
- https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/README.md — single-instance 跨平台表格 + 「必须先注册」约束
- https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/README.md — sql 插件跨平台表格 + migration 示例
- https://github.com/tauri-apps/tray-icon — tray-icon README，确认 Linux GTK 3 / libappindicator 依赖
- https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/tray/mod.rs — 核心源码注释：「Linux: Unsupported」事件说明
- https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/tray/plugin.rs — 确认 tray 是 plugin 形式注入 core
- https://github.com/rusqlite/rusqlite — bundled feature 说明
- https://github.com/tauri-apps/tauri/issues/12060 — macOS 托盘消失
- https://github.com/tauri-apps/tauri/issues/14226 — Linux 托盘重影
- https://github.com/tauri-apps/tauri/issues/14234 — Wayland 托盘缺失
- https://github.com/tauri-apps/tauri/issues/14795 — Windows 托盘点击焦点错位
- https://github.com/tauri-apps/tauri/issues/12534 — cleanup_before_exit 主线程崩溃
- https://github.com/tauri-apps/tauri/issues/15976 / 15902 — AppImage Wayland 崩溃
- https://github.com/tauri-apps/plugins-workspace/issues/771 — Windows autostart 被覆盖
- https://github.com/tauri-apps/plugins-workspace/issues/3166 — Flatpak autostart Exec 字段
- https://github.com/tauri-apps/plugins-workspace/issues/2927 — Linux positioner Tray panic
- https://github.com/tauri-apps/plugins-workspace/issues/3548 — single-instance Windows foreground
- https://github.com/tauri-apps/plugins-workspace/issues/3476 — sql BLOB JSON 序列化
- https://github.com/tauri-apps/plugins-workspace/issues/2622 — sqlite extension 加载
- https://github.com/tauri-apps/plugins-workspace/issues/886 — sql 事务支持 open

> 所有访问日期：2026-09-10。
