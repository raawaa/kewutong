import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  UserRound,
  CalendarOff,
} from "lucide-react";
import {
  listPeople,
  listProjects,
  listSubTeams,
  toAppError,
  todayWeek,
  type AppError,
  type AssigneeCandidate,
  type Person,
  type Project,
  type ProjectCandidate,
  type SubTeam,
  type Task,
  type TaskStatus,
  type TodayWeek as TodayWeekDto,
} from "@/lib/ipc";
import { STATUS_STYLE } from "@/lib/taskStatusStyle";

/**
 * 「今日 / 本周」视图（ticket #21，默认落地页）。
 *
 * 布局：
 * - 顶部一排计数瓦片（在岗人数 / 进行中 / 阻塞中等），数字由命令层算。
 * - 主体四列时间轴：已逾期 / 今天 / 明天 / 本周剩余（止于本周日）。
 *
 * 设计要点：
 * - 本视图内**不**做拖拽改期；改期走 chip 行（见 `DueDateChipRow`）。
 *   拖拽的语义全 app 唯一 = 改状态（仅项目看板出现）。
 * - 「本周剩余」按字面是"明天的明天到本周日"——明天桶独占"明天"
 *   一天,本周剩余只在中间日期有内容；周日当天本周剩余为空。
 * - 点瓦片下钻到对应筛选结果——在岗 → 人员卡片,进行中 / 阻塞中等 →
 *   对应状态的任务清单。
 *
 * 不在范围（spec #21 user story 64）："今天的周期性实例混排进'今天'列
 * 并带 ↻"。周期性 Template / Instance 由 #22 落地,届时在桶查询里加
 * `(recurring_template_id IS NULL OR scheduled_at &lt;=&gt; due_date)`
 * 分支,前端复用 `Repeat` 徽章——本视图先把一次性的四列时间轴跑通。
 */

/** 瓦片下钻面板展示什么。 */
type Drill =
  | { kind: "active_people"; people: Person[]; subTeams: SubTeam[] }
  | { kind: "in_progress" | "blocked"; tasks: Task[] }
  | null;

const BUCKETS: {
  key: keyof TodayWeekDto["buckets"];
  label: string;
  emptyHint: string;
}[] = [
  { key: "overdue", label: "已逾期", emptyHint: "暂无逾期任务" },
  { key: "today", label: "今天", emptyHint: "今天没有截止任务" },
  { key: "tomorrow", label: "明天", emptyHint: "明天没有截止任务" },
  { key: "thisWeekRest", label: "本周剩余", emptyHint: "本周剩余为空（止于本周日）" },
];

