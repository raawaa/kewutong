/**
 * Electron 主进程入口（tickets #38 #40 #54）。
 *
 * 职责（#54 之后）：
 * - 单实例锁：第二个进程启动 → 立即 quit,但把已有实例的主窗口唤回。
 * - 起 `BrowserWindow` + 加载 `dist/index.html`（prod）/ Vite dev
 *   server（dev）。
 * - 装 AppState（db + clock + tray status）+ 注册 IPC handlers。
 * - 装 Tray + 菜单：托盘可达时 `trayStatus = Available`,失败时
 *   `Unavailable { reason: 中文短句 }`。
 * - 窗口生命周期：close → 默认 hide 到托盘；只有显式 `app.quit()` 才
 *   退出进程；activate（macOS dock 点击 / 单实例重复启动）唤回。
 */

import { app, BrowserWindow, type WebPreferences } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "./db.js";
import { SystemClock } from "./clock.js";
import { newAppState, DEFAULT_TRAY_STATUS, type AppState } from "./state.js";
import { registerAllIpc, resolveMigrationsDir } from "./ipc/register.js";
import * as Materialization from "./materialization/index.js";
import * as Scheduler from "./notification/scheduler.js";
import { createTray, pushTrayStatus, showMainWindow } from "./tray/index.js";
import {
  bindWillQuitUnregister,
  registerGlobalShortcut,
} from "./shortcut/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** dev 模式由 `electron-vite` 注入 `ELECTRON_RENDERER_URL`。 */
const DEV_SERVER_URL = process.env["ELECTRON_RENDERER_URL"];

/** prod 模式 renderer 产物位置（electron-vite 默认 out/renderer）。 */
const RENDERER_DIST = path.join(__dirname, "../renderer");

/** dev 模式 preload 产物位置（electron-vite 默认 out/preload）。 */
const PRELOAD_DIST = path.join(__dirname, "../preload");

/** prod preload 与 main 同目录（out/main + out/preload），dev 同上。 */
function resolvePreload(): string {
  if (DEV_SERVER_URL) {
    return path.join(PRELOAD_DIST, "index.mjs");
  }
  return path.join(__dirname, "../preload/index.mjs");
}

/** 统一的 BrowserWindow webPreferences——`createMainWindow` 与 `activate` 分支共用。 */
function makeWebPreferences(): WebPreferences {
  return {
    preload: resolvePreload(),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
  };
}

function loadRenderer(win: BrowserWindow): void {
  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: "科室任务管理",
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    webPreferences: makeWebPreferences(),
  });
  loadRenderer(win);
  return win;
}

/**
 * 把「关窗 = 隐藏到托盘」+ 「did-finish-load 补推 tray.status」两件
 * 事绑到窗口上——初始创建与 `activate` 重建共用,避免漂移。
 */
