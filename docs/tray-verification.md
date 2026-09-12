# 托盘与窗口生命周期手工验证清单（ticket #29）

> 本期 acceptance criteria 第 5 条要求「三平台各有一份手工验证清单并已实际跑过（含 Wayland 与 macOS 两个已知失踪场景）」。这份清单就是给后续每次发版前回归用的。
>
> Rust 端已有 9 条集成测试（`cargo test --test tray`）覆盖平台分支、状态机、`tray_status` 命令,但 GUI 行为（点击、右键、隐藏 dock 图标、托盘消失场景）必须人工跑过——这部分在 headless 测试里没法覆盖。

---

## 通用前置

- 编译:`cargo tauri build` 拿到 release 包,或者 `cargo tauri dev` 起开发版
- 准备一份空 SQLite 库(`$XDG_DATA_HOME/com.raawaa.kewutong/kewutong.db` 等)
- 起动应用,看到主窗口标题「科室任务管理」

## macOS（macOS 14+，Apple Silicon）

环境：Dock 栏、系统设置 → 控制中心 → 「菜单栏额外项目」默认。

### 正常路径

- [ ] **关窗 = 隐藏到菜单栏**。点窗口左上红钮,窗口消失;`⌘+Tab` 看不到应用图标;**菜单栏右侧出现 kewutong 图标**;Dock 不再有图标。
- [ ] **菜单栏唤回**。点击菜单栏图标 → 弹菜单「显示主窗口 / 退出」;点「显示主窗口」→ 窗口回到屏幕,Dock 图标重新出现。
- [ ] **退出**。点菜单栏菜单的「退出」→ 进程结束,菜单栏图标消失。
- [ ] **单实例重复启动**。应用已运行时,在终端再跑一次二进制 → 不再开第二个窗口,已有窗口被唤回前台。
- [ ] **激活策略切换**。第一次隐藏后,Dock 图标确实没了（不是只最小化窗口）。唤回后,Dock 图标恢复。

### 已知场景回归

- [ ] **托盘消失场景（tauri#12060）**。连续唤回 / 隐藏 30 次,菜单栏图标始终稳定——虽然 #12060 未稳定复现,但本期不调 `set_title` / `set_icon`,baseline 上不应触发。

### 失败降级

- [ ] **托盘构建失败时**:在 `tauri.conf.json` 把 `bundle.icon` 路径改坏(临时),重新 build → 应用启动后**主窗口可见**,点关窗直接退出进程;前端 `tray_status` 命令返回 `available: false` + 一条中文 reason。

---

## Linux X11（Ubuntu 22.04 / GNOME）

环境：`libappindicator3-1`、`libgtk-3-0`、`libxdo-dev` 已装（research #8 §4）。

### 正常路径

- [ ] **关窗 = 隐藏到托盘**。点窗口右上 X 钮,主窗口消失;**顶部状态栏右侧出现 kewutong 图标**;进程仍在（`ps aux | grep kewutong`）。
- [ ] **右键菜单唤回**。点托盘图标右键 → 弹菜单「显示主窗口 / 退出」;选「显示主窗口」→ 主窗口回到屏幕。
- [ ] **退出**。右键菜单选「退出」→ 进程结束。
- [ ] **左键唤回**。按 tauri 注释（`crates/tauri/src/tray/mod.rs`），**Linux click 事件不触发**，左键应该是 no-op 或弹出右键菜单（取决于 libappindicator 版本），不是直接唤回。这是已知限制,文档已记。
- [ ] **避开 Tray* 位置**。唤回主窗口后，窗口位置在屏幕右下角附近(`Position::BottomRight`),不调用 `Position::Tray*` 系列——Rust 编译期分支保证(`for_current_platform` 单测已覆盖)。

### 已知场景回归

- [ ] **依赖缺失场景**。在容器里卸掉 `libappindicator3-1`,启动应用 → 主窗口可见,关窗正常退出,`tray_status` 命令返回 `available: false` + reason 形如「注册托盘失败：libappindicator …」。**不 panic**。

---

