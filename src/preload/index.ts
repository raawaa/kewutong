/**
 * Preload script（ADR 0008 §preload）。
 *
 * `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false` 下，
 * 渲染进程只能通过 `window.api` 这一唯一通道与主进程通信。每个方法是一
 * 个手写 typed wrapper——不暴露 `ipcRenderer` 原对象。
 *
 * 通道名 = 命令名一一对应（dot.case），便于跨 domain 分类与追踪。
 */

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

import type { PingReply, TrayStatusDto } from "@/main/types";

/** 渲染进程只能看到这一份 typed API。 */
const api = {
  ping: (echo: string | null): Promise<PingReply> =>
    ipcRenderer.invoke("ping", echo),

  dataFileLocation: (): Promise<string | null> =>
    ipcRenderer.invoke("dataFileLocation"),

  trayStatus: (): Promise<TrayStatusDto> =>
    ipcRenderer.invoke("trayStatus"),

  // —— 事件订阅（M3 阶段由 #54 / #55 补齐具体事件）——
  // 占位：当前无事件——tray / window / globalShortcut 在 #54 / #55 ticket
  // 里通过 `webContents.send` 推过来。
  onTrayStatus: (handler: (status: TrayStatusDto) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, status: TrayStatusDto): void => handler(status);
    ipcRenderer.on("tray.status", listener);
    return () => ipcRenderer.off("tray.status", listener);
  },
};

contextBridge.exposeInMainWorld("api", api);

// 给 TypeScript 一个 window.api 的声明（渲染进程 import 时拿到类型）。
export type KewutongApi = typeof api;