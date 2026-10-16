import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import {
  getPersonDetail,
  listSubTeams,
  toAppError,
  updatePerson,
  type AppError,
  type AssigneeCandidate,
  type Person,
  type PersonDetail,
  type PersonDetailInFlight,
  type Project,
  type RecurringTemplate,
  type SubTeam,
  type Task,
  type TaskStatus,
} from "@/lib/api";
import { toAssigneeCandidate } from "@/lib/assignee";
import { STATUS_STYLE } from "@/lib/taskStatusStyle";
import { PROJECT_STATUS_STYLE } from "@/lib/projectStatusStyle";

/**
 * 「人员详情」视图（tickets #80 / #81 / #82 / #83）。
 *
 * 渲染 header（详情档案 + 计数）+ 在飞任务 6 状态分段（#82 T2）+ 负责
 * 项目 / 等待 TA 推动 / 所在子组的周期模板 三段（#83 T3）。
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
  onCreateProject,
  onCreateTemplate,
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
   * 式,把当前人员预填为负责人。T2 在飞任务段、T3「等待 TA 推动」段
   * 共用同一个回调——后者 spec 与前者同语义（#80 §Implementation Deci
   * sions #17）。
   */
  onCreateTask: (person: Person) => void;
  /**
   * 「负责的项目」段（#83 T3）的 + 按钮 → App 层切到「项目」tab 并打
   * 开新建表单,把当前人员预填为负责人（spec #80 §Implementation #17）。
   */
  onCreateProject: (person: Person) => void;
  /**
   * 「所在子组的周期模板」段（#83 T3）的 + 按钮 → App 层切到「节假日
   * 」tab,把当前人员的子组 id 作为新建模板的子组预填（spec #80 §Imple
   * mentation #17）。模板创建 UI 当前在 holiday tab 内还未落地,本回
   * 调先实现「切到 tab」的最小动作——模板创建 UI 是后续 ticket。
   */
  onCreateTemplate: (subTeamId: number) => void;
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

  /**
   * T7（#87）：档案字段就地保存（Q25 决议）。一次 updatePerson 命令要求
   * 4 个字段齐（id / name / contact / subTeamId），所以一个字段改了也
   * 拿到当前 person 全量 + 这一字段的新值再发。失败抛 AppError，让
   * `InlineEditableText` / `InlineEditableSubTeam` 在行内红字 + 撤
   * 销按钮兜住。
   *
   * 本期仅乐观更新本 panel 的 `detail`（用户当下看到的详情视图立即
   * 显示新值）。其他 tab（matrix / personnel / projects）的 catalog
   * 不主动刷新——issue #87 第⑦项列举的 refreshToken+1 触发器是
   * "任务状态 / 任务保存 / 人员删除 / 子组重排",刻意没有"档案就地
   * 编辑"。用户重切 tab 或下次自然刷新时,新值会落齐。
   */
  async function persistPerson(
    updates: Partial<Pick<Person, "name" | "contact" | "subTeamId">>,
  ): Promise<void> {
    if (detail == null) return;
    const current = detail.person;
    const next = {
      id: current.id,
      name: updates.name ?? current.name,
      contact: updates.contact ?? current.contact,
      subTeamId: updates.subTeamId ?? current.subTeamId,
    };
    // 没真改直接返回——避免无关 updatePerson 把后端时间戳刷一遍。
    if (
      next.name === current.name &&
      next.contact === current.contact &&
      next.subTeamId === current.subTeamId
    ) {
      return;
    }
    const updated = await updatePerson(next);
    setDetail((prev) =>
      prev ? { ...prev, person: updated } : prev,
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header
        data-person-id={detail.person.id}
        className={`bg-card text-card-foreground flex flex-col gap-3 rounded-lg border p-4 ${
          off ? "bg-muted/40 text-muted-foreground" : ""
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <InlineEditableText
            value={detail.person.name}
            // 姓名走 <h2> 大字 —— 另给一组 className 维持版式。
            displayClassName="text-lg font-semibold"
            inputClassName="text-lg font-semibold"
            ariaLabel="档案 · 姓名"
            onSave={(next) => persistPerson({ name: next })}
          />
          {subTeamName != null && (
            <InlineEditableSubTeam
              subTeamId={detail.person.subTeamId}
              subTeams={allSubTeams}
              ariaLabel="档案 · 子组"
              onSave={(nextId) => persistPerson({ subTeamId: nextId })}
            />
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
            <dd className="text-foreground truncate font-mono">
              <InlineEditableText
                value={detail.person.contact}
                ariaLabel="档案 · 联系方式"
                onSave={(next) => persistPerson({ contact: next })}
              />
            </dd>
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

      <OwnedProjectsSection
        projects={detail.ownedProjects}
        subTeams={allSubTeams}
        onCreateProject={() => onCreateProject(detail.person)}
      />

      <WaitingOnTasksSection
        tasks={detail.waitingOnTasks}
        assignee={assigneeCandidate}
        onOpenTask={onOpenTask}
        onCreateTask={() => onCreateTask(detail.person)}
      />

      <SubTeamTemplatesSection
        templates={detail.subTeamTemplates}
        onCreateTemplate={() => onCreateTemplate(detail.person.subTeamId)}
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

// ---------------------------------------------------------------------------
// 段 3 / 段 4 / 段 5（tickets #83 T3）
//
// 三段共用「段头 + 计数 + + 按钮 + 列表/空态」四件套。空态的「→ 去
// XXX tab 新建」链接直接把用户送回父层切 tab——空态按钮本身**不**自己
// 切 tab,而是触发与段头 + 按钮同一个回调（语义：空着就该新建一条），
// 由父层决定后续动作（项目 tab / 弹新建任务模板 / 节假日 tab）。
//
// 段内不重排,排序由命令层（[`bucketByStatus`] 等）一次性给齐——与
// InFlightSection 同原则。
// ---------------------------------------------------------------------------

/**
 * 段 3「负责的项目」（tickets #80 / #83 T3）——列出
 * `project.owner_person_id = 本人` 的所有项目,跨子组也算（owner 与项目
 * 所属子组不要求一致）。命令层 `listProjectsForOwner` 已按
 * `due_date` ASC (NULL 末) 排序,本视图不再二次排。
 */
function OwnedProjectsSection({
  projects,
  subTeams,
  onCreateProject,
}: {
  projects: Project[];
  /** 父层 catalog——用来给每条项目显示「所属子组」徽章。 */
  subTeams: SubTeam[];
  onCreateProject: () => void;
}) {
  return (
    <section
      aria-label="负责的项目"
      className="bg-card text-card-foreground flex flex-col gap-2 rounded-lg border p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          负责的项目 <span className="text-muted-foreground font-normal">· {projects.length}</span>
        </h3>
        <button
          type="button"
          onClick={onCreateProject}
          aria-label="新建项目给 TA · 负责的项目"
          title="新建项目给 TA（负责的项目）"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs"
        >
          <Plus className="size-3" />
          <span className="sr-only">新建项目给 TA</span>
        </button>
      </header>

      {projects.length === 0 ? (
        <button
          type="button"
          onClick={onCreateProject}
          className="text-muted-foreground hover:text-foreground block cursor-pointer text-left text-xs"
        >
          暂无负责项目。→ 去项目 tab 新建
        </button>
      ) : (
        <ul className="flex flex-col gap-1">
          {projects.map((project) => (
            <OwnedProjectRow
              key={project.id}
              project={project}
              subTeams={subTeams}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** 项目行——项目名 + 状态徽章 + 子组名 + 截止日。点击 = 无操作（项目详情
 *  跳转不是 T3 范围）。 */
function OwnedProjectRow({
  project,
  subTeams,
}: {
  project: Project;
  subTeams: SubTeam[];
}) {
  const subTeam = subTeams.find((t) => t.id === project.subTeamId);
  const statusStyle = PROJECT_STATUS_STYLE[project.status];
  return (
    <li
      data-project-id={project.id}
      className="bg-background rounded-md border px-2.5 py-2 text-xs"
    >
      <div className="flex items-baseline gap-2 leading-snug">
        <span className="font-medium">{project.name}</span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusStyle.className}`}
          title={`项目状态 · ${statusStyle.label}`}
        >
          {statusStyle.label}
        </span>
      </div>
      <div className="text-muted-foreground mt-0.5 text-[10px]">
        {subTeam?.name ?? `未知子组 (id=${project.subTeamId})`}
        {project.dueDate ? ` · 截止 ${project.dueDate}` : ""}
      </div>
    </li>
  );
}

