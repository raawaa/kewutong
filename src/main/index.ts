/**
 * Electron 主进程入口（M1 ticket #38）。
 *
 * 职责：起 `BrowserWindow` + 加载 `dist/index.html`（prod）/ Vite dev
 * server（dev）+ 装 AppState（db + clock + tray status）+ 注册 IPC
 * handlers。
 *
 * 体积代价 / tray / globalShortcut / single-instance / notification 三件事
 * 在 M3 阶段（tickets #54 / #55 / #56）补齐。本文件先开起得来。
 */

import { app, BrowserWindow } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "./db.js";
import { SystemClock } from "./clock.js";
import { newAppState, DEFAULT_TRAY_STATUS } from "./state.js";
import { registerAllIpc, resolveMigrationsDir } from "./ipc/register.js";

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
  return path.join(__dirname, "../preload/index.js");
}

/** 单写者本机场景下也允许启动多实例——single-instance 在 #54 接入。 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    const dbPath = path.join(app.getPath("userData"), "kewutong.sqlite");
    const db = openDatabase(dbPath, resolveMigrationsDir());
    const state = newAppState(db, new SystemClock());
    state.dbPath = dbPath;

    registerAllIpc(state);

    const win = new BrowserWindow({
      title: "科室任务管理",
      width: 1280,
      height: 800,
      minWidth: 1024,
      minHeight: 640,
      webPreferences: {
        preload: resolvePreload(),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });

    if (DEV_SERVER_URL) {
      void win.loadURL(DEV_SERVER_URL);
    } else {
      void win.loadFile(path.join(RENDERER_DIST, "index.html"));
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        // macOS：Dock 图标被点开时重建窗口。
        const w = new BrowserWindow({
          webPreferences: {
            preload: resolvePreload(),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        });
        if (DEV_SERVER_URL) {
          void w.loadURL(DEV_SERVER_URL);
        } else {
          void w.loadFile(path.join(RENDERER_DIST, "index.html"));
        }
      }
    });
  });

  app.on("window-all-closed", () => {
    // macOS 习惯：所有窗口关掉后保留 app（等 tray 接入后改；M3 #54 处理）。
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

/** 暴露给测试与调试——不要在 main 业务代码里读。 */
export { DEFAULT_TRAY_STATUS };