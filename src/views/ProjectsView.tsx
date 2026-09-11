import { useEffect, useMemo, useState } from "react";
import { Plus, CalendarDays, UserRound, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createProject,
  deleteProject,
  listPeople,
  listProjects,
  listSubTeams,
  listTasks,
  setTaskStatus,
  toAppError,
  updateProject,
  type AppError,
  type Person,
  type Project,
  type ProjectStatus,
  type SubTeam,
  type Task,
  type TaskStatus,
} from "@/lib/ipc";
import { STATUS_STYLE } from "@/lib/taskStatusStyle";

/**
 * 项目状态（Active / Done / Cancelled）的色板——三色一一映射,与上面任务
 * 6 状态色的"已完成 / 已取消"对齐。Active 用 blue-50 区分于任务的
 * Open（muted），因为 Active 的语义更广（"还在飞"）而非单纯的"待开始"。
 */
const PROJECT_STATUS_STYLE: Record<ProjectStatus, { label: string; className: string }> = {
  Active: { label: "在飞", className: "bg-blue-50 text-blue-600" },
  Done: { label: "已完成", className: "bg-green-50 text-green-600" },
  Cancelled: { label: "已取消", className: "bg-muted text-muted-foreground line-through" },
};

const STATUS_COLUMNS: TaskStatus[] = [
  "Open",
  "In-progress",
  "Blocked",
  "Waiting-on",
  "Done",
  "Cancelled",
];

interface BlockedDropPrompt {
  task: Task;
  status: Extract<TaskStatus, "Blocked" | "Waiting-on">;
}

/**
 * 项目看板（ticket #20）。
 *
 * 左侧：项目卡网格——`status` 由视图层从 task 聚合（项目状态不是用户维护的）。
 * 右侧：所选项目名下任务的 6 状态分列。拖动任务卡到另一列 = 改状态
 * （走 [`set_task_status`]，全 app 唯一的状态变更入口）。
 *
 * 拖拽语义唯一——只在项目看板出现，其它视图（任务列表 / 人员）没有拖拽。
 * Blocked / Waiting-on 落列时弹小表单收集 reason 与可选 waiting_on。
 */
