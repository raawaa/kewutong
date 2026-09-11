import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DueDateChipRow } from "./DueDateChipRow";
import { RecurringSheet, defaultEndsDate } from "./RecurringSheet";
import { TitleEditor } from "./TitleEditor";
import {
  createTask,
  listAssigneeCandidates,
  listDueDateOptions,
  listProjectCandidates,
  toAppError,
  updateTask,
  upsertRecurringTemplate,
  type AppError,
  type AssigneeCandidate,
  type DueDateOption,
  type ProjectCandidate,
  type StructuredRule,
  type Task,
  type UpsertRecurringTemplateArgs,
} from "@/lib/ipc";

/**
 * 打开弹窗的两种方式。
 *
 * **编辑即详情**（ticket #19）：点开一条已有任务就是 `edit`，字段与 `create`
 * 完全一致——没有独立的详情视图，也没有第二套改期手势。
 */
export type TaskDialogTarget =
  | { mode: "create" }
  | { mode: "edit"; task: Task; assignee: AssigneeCandidate | null; project: ProjectCandidate | null };

/**
 * 全局新建 / 编辑任务弹窗（tickets #19 + #20）。
 *
 * 科长想到一件事就能立刻录进去：打字写标题、`@` 挑人 / `#` 挑项目、chip 点
 * 截止日，一句话录完一条任务。
 */
