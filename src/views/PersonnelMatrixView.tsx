import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CalendarOff } from "lucide-react";
import { TaskStatusMenu } from "@/components/task/TaskStatusMenu";
import {
  listPeople,
  listProjects,
  listSubTeams,
  personnelMatrix,
  setTaskStatus,
  toAppError,
  type AppError,
  type AssigneeCandidate,
  type PersonnelMatrix as PersonnelMatrixDto,
  type PersonnelMatrixPerson,
  type PersonnelMatrixSegment,
  type Person,
  type ProjectCandidate,
  type Project,
  type SubTeam,
  type Task,
} from "@/lib/ipc";

/**
 * 「人员矩阵」视图（ticket #22）。
 *
 * 布局：
 * - 每个子组一段瀑布流——段内用 CSS multi-column（columns: 258px）让
 *   窗口宽度决定列数，**横向永远不出现滚动条**（spec 验收）。
 * - 每张人员卡片：姓名 + 在飞任务数 / 阻塞数两个计数（命令层算出）+ 在飞任务列表。
 * - 任务列表上的状态徽章走「点徽章 → 6 项菜单」手势（`TaskStatusMenu`），
 *   与项目看板、详情视图共用同一组件。
 *
 * 设计要点：
 * - 顶部一个「显示离岗人员」开关，默认关。
 * - 卡片任务就地改状态成功后**乐观更新本地卡片**——`refreshToken` 由父层
 *   控制以做全屏重拉；单击卡片打开 TaskDialog 走原有详情流。
 * - 不做按子组的折叠（spec #67-71 没要求）；后续如要加，按人员段头加即可。
 * - 不引拖拽——拖拽语义全 app 唯一 = 改状态（在项目看板里），矩阵里走菜单。
 */

const TASK_CARD_WIDTH_PX = 258;

