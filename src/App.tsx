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
  listPeople,
  listProjects,
  listSubTeams,
  trayStatus,
  type Person,
  type Project,
  type SubTeam,
  type TrayStatusDto,
} from "@/lib/api";
import { toAssigneeCandidate } from "@/lib/assignee";
import {
  initialState,
  navigationReducer,
  type MainTabId,
  type NavigationEvent,
} from "@/views/navigation/state";

/**
 * 顶层 tab——spec #15 user story 60-66：四个主视图平级。
 *
 * 「今日 / 本周」是默认落地页（ticket #21），「人员矩阵」（ticket #22）、
 * 「项目看板」（ticket #20）并列。「人员」单独一个 tab——做子组 / 人员
 * CRUD，与矩阵的"读"视角分开。「人员详情」（ticket #80 / #84 T4）承载
 * 每位人员的子 tab 列表（多人员对比视图），与「人员」CRUD tab 分开——
 * 读 / 写两种视角各占一席。
 *
 * 主 tab id 用 `navigation/state.ts:MainTabId` 作单一权威（issue #97 接
 * 缝时由 reducer 接管,重复字面双权威已下线 —— parent spec #96 §决策 1）。
 */
const TABS: { id: MainTabId; label: string }[] = [
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
 *
 * 5 类导航状态（主 tab / sub-tab + active / TaskDialog / palette /
 * pendingIntent）已落入 `useReducer(navigationReducer, initialState)`
 * （issues #97 sub-tab / #98 tab+keydown / #99 dialog / #100 palette +
 * PalettePick + pendingIntent）。`activeSubTabId ∈ subTabs` 不变量由
 * reducer post-step `reconcileActive` 一行收敛（parent spec #96 §决策
 * 4,取代旧 stale-closure ref + fallback `useEffect` 双反模式）。dialog
 * 唯一性由 reducer `OpenTaskDialog` case 守 —— 已有 dialog 时再开第二
 * 份是 no-op（issue #99 §dialog 唯一性）。palette / pendingIntent 由
 * reducer 接管：⌘K / Esc / 遮罩 / PalettePick 4 子路由 / IntentConsumed
 * 全部走 reducer —— 一条 PalettePick 事件原子改多态（dialog / tab /
 * pendingIntent / palette）,React 不渲染中间帧（issue #100 §What to
 * build + AC #2）。
 *
 * 仍在 shell useState 的：transient data（people / subTeams / projects /
 * trayStatusDto）、invalidation counter `refreshToken` —— reducer 不沾
 * （spec #96 §决策 1、#99 §决策 13）。
 */
export default function App() {
  // ----- reducer：5 类导航状态 -----
  // 单一 seam —— `navigationReducer` 是纯函数,App.tsx 私有持有
  // （parent spec #96 §决策 3）,子视图不可自己 `useReducer`,
  // 只通过 `onNavigation={dispatch}` 派发事件。
  const [navState, dispatch] = useReducer(navigationReducer, initialState);
  const { tab, subTabs, activeSubTabId, dialog, palette, pendingIntent } =
    navState;

  // ----- shell useState：catalog / refreshToken -----
  // 弹窗保存后 +1，让当前视图重新拉一次。refreshToken 不沾 reducer
  // —— reducer `TaskSaved` 只关 dialog,shell `onTaskSaved` 显式 bump
  // （spec #96 §决策 13、#99 §决策 13）。
  const [refreshToken, setRefreshToken] = useState(0);

  // 全局 catalog：人员 / 子组 / 项目。一次拉，所有视图复用。命令面板
  // 据此算 assignee / project 候选，不必再发 IPC。
  const [people, setPeople] = useState<Person[]>([]);
  const [subTeams, setSubTeams] = useState<SubTeam[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  // 托盘可达性（ticket #29）：启动时拉一次。banner 只渲染不轮询——后续
  // Rust 端走事件总线推状态变化时再加 effect，本期只响应启动那一瞬。
  // `null` = 拉数据还没回来（不渲染，避免短暂闪烁）。
  const [trayStatusDto, setTrayStatusDto] = useState<TrayStatusDto | null>(null);

  /**
   * shell 处理 TaskDialog 保存结果 —— dispatch `TaskSaved` 让 reducer 关
   * dialog,同时显式 bump `refreshToken` 让视图重拉（spec #96 §决策 13）。
   * `dispatch` 与 `setRefreshToken` 互不依赖 —— reducer 不沾 refreshToken,
   * shell 显式同步 bump。
   */
  const onTaskSaved = useCallback(() => {
    dispatch({ kind: "TaskSaved" });
    setRefreshToken((token) => token + 1);
  }, [dispatch]);

  // 横幅清除示例后也得刷——views 按 refreshToken 拉数据，不清的话
  // Today/矩阵/项目/人员 视图继续展示已删的示例任务。
  const onSampleCleared = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  /**
   * 「人员详情」段 2（#82 T2）的 + 按钮:把当前人员预填为负责人,
   * 派 `OpenTaskDialog` reducer 事件。`subTeamName` 从 catalog 查;
   * catalog 缺失时回退空串 —— 详情页本来就有 fallback 路径
   * (`useMissingSubTeams`)兜底,这里不重复做。
   */
  const onCreateTaskWithAssignee = useCallback(
    (person: Person) => {
      dispatch({
        kind: "OpenTaskDialog",
        target: {
          mode: "create",
          initialAssignee: toAssigneeCandidate(person, subTeams),
        },
      });
    },
    [dispatch, subTeams],
  );

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
        // 命令面板只读 catalog——catalog 拉不到时仍能开窗，只是任务候
        // 选人退化成 null。不阻塞 UI。
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // 启动时拉一次托盘可达性（ticket #29）。失败 = banner 保持 null，不
  // 臆测状态——`reason` 是后端拥有的字段，前端不在 catch 里编一个；不
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
        // 故意不调 setTrayStatusDto——保留 null，banner 不渲染。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * PersonDetailTabsView 单一 nav 派发端口 —— 9 类 sub-tab event +
   * OpenCreateProjectFor / OpenCreateTemplateFor 共 11 类 event 折叠到
   * `onNavigation(event: NavigationEvent)`(issue #98 + #100)。子视图越
   * 权 dispatch 受 TS 类型 `NavigationEvent` 约束 —— 不能传非 union 成
   * 员(编译期报红)。
   *
   * 子视图对外只有「选中谁」「激活谁」「关谁」三种语义,内部翻译成对
   * 应 reducer 事件 —— shell 这层不再持有 imperative helper。
   */
  const onPersonDetailNavigate = useCallback(
    (event: NavigationEvent) => dispatch(event),
    [dispatch],
  );

  // 顶栏「新建任务」按钮 + ⌘N / ⌘K 都在 window 层——保证在任意视图
  // 都能唤起。
  // T7（#87）：人员详情专属快捷键 ——
  // - ⌘W 关当前激活子 tab
  // - ⌘⇧← / ⌘⇧→ 切到上一 / 下一子 tab
  // 按 Q27 决议只对「人员详情」tab 生效；其他 tab 不拦截 ⌘W，留给
  // Electron 默认关窗口的手势。
  // ⌘W / ⌘⇧← / ⌘⇧→ 全部派发 reducer 事件（issue #98）：
  // - `CloseActiveSubTab` (⌘W)
  // - `ActivatePersonTab`(⌘⇧← / ⌘⇧→ 切到上一 / 下一索引)
  // reducer 在 `CloseActiveSubTab` 主路径里做左-右-null 精细兜底
  // （state.ts:reduceCloseActiveSubTab），与旧 App.tsx 同步收敛
  // 多 setState 的主路径同形 —— 不过此时已一行 dispatch 顶替。
  //
  // ⌘N 的 dialog 唯一性(issue #99 §dialog 唯一性):已有 dialog 时 ⌘N
  // 在 effect 层 gate 掉,不再 dispatch —— reducer 自身的唯一性兜底
  // 作为防御。`dialog` 直接从 `navState.dialog` 读。
  //
  // ⌘K(issue #100):派 `OpenPalette` reducer 事件 —— palette 字段已
  // 入 reducer(`{ open: boolean } | null`),shell 不再为 palette 开关
  // 持有独立 useState。Esc 与点遮罩 → `ClosePalette`(CommandPalette 内部
  // onClose 回调 → 此处 dispatch)。PalettePick 4 子路由由 reducer 原子完成。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "n") {
        event.preventDefault();
        // dialog 唯一性 gate:已有 dialog 时 ⌘N 是 no-op(issue #99 §
        // dialog 唯一性)。reducer 自身也兜底,但 effect 层 gate 让用户
        // 按 ⌘N 时无声无息,不派第二条事件入 reducer 后被丢。
        if (dialog == null) {
          dispatch({ kind: "OpenTaskDialog", target: { mode: "create" } });
        }
        return;
      }
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        dispatch({ kind: "OpenPalette" });
        return;
      }
      // 后续 2 条仅「人员详情」tab 生效 —— tabs 不命中时直接 return,
      // 不 preventDefault，让 Electron / 浏览器默认手势（关窗口、向
      // 后翻页等）继续走。
      if (tab !== "personDetail") return;

      // ⌘W：关闭当前激活子 tab。无激活子 tab 时也 preventDefault ——
      // 用户在「人员详情」tab 按 ⌘W 的意图就是"关这条"，不该被透成关窗。
      if (mod && !event.shiftKey && event.key.toLowerCase() === "w") {
        event.preventDefault();
        dispatch({ kind: "CloseActiveSubTab" });
        return;
      }

      // ⌘⇧← / ⌘⇧→：上一/下一子 tab（Q27）。clamp 在两端 —— 与浏览器 /
      // VSCode 的 tab bar 语义一致，不环绕。1 条子 tab 时同样消费事件
      // 避免被浏览器读作"光标到输入框头部"。
      if (
        mod && event.shiftKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        if (subTabs.length > 1 && activeSubTabId != null) {
          event.preventDefault();
          const idx = subTabs.findIndex(
            (entry) => entry.personId === activeSubTabId,
          );
          if (idx >= 0) {
            const isLeft = event.key === "ArrowLeft";
            const clamped = isLeft
              ? Math.max(0, idx - 1)
              : Math.min(subTabs.length - 1, idx + 1);
            if (clamped !== idx) {
              const next = subTabs[clamped];
              if (next) {
                dispatch({
                  kind: "ActivatePersonTab",
                  personId: next.personId,
                });
              }
            }
          }
        } else {
          event.preventDefault();
        }
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog, tab, subTabs, activeSubTabId, dispatch]);

  // palette 是否开启 = `palette != null`。CommandPalette 收到 `open` 布尔
  // 透传显示 —— 关闭由组件内部 onClose 回调 → dispatch `ClosePalette`。
  const paletteIsOpen = palette !== null;

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
          <Button
            size="sm"
            variant="outline"
            onClick={() => dispatch({ kind: "OpenPalette" })}
            aria-label="打开命令面板"
            title="⌘K 打开命令面板"
          >
            ⌘K
          </Button>
          <Button
            size="sm"
            onClick={() =>
              dispatch({
                kind: "OpenTaskDialog",
                target: { mode: "create" },
              })
            }
          >
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
          onOpenTask={(task, { assignee, project }) =>
            dispatch({
              kind: "OpenTaskDialog",
              target: { mode: "edit", task, assignee, project },
            })
          }
        />
      ) : tab === "matrix" ? (
        <PersonnelMatrixView
          refreshToken={refreshToken}
          onOpenTask={(task, { assignee, project }) =>
            dispatch({
              kind: "OpenTaskDialog",
              target: { mode: "edit", task, assignee, project },
            })
          }
          onOpenPerson={(personId) =>
            dispatch({ kind: "OpenPerson", personId })
          }
        />
      ) : tab === "projects" ? (
        <ProjectsView
          refreshToken={refreshToken}
          // pendingIntent 单 slot —— locateProject / createProjectFor /
          // createTemplateFor 三种意图取代旧双 slot (issue #100,前后两
          // 个 useState 合并为 reducer 一个 sum-typed slot)。视图据
          // `kind` 决定 prefill,再回调 onIntentConsumed 清 slot。
          pendingIntent={pendingIntent}
          onIntentConsumed={() => dispatch({ kind: "IntentConsumed" })}
        />
      ) : tab === "personnel" ? (
        <PersonnelView
          onOpenPerson={(personId) =>
            dispatch({ kind: "OpenPerson", personId })
          }
        />
      ) : tab === "personDetail" ? (
        <PersonDetailTabsView
          openPersonTabs={subTabs}
          activePersonId={activeSubTabId}
          people={people}
          subTeams={subTeams}
          refreshToken={refreshToken}
          onNavigation={onPersonDetailNavigate}
          onOpenTask={(task, { assignee }) =>
            dispatch({
              kind: "OpenTaskDialog",
              target: { mode: "edit", task, assignee, project: null },
            })
          }
          onCreateTask={(person) => onCreateTaskWithAssignee(person)}
        />
      ) : (
        <HolidayCalendarView refreshToken={refreshToken} />
      )}

      {dialog && (
        <TaskDialog
          // 换任务 = 换一个弹窗实例，contenteditable 的初值才铺得干净
          key={dialog.mode === "edit" ? `edit-${dialog.task.id}` : "create"}
          target={dialog}
          onClose={() => dispatch({ kind: "CloseTaskDialog" })}
          onSaved={onTaskSaved}
          // #86 T6：任务详情弹窗的「负责人」「等待谁」字段可点。
          onOpenPerson={(personId) =>
            dispatch({ kind: "OpenPerson", personId })
          }
        />
      )}

      <CommandPalette
        open={paletteIsOpen}
        catalog={{ people, subTeams, projects }}
        // Esc / 点遮罩 / × 关闭 —— reducer `ClosePalette` case 体原子
        // 设 palette = null(issue #100 §AC #1)。
        onClose={() => dispatch({ kind: "ClosePalette" })}
        // 选中条目 —— reducer `PalettePick(target)` 一条事件原子改多态
        // (issue #100 §AC #2:PalettePick(openProject) = pendingIntent
        // 设 + tab projects + palette null 一帧完成,React 不渲染中间帧)。
        onPick={(target) => dispatch({ kind: "PalettePick", target })}
      />
    </main>
  );
}