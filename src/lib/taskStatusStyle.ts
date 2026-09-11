/**
 * 任务 6 状态的中文标签与色板。
 *
 * 锁定色板（来自 `prototype/task-editing`）——全 app 任何视图里展示状态徽
 * 章都走这里，不在视图里再各自定义一份。改一处就同步所有调用点，避免
 * "阻塞"在不同视图里颜色漂移。
 */
import type { TaskStatus } from "@/lib/ipc";

export const STATUS_STYLE: Record<
  TaskStatus,
  { label: string; className: string }
> = {
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