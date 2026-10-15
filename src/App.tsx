import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  TaskDialog,
  type TaskDialogTarget,
} from "@/components/task/TaskDialog";
import {
  CommandPalette,
  type CommandPaletteTarget,
} from "@/components/wayfinder/CommandPalette";
import { TrayStatusBanner } from "@/components/tray/TrayStatusBanner";
import { SampleDataBanner } from "@/components/SampleDataBanner";
import { PersonnelMatrixView } from "@/views/PersonnelMatrixView";
import { PersonnelView } from "@/views/PersonnelView";
import { ProjectsView } from "@/views/ProjectsView";
import { TodayWeekView } from "@/views/TodayWeekView";
import { HolidayCalendarView } from "@/views/HolidayCalendarView";
import {
  PersonDetailTabsView,
  type OpenPersonTab,
} from "@/views/PersonDetailTabsView";
import {
  listPeople,
  listProjects,
  listSubTeams,
  trayStatus,
  type AssigneeCandidate,
  type Person,
  type Project,
  type ProjectCandidate,
  type SubTeam,
  type Task,
  type TrayStatusDto,
} from "@/lib/api";
import { toAssigneeCandidate } from "@/lib/assignee";

/**
 * 顶层 tab——spec #15 user story 60-66：四个主视图平级。
 *
 * 「今日 / 本周」是默认落地页（ticket #21），「人员矩阵」（ticket #22）、
 * 「项目看板」（ticket #20）并列。「人员」单独一个 tab——做子组 / 人员
 * CRUD,与矩阵的"读"视角分开。「人员详情」（ticket #80 / #84 T4）承载
 * 每位人员的子 tab 列表（多人员对比视图），与「人员」CRUD tab 分开——
 * 读 / 写两种视角各占一席。
 */
type Tab = "today" | "matrix" | "projects" | "personnel" | "personDetail" | "holiday";

const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "今日 / 本周" },
  { id: "matrix", label: "人员矩阵" },
  { id: "projects", label: "项目" },
  { id: "personnel", label: "人员" },
  { id: "personDetail", label: "人员详情" },
  { id: "holiday", label: "节假日" },
];

/**
 * App 外壳。
 *
 * 新建任务的入口挂在这里而不是某个视图里——顶栏按钮与 ⌘N 得**在任意界面**
 * 都能唤起弹窗（ticket #19 验收点）。视图只管自己那摊数据。
 *
 * ⌘K 全局命令面板（ticket #28）也在这里挂：顶层的 `catalog` 给命令面板
 * 复用——命令面板点开一条任务后,需要的 assignee / project 候选人不再
 * 走 IPC,直接由 catalog 在内存里算。这把命令面板与各视图数据加载路径
 * 解耦,避免命令面板打开再发一次"全员 + 全项目 + 全子组"拉取。
 */
