/**
 * 任务 6 状态的 renderer 侧领域概念（ticket #92 C1 P3）。
 *
 * 6 状态字符串字面（Open / In-progress / Blocked / Waiting-on / Done /
 * Cancelled）散落 5 个 renderer 文件、加上主进程 `TASK_STATUSES`，本
 * 模块作为 renderer 侧的唯一权威。所有 view / component 想列、查、排、
 * 渲染状态都走这里。
 *
 * 与主进程 `src/main/task/index.ts:TASK_STATUSES` / `BLOCKED_STATUSES`
 * / `IN_FLIGHT_STATUSES` 是**镜像**——两套各自独立写，但 `lib/taskStatus.test.ts`
 * 的 drift test 在 CI 拦住漂移。
 *
 * 类型层面：`InFlight` / `Blocked` 是 `Extract` / `Exclude` 的派生，
 * 编译期保证子集不写错。
 */

import type { TaskStatus } from "@/main/types";

// 类型再次导出方便 view 直接 `import type { TaskStatus } from "@/lib/taskStatus"`。
export type { TaskStatus };

/** 在飞四态——Open / In-progress / Blocked / Waiting-on（与 ADR 0003 §D6 同形）。 */
export type InFlight = Exclude<TaskStatus, "Done" | "Cancelled">;

/** 阻塞 / 等待二态——Blocked / Waiting-on（瓦片「Blocked」用）。 */
export type Blocked = Extract<TaskStatus, "Blocked" | "Waiting-on">;

/**
 * 6 状态的渲染顺序——Open 在前，Cancelled 在后，符合 chief 的关注优先级。
 *
 * 与 main 端 `TASK_STATUSES` 顺序一致；drift test 守两边同步。
 */
export const TASK_STATUS_ORDER: readonly TaskStatus[] = [
  "Open",
  "In-progress",
  "Blocked",
  "Waiting-on",
  "Done",
  "Cancelled",
] as const satisfies readonly TaskStatus[];

/** 在飞四态值列表——`IN_FLIGHT.includes(task.status)` 替代 `=== "Open" || === "In-progress" || ...`。 */
export const IN_FLIGHT: readonly InFlight[] = [
  "Open",
  "In-progress",
  "Blocked",
  "Waiting-on",
] as const satisfies readonly TaskStatus[];

/** 阻塞 / 等待二态值列表。 */
export const BLOCKED: readonly Blocked[] = [
  "Blocked",
  "Waiting-on",
] as const satisfies readonly TaskStatus[];

/**
 * 6 状态的元数据——中文 label + 锁定色板。
 *
 * 锁定色板（来自 `prototype/task-editing`）——全 app 任何视图里展示
 * 状态徽章都走这里，不在视图里再各自定义一份。改一处就同步所有调用
 * 点，避免「阻塞」在不同视图里颜色漂移。
 */
export interface StatusMeta {
  /** 中文 label——展示给科长。 */
  label: string;
  /** Tailwind className 字符串——锁定色板。 */
  className: string;
}

export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  Open: { label: "待开始", className: "bg-muted text-muted-foreground" },
  "In-progress": { label: "进行中", className: "bg-blue-50 text-blue-600" },
  Blocked: { label: "已阻塞", className: "bg-orange-50 text-orange-600" },
  "Waiting-on": { label: "等待中", className: "bg-yellow-50 text-yellow-600" },
  Done: { label: "已完成", className: "bg-green-50 text-green-600" },
  Cancelled: {
    label: "已取消",
    className: "bg-muted text-muted-foreground line-through",
  },
};