export function TodayWeekView({
  refreshToken,
  onOpenTask,
}: {
  /** 父层保存任务后 +1，触发重新拉取。 */
  refreshToken: number;
  /**
   * 点一条任务：把 task 与候选人（assignee / project）一并传给父层
   * 打开编辑弹窗（编辑即详情，tickets #19 / #21）。
   */
  onOpenTask: (
    task: Task,
    extras: {
      assignee: AssigneeCandidate | null;
      project: ProjectCandidate | null;
    },
  ) => void;
}) {
  const [view, setView] = useState<TodayWeekDto | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [subTeams, setSubTeams] = useState<SubTeam[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<Drill>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    Promise.all([
      todayWeek(),
      // 在岗 / 进行中瓦片下钻 + 编辑弹窗预填候选人——一并打包拉
      listPeople({ includeDeactivated: false, subTeamId: null }),
      listSubTeams(),
      listProjects({ includeDone: true }),
    ])
      .then(([fetched, roster, teams, projectList]) => {
        if (cancelled) return;
        setView(fetched);
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
  }, [refreshToken]);

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

  function onTileClick(kind: "active_people" | "in_progress" | "blocked") {
    if (drill?.kind === kind) {
      setDrill(null);
      return;
    }
    if (!view) return;
    if (kind === "active_people") {
      setDrill({ kind: "active_people", people, subTeams });
    } else if (kind === "in_progress") {
      const tasks = collectTasksByStatus(view, "In-progress");
      setDrill({ kind: "in_progress", tasks });
    } else {
      const tasks = collectTasksByStatus(view, "Blocked", "Waiting-on");
      setDrill({ kind: "blocked", tasks });
    }
  }

  function handleOpenTask(task: Task) {
    onOpenTask(task, {
      assignee: assigneeOf(task),
      project: projectOf(task),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        今日 / 本周 · 计数瓦片 + 四列时间轴（已逾期 / 今天 / 明天 / 本周剩余，止于本周日）
      </p>

      {error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
        >
          {error.message}
        </div>
      )}

      {/* 瓦片行 */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <CountTile
          label="在岗人数"
          value={view?.counts.activePeople ?? 0}
          active={drill?.kind === "active_people"}
          onClick={() => onTileClick("active_people")}
          busy={busy}
        />
        <CountTile
          label="进行中"
          value={view?.counts.inProgress ?? 0}
          active={drill?.kind === "in_progress"}
          onClick={() => onTileClick("in_progress")}
          busy={busy}
        />
        <CountTile
          label="阻塞中等"
          value={view?.counts.blocked ?? 0}
          active={drill?.kind === "blocked"}
          onClick={() => onTileClick("blocked")}
          busy={busy}
          tone={view && view.counts.blocked > 0 ? "warn" : "default"}
        />
      </div>

      {/* 下钻面板 */}
      {drill && (
        <DrillPanel
          drill={drill}
          peopleById={peopleById}
          subTeamNameById={subTeamNameById}
          onOpenTask={handleOpenTask}
          onClose={() => setDrill(null)}
        />
      )}

      {/* 四列时间轴 */}
      {view ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
          {BUCKETS.map(({ key, label, emptyHint }) => (
            <BucketColumn
              key={key}
              label={label}
              tasks={view.buckets[key]}
              emptyHint={emptyHint}
              peopleById={peopleById}
              subTeamNameById={subTeamNameById}
              onOpenTask={handleOpenTask}
            />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{busy ? "载入中…" : ""}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function CountTile({
  label,
  value,
  active,
  onClick,
  busy,
  tone = "default",
}: {
  label: string;
  value: number;
  active: boolean;
  onClick: () => void;
  busy: boolean;
  tone?: "default" | "warn";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-pressed={active}
      className={`bg-card text-card-foreground flex items-baseline justify-between rounded-lg border px-4 py-3 text-left transition-colors hover:bg-muted/60 disabled:opacity-60 ${
        active ? "border-primary ring-2 ring-ring/30" : ""
      }`}
    >
      <span className="text-muted-foreground text-sm">{label}</span>
      <span
        className={`text-2xl font-semibold tabular-nums ${
          tone === "warn" && value > 0 ? "text-orange-600" : ""
        }`}
      >
        {value}
      </span>
    </button>
  );
}

function BucketColumn({
  label,
  tasks,
  emptyHint,
  peopleById,
  subTeamNameById,
  onOpenTask,
}: {
  label: string;
  tasks: Task[];
  emptyHint: string;
  peopleById: Map<number, Person>;
  subTeamNameById: Map<number, string>;
  onOpenTask: (task: Task) => void;
}) {
  return (
    <section className="bg-card text-card-foreground flex min-h-48 flex-col gap-2 rounded-lg border p-3">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{label}</h3>
        <span className="text-muted-foreground text-xs">{tasks.length}</span>
      </header>
      {tasks.length === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyHint}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((task) => (
            <li key={task.id}>
              <TaskCard
                task={task}
                peopleById={peopleById}
                subTeamNameById={subTeamNameById}
                onClick={() => onOpenTask(task)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskCard({
  task,
  peopleById,
  subTeamNameById,
  onClick,
}: {
  task: Task;
  peopleById: Map<number, Person>;
  subTeamNameById: Map<number, string>;
  onClick: () => void;
}) {
  const status = STATUS_STYLE[task.status];
  const owner = peopleById.get(task.ownerPersonId);
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-muted/60 flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left text-xs"
    >
      <div className="flex items-start gap-1.5">
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${status.className}`}
        >
          {status.label}
        </span>
        <span className="flex-1 font-medium leading-snug">{task.title}</span>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {owner && (
          <span className="flex items-center gap-1">
            <UserRound className="size-3" />
            {owner.name}
            <span className="opacity-60">
              · {subTeamNameById.get(owner.subTeamId) ?? ""}
            </span>
          </span>
        )}
        {task.dueDate ? (
          <span className="flex items-center gap-1">
            <CalendarDays className="size-3" />
            {task.dueDate}
          </span>
        ) : (
          <span className="flex items-center gap-1 opacity-60">
            <CalendarOff className="size-3" />
            无截止
          </span>
        )}
      </div>
    </button>
  );
}

function DrillPanel({
  drill,
  peopleById,
  subTeamNameById,
  onOpenTask,
  onClose,
}: {
  drill: Drill;
  peopleById: Map<number, Person>;
  subTeamNameById: Map<number, string>;
  onOpenTask: (task: Task) => void;
  onClose: () => void;
}) {
  if (drill === null) return null;
  if (drill.kind === "active_people") {
    const { people, subTeams } = drill;
    return (
      <section className="bg-card text-card-foreground rounded-lg border p-4">
        <header className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">
            在岗人数 · {people.length}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground text-xs hover:underline"
          >
            收起
          </button>
        </header>
        {people.length === 0 ? (
          <p className="text-muted-foreground text-xs">还没有在岗人员。</p>
        ) : (
          <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {people.map((person: Person) => (
              <li
                key={person.id}
                className="rounded-md border px-2 py-1"
              >
                <div className="font-medium">{person.name}</div>
                <div className="text-muted-foreground text-xs">
                  {subTeams.find((t: SubTeam) => t.id === person.subTeamId)?.name ?? ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  const title =
    drill.kind === "in_progress" ? "进行中" : "阻塞中等";
  return (
    <section className="bg-card text-card-foreground rounded-lg border p-4">
      <header className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">
          {title} · {drill.tasks.length}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground text-xs hover:underline"
        >
          收起
        </button>
      </header>
      {drill.tasks.length === 0 ? (
        <p className="text-muted-foreground text-xs">没有匹配任务。</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {drill.tasks.map((task: Task) => (
            <li key={task.id}>
              <TaskCard
                task={task}
                peopleById={peopleById}
                subTeamNameById={subTeamNameById}
                onClick={() => onOpenTask(task)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

/** 把 4 个桶里属于指定状态的任务合并起来——瓦片下钻用。 */
function collectTasksByStatus(view: TodayWeekDto, ...statuses: TaskStatus[]): Task[] {
  const allowed = new Set(statuses);
  const all = [
    ...view.buckets.overdue,
    ...view.buckets.today,
    ...view.buckets.tomorrow,
    ...view.buckets.thisWeekRest,
  ];
  return all.filter((t) => allowed.has(t.status));
}