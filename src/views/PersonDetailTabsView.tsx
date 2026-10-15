import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { X } from "lucide-react";
import { PersonDetailView } from "@/views/PersonDetailView";
import {
  type AssigneeCandidate,
  type Person,
  type SubTeam,
  type Task,
} from "@/lib/api";

/**
 * 「人员详情」主 tab 的子 tab 列表 + 内容区（tickets #80 / #84 T4）。
 *
 * 基础设施层 —— 不画详情内容，只承担：
 * 1. 子 tab 条（姓名 / （离岗）徽章 / × / 切换激活态 / 拖拽重排 / 右键菜单）。
 * 2. 已开子 tab 的内容区：所有 `PersonDetailView` 同时挂载，非激活用
 *    `hidden` 隐藏 —— DOM 与 React state 保留，切换瞬时（Q23）。
 * 3. 子 tab 列表空时显示空态占位（浏览网格由 T5 #85 接入）。
 *
 * 业务规则在 `PersonDetailView` 与主进程命令层；本视图只管"开 / 关 / 重排"。
 */

/** 一条已开子 tab = 一位人员的详情容器（spec #80 §Implementation #3）。 */
export interface OpenPersonTab {
  personId: number;
}

export function PersonDetailTabsView({
  openPersonTabs,
  activePersonId,
  people,
  subTeams,
  refreshToken,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCloseLeft,
  onCloseRight,
  onReorder,
  onOpenTask,
  onCreateTask,
  onCreateProject,
  onCreateTemplate,
}: {
  /** 已开子 tab 列表 —— 物理顺序即子 tab 显示顺序（spec #80 §Impl #11）。 */
  openPersonTabs: ReadonlyArray<OpenPersonTab>;
  /** 当前激活的子 tab；`null` = 没有任何子 tab 激活。 */
  activePersonId: number | null;
  /** 父层 catalog（人员）—— 用来给子 tab 标题取姓名 / 离岗徽章。 */
  people: ReadonlyArray<Person>;
  /** 父层 catalog（子组）—— 透传给 PersonDetailView。 */
  subTeams: ReadonlyArray<SubTeam>;
  /** 父层保存后 +1，触发所有已开子 tab 重拉（spec #80 §Impl #19）。 */
  refreshToken: number;
  /** 子 tab 点击 → 激活。 */
  onActivate: (personId: number) => void;
  /** × 关闭 / 右键菜单「关闭此」→ 从列表移除。 */
  onClose: (personId: number) => void;
  /** 右键菜单「关闭其他」→ 保留此人，关闭其余。 */
  onCloseOthers: (personId: number) => void;
  /** 右键菜单「关闭全部」→ 清空列表。 */
  onCloseAll: () => void;
  /** 右键菜单「关闭左侧」→ 关闭此左侧所有。 */
  onCloseLeft: (personId: number) => void;
  /** 右键菜单「关闭右侧」→ 关闭此右侧所有。 */
  onCloseRight: (personId: number) => void;
  /** 拖拽重排 → 用数组新顺序重排 openPersonTabs。 */
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** 内容区回调 —— 透传给 PersonDetailView（5 段聚合打开弹窗 / 新建）。 */
  onOpenTask: (task: Task, extras: { assignee: AssigneeCandidate }) => void;
  onCreateTask: (person: Person) => void;
  onCreateProject: (person: Person) => void;
  onCreateTemplate: (subTeamId: number) => void;
}) {
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  return (
    <div className="flex flex-col gap-4">
      <header
        aria-label="人员详情子 tab 条"
        className="flex items-center justify-between gap-2"
      >
        <p className="text-muted-foreground text-sm">
          人员详情 · 每人一个子 tab，切换不重拉
        </p>
      </header>

      {openPersonTabs.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <PersonSubTabBar
            openPersonTabs={openPersonTabs}
            activePersonId={activePersonId}
            peopleById={peopleById}
            onActivate={onActivate}
            onClose={onClose}
            onCloseOthers={onCloseOthers}
            onCloseAll={onCloseAll}
            onCloseLeft={onCloseLeft}
            onCloseRight={onCloseRight}
            onReorder={onReorder}
          />
          <PersonDetailContentArea
            openPersonTabs={openPersonTabs}
            activePersonId={activePersonId}
            subTeams={subTeams}
            refreshToken={refreshToken}
            onOpenTask={onOpenTask}
            onCreateTask={onCreateTask}
            onCreateProject={onCreateProject}
            onCreateTemplate={onCreateTemplate}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子 tab 条
// ---------------------------------------------------------------------------

/**
 * 子 tab 条 —— 一行渲染所有 openPersonTabs，每条 = 标题 + × + 右键菜单 +
 * 拖拽重排。
 *
 * 行为约束（spec #80 §Implementation Decisions #10 / #11 / #12）：
 * - hover 出现 ×；点击 = 激活。
 * - 右键 = 4 项菜单（关闭其他 / 关闭全部 / 关闭左侧 / 关闭右侧）。
 * - 拖拽 = 重排（HTML5 DnD；不引入额外依赖）。
 *
 * 不依赖 external DnD 库（spec #80 §Impl #23）。
 */
function PersonSubTabBar({
  openPersonTabs,
  activePersonId,
  peopleById,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCloseLeft,
  onCloseRight,
  onReorder,
}: {
  openPersonTabs: ReadonlyArray<OpenPersonTab>;
  activePersonId: number | null;
  peopleById: Map<number, Person>;
  onActivate: (personId: number) => void;
  onClose: (personId: number) => void;
  onCloseOthers: (personId: number) => void;
  onCloseAll: () => void;
  onCloseLeft: (personId: number) => void;
  onCloseRight: (personId: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}) {
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [menuState, setMenuState] = useState<{
    personId: number;
    top: number;
    left: number;
  } | null>(null);

  // 点击外部 / Escape 关闭右键菜单 —— 全局监听比 each-button 各自监听简洁。
  useEffect(() => {
    if (menuState == null) return;
    function handleMouseDown(event: globalThis.MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target && target.closest("[data-person-tab-menu]")) return;
      setMenuState(null);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuState(null);
    }
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [menuState]);

  const handleDragStart = useCallback(
    (index: number) => (event: ReactDragEvent<HTMLDivElement>) => {
      dragIndexRef.current = index;
      event.dataTransfer.effectAllowed = "move";
      // DnD 规范要求 setData 才能在 Firefox 触发 —— 实际内容不重要。
      event.dataTransfer.setData("text/plain", String(index));
    },
    [],
  );

  const handleDragOver = useCallback(
    (index: number) => (event: ReactDragEvent<HTMLDivElement>) => {
      if (dragIndexRef.current == null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dragOverIndex !== index) setDragOverIndex(index);
    },
    [dragOverIndex],
  );

  const handleDragEnd = useCallback(() => {
    dragIndexRef.current = null;
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback(
    (targetIndex: number) => (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const sourceIndex = dragIndexRef.current;
      dragIndexRef.current = null;
      setDragOverIndex(null);
      if (sourceIndex == null || sourceIndex === targetIndex) return;
      onReorder(sourceIndex, targetIndex);
    },
    [onReorder],
  );

  const handleContextMenu = useCallback(
    (personId: number) => (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setMenuState({
        personId,
        top: event.clientY,
        left: event.clientX,
      });
    },
    [],
  );

  // 每个菜单项触发后调一次:执行动作 + 关闭菜单。避免在 5 处各自
  // 重复 `() => { onX(); setMenuState(null); }`。
  const withCloseMenu = useCallback(
    <T extends (...args: never[]) => void>(fn: T): T =>
      ((...args: never[]) => {
        fn(...args);
        setMenuState(null);
      }) as T,
    [],
  );

  return (
    <nav
      aria-label="人员子 tab"
      className="border-border/60 bg-card text-card-foreground flex flex-wrap items-stretch gap-0 rounded-md border"
      onDragEnd={handleDragEnd}
    >
      {openPersonTabs.map((entry, index) => {
        const person = peopleById.get(entry.personId) ?? null;
        const isActive = entry.personId === activePersonId;
        const isDragOver = dragOverIndex === index;
        return (
          <PersonSubTabButton
            key={entry.personId}
            entry={entry}
            person={person}
            isActive={isActive}
            isDragOver={isDragOver}
            onActivate={() => onActivate(entry.personId)}
            onClose={() => onClose(entry.personId)}
            onContextMenu={handleContextMenu(entry.personId)}
            onDragStart={handleDragStart(index)}
            onDragOver={handleDragOver(index)}
            onDrop={handleDrop(index)}
          />
        );
      })}
      {menuState && (
        <SubTabContextMenu
          state={menuState}
          openPersonTabs={openPersonTabs}
          onClose={withCloseMenu(onClose)}
          onCloseOthers={withCloseMenu(onCloseOthers)}
          onCloseAll={withCloseMenu(onCloseAll)}
          onCloseLeft={withCloseMenu(onCloseLeft)}
          onCloseRight={withCloseMenu(onCloseRight)}
        />
      )}
    </nav>
  );
}

/** 单条子 tab —— 标题 + 徽章 + ×；× 与激活按钮平级,避免嵌套交互元素。 */
function PersonSubTabButton({
  entry,
  person,
  isActive,
  isDragOver,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  entry: OpenPersonTab;
  person: Person | null;
  isActive: boolean;
  isDragOver: boolean;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  // 拖拽事件挂在外部 <div> 上（draggable=true）—— 类型用 HTMLDivElement
  // 与 onDragStart/Over/Drop 的事件源匹配。
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
}) {
  const off = person?.deactivatedAt != null;
  const deleted = person == null;
  // 离岗 / 删除 两种徽章文案刻意分开 —— 离岗是档案字段,删除是 catalog 缺失。
  const badgeText = deleted ? "（已删除）" : off ? "（离岗）" : null;
  const titleText = deleted
    ? `id=${entry.personId} 已被删除`
    : person?.name ?? `id=${entry.personId}`;
  const baseClasses = `group/tab flex items-center border-r text-xs last:border-r-0 ${
    isActive
      ? "bg-background text-foreground font-medium"
      : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
  } ${isDragOver ? "bg-background/80" : ""}`;
  return (
    <div
      className={baseClasses}
      data-person-tab-id={entry.personId}
      data-active={isActive ? "true" : undefined}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/*
       * 主激活 button —— role=tab + aria-selected；拖拽由外层 div
       * 处理(div 接受 draggable + DnD events,而 button 上的拖拽
       * 在 Firefox/Edge 上兼容性差)。
       */}
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        aria-controls={`person-tab-panel-${entry.personId}`}
        onClick={onActivate}
        onContextMenu={onContextMenu}
        title={titleText}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 px-3 py-1.5"
      >
        <span className="truncate">{titleText}</span>
        {badgeText && (
          <span
            className={`shrink-0 rounded px-1 py-px text-[10px] ${
              deleted
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {badgeText}
          </span>
        )}
      </button>
      {/*
       * × 关闭 —— 与主 button 平级,不在 button 里嵌 button。click
       * stopPropagation 防止冒泡到 div 触发的副作用(dragend 之类
       * 不受影响,DnD 由 div 处理)。
       */}
      <button
        type="button"
        aria-label={`关闭子 tab · ${titleText}`}
        title="关闭"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        className="text-muted-foreground hover:text-foreground mr-1 inline-flex size-4 cursor-pointer items-center justify-center rounded-sm opacity-0 group-hover/tab:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/**
 * 子 tab 右键菜单 —— 4 项 + 1 项「关闭此」。位置 = 鼠标坐标；外部点击关闭。
 *
 * 「关闭其他 / 全部 / 左侧 / 右侧」按 (Q11) 决议，措辞与 IssueEditor / IDE
 * 子 tab 系统一致，便于用户形成迁移。「关闭此」是 × 的右键等价物，给不
 * 想瞄 × 的鼠标用户提供等价手势。
 */
function SubTabContextMenu({
  state,
  openPersonTabs,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCloseLeft,
  onCloseRight,
}: {
  state: { personId: number; top: number; left: number };
  openPersonTabs: ReadonlyArray<OpenPersonTab>;
  onClose: (personId: number) => void;
  onCloseOthers: (personId: number) => void;
  onCloseAll: () => void;
  onCloseLeft: (personId: number) => void;
  onCloseRight: (personId: number) => void;
}) {
  const index = openPersonTabs.findIndex((t) => t.personId === state.personId);
  // 单条子 tab 时「关闭其他 / 全部」无意义,但留作禁用态比隐藏更一致——避免
  // 菜单项数量随上下文变,用户形成稳定心智。
  const hasOthers = openPersonTabs.length > 1;
  const hasLeft = index > 0;
  const hasRight = index >= 0 && index < openPersonTabs.length - 1;
  return (
    <ul
      data-person-tab-menu
      role="menu"
      style={{
        position: "fixed",
        top: state.top,
        left: state.left,
        zIndex: 50,
      }}
      className="border-border bg-popover text-popover-foreground min-w-32 rounded-md border p-1 text-xs shadow-md"
    >
      <MenuItem
        label="关闭此"
        onSelect={() => onClose(state.personId)}
      />
      <MenuItem
        label="关闭其他"
        disabled={!hasOthers}
        onSelect={() => onCloseOthers(state.personId)}
      />
      <MenuItem
        label="关闭全部"
        onSelect={onCloseAll}
      />
      <MenuSeparator />
      <MenuItem
        label="关闭左侧"
        disabled={!hasLeft}
        onSelect={() => onCloseLeft(state.personId)}
      />
      <MenuItem
        label="关闭右侧"
        disabled={!hasRight}
        onSelect={() => onCloseRight(state.personId)}
      />
    </ul>
  );
}

function MenuItem({
  label,
  onSelect,
  disabled,
}: {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onSelect}
        className="hover:bg-accent hover:text-accent-foreground w-full cursor-pointer rounded-sm px-2 py-1 text-left disabled:cursor-not-allowed disabled:opacity-40"
      >
        {label}
      </button>
    </li>
  );
}

function MenuSeparator() {
  return (
    <li
      role="separator"
      aria-orientation="horizontal"
      className="border-border/60 my-1 border-t"
    />
  );
}

// ---------------------------------------------------------------------------
// 内容区 —— 同步挂载所有 openPersonTabs 的 PersonDetailView
// ---------------------------------------------------------------------------

/**
 * 内容区 —— 所有 openPersonTabs 同步挂载 PersonDetailView，非激活用
 * `hidden` 隐藏。
 *
 * `hidden` attribute (HTML) 让 React 不卸载 DOM，PersonDetailView 的
 * `useState` 全部保留 —— 切回时拿到上次缓存的 `detail`,不重新打 IPC
 * (Q23 决议)。
 *
 * 不在内容区层维护 activePersonId 二次校验 —— 由父层 PersonDetailTabsView
 * 保证 `activePersonId ∈ openPersonTabs`。
 */
function PersonDetailContentArea({
  openPersonTabs,
  activePersonId,
  subTeams,
  refreshToken,
  onOpenTask,
  onCreateTask,
  onCreateProject,
  onCreateTemplate,
}: {
  openPersonTabs: ReadonlyArray<OpenPersonTab>;
  activePersonId: number | null;
  subTeams: ReadonlyArray<SubTeam>;
  refreshToken: number;
  onOpenTask: (task: Task, extras: { assignee: AssigneeCandidate }) => void;
  onCreateTask: (person: Person) => void;
  onCreateProject: (person: Person) => void;
  onCreateTemplate: (subTeamId: number) => void;
}) {
  return (
    <div className="flex flex-col">
      {openPersonTabs.map((entry) => {
        const isActive = entry.personId === activePersonId;
        // catalog 缺失 = 人员已被「人员」tab 物理删除；PersonDetailView 内
        // 部调 getPersonDetail 会抛 AppError.invalid("人员不存在或已被删除。"),
        // 视图层走 error 分支渲染 role=alert —— 与"已被删除"语义吻合
        // (Q20 决议)。此处不做短路：保留 PersonDetailView 挂载,切回激活
        // 仍能看到删除状态,用户手动 × 关闭。
        return (
          <div
            key={entry.personId}
            role="tabpanel"
            id={`person-tab-panel-${entry.personId}`}
            data-person-tab-panel-id={entry.personId}
            hidden={!isActive}
          >
            <PersonDetailView
              personId={entry.personId}
              subTeams={[...subTeams]}
              refreshToken={refreshToken}
              onOpenTask={onOpenTask}
              onCreateTask={onCreateTask}
              onCreateProject={onCreateProject}
              onCreateTemplate={onCreateTemplate}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 空态 —— 子 tab 列表全空时显示（tickets #84 T4 占位 + #85 T5 浏览网格）
// ---------------------------------------------------------------------------

/**
 * 子 tab 列表全空时的占位文案 —— 浏览网格是 #85 T5 的范围，本视图只
 * 给「请打开」提示，避免冷启动看到一片空白。
 */
function EmptyState() {
  return (
    <div className="bg-card text-card-foreground rounded-lg border p-6 text-sm">
      <p className="text-muted-foreground">
        还没有打开任何人员的详情。
      </p>
      <p className="text-muted-foreground mt-2 text-xs">
        从「人员矩阵」点人名、⌘K 搜人员、或点任务条目的负责人都能打开子 tab。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
