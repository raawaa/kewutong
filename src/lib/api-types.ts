/**
 * 前端访问主进程命令层的唯一入口（ADR 0006 §行为契约 + ADR 0008 §渲染进程 seam）。
 *
 * 约定：前端不含业务逻辑，只调命令、显示 DTO。每个命令在这里包一层带类型的函数，
 * 组件不直接写 `window.api.*`。
 *
 * 本文件是原 `src/lib/ipc.ts` 的平迁：函数签名同形态，函数体换成
 * `window.api.<command>(args)`。
 */

import type {
  AppErrorDto,
  PingReply,
  TrayStatusDto,
} from "@/main/types";

/** 与主进程 `AppError.toPayload()` 一一对应。 */
export type AppError = AppErrorDto;

export type {
  PingReply,
  TrayStatusDto,
};

// ---------------------------------------------------------------------------
// 探活 / 数据文件位置 / 托盘（tickets #38 / #39 / #40 + 后续 #54）
// ---------------------------------------------------------------------------

/** 探活：确认主进程、数据库、时钟都接好了。 */
export function ping(echo?: string | null): Promise<PingReply> {
  return window.api.ping(echo ?? null);
}

/** 数据文件位置——便于科长把它加进 Syncthing 同步目录。 */
export function dataFileLocation(): Promise<string | null> {
  return window.api.dataFileLocation();
}

/** 启动时拉一次托盘可达性，前端 banner 据此渲染。 */
export function trayStatus(): Promise<TrayStatusDto> {
  return window.api.trayStatus();
}

/** 订阅托盘状态变化事件（M3 ticket #54 接入后才有 emit）。 */
export function onTrayStatus(handler: (status: TrayStatusDto) => void): () => void {
  return window.api.onTrayStatus(handler);
}

/**
 * 命令抛出来的一律是 `AppError` 形状；非预期异常也收敛成同一形状。
 */
export function toAppError(thrown: unknown): AppError {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    "message" in thrown
  ) {
    return thrown as AppError;
  }
  return {
    code: "UNKNOWN",
    message: "发生了未知错误，请重试。",
    detail: String(thrown),
  };
}