export function TaskDialog({
  target,
  onClose,
  onSaved,
}: {
  target: TaskDialogTarget;
  onClose: () => void;
  onSaved: (task: Task) => void;
}) {
  const editing = target.mode === "edit" ? target.task : null;

  const [options, setOptions] = useState<DueDateOption[] | null>(null);
  const [title, setTitle] = useState(editing?.title ?? "");
  const [assignee, setAssignee] = useState<AssigneeCandidate | null>(
    target.mode === "edit" ? target.assignee : null,
  );
  const [project, setProject] = useState<ProjectCandidate | null>(
    target.mode === "edit" ? target.project : null,
  );
  // 新建时截止日**默认留空**——「今天是哪一天」由命令层定，但「默认要不要
  // 强行给一条任务加 deadline」是业务决定。让 科长主动选，而不是悄悄替他
  // 选一个。编辑态保留原值。
  const [dueDate, setDueDate] = useState<string | null>(editing?.dueDate ?? null);
  // 新建时四格都不高亮（提示"还没设"），用户点过任何一格后切换到普通逻辑：
  // 「无」chip 仅在用户主动选时高亮。
  const [dueDateTouched, setDueDateTouched] = useState(editing != null);
  const [description, setDescription] = useState(editing?.description ?? "");
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);

  // 周期性:tick toggle → 立即打开侧抽屉（票面 AC：「周期」toggle 直接跳
  // 侧抽屉,无内联摘要）。recurringRule 仅在「打开过抽屉并确认」后才有
  // 值——抽屉里点取消就当作没点过。
  const [recurringRule, setRecurringRule] = useState<StructuredRule | null>(
    null,
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const recurringOn = recurringRule != null;
  const defaultRule: StructuredRule = useMemo(
    () => ({
      freq: "weekly",
      bydayMask: 0,
      bymonthday: null,
      bymonth: null,
      byhour: 9,
      byminute: 0,
      ianaZone: "Asia/Shanghai",
      ends: {
        kind: "on",
        date: defaultEndsDate(),
      },
      holidayBehavior: "skip",
    }),
    [],
  );

  // chip 行的取值是**命令层**算的（今天是哪一天由可注入时钟说了算），
  // 前端开窗时取一次即可。
  useEffect(() => {
    let cancelled = false;
    listDueDateOptions()
      .then((fetched) => {
        if (cancelled) return;
        setOptions(fetched);
      })
      .catch((thrown) => {
        if (!cancelled) setError(toAppError(thrown));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 弹窗级 Esc：标题里的 `@` / `#` 下拉会先把自己的 Esc 吞掉（见
  // TitleEditor），所以下拉开着时这一下不会误关弹窗。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const canSave =
    title.trim().length > 0 &&
    assignee != null &&
    !saving &&
    !(recurringOn && (project == null)); // 周期任务必挂项目——子组级 + 项目级二选一(本弹窗只有项目)

  async function save() {
    if (!canSave || assignee == null) return;
    setSaving(true);
    try {
      const fields = {
        title,
        description: description.trim() ? description.trim() : null,
        ownerPersonId: assignee.personId,
        projectId: project?.projectId ?? null,
        dueDate,
      };
      let savedTask: Task;
      if (editing) {
        savedTask = await updateTask({ id: editing.id, ...fields });
      } else {
        savedTask = await createTask(fields);
      }
      // 周期性 + 新建 + 配好规则 → 顺手 upsert 模板。本票周期任务必挂
      // 项目(否则 subTeamId 必填,当前弹窗没暴露)；模板记录在 DB 走物
      // 化层,见 ticket #25。
      if (recurringOn && recurringRule && project) {
        const rule = recurringRule;
        const args: UpsertRecurringTemplateArgs = {
          id: null,
          name: title.trim().slice(0, 60) || "未命名模板",
          rule,
          projectId: project.projectId,
          subTeamId: null,
          notes: null,
        };
        await upsertRecurringTemplate(args).catch(() => {
          // 模板保存失败不回滚 task——模板可后续单独再配。
        });
      }
      setError(null);
      onSaved(savedTask);
    } catch (thrown) {
      setError(toAppError(thrown));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "编辑任务" : "新建任务"}
        className="bg-background flex w-full max-w-xl flex-col rounded-xl border shadow-lg"
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-sm font-semibold">
            {editing ? "编辑任务" : "新建任务"}
          </h2>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </Button>
        </header>

        <div className="flex flex-col gap-3.5 px-5 py-4">
          <TitleEditor
            initialTitle={editing?.title ?? ""}
            initialAssignee={target.mode === "edit" ? target.assignee : null}
            initialProject={target.mode === "edit" ? target.project : null}
            autoFocus
            disabled={saving}
            onChange={(value) => {
              setTitle(value.title);
              setAssignee(value.assignee);
              setProject(value.project);
            }}
            fetchAssigneeCandidates={(query) => listAssigneeCandidates({ query })}
            fetchProjectCandidates={(query) => listProjectCandidates({ query })}
            onSubmit={() => void save()}
          />

          <div className="grid grid-cols-[3.5rem_1fr] items-center gap-3">
            <span className="text-muted-foreground text-xs">截止</span>
            {options == null ? (
              <span className="text-muted-foreground text-xs">载入中…</span>
            ) : (
              <DueDateChipRow
                options={options}
                value={dueDate}
                noneHighlighted={dueDateTouched}
                onChange={(next) => {
                  setDueDate(next);
                  setDueDateTouched(true);
                }}
                disabled={saving}
              />
            )}
          </div>

          <details open={Boolean(editing?.description)}>
            <summary className="text-muted-foreground cursor-pointer text-xs">
              添加描述（可选）
            </summary>
            <textarea
              aria-label="描述"
              rows={3}
              value={description}
              disabled={saving}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="任务的详细描述…"
              className="border-input bg-background mt-2 w-full rounded-md border px-2.5 py-1.5 text-sm"
            />
          </details>

          {/* 周期性 toggle 行:打开直接跳侧抽屉,无内联摘要 */}
          <div
            data-on={recurringOn}
            className="bg-muted rounded-md px-3 py-2 text-sm"
          >
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                aria-label="设为周期性任务"
                data-testid="recurring-toggle"
                checked={recurringOn}
                disabled={saving}
                onChange={(event) => {
                  if (event.target.checked) {
                    setSheetOpen(true);
                  } else {
                    setRecurringRule(null);
                  }
                }}
              />
              <span className="font-medium">设为周期性任务</span>
            </label>
            {recurringOn && (
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                className="text-primary mt-1.5 text-xs underline-offset-2 hover:underline"
              >
                重新编辑规则 →
              </button>
            )}
          </div>

          {error && (
            <p
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
            >
              {error.message}
            </p>
          )}
          {title.trim().length > 0 && assignee == null && (
            <p className="text-muted-foreground text-xs">
              还没指派负责人——在标题里打 <code>@</code> 挑一个人。
            </p>
          )}
          {recurringOn && project == null && (
            <p className="text-muted-foreground text-xs">
              周期性任务需要挂一个项目——在标题里打 <code>#</code> 选一个。
            </p>
          )}
        </div>

        <footer className="bg-muted flex items-center justify-between gap-2 rounded-b-xl border-t px-5 py-2.5">
          <span className="text-muted-foreground text-xs">
            Enter 提交 · Esc 取消
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!canSave}>
              {editing ? "保存修改" : "创建"}
            </Button>
          </div>
        </footer>
      </div>

      {sheetOpen && (
        <RecurringSheet
          initialRule={recurringRule ?? defaultRule}
          templateName={title.trim()}
          onCancel={() => setSheetOpen(false)}
          onConfirm={(rule) => {
            setRecurringRule(rule);
            setSheetOpen(false);
          }}
        />
      )}
    </div>
  );
}
