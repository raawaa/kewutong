/**
 * 「点徽章 → 6 项菜单」手势（tickets #20 / #22）。
 *
 * 全 app 唯一的状态变更入口：点徽章弹出 6 项菜单，选中后调用
 * `set_task_status` 命令。其它视图（项目看板、矩阵、未来详情视图）复用
 * 同一组件——避免业务手势在多处漂移。
 *
 * 设计要点：
 * - 菜单开合靠 `aria-expanded` + 点击外部 / Esc 关闭；不引外部 popover lib。
 * - `reason` / `waiting_on_person_id` 由弹层内部的"为什么"输入框一并采集，
 *   Blocked / Waiting-on 下必填（后端预检），其它状态忽略。
 * - Waiting-on 额外多一步"在等谁"选人——空选合法（"等系统"），spec #21 US-22。
 * - 不在 Save 上自己做校验细节——交给后端命令层（中文错误回传即可）。
 */
import { useEffect, useRef, useState } from "react";
import { STATUS_STYLE } from "@/lib/taskStatusStyle";
import {
  listAssigneeCandidates,
  type AssigneeCandidate,
  type Task,
  type TaskStatus,
} from "@/lib/ipc";

const STATUSES: TaskStatus[] = [
  "Open",
  "In-progress",
  "Blocked",
  "Waiting-on",
  "Done",
  "Cancelled",
];

const STATUS_LABELS: Record<TaskStatus, string> = {
  Open: "待开始",
  "In-progress": "进行中",
  Blocked: "已阻塞",
  "Waiting-on": "等待中",
  Done: "已完成",
  Cancelled: "已取消",
};

export function TaskStatusMenu({
  task,
  disabled,
  onChange,
}: {
  task: Task;
  /** 整体禁用——父视图正在拉数据时按 true。 */
  disabled?: boolean;
  /**
   * 用户在菜单里选完一项、填好 reason 后,父层用新 status + reason +
   * waiting_on_person_id 调 `set_task_status`。父层负责把命令层抛出的
   * 中文错误展示出来；本组件不做错误展示。
   */
  onChange: (next: {
    status: TaskStatus;
    blockedReason: string | null;
    waitingOnPersonId: number | null;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<TaskStatus | null>(null);
  const [reason, setReason] = useState("");
  const [waitingOnId, setWaitingOnId] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<AssigneeCandidate[] | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  // 打开菜单 / 进入 Waiting-on 子面板时才拉在岗人员候选。
  useEffect(() => {
    if (!open || pending !== "Waiting-on" || candidates != null) return;
    let cancelled = false;
    listAssigneeCandidates({ query: null })
      .then((list) => {
        if (!cancelled) setCandidates(list);
      })
      .catch(() => {
        // 命令层失败不影响其它路径——选"空"(等系统)也是合法的。
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, pending, candidates]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function close() {
    setOpen(false);
    setPending(null);
    setReason("");
    setWaitingOnId(null);
  }

  function select(status: TaskStatus) {
    if (status === task.status) {
      close();
      return;
    }
    // 进入 Blocked / Waiting-on 需要 reason——保留选中态等用户填好提交;
    // 其它状态直接回调、关菜单。
    if (status === "Blocked" || status === "Waiting-on") {
      setPending(status);
      return;
    }
    onChange({ status, blockedReason: null, waitingOnPersonId: null });
    close();
  }

  function confirmPending() {
    if (pending == null) return;
    onChange({
      status: pending,
      blockedReason: reason.trim() ? reason.trim() : null,
      waitingOnPersonId: pending === "Waiting-on" ? waitingOnId : null,
    });
    close();
  }

  const style = STATUS_STYLE[task.status];

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`状态：${style.label}，点击修改`}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={`cursor-pointer rounded-full px-2 py-0.5 text-[10px] font-medium ${style.className}`}
      >
        {style.label}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="修改状态"
          className="bg-popover text-popover-foreground absolute left-0 top-full z-20 mt-1 w-56 rounded-md border p-1 shadow-md"
        >
          {pending == null ? (
            <ul className="flex flex-col">
              {STATUSES.map((status) => {
                const selected = status === task.status;
                return (
                  <li key={status}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => select(status)}
                      className={`hover:bg-muted flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs ${
                        selected ? "font-semibold" : ""
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[status].className}`}
                        >
                          {STATUS_LABELS[status]}
                        </span>
                      </span>
                      {selected && <span aria-hidden>✓</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-col gap-2 p-1">
              <p className="text-muted-foreground text-xs">
                {pending === "Blocked" ? "卡在何处？" : "在等什么？"}
              </p>
              <input
                autoFocus
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && reason.trim()) {
                    event.preventDefault();
                    confirmPending();
                  }
                }}
                placeholder="写一句原因"
                className="border-input bg-background w-full rounded-md border px-2 py-1 text-xs"
              />
              {pending === "Waiting-on" && (
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">在等谁（可空）</span>
                  <select
                    value={waitingOnId ?? ""}
                    onChange={(event) =>
                      setWaitingOnId(
                        event.target.value === ""
                          ? null
                          : Number(event.target.value),
                      )
                    }
                    className="border-input bg-background w-full rounded-md border px-2 py-1 text-xs"
                  >
                    <option value="">不指定（如等系统）</option>
                    {(candidates ?? []).map((c) => (
                      <option key={c.personId} value={c.personId}>
                        {c.name} · {c.subTeamName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="flex justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setPending(null)}
                  className="text-muted-foreground hover:text-foreground rounded-sm px-2 py-1 text-xs"
                >
                  返回
                </button>
                <button
                  type="button"
                  disabled={!reason.trim()}
                  onClick={confirmPending}
                  className="bg-primary text-primary-foreground rounded-sm px-2 py-1 text-xs disabled:opacity-50"
                >
                  保存
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