export default function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [dialog, setDialog] = useState<TaskDialogTarget | null>(null);
  // 弹窗保存后 +1，让当前视图重新拉一次
  const [refreshToken, setRefreshToken] = useState(0);

  // 全局 catalog：人员 / 子组 / 项目。一次拉,所有视图复用。命令面板
  // 据此算 assignee / project 候选,不必再发 IPC。
  const [people, setPeople] = useState<Person[]>([]);
  const [subTeams, setSubTeams] = useState<SubTeam[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  // ⌘K 命令面板：开 / 关 + 选中目标后的导航意图。
  const [paletteOpen, setPaletteOpen] = useState(false);

  // 托盘可达性（ticket #29）：启动时拉一次。banner 只渲染不轮询——后续
  // Rust 端走事件总线推状态变化时再加 effect,本期只响应启动那一瞬。
  // `null` = 拉数据还没回来（不渲染,避免短暂闪烁）。
  const [trayStatusDto, setTrayStatusDto] = useState<TrayStatusDto | null>(null);

  // 项目视图的"定位"——从命令面板跳过去时给一个 initialProjectId,
  // 视图据此选中该项目的卡片。完成定位后清空。
  const [pendingProjectId, setPendingProjectId] = useState<number | null>(null);
  // 人员矩阵的"定位"——同理,跳过去时滚到该人员卡片。完成后清空。
  const [pendingPersonId, setPendingPersonId] = useState<number | null>(null);
  // 「人员详情」段 3 + 按钮（#83 T3）——切到「项目」tab 并打开新建
  // 表单,把这个 owner 预填进去。ProjectsView 用完清。
  const [pendingProjectCreateOwnerId, setPendingProjectCreateOwnerId] = useState<
    number | null
  >(null);

  // 「人员详情」主 tab（tickets #80 / #84 T4）——子 tab 列表 + 激活态。
  // session 内持久（关 app 清空），与既有 pendingProjectId / pendingPersonId
  // 同一思路，不引入持久化层。`openPersonTabs` 的物理顺序即子 tab 显
  // 示顺序：默认按打开时间（左旧右新），拖拽重排后按数组顺序（Q11 /
  // Q12 决议）。
  const [openPersonTabs, setOpenPersonTabs] = useState<OpenPersonTab[]>([]);
  const [activePersonId, setActivePersonId] = useState<number | null>(null);

  const openCreate = useCallback(() => setDialog({ mode: "create" }), []);
  /**
   * 「人员详情」段 2（#82 T2）的 + 按钮走这条路径：把当前人员预填
   * 为负责人,免去先 `@` 一下再录入标题的手势。`subTeamName` 从
   * catalog 查；catalog 缺失时回退空串——详情页本来就有 fallback
   * 路径（`useMissingSubTeams`）兜底,这里不重复做。
   */
  const openCreateWithAssignee = useCallback(
    (person: Person) => {
      setDialog({
        mode: "create",
        initialAssignee: toAssigneeCandidate(person, subTeams),
      });
    },
    [subTeams],
  );
  const closeDialog = useCallback(() => setDialog(null), []);
  const onTaskSaved = useCallback(() => {
    setDialog(null);
    setRefreshToken((token) => token + 1);
  }, []);
  // 横幅清除示例后也得刷——views 按 refreshToken 拉数据,不清的话
  // Today/矩阵/项目/人员 视图继续展示已删的示例任务。
  const onSampleCleared = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  // 顶栏「新建任务」按钮 + ⌘N / ⌘K 都在 window 层——保证在任意视图
  // 都能唤起。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openCreate();
        return;
      }
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openCreate]);

  // 启动 + 任一 tab 切换 + 任务保存后,都刷一次 catalog——各视图自身
  // 也用 refreshToken 触发,这里走同一份节奏避免漂移。
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listPeople({ includeDeactivated: true, subTeamId: null }),
      listSubTeams(),
      listProjects({ includeDone: true }),
    ])
      .then(([roster, teams, projectList]) => {
        if (cancelled) return;
        setPeople(roster);
        setSubTeams(teams);
        setProjects(projectList);
      })
      .catch(() => {
        // 命令面板只读 catalog——catalog 拉不到时仍能开窗,只是任务候
        // 选人退化成 null。不阻塞 UI。
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // 启动时拉一次托盘可达性（ticket #29）。失败 = banner 保持 null,不
  // 臆测状态——`reason` 是后端拥有的字段,前端不在 catch 里编一个;不
  // 渲染比渲染一条错的「托盘不可用」更安全。IPC 真的抛了,通常意味着
  // Tauri 自己就坏了,横幅说什么都不重要。
  useEffect(() => {
    let cancelled = false;
    trayStatus()
      .then((dto) => {
        if (cancelled) return;
        setTrayStatusDto(dto);
      })
      .catch(() => {
        // 故意不调 setTrayStatusDto——保留 null,banner 不渲染。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
  视图点开一条已有任务时调这里——App 负责把弹窗开起来。`assignee` /
  `project` 候选由视图自己算（今日 / 本周视图已有花名册与项目缓存），
  App 不重复打 IPC。
  */
  const openEditTask = useCallback(
    (
      task: Task,
      extras: {
        assignee: AssigneeCandidate | null;
        project: ProjectCandidate | null;
      },
    ) => {
      setDialog({
        mode: "edit",
        task,
        assignee: extras.assignee,
        project: extras.project,
      });
    },
    [],
  );

  /**
  ⌘K 命令面板选中一条候选后调这里——App 决定"跳到哪个 tab + 定位谁"。
  - 新建任务：直接开弹窗。
  - 已有任务：开弹窗（编辑即详情,ticket #19）。
  - 项目：切到项目 tab + pendingProjectId 选中。
  - 人员：切到人员矩阵 tab + pendingPersonId 滚到。
  */
  const handlePalettePick = useCallback(
    (target: CommandPaletteTarget) => {
      switch (target.kind) {
        case "openCreateTask":
          openCreate();
          return;
        case "openEditTask":
          setDialog({
            mode: "edit",
            task: target.task,
            assignee: target.assignee,
            project: target.project,
          });
          return;
        case "openProject":
          setPendingProjectId(target.projectId);
          setTab("projects");
          return;
        case "openPerson":
          setPendingPersonId(target.personId);
          setTab("matrix");
          return;
      }
    },
    [openCreate],
  );

  /**
   * 「人员详情」段 3（#83 T3）的 + 按钮走这条路径：把当前人员预填
   * 为新项目的负责人,切到「项目」tab 并触发 ProjectsView 的"开新建
   * 表单 + 默认填该 owner"。比让用户再切 tab + 点新建 + 选负责人
   * 省两步。
   */
  const openCreateProject = useCallback(
    (person: Person) => {
      setPendingProjectCreateOwnerId(person.id);
      setTab("projects");
    },
    [],
  );

  /**
   * 「人员详情」段 5（#83 T3）的 + 按钮走这条路径：切到「节假日」
   * tab。模板创建 UI 当前在 holiday tab 内还未落地（独立 ticket），
   * 本期 spec 只要求"切到 tab + 预填子组"——切到 tab 由本回调完
   * 成；「预填子组」的具体形态等模板 UI 落地时再补。
   */
  const openCreateTemplate = useCallback((_subTeamId: number) => {
    // `subTeamId` 入参暂未使用——保留参数等模板 UI 落地后从本回调
    // 直接预填到新表单里。当前最小动作只是切 tab。
    void _subTeamId;
    setTab("holiday");
  }, []);

  /**
   * 「人员详情」子 tab 基础设施（tickets #80 / #84 T4）。
   *
   * `openPerson` 是 5 个外部入口（#86 T6）共用入口：
   * - 矩阵卡片 / PersonnelView 行 / TaskDialog 负责人 / TaskDialog 等
   *   待谁 / ⌘K 命令面板 + dev 临时按钮。
   * - 同一 personId 重复 add → 聚焦已开，不重复新增（Q10 决议）。
   * - 总是切到「人员详情」tab + 激活该子 tab——入口的语义就是"展开
   *   这人的详情"，不把"切到 tab"留给上层记挂。
   */
  const openPerson = useCallback((personId: number) => {
    setOpenPersonTabs((tabs) => {
      if (tabs.some((t) => t.personId === personId)) return tabs;
      return [...tabs, { personId }];
    });
    setActivePersonId(personId);
    setTab("personDetail");
  }, []);

  /**
   * 最新 openPersonTabs 的镜像 —— `closePersonTab` 需要"刚被关闭
   * 那一帧"的 idx 推断左右邻居,但 functional setState 的回调里再
   * 调另一个 setState 是 antipattern。改成 ref：每次 render 同步
   * 更新到最新值，闭包内直接读。
   */
  const openPersonTabsRef = useRef(openPersonTabs);
  openPersonTabsRef.current = openPersonTabs;

  /**
   * × 关闭单条子 tab。
   *
   * 关闭的是当前激活子 tab 时，新激活态按"先左后右"规则收敛——
   * 优先选刚关掉那条左侧的剩余子 tab；没有左侧剩就选右侧第一条
   * （与 VSCode / IntelliJ 子 tab 关闭的 UX 行为一致）。两个状态
   * 在同一 React 同步事件里更新,避免 effect 兜底造成"两次闪烁"。
   *
   * 关闭非激活子 tab 时不动 activePersonId。
   */
  const closePersonTab = useCallback((personId: number) => {
    const tabs = openPersonTabsRef.current;
    const idx = tabs.findIndex((t) => t.personId === personId);
    if (idx < 0) return;
    setOpenPersonTabs(tabs.filter((t) => t.personId !== personId));
    setActivePersonId((current) => {
      if (current !== personId) return current;
      const left = tabs[idx - 1];
      const right = tabs[idx + 1];
      return left?.personId ?? right?.personId ?? null;
    });
  }, []);

  // 兜底：openPersonTabs / activePersonId 任意一方变化后,若
  // activePersonId 仍不在 openPersonTabs 中（外部路径触发,例如
  // 切到其他主 tab 后又回来时状态错位）——回退到左邻居 / 右邻居 /
  // 剩余 [0] / null。这一层是 closePersonTab 主路径之外的兜底,主
  // 路径已在 setOpenPersonTabs 内同步收敛。
  useEffect(() => {
    if (openPersonTabs.length === 0) {
      if (activePersonId !== null) setActivePersonId(null);
      return;
    }
    if (
      activePersonId == null ||
      !openPersonTabs.some((t) => t.personId === activePersonId)
    ) {
      // 兜底规则：右邻居（即刚被关掉的右侧），再左邻居，再 [0]。
      // 大多数场景下 closePersonTab 已在前一帧定好,这里只在异常
      // 路径（外部强制改 state）生效。
      setActivePersonId(openPersonTabs[0]!.personId);
    }
  }, [openPersonTabs, activePersonId]);

  /** 关闭所有非 `personId` 的子 tab（右键菜单「关闭其他」）。 */
  const closeOtherPersonTabs = useCallback((personId: number) => {
    setOpenPersonTabs((tabs) => tabs.filter((t) => t.personId === personId));
    setActivePersonId(personId);
  }, []);

  /** 关闭所有子 tab（右键菜单「关闭全部」）。 */
  const closeAllPersonTabs = useCallback(() => {
    setOpenPersonTabs([]);
    setActivePersonId(null);
  }, []);

  /** 关闭 `personId` 左侧所有子 tab（右键菜单「关闭左侧」）。 */
  const closeLeftPersonTabs = useCallback((personId: number) => {
    setOpenPersonTabs((tabs) => {
      const idx = tabs.findIndex((t) => t.personId === personId);
      if (idx <= 0) return tabs;
      return tabs.slice(idx);
    });
  }, []);

  /** 关闭 `personId` 右侧所有子 tab（右键菜单「关闭右侧」）。 */
  const closeRightPersonTabs = useCallback((personId: number) => {
    setOpenPersonTabs((tabs) => {
      const idx = tabs.findIndex((t) => t.personId === personId);
      if (idx < 0 || idx >= tabs.length - 1) return tabs;
      return tabs.slice(0, idx + 1);
    });
  }, []);

  /** 拖拽重排 —— `fromIndex` / `toIndex` 是 openPersonTabs 的下标。 */
  const reorderPersonTabs = useCallback((fromIndex: number, toIndex: number) => {
    setOpenPersonTabs((tabs) => {
      if (fromIndex === toIndex) return tabs;
      if (fromIndex < 0 || fromIndex >= tabs.length) return tabs;
      if (toIndex < 0 || toIndex >= tabs.length) return tabs;
      const next = [...tabs];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return tabs;
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <h1 className="text-xl font-semibold">科室任务管理</h1>
          <nav className="flex gap-1">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-current={tab === entry.id ? "page" : undefined}
                onClick={() => setTab(entry.id)}
                className={`cursor-pointer rounded-md px-3 py-1.5 text-sm ${
                  tab === entry.id
                    ? "bg-muted font-medium"
                    : "text-muted-foreground hover:bg-muted/60"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPaletteOpen(true)}
            aria-label="打开命令面板"
            title="⌘K 打开命令面板"
          >
            ⌘K
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus />
            新建任务
            <kbd className="ml-1 text-xs opacity-70">⌘N</kbd>
          </Button>
        </div>
      </header>

      <TrayStatusBanner status={trayStatusDto} />
      <SampleDataBanner
        refreshToken={refreshToken}
        onCleared={onSampleCleared}
      />

      {tab === "today" ? (
        <TodayWeekView
          refreshToken={refreshToken}
          onOpenTask={openEditTask}
        />
      ) : tab === "matrix" ? (
        <PersonnelMatrixView
          refreshToken={refreshToken}
          onOpenTask={openEditTask}
          pendingPersonId={pendingPersonId}
          onPersonLocated={() => setPendingPersonId(null)}
        />
      ) : tab === "projects" ? (
        <ProjectsView
          refreshToken={refreshToken}
          pendingProjectId={pendingProjectId}
          onProjectLocated={() => setPendingProjectId(null)}
          pendingCreateOwnerId={pendingProjectCreateOwnerId}
          onCreateOwnerConsumed={() => setPendingProjectCreateOwnerId(null)}
        />
      ) : tab === "personnel" ? (
        <PersonnelView />
      ) : tab === "personDetail" ? (
        <PersonDetailTabsView
          openPersonTabs={openPersonTabs}
          activePersonId={activePersonId}
          people={people}
          subTeams={subTeams}
          refreshToken={refreshToken}
          onActivate={setActivePersonId}
          onClose={closePersonTab}
          onCloseOthers={closeOtherPersonTabs}
          onCloseAll={closeAllPersonTabs}
          onCloseLeft={closeLeftPersonTabs}
          onCloseRight={closeRightPersonTabs}
          onReorder={reorderPersonTabs}
          onOpenTask={(task, { assignee }) =>
            openEditTask(task, { assignee, project: null })
          }
          onCreateTask={(person) => openCreateWithAssignee(person)}
          onCreateProject={(person) => openCreateProject(person)}
          onCreateTemplate={(subTeamId) => openCreateTemplate(subTeamId)}
        />
      ) : (
        <HolidayCalendarView refreshToken={refreshToken} />
      )}

      {/* Dev-only: 临时打开人员详情视图（tickets #81 T1 / #82 T2 / #84 T4 · 端到端 seam）。
       * 仅 dev 模式下出现,Vite 注入 `import.meta.env.DEV = true`、
       * 注入 `import.meta.env.MODE = 'development'`；生产构建时两个都
       * 不是预期值,按钮自动消失。test 模式 (`MODE = 'test'`) 也不渲
       * 染,避免污染 App.test 的断言。
       * T4 起本按钮调 openPerson(1)（替代 T1 的内联 PersonDetailView）
       * —— 真实「人员详情」tab + 子 tab 列表是 T4 落地后的渲染路径。
       * T6 (#86) 移除本按钮,改由 5 个真入口（矩阵 / PersonnelView /
       * TaskDialog / ⌘K）触发 openPerson。 */}
      {import.meta.env.DEV && import.meta.env.MODE !== "test" && (
        <div className="border-warning/40 bg-warning/10 rounded-md border p-3 text-xs">
          <div className="text-warning mb-2 font-medium">
            DEV · 临时打开人员详情子 tab（id=1,T4 起 → T6 移除）
          </div>
          <button
            type="button"
            onClick={() => openPerson(1)}
            className="bg-warning text-warning-foreground hover:bg-warning/80 rounded-md px-2 py-1 text-xs"
          >
            打开 person id=1 的子 tab
          </button>
        </div>
      )}

      {dialog && (
        <TaskDialog
          // 换任务 = 换一个弹窗实例，contenteditable 的初值才铺得干净
          key={dialog.mode === "edit" ? `edit-${dialog.task.id}` : "create"}
          target={dialog}
          onClose={closeDialog}
          onSaved={onTaskSaved}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        catalog={{ people, subTeams, projects }}
        onClose={() => setPaletteOpen(false)}
        onPick={handlePalettePick}
      />
    </main>
  );
}
