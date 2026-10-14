import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  getPersonDetail,
  listSubTeams,
  toAppError,
  type AppError,
  type AssigneeCandidate,
  type Person,
  type PersonDetail,
  type PersonDetailInFlight,
  type SubTeam,
  type Task,
  type TaskStatus,
} from "@/lib/api";
import { toAssigneeCandidate } from "@/lib/assignee";
import { STATUS_STYLE } from "@/lib/taskStatusStyle";

/**
 * 「人员详情」视图（tickets #80 / #81 / #82）。
 *
 * 渲染 header（详情档案 + 计数）+ 在飞任务 6 状态分段（#82 T2）。
 * 后续 T3~T5 ticket 会按父 issue #80 的「5 段聚合」顺序在本组件下方叠
 * 加「负责项目」「等待本人推动」「所属子组的周期模板」三段。本期
 * spec 不涉及。
 *
 * 业务语义全在主进程 `getPersonDetail`——前端拿到就渲染,不二次聚合,
 * 不二次排序。子组徽章的 `name` 复用父层 catalog,避免详情页单独发
 * 一次 IPC——若 catalog 里没有,回退到 "未知子组 (id=n)"。
 */
export function PersonDetailView({
  personId,
  subTeams,
  refreshToken,
  onOpenTask,
  onCreateTask,
}: {
  personId: number;
  /** 父层 catalog 里的子组缓存——详情视图借此展示子组徽章,不发 IPC。 */
  subTeams: SubTeam[];
  /** 父层保存后 +1,触发本视图重拉。 */
  refreshToken: number;
  /**
   * 点任务条目 → App 层开 TaskDialog（编辑即详情）。`extras.assignee`
   * 由本视图算好（本人员 + 子组名）,App 不必再发 IPC 拉花名册——与
   * 「人员矩阵」「今日 / 本周」点任务的 extras 形状完全一致。
   */
  onOpenTask: (task: Task, extras: { assignee: AssigneeCandidate }) => void;
  /**
   * 段头 + 按钮 / 空态「→ 新建任务给 TA」→ App 层开 TaskDialog 新建模
   * 式,把当前人员预填为负责人。
   */
  onCreateTask: (person: Person) => void;
}) {
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    getPersonDetail({ id: personId })
      .then((dto) => {
        if (cancelled) return;
        setDetail(dto);
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
  }, [personId, refreshToken]);

  // 父层 catalog 优先;若该 person 的 sub_team 不在 catalog 里(罕见,父层刚
  // 刷新或人员刚被调岗),拉一次兜底——子组徽章不该是 "?"。这里单独
  // 调 listSubTeams 而不是给整个 catalog 加 fallback,因为详情页是
  // 被动打开,不主动维护全局缓存。
  const fallbackSubTeams: SubTeam[] | null = useMissingSubTeams(detail, subTeams);
  const allSubTeams: SubTeam[] = fallbackSubTeams ?? subTeams;

  const subTeamName = useMemo(() => {
    if (detail == null) return null;
    const found = allSubTeams.find((t) => t.id === detail.person.subTeamId);
    return found?.name ?? `未知子组 (id=${detail.person.subTeamId})`;
  }, [detail, allSubTeams]);

  if (error) {
    return (
      <section
        role="alert"
        className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
      >
        {error.message}
      </section>
    );
  }

  if (detail == null) {
    return (
      <p className="text-muted-foreground text-sm">
        {busy ? "载入中…" : "暂无数据。"}
      </p>
    );
  }

  // 任务条目的负责人都是当前人员——为「点任务 → 开 TaskDialog」路径
  // 把 Person 转成 AssigneeCandidate。catalog 兜底已由 `useMissingSubTeams`
  // 处理过,这里直接收。
  const assigneeCandidate: AssigneeCandidate = toAssigneeCandidate(
    detail.person,
    allSubTeams,
  );

  const inFlightCount =
    detail.inFlight.open.length +
    detail.inFlight.inProgress.length +
    detail.inFlight.blocked.length +
    detail.inFlight.waitingOn.length;
  const blockedCount =
    detail.inFlight.blocked.length + detail.inFlight.waitingOn.length;
  const off = detail.person.deactivatedAt != null;

  return (
    <div className="flex flex-col gap-4">
      <header
        data-person-id={detail.person.id}
        className={`bg-card text-card-foreground flex flex-col gap-3 rounded-lg border p-4 ${
          off ? "bg-muted/40 text-muted-foreground" : ""
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-lg font-semibold">{detail.person.name}</h2>
          {subTeamName != null && (
            <span
              className="rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700"
              title="所属子组"
            >
              {subTeamName}
            </span>
          )}
          {off && (
            <span
              className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium"
              title="已离岗"
            >
              离岗 · {detail.person.deactivatedAt}
            </span>
          )}
        </div>

        <dl className="text-muted-foreground grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-1.5">
            <dt className="shrink-0">联系方式</dt>
            <dd className="text-foreground truncate font-mono">{detail.person.contact}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="shrink-0">录入时间</dt>
            <dd className="text-foreground">{detail.person.createdAt}</dd>
          </div>
          {off && (
            <div className="flex gap-1.5">
              <dt className="shrink-0">离岗时间</dt>
              <dd className="text-foreground">{detail.person.deactivatedAt}</dd>
            </div>
          )}
        </dl>

        <div className="text-muted-foreground flex items-baseline gap-4 text-xs tabular-nums">
          <span title="在飞任务数(Open / In-progress / Blocked / Waiting-on)">
            在飞 <span className="text-foreground font-medium">{inFlightCount}</span>
          </span>
          {blockedCount > 0 ? (
            <span className="text-orange-600" title="阻塞任务数(Blocked + Waiting-on)">
              阻塞 <span className="font-medium">{blockedCount}</span>
            </span>
          ) : (
            <span title="阻塞任务数(Blocked + Waiting-on)">
              阻塞 <span className="text-foreground font-medium">{blockedCount}</span>
            </span>
          )}
        </div>
      </header>

      <InFlightSection
        inFlight={detail.inFlight}
        assignee={assigneeCandidate}
        onOpenTask={onOpenTask}
        onCreateTask={() => onCreateTask(detail.person)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 在飞任务 6 状态分段（ticket #82 T2）
// ---------------------------------------------------------------------------

/** 默认折叠条数 — 与 [PersonDetailHead] header 的「在飞」计数视觉对齐。 */
const DEFAULT_COLLAPSED_COUNT = 5;

/** 6 状态在 UI 上的渲染顺序 — 排在前 = 科长最先看到的「应当关注」的段。 */
const SEGMENT_ORDER: TaskStatus[] = [
  "Open",
  "In-progress",
  "Blocked",
  "Waiting-on",
  "Done",
  "Cancelled",
];

/**
 * 各状态桶在本视图内的快捷访问名——与 [`STATUS_STYLE`] 的键同形。
 *
 * `PersonDetailInFlight` 的字段是 6 个具名数组（`open` / `inProgress`
 * / ...）,而 [`STATUS_STYLE`] 用 `TaskStatus` 字面量做键。这里建一张
 * 「状态 → 桶名」表,避免 `inFlight["In-progress"]` 这种 magic string。
 */
const BUCKET_KEY: Record<TaskStatus, keyof PersonDetailInFlight> = {
  Open: "open",
  "In-progress": "inProgress",
  Blocked: "blocked",
  "Waiting-on": "waitingOn",
  Done: "done",
  Cancelled: "cancelled",
};

/**
 * 在飞任务 6 状态分段（ticket #82 T2）。
 *
 * 设计要点：
 * - 6 段顺序固定（Open / In-progress / Blocked / Waiting-on / Done /
 *   Cancelled）——与人员矩阵「在飞四态优先」的心智一致。
 * - 段内排序在命令层（[`bucketByStatus`]）已一次性给齐,本视图不二次排。
 * - 每段默认折叠 5 条 + 「展开全部」——繁忙人员不会把页面挤成天梯。
 *   展开由各 segment 自己的 `useState` 维护,不上升到父层。
 * - 段头 + 按钮、空态「→ 新建任务给 TA」共用同一个 `onCreateTask`
 *   回调——把当前人员作为负责人预填进 TaskDialog（编辑即详情）。
 */
function InFlightSection({
  inFlight,
  assignee,
  onOpenTask,
  onCreateTask,
}: {
  inFlight: PersonDetailInFlight;
  /**
   * 当前人员（已转成 AssigneeCandidate）——所有在飞任务的负责人都是
   * TA,直接传下去避免每条任务再算一次。
   */
  assignee: AssigneeCandidate;
  onOpenTask: (task: Task, extras: { assignee: AssigneeCandidate }) => void;
  onCreateTask: () => void;
}) {
  return (
    <section
      aria-label="在飞任务按 6 状态分组"
      className="bg-card text-card-foreground flex flex-col gap-3 rounded-lg border p-4"
    >
      <h3 className="text-sm font-semibold">在飞任务 · 按状态</h3>
      <div className="flex flex-col gap-3">
        {SEGMENT_ORDER.map((status) => {
          const bucket = inFlight[BUCKET_KEY[status]];
          return (
            <SegmentBlock
              key={status}
              status={status}
              tasks={bucket}
              assignee={assignee}
              onOpenTask={onOpenTask}
              onCreateTask={onCreateTask}
            />
          );
        })}
      </div>
    </section>
  );
}

/**
 * 单个状态段：段头（标签 + 计数 + + 按钮）+ 折叠/展开列表 + 空态。
 */
function SegmentBlock({
  status,
  tasks,
  assignee,
  onOpenTask,
  onCreateTask,
}: {
  status: TaskStatus;
  tasks: Task[];
  assignee: AssigneeCandidate;
  onOpenTask: (task: Task, extras: { assignee: AssigneeCandidate }) => void;
  onCreateTask: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? tasks : tasks.slice(0, DEFAULT_COLLAPSED_COUNT);
  const hidden = tasks.length - visible.length;
  const style = STATUS_STYLE[status];

  return (
    <article
      data-segment-status={status}
      className="border-border/60 flex flex-col gap-2 rounded-md border p-2.5"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 text-xs">
          <span
            className={`rounded-md px-1.5 py-0.5 font-medium ${style.className}`}
            title={`${style.label} · ${tasks.length} 条`}
          >
            <span>{style.label}</span>
            <span aria-hidden="true"> · </span>
            <span>{tasks.length}</span>
          </span>
        </div>
        <button
          type="button"
          onClick={onCreateTask}
          aria-label={`新建任务给 TA · ${style.label}`}
          title={`新建任务给 TA（${style.label}）`}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs"
        >
          <Plus className="size-3" />
          <span className="sr-only">新建任务给 TA</span>
        </button>
      </header>

      {tasks.length === 0 ? (
        <button
          type="button"
          onClick={onCreateTask}
          className="text-muted-foreground hover:text-foreground block cursor-pointer text-left text-xs"
        >
          手上没有在办任务。→ 新建任务给 TA
        </button>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {visible.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                assignee={assignee}
                onOpenTask={onOpenTask}
              />
            ))}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-muted-foreground hover:text-foreground self-start text-xs underline-offset-2 hover:underline"
            >
              展开全部（还有 {hidden} 条）
            </button>
          )}
        </>
      )}
    </article>
  );
}

/**
 * 单条任务条目——纯展示,点击 = 调 `onOpenTask` 让 App 开 TaskDialog。
 *
 * 列表项不嵌状态徽章 / 不嵌「点徽章 → 6 项菜单」——详情页的任务交互只
 * 走「点击开详情,详情里改」一条路,与「人员矩阵 / Today-Week」里任务
 * 卡片就地改状态的两套手势刻意分开（user story #26）。
 */
function TaskRow({
  task,
  assignee,
  onOpenTask,
}: {
  task: Task;
  assignee: AssigneeCandidate;
  onOpenTask: (task: Task, extras: { assignee: AssigneeCandidate }) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenTask(task, { assignee })}
        className="hover:bg-muted/60 block w-full cursor-pointer rounded-sm px-1.5 py-1 text-left text-xs"
      >
        <span className="block font-medium leading-snug">{task.title}</span>
        {task.dueDate && (
          <span className="text-muted-foreground block text-[10px]">
            截止 {task.dueDate}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * 父层 catalog 缺失时,兜底拉一次 sub_team——给详情页能正常显示子组徽章。
 *
 * 「仅缺一个就发 IPC」很轻——`listSubTeams` 全表查,UI 上每人详情页
 * 至多触发一次（person 切换后 effect 跑、refreshToken 变化时也跑）。
 * 这层 fallback 只在 catalog 缺的子组 id 出现在当前 detail 时触发,平
 * 时返回 null（不发 IPC）。
 */
function useMissingSubTeams(
  detail: PersonDetail | null,
  subTeams: SubTeam[],
): SubTeam[] | null {
  const [fallback, setFallback] = useState<SubTeam[] | null>(null);
  const targetId = detail?.person.subTeamId ?? null;
  const inCatalog = targetId == null
    || subTeams.some((t) => t.id === targetId);

  useEffect(() => {
    if (inCatalog) {
      setFallback(null);
      return;
    }
    let cancelled = false;
    listSubTeams()
      .then((all) => {
        if (!cancelled) setFallback(all);
      })
      .catch(() => {
        // 拉失败 → 详情页回退到「未知子组 (id=n)」,不阻塞渲染。
      });
    return () => {
      cancelled = true;
    };
  }, [targetId, inCatalog]);

  return fallback;
}