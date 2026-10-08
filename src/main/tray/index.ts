/**
 * 系统托盘 + 菜单 + 窗口唤回（ticket #54）。
 *
 * 设计要点（对应 acceptance criteria）：
 * 1. **菜单项**：`打开主窗口` + `退出` + 分隔线。点击 `退出` 走
 *    `app.quit()`——这是唯一能退出进程的路径；其它路径（菜单 / 托盘图
 *    标 click / 单实例重复启动）都只是把窗口显示回来。
 * 2. **托盘图标 click**：Windows / Linux 左键唤回主窗口；macOS 不绑
 *    click（菜单栏图标由系统处理 left-click = open menu）。
 * 3. **托盘不可用降级**：`createTray` 失败时返回 `null`,`index.ts`
 *    据此把 `state.trayStatus` 翻成 `Unavailable { reason }` ——**不
 *    panic**。前端通过 `trayStatus` 命令拿到 reason 并展示 banner。
 * 4. **图标缺失兜底**：build 资源 `build/icon.png` 缺失时用
 *    `nativeImage.createEmpty()` —— 不让「图标缺」单独成为启动阻塞；
 *    此时仍然 `kind: 'available'`,菜单功能完整,只是系统托盘显示空
 *    图标。运维侧真正该看的是 build pipeline 是否漏拷资源。
 * 5. **事件推送**：tray 状态变更时通过 `webContents.send('tray.status',
 *    payload)` 推到 renderer,供 #55 IPC 事件总线（前端 banner 跟随托盘
 *    状态变化）使用。`tray.status` channel 名与 `src/preload/index.ts`
 *    中 `ipcRenderer.on('tray.status', ...)` 对齐——只有这一个约定,
 *    不再独立 `events.ts`（本期先收敛,后续 #55 拆出）。
 *
 * 纯函数 / 常量在 [`./dto.ts`]——`index.ts` 顶部 `import "electron"`
 * 会加载 Electron 二进制,vitest 跑 `tray.test.ts` 时改 import dto,
 * 跳过 Electron。
 */

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AppState } from "../state.js";
import { TRAY_STATUS_CHANNEL, trayStatusToDto } from "./dto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 重导出纯函数 / 常量——让 `src/main/index.ts` 等业务方只 import 一个
// barrel 入口；测试则改 import `./dto.js` 跳过 Electron 二进制加载。
// 直接 re-export 本文件的 import 绑定,避免 import + export ... from 同
// 一行的两份解析。
export { TRAY_STATUS_CHANNEL, trayStatusToDto };

/** 默认托盘图标路径——electron-builder 把 `build/` 作为 buildResources。 */
function defaultIconPath(): string {
  // src/main/tray/index.ts → ../../build/icon.png
  return path.join(__dirname, "../../build/icon.png");
}

/**
 * 把当前 `state.trayStatus` 推到指定窗口的 renderer。
 *
 * - 窗口已销毁 → 静默跳过（close→quit 边界竞态）。
 * - renderer 未加载完时 `webContents.send` 会丢消息,目前不重试——下
 *   一轮 IPC `trayStatus()` 命令会拿到最新值兜底。
 */
export function pushTrayStatus(window: BrowserWindow, state: AppState): void {
  if (window.isDestroyed()) return;
  window.webContents.send(TRAY_STATUS_CHANNEL, trayStatusToDto(state.trayStatus));
}

/** 显示主窗口——从托盘菜单 / 托盘 click / 单实例重复启动三处会聚到这里。 */
export function showMainWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** 从路径加载图标；缺失 / 解析失败时降级到空图。 */
function loadTrayIcon(iconPath: string): NativeImage {
  if (!fs.existsSync(iconPath)) {
    console.warn(`[tray] 图标缺失：${iconPath} —— 使用空图占位。`);
    return nativeImage.createEmpty();
  }
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.warn(`[tray] 图标无法解析：${iconPath} —— 使用空图占位。`);
  }
  return image;
}

export interface CreateTrayOptions {
  /** 主窗口——菜单「打开主窗口」/ 托盘 click 都唤回它。 */
  window: BrowserWindow;
  /** 全局 state——成功时翻 `trayStatus = Available`,事件推送也用它。 */
  state: AppState;
  /** 默认 `build/icon.png`,测试可注入临时图。 */
  iconPath?: string;
}

export interface CreateTrayResult {
  tray: Tray;
}

/**
 * 安装托盘 + 菜单 + 事件回调。失败时抛错——由调用方（`index.ts`）决定
 * 是不是降级成 `Unavailable`,这里不吞。
 *
 * 抛出 `Error` 而不是 `AppError`——`AppError.fromIo` 收敛到面向科长
 * 的中文消息 + IO code,而托盘创建失败是「平台/环境」问题,不该被
 * 前端当作业务 IO 错误弹窗。让 `index.ts` 用一个更适合的中文 reason
 * 填进 `TrayStatus.Unavailable`。
 */
export function createTray(options: CreateTrayOptions): CreateTrayResult {
  const { window, state, iconPath = defaultIconPath() } = options;

  const tray = new Tray(loadTrayIcon(iconPath));

  const template: MenuItemConstructorOptions[] = [
    {
      label: "打开主窗口",
      click: () => showMainWindow(window),
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        // 唯一能退出进程的入口——其它路径（菜单「打开主窗口」、托盘
        // 图标 click、单实例重复启动）都只唤回窗口。
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));

  tray.setToolTip("科室任务管理");

  // Windows / Linux：托盘图标 click = 唤回主窗口。
  // macOS：菜单栏图标 left-click 由系统展开菜单（不要绑 click，
  // 否则会和菜单一起触发导致窗口先显示又立即被菜单收起）。
  tray.on("click", () => {
    if (process.platform !== "darwin") {
      showMainWindow(window);
    }
  });

  state.trayStatus = { kind: "available" };
  pushTrayStatus(window, state);

  return { tray };
}