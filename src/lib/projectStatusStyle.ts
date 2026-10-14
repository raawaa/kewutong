/**
 * 项目 3 状态（Active / Done / Cancelled）的中文标签与色板。
 *
 * 与 `src/lib/taskStatusStyle.ts` 同一原则——锁定色板,改一处同步所有
 * 调用点,避免"在飞"在不同视图里颜色漂移。当前调用点：
 * - [`ProjectsView`](../../views/ProjectsView.tsx) 项目卡上的状态徽章
 * - [`PersonDetailView`](../../views/PersonDetailView.tsx)「负责的项
 *   目」段（#83 T3）每行项目的小徽章
 */
import type { ProjectStatus } from "@/lib/api";

export const PROJECT_STATUS_STYLE: Record<
  ProjectStatus,
  { label: string; className: string }
> = {
  Active: { label: "在飞", className: "bg-blue-50 text-blue-600" },
  Done: { label: "已完成", className: "bg-green-50 text-green-600" },
  Cancelled: {
    label: "已取消",
    className: "bg-muted text-muted-foreground line-through",
  },
};