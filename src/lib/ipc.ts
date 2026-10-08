/**
 * DEPRECATED: Tauri 迁移完成（issue #59）。所有 IPC 现在走 preload
 * 通过 `contextBridge.exposeInMainWorld("api", ...)` 暴露的 `window.api`
 * ——见 `src/preload/index.ts` 与 ADR 0008。
 *
 * 新代码必须从 `@/lib/api-types` 导入；本文件仅作为兼容 shim 留
 * 在 `src/lib/` 下，**不再包含任何 `@tauri-apps/*` 依赖**。
 *
 * 表面与原 Tauri 版一一对应（函数签名同形，DTO 同形，错误 shape
 * 同形）——历史 renderer 代码 `import { ... } from "@/lib/ipc"` 不必
 * 立即改写，仍可工作；推荐在后续清理 PR 中统一改写为 `@/lib/api-types`。
 */

export * from "./api-types";

// 下面这些类型原 `src/lib/ipc.ts` 在 Tauri 时代直接声明——
// `api-types.ts` 的 `export type {}` 块当时没把它们列进来,这里补齐
// 兼容,让 shim 的表面与原 `ipc.ts` 完全一致。
export type {
  TaskStatus,
  ProjectStatus,
  DueDateChip,
  PersonnelMatrixPerson,
  PersonnelMatrixSegment,
  TodayWeekCounts,
  TodayWeekBuckets,
  StructuredRule,
  RecurringFreq,
  RecurringHolidayBehavior,
  RecurringEnds,
  WayfinderMatchKind,
  WayfinderPersonHit,
  WayfinderProjectHit,
} from "@/main/types";

// byday bitmask 常量（与主进程 `src/main/recurring_template/index.ts`
// 里的 BYDAY_MO..BYDAY_SU 对应）。原 Tauri 版 `ipc.ts` 末尾就有这个
// 对象,shim 保留同形;UI 侧 `RecurringSheet` 用 `byday.MO | byday.WE`
// 这种写法拼周内组合。
export const byday = {
  MO: 1 << 0,
  TU: 1 << 1,
  WE: 1 << 2,
  TH: 1 << 3,
  FR: 1 << 4,
  SA: 1 << 5,
  SU: 1 << 6,
} as const;