function attachWindowLifecycle(win: BrowserWindow, state: AppState): void {
  win.on("close", (e) => {
    if (!isQuitting && state.trayStatus.kind === "available") {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on("did-finish-load", () => pushTrayStatus(win, state));
}

// ---------------------------------------------------------------------------
// 全局 main-process 状态
// ---------------------------------------------------------------------------

/** 主窗口——单例；激活路径会重建。 */
let mainWindow: BrowserWindow | null = null;

/**
 * 区分「用户关窗」与「真退出」：
 * - 关窗 = 默认 hide 到托盘（托盘可用时）；
 * - 显式 `app.quit()`（托盘菜单「退出」/ 二次启动唤醒时若已 quit 等）
 *   = 走 `before-quit` → 这里置 true,窗口 close 事件就放行不再
 *   preventDefault。
 */
let isQuitting = false;

/** 单实例锁：第二个实例启动 → quit 自己，但已运行的实例把主窗口唤回。 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 用户从 Finder/Explorer 双击图标重新唤起——把主窗口拉回前台。
    if (mainWindow) {
      showMainWindow(mainWindow);
    }
  });

  app.whenReady().then(() => {
    const dbPath = path.join(app.getPath("userData"), "kewutong.sqlite");
    const db = openDatabase(dbPath, resolveMigrationsDir());
    const state = newAppState(db, new SystemClock());
    state.dbPath = dbPath;

    registerAllIpc(state);

    mainWindow = createMainWindow();
    attachWindowLifecycle(mainWindow, state);

    // 装托盘——失败时降级成 unavailable,不 panic。
    try {
      createTray({ window: mainWindow, state });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      state.trayStatus = {
        kind: "unavailable",
        reason: "系统托盘不可用，请检查系统设置。",
      };
      // 降级时再补一次推送——启动 banner 已经在 `DEFAULT_TRAY_STATUS`
      // 上展示「unavailable」,但这条更新带了真正的 reason。
      if (mainWindow) pushTrayStatus(mainWindow, state);
      console.error(`[tray] 托盘初始化失败：${detail}`);
    }

    // ⌘K / Ctrl+K 全局快捷键(ticket #55)。失败(Wayland / 被占用 /
    // 抛异常)时仅 warn,不 panic;`registerGlobalShortcut` 自己 log。
    if (mainWindow) {
      registerGlobalShortcut(mainWindow);
    }
    // 全局快捷键挂在 `will-quit` 唯一注销——避免 dev 重启时残留
    // 「ghost shortcut」(Electron 文档明确要求)。
    bindWillQuitUnregister();

    // -------------------------------------------------------------------------
    // Spec §M4 / ticket #56 — Materialization + Scheduler 启动 + 跨周触发
    // -------------------------------------------------------------------------
    //
    // 启动时立即跑一次物化（12 周窗口）+ 一次 scheduler（due_24h /
    // blocked_3d / weekly_digest）。`materializeIfNewWeek` 内部已经做
    // "current ISO week 与 meta `last_iso_year/week` 比较"的判定——
    // 启动时 meta 通常是 null（首次启动）或上一周的；首次启动强制跑一
    // 次,后续启动同 ISO 周内重复会被它自己拒掉,定时器兜底。
    //
    // 失败仅 console.error,不 panic（通知是后台能力）。
    try {
      Materialization.materializeIfNewWeek(state);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      console.error(`[materialization] 启动物化失败：${detail}`);
    }
    try {
      Scheduler.runAll(state);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      console.error(`[notification] 启动调度失败：${detail}`);
    }

    // 跨周检查 + 通知扫——每小时一次。`materializeIfNewWeek` 自带
    // ISO-week gate,只有真正跨入新一周时才落库；`runAll` 每小时跑
    // 一次也只算"扫描"代价,内部 dedup 阻止重复轰炸。
    const TICK_INTERVAL_MS = 60 * 60 * 1000; // 1h
    const tickHandle = setInterval(() => {
      try {
        Materialization.materializeIfNewWeek(state);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        console.error(`[materialization] tick 失败：${detail}`);
      }
      try {
        Scheduler.runAll(state);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        console.error(`[notification] tick 失败：${detail}`);
      }
    }, TICK_INTERVAL_MS);
    // 后台定时器不需要 keep process alive——`unref()` 让进程可以
    // 在没有其他阻挡时正常退出。
    tickHandle.unref();

    // 托盘可达：所有窗口关掉后保留 app（托盘常驻，进程不退）。
    // 托盘不可用：窗口关掉 = 没有 UI 也没有托盘 = 直接退——下次启动
    // 再试一次托盘初始化。这是「托盘不可用」的降级路径终点。
    app.on("window-all-closed", () => {
      if (state.trayStatus.kind !== "available") {
        app.quit();
      }
      // 否则 no-op: 托盘在,进程不退。
    });

    app.on("activate", () => {
      // macOS：Dock 图标被点 / Launchpad 唤回。
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
        attachWindowLifecycle(mainWindow, state);
      } else if (mainWindow) {
        showMainWindow(mainWindow);
      }
    });
  });

  app.on("before-quit", () => {
    // 让 window close 事件直接退出,不 hide。
    isQuitting = true;
  });
}

/** 暴露给测试与调试——不要在 main 业务代码里读。 */
export { DEFAULT_TRAY_STATUS };