/**
 * 前端访问 Rust 命令层的唯一入口。
 *
 * 约定：前端不含业务逻辑，只调命令、显示 DTO。每个命令在这里包一层带类型的函数，
 * 组件不直接写 `invoke`。
 */
import { invoke } from "@tauri-apps/api/core";

/** 与 Rust 端 `AppError` 的序列化形状一一对应。 */
export type AppError = {
  /** 机器可读的错误码，如 `INVALID_ARGUMENT`。 */
  code: string;
  /** 可直接展示给科长的中文消息。 */
  message: string;
  /** 给维护者排查用的技术细节，可能为空。 */
  detail: string | null;
};

export type PingReply = {
  message: string;
  now: string;
  schemaVersion: number | null;
  echo: string | null;
};

/** 探活：确认命令层、数据库、时钟都接好了。 */
export function ping(echo?: string): Promise<PingReply> {
  return invoke<PingReply>("ping", { echo });
}

/** 命令抛出来的一律是 `AppError` 形状；非预期异常也收敛成同一形状。 */
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
