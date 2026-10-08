/**
 * 全 app 统一的错误类型（ADR 0006 §行为契约）。
 *
 * 与原 Rust 端 `AppError` 同形：机器可读 `code` + 面向科长的中文 `message` +
 * 给维护者看的英文 `detail`。前端只负责展示 `message`，不解析 `detail`。
 *
 * 序列化形状 = `{ code, message, detail }`——与前端 `AppError` 类型一一对应。
 */

import type { Database } from "better-sqlite3";

/** 命令层与仓储层统一的 Result。 */
export type Result<T> = T extends never ? never : { ok: true; value: T } | { ok: false; error: AppError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(error: AppError): Result<never> {
  return { ok: false, error };
}

/** `code` 字面量集合——前端据此分支。 */
export type AppErrorCode =
  | "DATABASE"
  | "MIGRATION"
  | "IO"
  | "INTERNAL"
  | "INVALID_ARGUMENT";

/** 面向科长的固定中文消息——与原 Rust 端一一对应。 */
const DATABASE_MESSAGE = "数据库读写失败，请稍后重试；若反复出现请联系维护者。";
const MIGRATION_MESSAGE = "数据库升级失败，请联系维护者。";
const IO_MESSAGE = "读写数据文件失败，请检查磁盘空间与目录权限。";
const INTERNAL_MESSAGE = "应用内部状态异常，请重启应用。";

/** 序列化形状——前端实际看到的契约。 */
export interface AppErrorPayload {
  code: AppErrorCode;
  message: string;
  detail: string | null;
}

/** 错误类——命令层只抛这一个类型。 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  /** 给科长看的中文消息（`InvalidArgument` 时是构造时传入的入参错误消息）。 */
  readonly message: string;
  /** 给维护者看的技术细节，`InvalidArgument` 时为 null。 */
  readonly detail: string | null;

  private constructor(code: AppErrorCode, message: string, detail: string | null) {
    super(detail ? `${message}：${detail}` : message);
    this.code = code;
    this.message = message;
    this.detail = detail;
    this.name = "AppError";
  }

  /** 入参不合法——`message` 必须是能直接展示给科长的中文。 */
  static invalid(message: string): AppError {
    return new AppError("INVALID_ARGUMENT", message, null);
  }

  /** 应用内部状态异常。 */
  static internal(message: string): AppError {
    return new AppError("INTERNAL", INTERNAL_MESSAGE, message);
  }

  /** 从 better-sqlite3 抛错收敛。 */
  static fromSqlite(error: unknown): AppError {
    const detail = error instanceof Error ? error.message : String(error);
    return new AppError("DATABASE", DATABASE_MESSAGE, detail);
  }

  /** 从 IO 异常收敛。 */
  static fromIo(error: unknown): AppError {
    const detail = error instanceof Error ? error.message : String(error);
    return new AppError("IO", IO_MESSAGE, detail);
  }

  /** 从迁移失败收敛。 */
  static fromMigration(error: unknown): AppError {
    const detail = error instanceof Error ? error.message : String(error);
    return new AppError("MIGRATION", MIGRATION_MESSAGE, detail);
  }

  /** 序列化为前端契约。 */
  toPayload(): AppErrorPayload {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

/**
 * 命令层返回 DTO 时一律走「抛 AppError / 返回 DTO」二选一：
 * - 不抛时 = 返回 DTO；
 * - 抛时 = 一定是 AppError，前端 `toAppError(thrown)` 收得到一致形状。
 *
 * 这里不强制 `Result<T>`——main IPC glue 直接 try/catch + AppError.serialize
 * 即可；测试侧也只断言 `await expect(...).rejects.toThrow(...)`。
 */
export type { Database };