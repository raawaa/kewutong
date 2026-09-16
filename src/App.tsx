import { useCallback, useEffect, useState } from "react";
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
import { PersonnelMatrixView } from "@/views/PersonnelMatrixView";
import { PersonnelView } from "@/views/PersonnelView";
import { ProjectsView } from "@/views/ProjectsView";
import { TodayWeekView } from "@/views/TodayWeekView";
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
} from "@/lib/ipc";

/**
 * 顶层 tab——spec #15 user story 60-66：四个主视图平级。
 *
 * 「今日 / 本周」是默认落地页（ticket #21），「人员矩阵」（ticket #22）、
 * 「项目看板」（ticket #20）并列。「人员」单独一个 tab——做子组 / 人员
 * CRUD,与矩阵的"读"视角分开。
 */
type Tab = "today" | "matrix" | "projects" | "personnel";

const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "今日 / 本周" },
  { id: "matrix", label: "人员矩阵" },
  { id: "projects", label: "项目" },
  { id: "personnel", label: "人员" },
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

  const openCreate = useCallback(() => setDialog({ mode: "create" }), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const onTaskSaved = useCallback(() => {
    setDialog(null);
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
        />
      ) : (
        <PersonnelView />
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