## Linux Wayland（Ubuntu 22.04 / GNOME Wayland）

环境：登录会话选 GNOME on Xorg 反例——必须 Wayland 会话。`echo $XDG_SESSION_TYPE` 应输出 `wayland`。

### 已知失踪场景（tauri#14234）

- [ ] **托盘图标可能出现也可能不出现**。这是上游已知 bug——Wayland 下某些 DE 给 SNI（StatusNotifierItem）协议的实现不一致。验收口径是：**若图标出现了**,右键菜单能唤回;**若图标没出现**,前端 `tray_status` 命令仍能拿到 reason 给科长看（图标从未注册成功时,降级逻辑生效）。
- [ ] **降级提示**。在 Wayland 没托盘图标的机器上启动 → 主窗口可见;关窗正常退出（不卡死也不静默失活);前端如果有 banner 应展示 reason。

### 正常路径（若托盘出现）

- [ ] **关窗 = 隐藏**。点 X 钮,主窗口消失;进程仍在。
- [ ] **右键菜单唤回 / 退出**。同上 X11。

---

## Windows 10/11

### 正常路径

- [ ] **关窗 = 隐藏到托盘**。点右上 X 钮,主窗口消失;**任务栏右下角系统托盘出现 kewutong 图标**;进程仍在（任务管理器能看到 `kewutong.exe`）。
- [ ] **左键唤回**。点托盘图标左键 → 主窗口回到前台（macOS 同样行为)。
- [ ] **右键菜单**。右键图标 → 弹菜单「显示主窗口 / 退出」。
- [ ] **退出**。选「退出」→ 进程结束,托盘图标消失。
- [ ] **单实例重复启动**。再次运行 `kewutong.exe` → 不开新窗口,已有窗口被唤回（[#3548](https://github.com/tauri-apps/plugins-workspace/issues/3548) 报告需要 `AllowSetForegroundWindow`,plugin 2.4.x 已处理）。

### 已知场景

- [ ] **焦点错位（#14795）**。从其它应用切回时,若出现焦点没拉到前台,点托盘图标左键仍能把窗口拉到最前。

---

## 跨平台通用:降级路径

> 这条最重要——托盘不可用时不能让应用半残。

- [ ] **托盘初始化失败**:
  - 拿到 release 包后,临时改 `tauri.conf.json` 的 `bundle.icon[0]` 指向不存在的文件 → 重 build → 启动应用
  - 预期:主窗口正常出现,关窗走默认行为(进程退出,不卡住),前端 `tray_status` 命令返回 `{available: false, reason: "..."}`
  - **绝不能**:panic、应用半残、关窗后菜单栏图标残留

---

## 自动化测试覆盖一览

```
$ cargo test --test tray
running 9 tests
test 托盘定位策略_按当前平台返回正确变体 ... ok
test 托盘菜单项_id_是稳定字符串 ... ok
test 托盘状态默认值是_不可用_且带原因 ... ok
test 托盘状态_set_available_后能读出_available ... ok
test 托盘状态_set_unavailable_后能读出_unavailable_并带原因 ... ok
test tray_status_命令_默认返回_unavailable ... ok
test tray_status_命令_设置_available_后返回_available_且原因为空 ... ok
test tray_status_命令_dto_字段是_camel_case ... ok
test tray_status_命令_返回的_dto_与状态机的不可用路径一致 ... ok

test result: ok. 9 passed; 0 failed
```

单元覆盖：`kewutong_lib::tray` 模块内 `tests` 子模块两条（平台分支 + menu_id 稳定性）。

不能自动化、必须人工的部分：菜单项视觉呈现、托盘 click 行为、Wayland 失踪场景、macOS dock 切换。

---

## 复测节奏

- **每次发版前** 跑 macOS + Linux X11（开发机默认）。
- **每季度** 在 Wayland 机器上跑一次失踪场景回归——`tauri#14234` 上游若关掉,这条可以淡化。
- **依赖变更后**(升级 tauri / libappindicator):重跑 macOS 全部 + Linux X11 全部。