/**
 * 段 4「等待 TA 推动」（tickets #80 / #83 T3）——列出
 * `task.waiting_on_person_id = 本人` 的任务,按 `blocked_at` ASC 排（与
 * Blocked / Waiting-on 桶同语义——longest-stuck first,命令层一次性给
 * 齐）。点任务条目仍开 TaskDialog,行为与人员矩阵点任务一致。
 */
function WaitingOnTasksSection({
  tasks,
  assignee,
  onOpenTask,
  onCreateTask,
}: {
  tasks: Task[];
  /** 当前人员作为 AssigneeCandidate——为「点任务 → 开 TaskDialog」
   *  路径算好,避免每条任务再算一次。 */
  assignee: AssigneeCandidate;
  onOpenTask: (task: Task, extras: { assignee: AssigneeCandidate }) => void;
  /** 段头 + / 空态 + ——「等待 TA 推动」与「在飞任务」新建手势同语义,
   *  统一走 `onCreateTask` 把当前人员预填为新任务的负责人（spec
   *  #80 §Implementation #17:「⑤等待 TA + → 与 ② 同」）。 */
  onCreateTask: () => void;
}) {
  return (
    <section
      aria-label="等待 TA 推动"
      className="bg-card text-card-foreground flex flex-col gap-2 rounded-lg border p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          等待 TA 推动 <span className="text-muted-foreground font-normal">· {tasks.length}</span>
        </h3>
        <button
          type="button"
          onClick={onCreateTask}
          aria-label="新建任务给 TA · 等待 TA 推动"
          title="新建任务给 TA（等待 TA 推动）"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs"
        >
          <Plus className="size-3" />
          <span className="sr-only">新建任务给 TA</span>
        </button>
      </header>

      {tasks.length === 0 ? (
        // T7（#87）：与其它 3 段空态同型——可点按钮 → 调 onCreateTask
        // 把当前人员预填为新任务的负责人（Q18 决议 4 条一致）。
        <button
          type="button"
          onClick={onCreateTask}
          className="text-muted-foreground hover:text-foreground block cursor-pointer text-left text-xs"
        >
          暂时没有任务等 TA 推动。→ 新建任务给 TA
        </button>
      ) : (
        <ul className="flex flex-col gap-1">
          {tasks.map((task) => (
            <WaitingOnTaskRow
              key={task.id}
              task={task}
              assignee={assignee}
              onOpenTask={onOpenTask}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** 等待任务行——任务名 + 阻塞原因（卡最久的在前）。点击 = 开 TaskDialog,
 *  与 InFlightSection 的 TaskRow 一致。 */
function WaitingOnTaskRow({
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
        {(task.blockedReason || task.blockedAt) && (
          <span className="text-muted-foreground block text-[10px]">
            {task.blockedReason ? `${task.blockedReason}` : ""}
            {task.blockedAt && task.blockedReason ? " · " : ""}
            {task.blockedAt ? `${task.blockedAt} 起卡住` : ""}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * 段 5「所在子组的周期模板」（tickets #80 / #83 T3）——列出
 * `recurring_template.sub_team_id = person.sub_team_id` 的模板,**仅**
 * 子组级,不含项目级模板（命令层 `listTemplatesForSubTeam` 已用
 * `WHERE sub_team_id = ?` 兜底）。+ 按钮 → 切到「节假日」tab + 预填
 * 子组（spec #80 §Implementation #17）。
 */
function SubTeamTemplatesSection({
  templates,
  onCreateTemplate,
}: {
  templates: RecurringTemplate[];
  onCreateTemplate: () => void;
}) {
  return (
    <section
      aria-label="所在子组的周期模板"
      className="bg-card text-card-foreground flex flex-col gap-2 rounded-lg border p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          所在子组的周期模板 <span className="text-muted-foreground font-normal">· {templates.length}</span>
        </h3>
        <button
          type="button"
          onClick={onCreateTemplate}
          aria-label="新建周期模板 · 所在子组的周期模板"
          title="新建周期模板（所在子组的周期模板）"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs"
        >
          <Plus className="size-3" />
          <span className="sr-only">新建周期模板</span>
        </button>
      </header>

      {templates.length === 0 ? (
        <button
          type="button"
          onClick={onCreateTemplate}
          className="text-muted-foreground hover:text-foreground block cursor-pointer text-left text-xs"
        >
          所在子组暂无周期模板。→ 去节假日 tab 配置周期事务
        </button>
      ) : (
        <ul className="flex flex-col gap-1">
          {templates.map((template) => (
            <TemplateRow key={template.id} template={template} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** 模板行——模板名 + 频次描述（每周一 09:00 / 每月 1 号等）。点击 =
 *  无操作（模板详情跳转不是 T3 范围）。 */
function TemplateRow({ template }: { template: RecurringTemplate }) {
  return (
    <li
      data-template-id={template.id}
      className="bg-background rounded-md border px-2.5 py-2 text-xs"
    >
      <div className="flex items-baseline gap-2 leading-snug">
        <span className="font-medium">{template.name}</span>
        {!template.enabled && (
          <span
            className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            title="模板已停用"
          >
            停用
          </span>
        )}
      </div>
      <div className="text-muted-foreground mt-0.5 text-[10px]">
        {describeRule(template)}
        {template.holidayBehavior === "skip" ? " · 节假日跳过" : " · 节假日顺延"}
      </div>
    </li>
  );
}

/** 周内位掩码 → "每周X Y点" 短句;月度 → "每月 D 号";|X 日期结束 → "到 YYYY-MM-DD"。 */
function describeRule(template: RecurringTemplate): string {
  const { freq, bydayMask, bymonthday, byminute, byhour } = template;
  const time = `${String(byhour).padStart(2, "0")}:${String(byminute).padStart(2, "0")}`;
  if (freq === "weekly") {
    const days = describeBydayMask(bydayMask);
    return `每周 ${days} ${time}`;
  }
  if (freq === "monthly") {
    const day = bymonthday?.[0];
    return day ? `每月 ${day} 号 ${time}` : `每月 ${time}`;
  }
  if (freq === "daily") return `每天 ${time}`;
  if (freq === "yearly") return `每年 ${time}`;
  return freq;
}

function describeBydayMask(mask: number): string {
  const names = ["一", "二", "三", "四", "五", "六", "日"] as const;
  const on = names.filter((_, i) => (mask & (1 << i)) !== 0);
  return on.length === 0 ? "—" : on.join("/");
}

// ---------------------------------------------------------------------------
// 档案字段就地编辑（ticket #87 T7）
//
// 设计要点（Q25 决议）：
// - 单击进入编辑态；onBlur 触发 save。
// - Enter = 提交；Escape = 取消并关闭。
// - 保存中：行内 spinner（旧值保留可见），不让输入框在保存中还能再改。
// - 失败：行内红字 + 「撤销」按钮 —— 撤销 = 清掉错误、丢弃当前输入、
//   把字段还原回编辑前那个值。
// - 与段内的 `<button>` "+" 等按钮共享 cursor / focus 风格,不引入
//   额外的视觉模态（spec #87 强调"就地"）。
// - 父层 `value` 变化时（refreshToken 触发重拉 → detail 更新 →
//   字段值变化），若当前不在编辑态，把 draft 同步到新值。这一层收敛
//   了"父层同步 vs 本地输入"两条 seam。
// ---------------------------------------------------------------------------

/**
 * 行内可编辑文本字段 —— 适用 `name` / `contact`。
 *
 * - 展示态：`<button>` 包值，hover 出 `bg-muted/60` 暗示可点。
 * - 编辑态：`<input>`，autoFocus，整段同一行 + 行内错误 / 撤销。
 *
 * `onSave` 抛错走 `AppError` 形态 —— 失败时输入保留，`error` 区显示
 * `toAppError(thrown).message`，撤销按钮把字段恢复到 `value`。
 */
function InlineEditableText({
  value,
  onSave,
  ariaLabel,
  displayClassName,
  inputClassName,
}: {
  value: string;
  /**
   * 保存回调抛错即视为失败，**字段不会**被父层更新，留在编辑态显示错
   * 误。本组件不主动判空 —— 命令层 `updatePerson` 已抛 AppError.
   * invalid("姓名不能为空。") / "联系方式不能为空。" 等。
   */
  onSave: (next: string) => Promise<void> | void;
  ariaLabel: string;
  /** 展示态按钮的额外 className（用于套字号 / 字重的版式）。 */
  displayClassName?: string;
  /** 编辑态 input 的额外 className（用于套字号 / 字重的版式）。 */
  inputClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 父层 value 变化时（非编辑 / 非保存中）同步 draft —— 单纯展示态
  // 跟住最新一份数据。保存成功走 onSave → 父层 → 新 value → 这里
  // 已不在 editing，所以再 sync 一次让 draft 与最新保持一致。
  useEffect(() => {
    if (!editing && !saving) setDraft(value);
  }, [value, editing, saving]);

  useEffect(() => {
    if (editing) {
      // 推到下一帧，等 input 挂载完再 focus —— React 18 同步 ref 即可，
      // 但 esbuild 评测里 ref 已稳定，更直接。
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEdit() {
    if (saving) return;
    setDraft(value);
    setError(null);
    setEditing(true);
  }

  function undo() {
    // 撤销 = 丢弃本地输入，回退到打开编辑前的值，关闭编辑态。
    setDraft(value);
    setError(null);
    setEditing(false);
  }

  async function commit() {
    if (saving) return;
    setError(null);
    if (draft === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (thrown) {
      setError(toAppError(thrown).message);
      // 保留 draft + editing —— 用户可以再改一次或点撤销。
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      undo();
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        title="点击编辑"
        onClick={startEdit}
        className={`hover:bg-muted/60 cursor-pointer rounded px-1 text-left ${
          displayClassName ?? "text-foreground"
        }`}
      >
        {value}
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={handleKeyDown}
        disabled={saving}
        aria-label={ariaLabel}
        aria-invalid={error != null}
        className={`min-w-32 rounded border bg-background px-1 outline-none ${
          error != null
            ? "border-destructive ring-2 ring-destructive/20"
            : "border-input focus-visible:border-ring"
        } ${inputClassName ?? "text-foreground"}`}
      />
      {saving && (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          <Loader2 className="size-3 animate-spin" />
          <span>保存中…</span>
        </span>
      )}
      {error != null && (
        <>
          <span
            className="text-destructive text-xs"
            role="alert"
            aria-label="保存失败原因"
          >
            {error}
          </span>
          <button
            type="button"
            onClick={undo}
            className="text-foreground hover:underline text-xs"
            aria-label="撤销编辑"
          >
            撤销
          </button>
        </>
      )}
    </span>
  );
}

/**
 * 行内可编辑子组字段 —— 适用 `subTeamId`。
 *
 * 展示态是一个蓝底徽章（保留原有视觉），点击 → 切到 `<select>`。
 * onBlur 与 InlineEditableText 同语义；保存成功 → refreshToken+1
 * → 子组 catalog 重拉 → 当前人员徽章立即刷新。
 */
function InlineEditableSubTeam({
  subTeamId,
  subTeams,
  onSave,
  ariaLabel,
}: {
  subTeamId: number;
  /** 父层 catalog + 兜底后的子组全量；空 = 没东西可选 → 进编辑态也展示空 select。 */
  subTeams: SubTeam[];
  onSave: (nextId: number) => Promise<void> | void;
  ariaLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(subTeamId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const currentName =
    subTeams.find((t) => t.id === subTeamId)?.name ??
    `未知子组 (id=${subTeamId})`;

  useEffect(() => {
    if (!editing && !saving) setDraft(subTeamId);
  }, [subTeamId, editing, saving]);

  useEffect(() => {
    if (editing) selectRef.current?.focus();
  }, [editing]);

  function startEdit() {
    if (saving) return;
    setDraft(subTeamId);
    setError(null);
    setEditing(true);
  }

  function undo() {
    setDraft(subTeamId);
    setError(null);
    setEditing(false);
  }

  async function commit() {
    if (saving) return;
    setError(null);
    if (draft === subTeamId) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (thrown) {
      setError(toAppError(thrown).message);
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLSelectElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      undo();
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        title="点击编辑子组"
        onClick={startEdit}
        className="cursor-pointer rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
      >
        {currentName}
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <select
        ref={selectRef}
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        onBlur={() => void commit()}
        onKeyDown={handleKeyDown}
        disabled={saving}
        aria-label={ariaLabel}
        aria-invalid={error != null}
        className={`rounded border bg-background px-1 text-xs font-medium text-blue-700 outline-none ${
          error != null
            ? "border-destructive ring-2 ring-destructive/20"
            : "border-input focus-visible:border-ring"
        }`}
      >
        {subTeams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
      {saving && (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          <Loader2 className="size-3 animate-spin" />
          <span>保存中…</span>
        </span>
      )}
      {error != null && (
        <>
          <span
            className="text-destructive text-xs"
            role="alert"
            aria-label="保存失败原因"
          >
            {error}
          </span>
          <button
            type="button"
            onClick={undo}
            className="text-foreground hover:underline text-xs"
            aria-label="撤销编辑"
          >
            撤销
          </button>
        </>
      )}
    </span>
  );
}