/**
 * 入参校验：字符串处理单源。
 *
 * 命令层统一的必填字符串 / 可空字符串处理：trim 后空 → 抛 INVALID_ARGUMENT
 * 给科长看的中文 message；`null` / `undefined` 折叠为 `null`（DB 列可选）。
 *
 * 与原 Rust 端 `validate_required_string` / `validate_optional_string`
 * 同形。
 */

import { AppError } from "../error.js";

/**
 * 必填字符串——`null` / `undefined` / 纯空白 → 抛中文 `INVALID_ARGUMENT`。
 *
 * 签名接受 `string | null | undefined` 避免调用方在 nullable 字段上单独
 * 处理空值——一并在这里收敛,杜绝「task/index.ts 漏写 null 守卫」一类的
 * bug。
 */
export function requireNonBlank(
  value: string | null | undefined,
  message: string,
): string {
  if (value === null || value === undefined) {
    throw AppError.invalid(message);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) throw AppError.invalid(message);
  return trimmed;
}

/**
 * 可空字符串——`null` / `undefined` / 纯空白 → `null`；否则 trim 后落库。
 */
export function trimToOption(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}