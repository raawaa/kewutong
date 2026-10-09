# 托盘与窗口生命周期手工验证清单（ticket #29）

> 本期 acceptance criteria 第 5 条要求「macOS 有一份手工验证清单并已实际跑过」——这份清单就是给每次发版前回归用的。
>
> Vitest 已覆盖 IPC DTO 转换（`src/main/tray/tray.test.ts`）与 renderer banner 行为（`src/App.test.tsx`），但 GUI 行为（菜单栏 click、右键菜单、关窗是否进入托盘、Dock 图标切换）必须人工跑——headless 测试覆盖不到。

---

## 通用前置

- **构建**：`npm run build`（typecheck + electron-vite build + electron-builder 出 `.dmg`）；纯 electron-vite 构建用 `npm run build:app`（跳过 typecheck 与 electron-builder，dev-loop 调试时更省时）；dev 走 `npm run dev`（electron-vite dev，HMR 启用）。
- **配置**：`electron-builder.yml`（mac 段：`target: dmg`、`arch: [arm64, x64]`、`identity: '-'`、`notarize: false`）。
- **空 SQLite**：跑前清空 `~/Library/Application Support/kewutong/`，首次启动自动建表（`src/main/index.ts:125` 的 `dbPath = path.join(app.getPath('userData'), 'kewutong.sqlite')`）。
- **启动应用**：dev 模式直接看主窗口；prod 模式拖 `.dmg` 进「应用程序」，按 [`docs/distribution.md`](distribution.md)「方法 1 / 2 / 3」过 Gatekeeper。
- **主窗口标题**：「科室任务管理」（`src/main/index.ts:71`）。

---

## macOS（macOS 14+，Apple Silicon）

环境：Dock 栏、系统设置 → 控制中心 → 「菜单栏额外项目」默认。

