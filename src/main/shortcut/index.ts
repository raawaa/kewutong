/**
 * ⌘K / Ctrl+K 全局快捷键(ticket #55)。
 *
 * 设计要点(对应 acceptance criteria):
 *
 * 1. **Electron `globalShortcut`**: 注册 `CommandOrControl+K`(macOS 上
 *    自动落到 `⌘K`,其它平台落到 `Ctrl+K`)。触发时把主窗口从托盘拉
 *    回前台(`restore` + `show` + `focus`) + 推送 `shortcut.command-
 *    palette` IPC 事件——renderer 的 keydown 也会同时触发面板开启,
 *    但 IPC 通道给后续「在 macOS Dock / Windows 系统托盘点击之外需要
 *    唤起命令面板」的场景留下钩子(参见 ticket 验收点 #5)。
 *
 * 2. **平台降级**: Linux Wayland 下 GTK 全局快捷键不一定能注册成功
 *    (Electron 用 GTK accelerator,Wayland 的 portal 设计会拦截)——
 *    检测到 `XDG_SESSION_TYPE === "wayland"` 时主动跳过注册、log 告警,
 *    dev 模式 banner 沿用 #29 的设计在 UI 侧展示「快捷键不可用」。注
 *    册失败本身(`register` 返回 false / 抛异常)也按同样路径降级——
 *    不 panic,主进程继续运行,只是快捷键失活。
 *
 * 3. **卸载**:`globalShortcut.unregisterAll()` 必须挂在
 *    `app.on('will-quit', ...)`——否则快捷键会跨测试运行泄漏,用户在
 *    dev 重启 Electron 时已经触发不存在的 window(典型的"ghost
 *    shortcut")。`will-quit` 是 Electron 文档明确推荐的位置(参见
 *    https://www.electronjs.org/docs/latest/api/global-shortcut)。
 *
 * 4. **focus 要求**: 部分 Linux 桌面环境下,Electron 的 globalShortcut
 *    在系统层要求 app 必须已注册,并不要求 app 当前 focused——这点与
 *    `localShortcut` 不同。代码注释里标了这一点,免得后人误改
 *    `focus()` 调用时机。
 */

import { app, globalShortcut, type BrowserWindow } from "electron";

import { IPC_CHANNELS, sendEvent } from "../ipc/events.js";

/** 全局快捷键 accelerator——macOS 自动落到 ⌘K,其它平台落到 Ctrl+K。 */
const SHORTCUT_ACCELERATOR = "CommandOrControl+K";

/**
 * 检测 Linux Wayland 会话——`globalShortcut` 在 Wayland 下不可靠
 * (GTK accelerator 受 portal 拦截),主动跳过避免误导性的注册失败。
 *
 * `XDG_SESSION_TYPE=wayland` 是 systemd-logind 标准;`WAYLAND_DISPLAY`
 * 是 Wayland compositor 设置的环境变量,两者任一为真即认为 Wayland。
 * 检测只在 Linux 上做,其它平台直接返回 false。
 */
function isLinuxWayland(): boolean {
  if (process.platform !== "linux") return false;
  return (
    process.env["XDG_SESSION_TYPE"] === "wayland" ||
    process.env["WAYLAND_DISPLAY"] !== undefined
  );
}

/**
 * 注册 ⌘K / Ctrl+K 全局快捷键。Linux Wayland 直接跳过 + warn。
 *
 * 返回值: 成功注册返回 true;Wayland / 注册失败 / 抛异常时返回 false。
 * 调用方据此决定要不要走 banner 提示路径(本期不实现,后续 ticket)。
 *
 * 不要在 module top-level 调——`globalShortcut.register` 必须在
 * `app.whenReady()` 之后,否则会抛 `Failed to register ... not ready`。
 */
export function registerGlobalShortcut(window: BrowserWindow): boolean {
  if (isLinuxWayland()) {
    console.warn(
      `[shortcut] 检测到 Linux Wayland 会话,跳过全局快捷键注册:` +
        ` SHORTCUT_ACCELERATOR=${SHORTCUT_ACCELERATOR}。` +
        `请改用 localShortcut 或在 Wayland 桌面环境配置系统级快捷键。`,
    );
    return false;
  }

  try {
    const ok = globalShortcut.register(SHORTCUT_ACCELERATOR, () => {
      // 窗口已被用户关掉 / 重建中 → 静默跳过。close→quit 边界竞态
      // 里 mainWindow 可能短暂为 null,但这里只读 window 引用,安全。
      if (!window || window.isDestroyed()) return;

      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();

      // 推 IPC 事件——renderer 的 window-level keydown 在 show+focus
      // 后也会触发并打开面板,所以这条事件是「兜底通道」:即便用户配
      // 置让 keydown 被拦截(罕见),面板仍会通过这条事件被打开。
      sendEvent(window, IPC_CHANNELS.SHORTCUT_COMMAND_PALETTE, {
        shortcut: SHORTCUT_ACCELERATOR,
      });
    });

    if (!ok) {
      console.warn(
        `[shortcut] 注册全局快捷键失败(已被其它应用占用?):` +
          ` accelerator=${SHORTCUT_ACCELERATOR}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    // 某些 Linux 桌面(GNOME/KDE Wayland fallback 等)抛异常而不是返回
    // false——统一兜底成「注册失败」语义,不阻塞主进程。
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[shortcut] 全局快捷键注册异常:${detail}`);
    return false;
  }
}

/**
 * 注销所有全局快捷键——挂在 `app.on('will-quit', ...)` 唯一入口。
 *
 * 直接调 `globalShortcut.unregisterAll()`,不去记单条 accelerator——
 * 注册是 module-load 时的 `const`,不变量保证「只注册了一条」,且后续
 * ticket 还会追加更多 accelerator,届时由各自模块负责注销更精细。
 */
export function unregisterAllShortcuts(): void {
  globalShortcut.unregisterAll();
}

/**
 * 给 `index.ts` 用的「挂 will-quit」helper——测试也可绕过 app 直接调。
 */
export function bindWillQuitUnregister(): void {
  app.on("will-quit", unregisterAllShortcuts);
}
