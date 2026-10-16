import { useCallback, useEffect, useReducer, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TaskDialog } from "@/components/task/TaskDialog";
import { CommandPalette } from "@/components/wayfinder/CommandPalette";
import { TrayStatusBanner } from "@/components/tray/TrayStatusBanner";
import { SampleDataBanner } from "@/components/SampleDataBanner";
import { PersonnelMatrixView } from "@/views/PersonnelMatrixView";
import { PersonnelView } from "@/views/PersonnelView";
import { ProjectsView } from "@/views/ProjectsView";
import { TodayWeekView } from "@/views/TodayWeekView";
import { HolidayCalendarView } from "@/views/HolidayCalendarView";
import { PersonDetailTabsView } from "@/views/PersonDetailTabsView";
import {
  listPeople, listProjects, listSubTeams, trayStatus,
  type Person,
  type Project, type SubTeam, type TrayStatusDto,
} from "@/lib/api";
import { toAssigneeCandidate } from "@/lib/assignee";
import {
  initialState, navigationReducer,
  type MainTabId, type NavigationEvent,
} from "@/views/navigation/state";

/** 主 tab 表(`MainTabId` 字面在 state.ts;详见 ADR 0012)。 */
const TABS: { id: MainTabId; label: string }[] = [
  { id: "today", label: "今日 / 本周" },
  { id: "matrix", label: "人员矩阵" },
  { id: "projects", label: "项目" },
  { id: "personnel", label: "人员" },
  { id: "personDetail", label: "人员详情" },
  { id: "holiday", label: "节假日" },
];