> **2026-10-09 验证状态：blocked by [#75](https://github.com/raawaa/kewutong/issues/75)**
>
> T4 (#72) 首次在 macOS 15.6.1 arm64 上跑 dev 模式即撞上 preload (`.mjs`) 在 Chromium sandboxed preload loader 下加载失败 (`SyntaxError: Cannot use import statement outside a module`)。Renderer 三层 (`App` / `SampleDataBanner` / `TodayWeekView`) 全部 `TypeError: Cannot read properties of undefined (reading 'sample'/'task'/'personnel')` —— IPC bridge 没装上,主进程逻辑根本无法触达。本节全部 `- [ ]` 条目**未验证**,待 #75 修完重跑。
>
> 根因(非修复):`out/preload/index.mjs` 是真 ESM 但旁无 `package.json#type=module`;且 `src/main/index.ts:47` 的 prod 路径写的是 `index.js`,而 `electron-vite@5` 默认输出 `.mjs`,dev/prod 两边都对不上。详见 #75 完整诊断。

### 正常路径

- [ ] **关窗 = 隐藏到菜单栏**。点窗口左上红钮，主窗口消失；`⌘+Tab` 看不到应用入口；**菜单栏右侧出现 kewutong 图标**；进程仍在（活动监视器能看到）。
- [ ] **菜单栏唤回**。点击菜单栏图标 → 系统弹出右键菜单（含「打开主窗口 / 退出」）；点「打开主窗口」→ 主窗口回到屏幕。注：macOS 菜单栏图标的 left-click 由系统接管为「打开菜单」（见 `src/main/tray/index.ts:139-143` 的 `process.platform !== 'darwin'` 分支），不要误以为 click 没生效。
- [ ] **退出**。点菜单栏菜单的「退出」→ 进程结束，菜单栏图标消失。**这是唯一能退出进程的路径**（`src/main/tray/index.ts:125-129` 的 `app.quit()`）。
- [ ] **单实例重复启动**。应用已运行时，在终端再跑一次 `open /Applications/kewutong.app` → 不再开第二个进程，已有进程把主窗口拉回前台（`src/main/index.ts:113-122` 的 `requestSingleInstanceLock` + `second-instance` 监听）。
- [ ] **关窗 → hide → 唤回** 闭环。连续执行 5 次「关窗 → 菜单栏唤回」，每次唤回后主窗口都能正确显示在前台，没有焦点错位、菜单栏图标闪烁、进程泄漏等问题。

### 失败降级

- [ ] **托盘初始化失败时**：把 `build/icon.png` 临时改名（例如 `icon.png.bak`），重新 `npm run build` → 应用启动后**主窗口可见**，点关窗直接退出进程（不卡死、不静默失活）；前端 `trayStatus` IPC（命令在 `src/lib/api.ts:198`，IPC channel 常量 `tray.status` 在 `src/main/tray/dto.ts:18`）返回 `{ available: false, reason: "系统托盘不可用，请检查系统设置。" }` 或类似中文短句（见 `src/main/index.ts:138-148` 的 try/catch）；renderer 显示 `TrayStatusBanner`（`src/components/tray/TrayStatusBanner.tsx`）。
  - 注：当前实现里 `createTray` 内部对图标缺失有兜底（`nativeImage.createEmpty()`，见 `src/main/tray/index.ts:78-88`），所以这条「触发 unavailable」的实际路径在 macOS 上**较难触发**——若本次跑通后没有触发，注记「macOS 下当前实现未触发 unavailable 路径，但降级逻辑已就位」即可，**不需要强行造一个失败**。

### 验证记录

| 日期 | 分支 / commit | 环境 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-10-09 | `feat/electron-44-node-sqlite-68` @ HEAD（pre-#75） | macOS 15.6.1 arm64，`npm run dev` | ❌ blocked | preload (`.mjs`) sandbox 加载失败，详见 #72 macOS 段顶部 blockquote + [#75](https://github.com/raawaa/kewutong/issues/75) |
| 2026-10-08 | `master` @ `118ea03` | "verified locally" commit message | ⚠️ 构建产物 | typecheck / vitest 349/349 / `npm run build` 出 `.dmg` 三件都过，但**未真跑过 GUI 行为**——#66 / #72 之前没有强约束 |

---

## Linux / Windows（本期不发）

本期只发 macOS（[`docs/distribution.md`](distribution.md) 钉在 2026-10-08：Linux / Windows 以后再做）。Linux X11 / Wayland 与 Windows 的手工验证清单等对应平台正式开工时另开票维护——本文件不留空白框。`electron-builder.yml` 的 win / linux target 与 `.github/workflows/release.yml` 的多 runner 矩阵照旧保留，所以打 tag 时 Linux / Windows 产物**仍会照常构建并挂到 draft release 上**，但当前不承诺可用、不下载。

---

## 自动化测试覆盖一览

```
$ npm test -- src/main/tray/tray.test.ts
 ✓ src/main/tray/tray.test.ts (4)
   ✓ tray #54
     ✓ trayStatusToDto
       ✓ available → available: true, reason 为空
       ✓ unavailable → available: false, reason 原样透传
       ✓ DEFAULT_TRAY_STATUS 默认 unavailable
     ✓ IPC channel 常量
       ✓ TRAY_STATUS_CHANNEL 与 preload 对齐

$ npm test -- src/App.test.tsx
 ✓ src/App.test.tsx (8)
   ✓ App · 全局新建入口                    ← 非 tray 范围,本 doc 不展开,见 ticket #19
     ✓ 顶栏按钮唤起新建弹窗
     ✓ ⌘N 唤起新建弹窗
     ✓ 非 mac 的 Ctrl+N 一样唤起
     ✓ 切到人员界面后，⌘N 仍然唤起新建弹窗
     ✓ 切到人员界面后，顶栏按钮仍然唤起新建弹窗
   ✓ App · 托盘不可用 banner（ticket #29）
     ✓ tray_status 返回不可用时,主界面渲染 reason banner
       → TrayStatusBanner 渲染 role="alert" 节点 + reason 文案
     ✓ tray_status 返回可用时,主界面不渲染 banner
     ✓ tray_status 命令本身抛错时不臆测状态——banner 保持 null 不渲染
       → IPC 抛错 → 不臆测 unavailable → 不假报「托盘不可用」给科长
```

Vitest 覆盖的是「IPC DTO 契约」（`src/main/tray/dto.ts` 的 `trayStatusToDto` 转换 + `TRAY_STATUS_CHANNEL` 常量；`src/lib/api.ts:198` 的 `trayStatus()` IPC 命令封装）和「IPC 命令抛错时的退化」（不臆测状态）。**不能**自动化、必须人工的部分：菜单栏 click 行为、关窗是否进入菜单栏、Dock 显隐、`⌘+Tab` 不响应应用入口。

> 关于 `App.test.tsx` 的 `App · 全局新建入口` 5 个测：不在 tray 范围内，是 ticket #19（全局新建入口）的 AC 覆盖——见 `src/App.test.tsx:66-116`。本 doc 只覆盖 tray 相关子集，避免误把非 tray 行为算入 tray 验证范围。

---

## 复测节奏

- **每次发版前** 跑 macOS 全部条目（Apple Silicon 必跑；Intel 若能借到 runner / 机器就一并跑）。
- **升级 Electron / electron-builder 主版本后** 重跑全部——API 行为可能漂移（菜单栏策略、Dock 行为、`requestSingleInstanceLock` 语义）。