export function PersonnelMatrixView({
  refreshToken,
  onOpenTask,
}: {
  /** 父层保存任务后 +1，触发重新拉取。 */
  refreshToken: number;
  onOpenTask: (
    task: Task,
    extras: {
      assignee: AssigneeCandidate | null;
      project: ProjectCandidate | null;
    },
  ) => void;
}) {
  const [view, setView] = useState<PersonnelMatrixDto | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [subTeams, setSubTeams] = useState<SubTeam[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [includeDeactivated, setIncludeDeactivated] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  // 矩阵就地改状态成功后,本地 +1,触发本组件内 useEffect 重拉——两个计数
  // 仍由命令层算出,与父层 `refreshToken` 走同一条拉取路径。
  const [localRevision, setLocalRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    Promise.all([
      personnelMatrix({ includeDeactivated }),
      // 编辑弹窗预填候选人 + 子组 / 项目缓存——并入同一 batch 一次拉完
      listPeople({ includeDeactivated: true, subTeamId: null }),
      listSubTeams(),
      listProjects({ includeDone: true }),
    ])
      .then(([matrix, roster, teams, projectList]) => {
        if (cancelled) return;
        setView(matrix);
        setPeople(roster);
        setSubTeams(teams);
        setProjects(projectList);
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
  }, [refreshToken, includeDeactivated, localRevision]);

  const peopleById = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people],
  );
  const subTeamNameById = useMemo(
    () => new Map(subTeams.map((t) => [t.id, t.name])),
    [subTeams],
  );
  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  async function handleStatusChange(
    task: Task,
    next: {
      status: Task["status"];
      blockedReason: string | null;
      waitingOnPersonId: number | null;
    },
  ) {
    // 失败的乐观回滚需要快照——成功则用本地 revision 触发整屏重拉,
    // 让两个计数继续由命令层算出。乐观替换只改徽章,不二次聚合。
    const prevView = view;
    setView((current) =>
      optimisticReplaceTask(current, task.id, { ...task, status: next.status }),
    );
    try {
      await setTaskStatus({
        taskId: task.id,
        status: next.status,
        blockedReason: next.blockedReason,
        waitingOnPersonId: next.waitingOnPersonId,
      });
      setError(null);
      setLocalRevision((value) => value + 1);
    } catch (thrown) {
      setView(prevView);
      setError(toAppError(thrown));
    }
  }

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
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          人员矩阵 · 每个子组一段，段内自适应分列，横向不出现滚动条
        </p>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeDeactivated}
            disabled={busy}
            onChange={(event) => setIncludeDeactivated(event.target.checked)}
          />
          显示离岗人员
        </label>
      </header>

      {error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
        >
          {error.message}
        </div>
      )}

      {view == null ? (
        <p className="text-muted-foreground text-sm">
          {busy ? "载入中…" : "暂无数据。"}
        </p>
      ) : view.segments.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          还没有子组或人员。先到「人员」录入花名册。
        </p>
      ) : (
        view.segments.map((segment) => (
          <SegmentView
            key={segment.subTeam.id}
            segment={segment}
            busy={busy}
            onStatusChange={handleStatusChange}
            onOpenTask={(task) =>
              onOpenTask(task, {
                assignee: assigneeOf(task),
                project: projectOf(task),
              })
            }
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 段 + 卡片
// ---------------------------------------------------------------------------

function SegmentView({
  segment,
  busy,
  onStatusChange,
  onOpenTask,
}: {
  segment: PersonnelMatrixSegment;
  busy: boolean;
  onStatusChange: (
    task: Task,
    next: {
      status: Task["status"];
      blockedReason: string | null;
      waitingOnPersonId: number | null;
    },
  ) => void;
  onOpenTask: (task: Task) => void;
}) {
  const groupOpen = segment.people.reduce(
    (n, p) => n + p.inFlightCount,
    0,
  );
  const groupBlocked = segment.people.reduce(
    (n, p) => n + p.blockedCount,
    0,
  );
  return (
    <section className="bg-card text-card-foreground rounded-lg border p-3">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{segment.subTeam.name}</h2>
        <div className="text-muted-foreground flex items-baseline gap-3 text-xs">
          <span>{segment.people.length} 人</span>
          <span>在办 {groupOpen}</span>
          {groupBlocked > 0 && (
            <span className="text-orange-600">{groupBlocked} 阻塞</span>
          )}
        </div>
      </header>

      {/* 段内瀑布流：CSS multi-column,宽度自适应分列,横向无滚动条 */}
      <div
        className="break-inside-avoid-column"
        style={{
          columnWidth: `${TASK_CARD_WIDTH_PX}px`,
          columnGap: "0.75rem",
        }}
      >
        {segment.people.map((person) => (
          <PersonCard
            key={person.person.id}
            entry={person}
            busy={busy}
            onStatusChange={onStatusChange}
            onOpenTask={onOpenTask}
          />
        ))}
      </div>
    </section>
  );
}

function PersonCard({
  entry,
  busy,
  onStatusChange,
  onOpenTask,
}: {
  entry: PersonnelMatrixPerson;
  busy: boolean;
  onStatusChange: (
    task: Task,
    next: {
      status: Task["status"];
      blockedReason: string | null;
      waitingOnPersonId: number | null;
    },
  ) => void;
  onOpenTask: (task: Task) => void;
}) {
  return (
    <article
      className={`bg-background mb-3 inline-block w-full rounded-md border p-2.5 text-xs ${
        entry.blockedCount > 0 ? "border-orange-300/60" : ""
      }`}
    >
      <header className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-medium">{entry.person.name}</span>
        <span className="text-muted-foreground flex items-baseline gap-2 tabular-nums">
          <span title="在飞任务数">{entry.inFlightCount}</span>
          {entry.blockedCount > 0 && (
            <span className="text-orange-600" title="阻塞任务数">
              · {entry.blockedCount} 阻塞
            </span>
          )}
        </span>
      </header>
      {entry.tasks.length === 0 ? (
        <p className="text-muted-foreground text-[11px]">手上没有在办任务</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {entry.tasks.map((task) => (
            <li
              key={task.id}
              className="hover:bg-muted/60 flex flex-col gap-0.5 rounded-sm px-1.5 py-1"
            >
              <div className="flex items-start gap-1.5">
                <TaskStatusMenu
                  task={task}
                  disabled={busy}
                  onChange={(next) => onStatusChange(task, next)}
                />
                <button
                  type="button"
                  onClick={() => onOpenTask(task)}
                  className="flex-1 cursor-pointer truncate text-left leading-snug font-medium"
                  title={task.title}
                >
                  {task.title}
                </button>
              </div>
              <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
                {task.dueDate ? (
                  <span className="flex items-center gap-0.5">
                    <CalendarDays className="size-2.5" />
                    {task.dueDate}
                  </span>
                ) : (
                  <span className="flex items-center gap-0.5 opacity-60">
                    <CalendarOff className="size-2.5" />
                    无截止
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

/**
 * 乐观地把一条 task 替换进 DTO 树——只换对象本身,不动两个计数。
 *
 * 计数仍由命令层权威:成功时父层通过 `onTasksChanged` 触发整屏重拉,
 * 失败时父层用快照回滚。两个计数保持命令层算出的语义,前端不二次聚合。
 */
function optimisticReplaceTask(
  view: PersonnelMatrixDto | null,
  taskId: number,
  nextTask: Task,
): PersonnelMatrixDto | null {
  if (view == null) return view;
  return {
    segments: view.segments.map((segment) => ({
      ...segment,
      people: segment.people.map((person) => {
        let touched = false;
        const tasks = person.tasks.map((task) => {
          if (task.id !== taskId) return task;
          touched = true;
          return nextTask;
        });
        return touched ? { ...person, tasks } : person;
      }),
    })),
  };
}