/** App 外壳。5 类导航状态全入 `navigationReducer`;shell 只剩 transient data + `refreshToken`(ADR 0012)。 */
export default function App() {
  const [nav, dispatch] = useReducer(navigationReducer, initialState);
  const { tab, subTabs, activeSubTabId, dialog, palette, pendingIntent } = nav;

  // reducer 不沾 refreshToken —— TaskSaved 时 shell bump 重拉(spec #96 §决策 13)。
  const [refreshToken, setRefreshToken] = useState(0);
  const [people, setPeople] = useState<Person[]>([]);
  const [subTeams, setSubTeams] = useState<SubTeam[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // `null` = 还没拉回;banner 不渲染避免「不可用」臆测(issue #29)。
  const [trayStatusDto, setTrayStatusDto] = useState<TrayStatusDto | null>(null);

  const openCreateTask = useCallback(
    () => dispatch({ kind: "OpenTaskDialog", target: { mode: "create" } }),
    [dispatch],
  );

  const onTaskSaved = useCallback(() => {
    dispatch({ kind: "TaskSaved" });
    setRefreshToken((t) => t + 1);
  }, [dispatch]);

  const onSampleCleared = useCallback(
    () => setRefreshToken((t) => t + 1),
    [],
  );

  // 「人员详情」段 2 + 按钮:预填 assignee。
  const onCreateTaskWithAssignee = useCallback(
    (person: Person) =>
      dispatch({
        kind: "OpenTaskDialog",
        target: {
          mode: "create",
          initialAssignee: toAssigneeCandidate(person, subTeams),
        },
      }),
    [dispatch, subTeams],
  );

  // 11 类 event 同一端口(issue #98 + #100);TS 阻挡越权主 tab event。
  const onPersonDetailNavigate = useCallback(
    (event: NavigationEvent) => dispatch(event),
    [dispatch],
  );

  // catalog 随 refreshToken 重拉 — 命令面板读 catalog 不发 IPC。
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
      .catch(() => {});
    return () => { cancelled = true; };
  }, [refreshToken]);

  // 启动时拉一次托盘可达性;失败不编 reason —— null 保持不渲染。
  useEffect(() => {
    let cancelled = false;
    trayStatus()
      .then((dto) => { if (!cancelled) setTrayStatusDto(dto); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // ⌘N / ⌘K 任意 tab 唤起;⌘W / ⌘⇧← / ⌘⇧→ 仅「人员详情」生效(Q27);其它 tab 不拦截 Electron 默认手势。
  // ⌘N dialog 唯一性(#99);⌘K 派 OpenPalette(#100);⌘W → CloseActiveSubTab / ⌘⇧←→ → ActivatePersonTab clamped(#98)。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (dialog == null) openCreateTask();
        return;
      }
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        dispatch({ kind: "OpenPalette" });
        return;
      }
      if (tab !== "personDetail") return;
      if (mod && !event.shiftKey && event.key.toLowerCase() === "w") {
        event.preventDefault();
        dispatch({ kind: "CloseActiveSubTab" });
        return;
      }
      if (
        mod && event.shiftKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        subTabs.length > 1 && activeSubTabId != null
      ) {
        event.preventDefault();
        const idx = subTabs.findIndex(
          (entry) => entry.personId === activeSubTabId,
        );
        if (idx < 0) return;
        const next = subTabs[
          event.key === "ArrowLeft"
            ? Math.max(0, idx - 1)
            : Math.min(subTabs.length - 1, idx + 1)
        ];
        if (next && next.personId !== activeSubTabId) {
          dispatch({ kind: "ActivatePersonTab", personId: next.personId });
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog, tab, subTabs, activeSubTabId, dispatch, openCreateTask]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <h1 className="text-xl font-semibold">科室任务管理</h1>
          <nav className="flex gap-1">
            {TABS.map((entry) => (
              <button
                key={entry.id} type="button"
                aria-current={tab === entry.id ? "page" : undefined}
                onClick={() => dispatch({ kind: "SetTab", tab: entry.id })}
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
          <Button size="sm" variant="outline"
            onClick={() => dispatch({ kind: "OpenPalette" })}
            aria-label="打开命令面板" title="⌘K 打开命令面板">⌘K</Button>
          <Button size="sm" onClick={openCreateTask}>
            <Plus />新建任务<kbd className="ml-1 text-xs opacity-70">⌘N</kbd>
          </Button>
        </div>
      </header>

      <TrayStatusBanner status={trayStatusDto} />
      <SampleDataBanner refreshToken={refreshToken} onCleared={onSampleCleared} />

      {tab === "today" ? (
        <TodayWeekView refreshToken={refreshToken}
          onOpenTask={(task, { assignee, project }) =>
            dispatch({ kind: "OpenTaskDialog", target: { mode: "edit", task, assignee, project } })} />
      ) : tab === "matrix" ? (
        <PersonnelMatrixView refreshToken={refreshToken}
          onOpenTask={(task, { assignee, project }) =>
            dispatch({ kind: "OpenTaskDialog", target: { mode: "edit", task, assignee, project } })}
          onOpenPerson={(personId) => dispatch({ kind: "OpenPerson", personId })} />
      ) : tab === "projects" ? (
        // pendingIntent 单 slot(#100);回调 IntentConsumed 清 slot。
        <ProjectsView refreshToken={refreshToken} pendingIntent={pendingIntent}
          onIntentConsumed={() => dispatch({ kind: "IntentConsumed" })} />
      ) : tab === "personnel" ? (
        <PersonnelView onOpenPerson={(personId) => dispatch({ kind: "OpenPerson", personId })} />
      ) : tab === "personDetail" ? (
        <PersonDetailTabsView
          openPersonTabs={subTabs} activePersonId={activeSubTabId}
          people={people} subTeams={subTeams} refreshToken={refreshToken}
          onNavigation={onPersonDetailNavigate}
          onOpenTask={(task, { assignee }) =>
            dispatch({ kind: "OpenTaskDialog", target: { mode: "edit", task, assignee, project: null } })}
          onCreateTask={onCreateTaskWithAssignee}
        />
      ) : (
        <HolidayCalendarView refreshToken={refreshToken} />
      )}

      {dialog && (
        <TaskDialog
          // 换任务 = 换 key,contenteditable 初值铺得干净
          key={dialog.mode === "edit" ? `edit-${dialog.task.id}` : "create"}
          target={dialog}
          onClose={() => dispatch({ kind: "CloseTaskDialog" })}
          onSaved={onTaskSaved}
          onOpenPerson={(personId) => dispatch({ kind: "OpenPerson", personId })}
        />
      )}

      <CommandPalette
        open={palette !== null}
        catalog={{ people, subTeams, projects }}
        onClose={() => dispatch({ kind: "ClosePalette" })}
        // PalettePick 一条事件原子改多态(#100 §AC #2)
        onPick={(target) => dispatch({ kind: "PalettePick", target })}
      />
    </main>
  );
}
