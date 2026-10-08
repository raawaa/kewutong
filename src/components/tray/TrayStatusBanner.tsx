/**
 * 托盘可达性 banner（ticket #29 验收点：「并给科长可见提示」）。
 *
 * 设计要点：
 * - 输入是启动时拉到的 [`TrayStatusDto`]；banner 只渲染不轮询——后续
 *   Rust 端通过事件总线推状态变化时再补一个 effect,本期只响应启动那
 *   一次的状态。
 * - `available = true` 或 `status = null`（拉数据中）→ 不渲染——避免短
 *   暂闪烁,也避免留一个占位空容器影响布局。
 * - `available = false` → `role="alert"` 节点上展示 reason。后端约定
 *   reason 是面向科长的中文短句,前端不二次包装——免得在 banner 里又
 *   出现"失败:失败"这种重复。
 * - reason 偶尔被后端回空时(实现 bug)仍然渲染——理由是「科长要看见
 *   出错了」比「reason 是空串就啥也不说」更安全,但显示一个保底文案,
 *   让科长看到「托盘不可用」这条事实。
 */
import type { TrayStatusDto } from "@/lib/api";

/** 后端不可用 + reason 空串时给科长看的兜底文案。 */
const FALLBACK_REASON = "托盘不可用，关闭主窗口会直接退出应用。";

export function TrayStatusBanner({
  status,
}: {
  /** 启动时拉到的托盘状态；`null` = 拉数据还没回来（不渲染）。 */
  status: TrayStatusDto | null;
}) {
  if (status == null || status.available) return null;

  const reason = status.reason.trim() === "" ? FALLBACK_REASON : status.reason;

  return (
    <div
      role="alert"
      className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border px-3 py-2 text-sm"
    >
      <span className="font-medium">托盘不可用</span>
      <span className="mx-2 text-destructive/60">·</span>
      <span>{reason}</span>
    </div>
  );
}