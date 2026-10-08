/**
 * 主进程 IPC 注册中心（ADR 0008 §主进程注册）。
 *
 * 每个 domain 一个 registerXxx 模块，channel 名与命令名一一对应
 * （如 `personnel.list_sub_teams`）。错误统一收敛成 AppError
 * 形状（`{ code, message, detail }`）抛给 renderer。
 */

import { app, ipcMain } from "electron";
import type { IpcMain } from "electron";
import * as path from "node:path";
import { AppError } from "../error.js";
import { schemaVersion } from "../db.js";
import type { AppState } from "../state.js";

/**
 * 把命令函数包装成 ipcMain.handle 的 handler。
 *
 * - 入参从渲染进程 `invoke('cmd', args)` 拿到；本 wrapper 直接转发。
 * - 抛 AppError → 前端 `toAppError(thrown)` 收到一致形状。
 * - 抛非 AppError → 收敛成 `INTERNAL` 错误（detail = 原 message）。
 */
export function handle<TArgs, TReturn>(
  channel: string,
  command: (state: AppState, args: TArgs) => TReturn | Promise<TReturn>,
): (ipc: IpcMain, state: AppState) => void {
  return (ipc, state) => {
    ipc.handle(channel, async (_event, args: TArgs) => {
      try {
        return await command(state, args);
      } catch (cause) {
        if (cause instanceof AppError) {
          throw cause.toPayload();
        }
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw AppError.internal(detail).toPayload();
      }
    });
  };
}

/** 一个无入参命令。 */
export function handleVoid<TReturn>(
  channel: string,
  command: (state: AppState) => TReturn | Promise<TReturn>,
): (ipc: IpcMain, state: AppState) => void {
  return handle<undefined, TReturn>(channel, async (state, _args) => command(state));
}

/**
 * 注册 M1 阶段的最小命令集：ping + dataFileLocation。
 * 后续 M2 ticket 各自加 registerXxx 模块并在此统一注册。
 */
export function registerAllIpc(state: AppState): void {
  // ping — 探活，确认主进程 + DB + 时钟都接好了。
  handle<string | null | undefined, import("../types.js").PingReply>("ping", async (_state, echo) => {
    return {
      message: "pong",
      now: state.clock.nowSql(),
      schemaVersion: schemaVersion(state.db),
      echo: echo ?? null,
    };
  })(ipcMain, state);

  // dataFileLocation — 返回 SQLite 文件绝对路径，便于科长把它加进
  // Syncthing 同步目录。内存库 fixture 不设路径，这里返 null 时由命令层
  // 转成中文错误。
  handleVoid<string | null>("dataFileLocation", (state) => {
    return state.dbPath;
  })(ipcMain, state);

  // trayStatus — 启动时拉一次托盘可达性（前端 banner 用）。
  handleVoid<import("../types.js").TrayStatusDto>("trayStatus", (state) => {
    const status = state.trayStatus;
    return status.kind === "available"
      ? { available: true, reason: "" }
      : { available: false, reason: status.reason };
  })(ipcMain, state);
}

/**
 * 在 dev 模式下通过 `__dirname` 反推出 migrations 目录位置。
 * 打包后 resources 路径由 `process.resourcesPath` 给出。
 */
export function resolveMigrationsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "migrations");
  }
  // dev: src/main/migrations/
  return path.join(app.getAppPath(), "src/main/migrations");
}

/**
 * dev 模式下解析 holidays 目录（打包后由 extraResources 落到 resources/holidays）。
 */
export function resolveHolidaysDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "holidays");
  }
  return path.join(app.getAppPath(), "holidays");
}