export function ProjectsView({ refreshToken }: { refreshToken: number }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [subTeams, setSubTeams] = useState<SubTeam[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [editing, setEditing] = useState<
    | { kind: "new" }
    | { kind: "edit"; project: Project }
    | null
  >(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const [includeDone, setIncludeDone] = useState(true);
  const [dropPrompt, setDropPrompt] = useState<BlockedDropPrompt | null>(null);
  const [dropReason, setDropReason] = useState("");
  const [dropWaitingOn, setDropWaitingOn] = useState<number | null>(null);

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDone, refreshToken]);

  // 默认选第一个项目
  useEffect(() => {
    if (selectedProjectId == null && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  async function refreshAll() {
    setBusy(true);
    try {
      const [teams, roster, projectList, allTasks] = await Promise.all([
        listSubTeams(),
        listPeople({ includeDeactivated: true, subTeamId: null }),
        listProjects({ includeDone }),
        // 取在飞任务（默认 include_cancelled=false），看板不需要 Done / Cancelled
        // 之外的历史——但仍要把选中的项目名下所有任务拿出来，**包含** Done /
        // Cancelled,否则项目卡的状态聚合会少算
        listTasks({ includeCancelled: true }),
      ]);
      setSubTeams(teams);
      setPeople(roster);
      setProjects(projectList);
      setTasks(allTasks);
      setError(null);
    } catch (thrown) {
      setError(toAppError(thrown));
    } finally {
      setBusy(false);
    }
  }

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const tasksForProject = useMemo(() => {
    if (selectedProject == null) return [] as Task[];
    return tasks.filter((t) => t.projectId === selectedProject.id);
  }, [tasks, selectedProject]);

  const tasksByStatus = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = {
      Open: [],
      "In-progress": [],
      Blocked: [],
      "Waiting-on": [],
      Done: [],
      Cancelled: [],
    };
    for (const t of tasksForProject) {
      map[t.status].push(t);
    }
    // 各自按 due_date / created_at 兜底
    for (const status of STATUS_COLUMNS) {
      map[status].sort((a, b) => {
        const da = a.dueDate ?? "";
        const db = b.dueDate ?? "";
        if (da !== db) return da < db ? -1 : 1;
        return a.id - b.id;
      });
    }
    return map;
  }, [tasksForProject]);

  async function runCommand<T>(thunk: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    try {
      const result = await thunk();
      setError(null);
      return result;
    } catch (thrown) {
      setError(toAppError(thrown));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleDrop(task: Task, target: TaskStatus) {
    if (task.status === target) return;
    if (target === "Blocked" || target === "Waiting-on") {
      // 落阻塞列前先把 reason 收齐——走 `set_task_status` 时 reason 必填
      setDropPrompt({ task, status: target });
      setDropReason("");
      // 默认沿用当前 waiting_on（若有），方便「Blocked ↔ Waiting-on」互切
      setDropWaitingOn(
        target === "Waiting-on"
          ? (task.waitingOnPersonId ?? null)
          : null,
      );
      return;
    }
    await runCommand(() =>
      setTaskStatus({
        taskId: task.id,
        status: target,
        blockedReason: null,
        waitingOnPersonId: null,
      }),
    );
    await refreshAll();
  }

  async function confirmBlockedDrop() {
    if (!dropPrompt) return;
    const reason = dropReason.trim();
    if (reason.length === 0) {
      setError(toAppError({
        code: "INVALID_ARGUMENT",
        message: dropPrompt.status === "Blocked" ? "阻塞原因不能为空,请填写卡在何处。" : "等待原因不能为空,请填写在等什么。",
        detail: null,
      }));
      return;
    }
    const result = await runCommand(() =>
      setTaskStatus({
        taskId: dropPrompt.task.id,
        status: dropPrompt.status,
        blockedReason: reason,
        waitingOnPersonId: dropWaitingOn,
      }),
    );
    setDropPrompt(null);
    if (result) await refreshAll();
  }

  function cancelBlockedDrop() {
    setDropPrompt(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        项目看板 · 项目卡网格 + 6 状态分列 · 拖动任务卡到另一列 = 改状态
      </p>

      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {error.message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        {/* ========== 项目面板 ========== */}
        <section className="bg-card text-card-foreground rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">项目</h2>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setEditing({ kind: "new" })}
              disabled={busy || subTeams.length === 0 || people.length === 0}
              title={subTeams.length === 0 || people.length === 0 ? "先在人员管理里建子组与人员" : undefined}
            >
              <Plus />
              新建
            </Button>
          </div>

          <label className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={includeDone}
              onChange={(event) => setIncludeDone(event.target.checked)}
              className="size-3.5"
            />
            含已 Done / Cancelled 的项目
          </label>

          {projects.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              还没有项目。先在人员管理里建好子组与人员,再来这里挂项目。
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-1.5">
              {projects.map((project) => {
                const selected = project.id === selectedProjectId;
                return (
                  <li
                    key={project.id}
                    className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                      selected ? "bg-muted" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedProjectId(project.id)}
                      className="flex-1 cursor-pointer text-left"
                    >
                      <div className="font-medium">{project.name}</div>
                      <div className="text-muted-foreground text-xs">
                        <ProjectStatusBadge status={project.status} />
                        {project.dueDate ? ` · 截止 ${project.dueDate}` : ""}
                      </div>
                    </button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => setEditing({ kind: "edit", project })}
                      disabled={busy}
                      aria-label="编辑"
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={async () => {
                        await runCommand(() => deleteProject({ id: project.id }));
                        if (selectedProjectId === project.id) {
                          setSelectedProjectId(null);
                        }
                        await refreshAll();
                      }}
                      disabled={busy}
                      aria-label="删除"
                      title="删除项目 → 名下任务的 project_id 置 NULL"
                    >
                      <Trash2 />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ========== 看板 ========== */}
        <section className="bg-card text-card-foreground rounded-lg border p-4">
          {selectedProject == null ? (
            <p className="text-muted-foreground text-xs">
              左侧选一个项目看任务分列。
            </p>
          ) : (
            <Board
              project={selectedProject}
              tasksByStatus={tasksByStatus}
              peopleById={new Map(people.map((p) => [p.id, p]))}
              subTeamNameById={new Map(subTeams.map((t) => [t.id, t.name]))}
              onDrop={handleDrop}
              dropPrompt={dropPrompt}
              dropReason={dropReason}
              setDropReason={setDropReason}
              dropWaitingOn={dropWaitingOn}
              setDropWaitingOn={setDropWaitingOn}
              onConfirmBlockedDrop={confirmBlockedDrop}
              onCancelBlockedDrop={cancelBlockedDrop}
              people={people}
              busy={busy}
            />
          )}
        </section>
      </div>

      {/* ========== 项目表单 ========== */}
      {editing && (
        <ProjectForm
          initial={editing.kind === "edit" ? editing.project : null}
          subTeams={subTeams}
          people={people}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={async (values) => {
            const result = await runCommand(() =>
              editing.kind === "edit"
                ? updateProject({ id: editing.project.id, ...values })
                : createProject(values),
            );
            if (result) {
              setEditing(null);
              setSelectedProjectId(result.id);
              await refreshAll();
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const entry = PROJECT_STATUS_STYLE[status];
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${entry.className}`}
    >
      {entry.label}
    </span>
  );
}

function Board({
  project,
  tasksByStatus,
  peopleById,
  subTeamNameById,
  onDrop,
  dropPrompt,
  dropReason,
  setDropReason,
  dropWaitingOn,
  setDropWaitingOn,
  onConfirmBlockedDrop,
  onCancelBlockedDrop,
  people,
  busy,
}: {
  project: Project;
  tasksByStatus: Record<TaskStatus, Task[]>;
  peopleById: Map<number, Person>;
  subTeamNameById: Map<number, string>;
  onDrop: (task: Task, target: TaskStatus) => Promise<void>;
  dropPrompt: BlockedDropPrompt | null;
  dropReason: string;
  setDropReason: (value: string) => void;
  dropWaitingOn: number | null;
  setDropWaitingOn: (value: number | null) => void;
  onConfirmBlockedDrop: () => Promise<void>;
  onCancelBlockedDrop: () => void;
  people: Person[];
  busy: boolean;
}) {
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);
  const [hoverColumn, setHoverColumn] = useState<TaskStatus | null>(null);

  function handleDragStart(event: React.DragEvent<HTMLDivElement>, task: Task) {
    setDragTaskId(task.id);
    event.dataTransfer.setData("text/plain", String(task.id));
    event.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>, column: TaskStatus) {
    if (dragTaskId == null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (hoverColumn !== column) setHoverColumn(column);
  }

  async function handleDropOnColumn(event: React.DragEvent<HTMLDivElement>, column: TaskStatus) {
    event.preventDefault();
    setHoverColumn(null);
    const idText = event.dataTransfer.getData("text/plain");
    const id = Number(idText);
    setDragTaskId(null);
    if (!Number.isFinite(id)) return;
    // 在 tasksByStatus 里找到该任务
    let task: Task | null = null;
    for (const status of STATUS_COLUMNS) {
      const found = tasksByStatus[status].find((t) => t.id === id);
      if (found) {
        task = found;
        break;
      }
    }
    if (!task) return;
    await onDrop(task, column);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{project.name}</h3>
        <span className="text-muted-foreground text-xs">
          {project.startDate ? `${project.startDate} 起` : ""}
          {project.dueDate ? ` · 截止 ${project.dueDate}` : ""}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6">
        {STATUS_COLUMNS.map((status) => {
          const items = tasksByStatus[status];
          const isHover = hoverColumn === status;
          return (
            <div
              key={status}
              onDragOver={(event) => handleDragOver(event, status)}
              onDragLeave={() => setHoverColumn(null)}
              onDrop={(event) => void handleDropOnColumn(event, status)}
              className={`bg-background flex min-h-32 flex-col gap-1.5 rounded-md border p-2 transition-colors ${
                isHover ? "border-primary bg-primary/5" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-1 text-xs">
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLE[status].className}`}
                >
                  {STATUS_STYLE[status].label}
                </span>
                <span className="text-muted-foreground">{items.length}</span>
              </div>
              {items.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  peopleById={peopleById}
                  subTeamNameById={subTeamNameById}
                  onDragStart={(event) => handleDragStart(event, task)}
                />
              ))}
            </div>
          );
        })}
      </div>

      {/* Blocked / Waiting-on 落列时的 reason + waiting_on 小表单 */}
      {dropPrompt && (
        <BlockedDropDialog
          status={dropPrompt.status}
          taskTitle={dropPrompt.task.title}
          reason={dropReason}
          onReasonChange={setDropReason}
          waitingOn={dropWaitingOn}
          onWaitingOnChange={setDropWaitingOn}
          people={people}
          busy={busy}
          onConfirm={() => void onConfirmBlockedDrop()}
          onCancel={onCancelBlockedDrop}
        />
      )}
    </div>
  );
}

function TaskCard({
  task,
  peopleById,
  subTeamNameById,
  onDragStart,
}: {
  task: Task;
  peopleById: Map<number, Person>;
  subTeamNameById: Map<number, string>;
  onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  const owner = peopleById.get(task.ownerPersonId);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="bg-card hover:bg-muted/60 cursor-grab rounded-md border px-2.5 py-2 text-xs shadow-sm active:cursor-grabbing"
    >
      <div className="font-medium leading-snug">{task.title}</div>
      <div className="text-muted-foreground mt-1 flex items-center gap-2">
        <span className="flex items-center gap-1">
          <UserRound className="size-3" />
          {owner?.name ?? "?"}
          {owner && (
            <span className="opacity-60">
              · {subTeamNameById.get(owner.subTeamId) ?? ""}
            </span>
          )}
        </span>
        {task.dueDate && (
          <span className="flex items-center gap-1">
            <CalendarDays className="size-3" />
            {task.dueDate}
          </span>
        )}
      </div>
    </div>
  );
}

function BlockedDropDialog({
  status,
  taskTitle,
  reason,
  onReasonChange,
  waitingOn,
  onWaitingOnChange,
  people,
  busy,
  onConfirm,
  onCancel,
}: {
  status: Extract<TaskStatus, "Blocked" | "Waiting-on">;
  taskTitle: string;
  reason: string;
  onReasonChange: (value: string) => void;
  waitingOn: number | null;
  onWaitingOnChange: (value: number | null) => void;
  people: Person[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isWaiting = status === "Waiting-on";
  return (
    <div className="bg-card text-card-foreground fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-background w-full max-w-sm space-y-3 rounded-lg border p-4 shadow-lg">
        <h3 className="text-sm font-semibold">
          {isWaiting ? "切到等待中" : "切到已阻塞"} · {taskTitle}
        </h3>
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">
            {isWaiting ? "等待原因" : "阻塞原因"}
          </span>
          <textarea
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            autoFocus
            rows={3}
            maxLength={500}
            disabled={busy}
            placeholder={isWaiting ? "等分管领导批示…" : "卡在等外委回函…"}
            className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          />
        </label>
        {isWaiting && (
          <label className="block text-sm">
            <span className="text-muted-foreground text-xs">
              等谁（可选,如「等系统自动恢复」无需指人）
            </span>
            <select
              value={waitingOn ?? ""}
              onChange={(event) =>
                onWaitingOnChange(event.target.value === "" ? null : Number(event.target.value))
              }
              disabled={busy}
              className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
            >
              <option value="">不指定</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button type="button" size="sm" onClick={onConfirm} disabled={busy || !reason.trim()}>
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProjectForm({
  initial,
  subTeams,
  people,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: Project | null;
  subTeams: SubTeam[];
  people: Person[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: {
    name: string;
    ownerPersonId: number;
    subTeamId: number;
    startDate: string | null;
    dueDate: string | null;
    notes: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [ownerPersonId, setOwnerPersonId] = useState<number | "">(
    initial?.ownerPersonId ?? "",
  );
  const [subTeamId, setSubTeamId] = useState<number | "">(
    initial?.subTeamId ?? (subTeams[0]?.id ?? ""),
  );
  const [startDate, setStartDate] = useState<string>(initial?.startDate ?? "");
  const [dueDate, setDueDate] = useState<string>(initial?.dueDate ?? "");
  const [notes, setNotes] = useState<string>(initial?.notes ?? "");

  return (
    <div className="bg-card text-card-foreground fixed inset-0 z-10 flex items-center justify-center bg-black/30 p-4">
      <form
        className="bg-background w-full max-w-md space-y-3 rounded-lg border p-4 shadow-lg"
        onSubmit={async (event) => {
          event.preventDefault();
          if (ownerPersonId === "" || subTeamId === "") return;
          await onSubmit({
            name: name.trim(),
            ownerPersonId,
            subTeamId,
            startDate: startDate.trim() || null,
            dueDate: dueDate.trim() || null,
            notes: notes.trim() || null,
          });
        }}
      >
        <h3 className="text-sm font-semibold">
          {initial == null ? "新建项目" : `编辑项目 · ${initial.name}`}
        </h3>
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">项目名</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            autoFocus
            className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">负责人</span>
          <select
            value={ownerPersonId}
            onChange={(event) =>
              setOwnerPersonId(event.target.value === "" ? "" : Number(event.target.value))
            }
            required
            className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          >
            <option value="">请选择</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">所属子组</span>
          <select
            value={subTeamId}
            onChange={(event) =>
              setSubTeamId(event.target.value === "" ? "" : Number(event.target.value))
            }
            required
            className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          >
            <option value="">请选择</option>
            {subTeams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">
            <span className="text-muted-foreground text-xs">开始日（可空）</span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground text-xs">截止日（可空）</span>
            <input
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">背景备注（可空）</span>
          <textarea
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="市里督办 / 立项依据 / 重点提示…"
            className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={busy || !name.trim() || ownerPersonId === "" || subTeamId === ""}
          >
            保存
          </Button>
        </div>
      </form>
    </div>
  );
}