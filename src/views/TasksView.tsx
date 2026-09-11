import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CircleAlert, UserRound } from "lucide-react";
import {
  listPeople,
  listProjects,
  listSubTeams,
  listTasks,
  toAppError,
  type AppError,
  type AssigneeCandidate,
  type Person,
  type Project,
  type ProjectCandidate,
  type SubTeam,
  type Task,
  type TaskStatus,
} from "@/lib/ipc";

/** 6 状态的中文标签与色板（承 `prototype/task-editing` 的锁定色板）。 */
const STATUS_STYLE: Record<TaskStatus, { label: string; className: string }> = {
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

/**
 * 任务列表（ticket #19 的落脚点）。
 *
 * 「编辑即详情」：点一行就进编辑态，不开独立详情视图。这里只负责把任务
 * 摆出来并把点击转交给弹窗——排序、过滤都由命令层 `list_tasks` 决定。
 */
export function TasksView({
  refreshToken,
  onOpenTask,
}: {
  /** 父层保存任务后 +1，触发重新拉取。 */
  refreshToken: number;
  onOpenTask: (
    task: Task,
    assignee: AssigneeCandidate | null,
    project: ProjectCandidate | null,
  ) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [subTeams, setSubTeams] = useState<SubTeam[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    Promise.all([
      listTasks({ includeCancelled: false }),
      // 花名册含离岗的人：历史任务的负责人可能已经离岗，名字仍要显示得出来
      listPeople({ includeDeactivated: true, subTeamId: null }),
      listSubTeams(),
      listProjects({ includeDone: true }),
    ])
      .then(([fetchedTasks, roster, teams, fetchedProjects]) => {
        if (cancelled) return;
        setTasks(fetchedTasks);
        setPeople(roster);
        setSubTeams(teams);
        setProjects(fetchedProjects);
        setError(null);
      })
      .catch((thrown) => {
        if (!cancelled) setError(toAppError(thrown));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  const peopleById = useMemo(
    () => new Map(people.map((person) => [person.id, person])),
    [people],
  );
  const subTeamNameById = useMemo(
    () => new Map(subTeams.map((team) => [team.id, team.name])),
    [subTeams],
  );
  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  function assigneeOf(task: Task): AssigneeCandidate | null {
    const person = peopleById.get(task.ownerPersonId);
    if (!person) return null;
    return {
      personId: person.id,
      name: person.name,
      subTeamName: subTeamNameById.get(person.subTeamId) ?? "",
    };
  }

  function projectOf(task: Task): ProjectCandidate | null {
    if (task.projectId == null) return null;
    const project = projectsById.get(task.projectId);
    if (!project) return null;
    return {
      projectId: project.id,
      name: project.name,
      subTeamName: subTeamNameById.get(project.subTeamId) ?? "",
    };
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        任务 · 点一条即进编辑态
      </p>

      {error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
        >
          {error.message}
        </div>
      )}

      {tasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {busy ? "载入中…" : "还没有任务。按 ⌘N 录一条。"}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((task) => {
            const status = STATUS_STYLE[task.status];
            return (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => onOpenTask(task, assigneeOf(task), projectOf(task))}
                  className="hover:bg-muted/60 flex w-full cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-left text-sm"
                >
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}
                  >
                    {status.label}
                  </span>
                  <span className="flex-1 font-medium">{task.title}</span>
                  {task.projectId != null && projectsById.has(task.projectId) && (
                    <span className="text-emerald-700 flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-xs">
                      <span aria-hidden>#</span>
                      {projectsById.get(task.projectId)?.name}
                    </span>
                  )}
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    <UserRound className="size-3" />
                    {peopleById.get(task.ownerPersonId)?.name ?? "?"}
                  </span>
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    {task.dueDate ? (
                      <>
                        <CalendarDays className="size-3" />
                        {task.dueDate}
                      </>
                    ) : (
                      <>
                        <CircleAlert className="size-3" />
                        无截止
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}