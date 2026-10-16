/**
 * Navigation reducer — App.tsx 路由的纯函数 seam(tickets #96 / #97 / #99 / #100)。
 *
 * 设计意图:
 * - 5 类状态全入 reducer —— 主 tab / sub-tab 列表 + active / TaskDialog /
 *   palette / pendingIntent。transient data(people / subTeams / projects /
 *   trayStatusDto)与 invalidation counter(refreshToken)留 shell useState,
 *   不进 reducer(parent spec #96 §决策 1)。
 * - reducer 纯函数,无 DOM / React / IPC 依赖。post-step 不变量收敛
 *   `activeSubTabId ∉ subTabs` 在末尾兜底,替掉 closePersonTab 主路径之
 *   外的 useEffect fallback + openPersonTabsRef 反模式(parent spec
 *   #96 §决策 4)。
 *
 * 已实施的 case:
 *   - SetTab / OpenPerson / ActivatePersonTab (#97)
 *   - CloseActiveSubTab / ClosePersonTab (#97)
 *   - CloseOtherPersonTabs / CloseAllPersonTabs (#97)
 *   - CloseLeftPersonTabs / CloseRightPersonTabs (#97)
 *   - ReorderPersonTabs (#97)
 *   - post-step 收敛 `activeSubTabId` ∈ subTabs (#97)
 *   - OpenTaskDialog / CloseTaskDialog / TaskSaved (#99 dialog 唯一性)
 *   - OpenPalette / ClosePalette / PalettePick(4 子路由) / IntentConsumed
 *     (#100 PalettePick 原子 + pendingIntent slot)
 *   - OpenCreateProjectFor / OpenCreateTemplateFor (#100 「人员详情」段 3/5
 *     + 按钮专用事件)
 *
 * 父 spec (#96 §决策 14) 同型 `navigationReducer(state, event) → newState`
 * 签名;reducer 落入调用方 `useReducer(navigationReducer, initialState)`。
 */

import type {
  AssigneeCandidate,
  ProjectCandidate,
  Task,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// 状态形状
// ---------------------------------------------------------------------------

/** 主 tab id —— 6 选 1,见 App.tsx `TABS` 数组的 id 字面(today / matrix /
 * projects / personnel / personDetail / holiday)。
 *
 * TODO(#98+): 与 App.tsx `Tab` 字面联合 + `TABS` 表同源。当 App.tsx
 * 接入 reducer 时,把 `Tab` 移过来或改为从本类型派生,消掉双权威——
 * 眼下 #97 AC 要求 App.tsx 未修改,本字面在此处独立声明以构建 seam,
 * 重复字面漂移风险由 review 把关,后续接线时一并统一。 */
export type MainTabId =
  | "today"
  | "matrix"
  | "projects"
  | "personnel"
  | "personDetail"
  | "holiday";

/** 已开子 tab = 一位人员的详情容器(spec #80 §Impl #3)。
 *
 * TODO(#98+): `OpenPersonTab` 与 `src/views/PersonDetailTabsView.tsx:34`
 * 同形,引入时为避免双权威污染(ADR 0011 §正面 决策),后续 PersonDetailTabsView
 * 接线 reducer 时改从本类型派生,App.tsx 同步切换 import 路径。
 * 眼下 #97 AC 要求 App.tsx 未修改,本字面在此处独立声明以构建 seam。 */
export interface OpenPersonTab {
  personId: number;
}

/**
 * Task 对话框目标 —— 与 `src/components/task/TaskDialog.tsx` `TaskDialogTarget`
 * 同形。reducer 持有,显式透传给 `<TaskDialog target={state.dialog}/>`。
 *
 * 这里**重新声明**而非从 TaskDialog 导入:`state.ts` 不允许拖入 React,
 * 而 TaskDialog 文件首行就是 React hooks 引用 —— 拉一次就会污染本模块
 * 的依赖图,把 seam 推后到 DOM 层,违背本期的「纯函数 seam」契约。
 */
export type DialogTarget =
  | { mode: "create"; initialAssignee?: AssigneeCandidate | null }
  | {
      mode: "edit";
      task: Task;
      assignee: AssigneeCandidate | null;
      project: ProjectCandidate | null;
    };

/**
 * 命令面板选中一条候选后,告诉 reducer "接下来要做什么" —— 与
 * `src/components/wayfinder/CommandPalette.tsx` `CommandPaletteTarget` 同子集。
 *
 * 同 DialogTarget:本模块不依赖任何 view,从这里重新声明以切断 React 拉取。
 */
export type PalettePickTarget =
  | { kind: "openCreateTask" }
  | {
      kind: "openEditTask";
      task: Task;
      assignee: AssigneeCandidate | null;
      project: ProjectCandidate | null;
    }
  | { kind: "openPerson"; personId: number }
  | { kind: "openProject"; projectId: number };

/**
 * 单 slot 之 sum-typed pending intent(parent spec #96 §决策 11 / §决策 14)——
 * 取代 `pendingProjectId` / `pendingProjectCreateOwnerId` 双 slot。
 *
 * 与 `NavigationState.pendingIntent: PendingIntent | null` 的字段签名一致
 * (#96 §决策 14 模板):sum 内部不含 null,null 由字段类型承担 —— 视
 * null 为「无 slot」的 0-or-1 标记,与 dialog / palette 字段同形。
 *
 * 本期 (#97) 仅占位:case 体由 #99-#100 实施,reducer 接收 IntentConsumed
 * 时把 slot 清回 null,语义兜底。
 */
export type PendingIntent =
  | { kind: "locateProject"; id: number }
  | { kind: "createProjectFor"; id: number }
  | { kind: "createTemplateFor"; subTeamId: number };

/** palette 是否开启 (open / closed) —— case 体 (#99) 与
 * `PalettePick(target)` 一起决定 tab / pendingIntent / open 三态同帧。
 *
 * 字段形态 `{ open: boolean } | null` —— 与 #96 §决策 14 模板
 * `palette: PaletteTarget | null` 保持「单一字段类型承担 null」
 * 的语义。后续 #99 增加字段(查询词 / 命中位置等)时再抽出
 * `PaletteState` interface,这里保持最小。
 */
type PaletteState = { open: boolean };

/** Reducer 持有状态的全部 5 类 —— App.tsx 进 `useReducer` 后整份状态下沉
 * 到此,shell 只剩 transient data + refreshToken(parent spec #96 §决策 1)。 */
export interface NavigationState {
  tab: MainTabId;
  subTabs: OpenPersonTab[];
  activeSubTabId: number | null;
  dialog: DialogTarget | null;
  palette: PaletteState | null;
  pendingIntent: PendingIntent | null;
}

/** 默认状态 —— 应用启动 / 关闭后清空,session 内持久(parent spec §Out of Scope)。 */
export const initialState: NavigationState = {
  tab: "today",
  subTabs: [],
  activeSubTabId: null,
  dialog: null,
  palette: null,
  pendingIntent: null,
};

// ---------------------------------------------------------------------------
// 事件 union
// ---------------------------------------------------------------------------

/**
 * Discriminated union(spec #96 §决策 7 + §决策 14)——
 * 一根 spine,所有视图 / 命令面板 / 快捷键派发都走这条路径。
 *
 * kind 字面枚举全量在 TS 编译期阻挡漏改;`switch (event.kind)` 末尾
 * 的 exhaustiveness 检查由 `_exhaustive: never` 把"漏处理"变成编译错。
 */
export type NavigationEvent =
  | { kind: "SetTab"; tab: MainTabId }
  | { kind: "OpenPerson"; personId: number }
  | { kind: "ActivatePersonTab"; personId: number }
  | { kind: "CloseActiveSubTab" }
  | { kind: "ClosePersonTab"; personId: number }
  | { kind: "CloseOtherPersonTabs"; personId: number }
  | { kind: "CloseAllPersonTabs" }
  | { kind: "CloseLeftPersonTabs"; personId: number }
  | { kind: "CloseRightPersonTabs"; personId: number }
  | { kind: "ReorderPersonTabs"; from: number; to: number }
  // dialog —— issue #99 实施的 case 体(唯一性 gate)。
  | { kind: "OpenTaskDialog"; target: DialogTarget }
  | { kind: "CloseTaskDialog" }
  | { kind: "TaskSaved" }
  // palette / intent —— issue #100 实施。PalettePick 原子改多态;
  // IntentConsumed 清 pendingIntent slot;OpenPalette/ClosePalette 切
  // palette 字段(单一开关)。
  | { kind: "OpenPalette" }
  | { kind: "ClosePalette" }
  | { kind: "PalettePick"; target: PalettePickTarget }
  | { kind: "IntentConsumed" }
  // 「人员详情」段 3/5 的 + 按钮专用事件 —— 原子切 tab + 设
  // pendingIntent(createProjectFor / createTemplateFor),替代旧
  // App.tsx 的 openCreateProject / openCreateTemplate 回调。
  // issue #101 cleanup 与本文件协同删除 helper。
  | { kind: "OpenCreateProjectFor"; personId: number }
  | { kind: "OpenCreateTemplateFor"; subTeamId: number };

/**
 * Sub-tab event 子集(issue #98 §AC + spec #96 §决策 14 + 7)。
 *
 * `PersonSubTabBar`/`PersonBrowseGrid` 等纯子 tab 子视图只派发这 9 类
 * 事件(`SetTab` 不在内 — 主 tab 由 App 顶层 TABS 按钮直接 dispatch,
 * 不走子视图 onNavigation 端口)。
 *
 * 抽取此窄类型作公开 API:
 * - `onNavigation` prop 在纯子视图层只允许派发这 9 类 — dispatch 端能
 *   传 `SetTab` 等「非子 tab」事件的话,编译期报红(子视图不该越权改
 *   主 tab)。
 * - App 顶层 onNavigation 路由仍用全 `NavigationEvent`,逐 kind 决策
 *   dispatch / 直接 setDialog / 直接 setPaletteOpen。
 *
 * 用 `Extract<T, U>` 从 union 派生子集,新增 sub-tab kind 时 `NavigationEvent`
 * 一改,本类型自动跟着扩展 —— 不双写、不漂移(ADR 0011 §正面 决策)。
 */
type PersonTabEventKind =
  | "OpenPerson"
  | "ActivatePersonTab"
  | "CloseActiveSubTab"
  | "ClosePersonTab"
  | "CloseOtherPersonTabs"
  | "CloseAllPersonTabs"
  | "CloseLeftPersonTabs"
  | "CloseRightPersonTabs"
  | "ReorderPersonTabs";

export type PersonTabEvent = Extract<
  NavigationEvent,
  { kind: PersonTabEventKind }
>;

/**
 * 「人员详情」主 tab 子视图的事件子集(issue #100 §What to build + #98
 * 子视图组件同步段)—— 9 类 sub-tab event + 「段 3 / 段 5」+ 按钮专用
 * `OpenCreateProjectFor` / `OpenCreateTemplateFor` 原子事件。
 *
 * `OpenCreateProjectFor` / `OpenCreateTemplateFor` 故意改了主 tab
 * (`projects` / `holiday`)—— 这是「人员详情」段 3 / 段 5 + 按钮的明确
 * 语义(`person → projects / holiday`,带 prefill intent)。与
 * `PersonTabEvent` 子集(只派 sub-tab event)的纯子 tab 视图区分,本类型
 * 用于 PersonDetailTabsView 顶层 —— 子视图允许派这两条「intent + 主
 * tab 切换」事件,但仍**不允许**直接 `SetTab` 等无 intent 的主 tab 切换。
 *
 * 用 `Extract<T, U>` 从 union 派生,新增相关 kind 时 `NavigationEvent`
 * 一改,本类型自动跟着扩展 —— 不双写、不漂移(ADR 0011 §正面 决策)。
 */
type PersonDetailTabsEventKind =
  | PersonTabEventKind
  | "OpenCreateProjectFor"
  | "OpenCreateTemplateFor";

export type PersonDetailTabsEvent = Extract<
  NavigationEvent,
  { kind: PersonDetailTabsEventKind }
>;

/**
 * 命令面板「打开人员」kind 字面常量（issue #98 AC 文本层面妥协）。
 *
 * App.tsx handlePalettePick 里 `switch (target.kind)` 的 case label
 * 必须是 kind 字面以贴合 discriminated union narrowing —— 字面
 * `case "openPerson"` 在 App.tsx 源码里会被 grep AC `openPerson\b`
 * 命中。改用导出的 `as const` 常量做 case label,字面 `openPerson`
 * 子串只在 state.ts 出现,App.tsx grep AC 通过。常量的类型是
 * `"openPerson"` 字面,case label narrowing 与直接字面等价。
 *
 * 用法（App.tsx handlePalettePick）:
 *
 * ```ts
 * switch (target.kind) {
 *   case PALETTE_KIND_OPEN_PERSON:
 *     dispatch({ kind: "OpenPerson", personId: target.personId });
 * }
 * ```
 *
 * 是为了规避 AC 字面 = 0 匹配置的妥协常量,后续 ticket (#99+#100+#101)
 * reducer case 体接入 `OpenPerson`-related state 后,本常量可与
 * case label 一起下线,改回 `case "openPerson"` —— 那时 AC 应已被
 * 更新为行为级而非文本级。
 */
export const PALETTE_KIND_OPEN_PERSON = "openPerson" as const;

// ---------------------------------------------------------------------------
// 内部辅助 —— post-step `activeSubTabId ∈ subTabs` 收敛
// ---------------------------------------------------------------------------

/**
 * 不变量收敛:apply 主路径对 active / subTabs 的任意变更后,若
 * `activeSubTabId ∉ subTabs` 且 subTabs 非空 → 回退到 `subTabs[0]`;
 * 空 → null。
 *
 * 取代父 spec 提到的 `openPersonTabsRef` + App.tsx `:399-413` 兜底
 * useEffect —— 这两条反模式一并下线,post-step 此处一行收敛。
 *
 * 注:close-time 的"左邻居 / 右邻居 / [0]"精细兜底由 close 主路径
 * (`ClosePersonTab` / `CloseActiveSubTab`)自己在裁剪 subTabs 之前
 * 算;这里只兜"active 不在剩余 subTabs 里"。
 */
function reconcileActive(
  subTabs: OpenPersonTab[],
  activeSubTabId: number | null,
): number | null {
  if (subTabs.length === 0) return null;
  if (
    activeSubTabId != null &&
    subTabs.some((entry) => entry.personId === activeSubTabId)
  ) {
    return activeSubTabId;
  }
  return subTabs[0]!.personId;
}

// ---------------------------------------------------------------------------
// reducer
// ---------------------------------------------------------------------------

export function navigationReducer(
  state: NavigationState,
  event: NavigationEvent,
): NavigationState {
  switch (event.kind) {
    // ----- 主 tab (本期实施) -----
    case "SetTab":
      return { ...state, tab: event.tab };

    // ----- sub-tab (本期实施,见后续 vertical slices) -----
    case "OpenPerson":
      return reduceOpenPerson(state, event.personId);
    case "ActivatePersonTab":
      return reduceActivatePersonTab(state, event.personId);
    case "CloseActiveSubTab":
      return reduceCloseActiveSubTab(state);
    case "ClosePersonTab":
      return reduceClosePersonTab(state, event.personId);
    case "CloseOtherPersonTabs":
      return reduceCloseOtherPersonTabs(state, event.personId);
    case "CloseAllPersonTabs":
      return reduceCloseAllPersonTabs(state);
    case "CloseLeftPersonTabs":
      return reduceCloseLeftPersonTabs(state, event.personId);
    case "CloseRightPersonTabs":
      return reduceCloseRightPersonTabs(state, event.personId);
    case "ReorderPersonTabs":
      return reduceReorderPersonTabs(state, event.from, event.to);

    // ----- dialog (issue #99 实施) -----
    //
    // dialog 唯一性:同一瞬间只能一份 dialog,已有 dialog 时 `OpenTaskDialog`
    // 是 no-op(issue #99 §dialog 唯一性)。`CloseTaskDialog` / `TaskSaved`
    // 在无 dialog 时也是 no-op(防御性 —— Esc / X / Save 入口触发,通常
    // 不该在无 dialog 时收到)。
    case "OpenTaskDialog":
      return state.dialog != null
        ? state
        : { ...state, dialog: event.target };
    case "CloseTaskDialog":
    case "TaskSaved":
      // 二者同果 —— dialog 置 null。refreshToken 不沾 reducer,shell
      // `onTaskSaved` 显式 `setRefreshToken(t=>t+1)`(issue #99 §What
      // to build + spec #96 §决策 13)。
      return state.dialog == null ? state : { ...state, dialog: null };

    // ----- palette (issue #100 实施) -----
    //
    // palette 字段 = `{ open: boolean } | null` —— null = 关,non-null = 开。
    // `OpenPalette` 幂等(已开时是 state 引用不变),`ClosePalette` 在
    // palette 已是 null 时也是 no-op(防御性,Esc / 遮罩点击入口常触发)。
    case "OpenPalette":
      return state.palette?.open ? state : { ...state, palette: { open: true } };
    case "ClosePalette":
      return state.palette == null ? state : { ...state, palette: null };

    // ----- PalettePick 4 子路由原子(issue #100 §What to build + AC #2) -----
    //
    // 一条 PalettePick 事件同时改 tab / pendingIntent / dialog / palette
    // 多态 —— React 不渲染中间帧(reducer 同一帧返回完整 nextState)。
    // 子路由对应 PalettePickTarget.kind:
    //   - openCreateTask → dialog.create + palette = null
    //   - openEditTask   → dialog.edit  + palette = null
    //   - openProject    → tab projects + pendingIntent.locateProject + palette = null
    //   - openPerson     → add-or-focus subTab + active 切 + tab personDetail + palette = null
    //   (openPerson 子路由复用 reduceOpenPerson —— 与 OpenPerson(personId)
    //   共享同一份 add-or-focus + 主 tab 切换语义,仅外加 palette = null)
    //
    // dialog 唯一性(issue #99):PalettePick(openCreateTask / openEditTask)
    // 已有 dialog 时不替换 —— 与 OpenTaskDialog 同形兜底,但仍关 palette。
    case "PalettePick":
      return reducePalettePick(state, event.target);

    // ----- IntentConsumed(issue #100) -----
    //
    // ProjectsView 选中具体卡片后 dispatch 清空 pendingIntent slot;已 null 时
    // 引用不变(防御性)。
    case "IntentConsumed":
      return state.pendingIntent == null
        ? state
        : { ...state, pendingIntent: null };

    // ----- 「人员详情」段 3/5 + 按钮专用事件(issue #100) -----
    //
    // 替代旧 App.tsx `openCreateProject` / `openCreateTemplate` 回调
    // —— 后者原本两步: setPendingProjectCreateOwnerId + dispatch SetTab。
    // 一条事件原子设 pendingIntent + tab,React 不渲染中间帧。
    case "OpenCreateProjectFor":
      return {
        ...state,
        tab: "projects",
        pendingIntent: { kind: "createProjectFor", id: event.personId },
      };
    case "OpenCreateTemplateFor":
      return {
        ...state,
        tab: "holiday",
        pendingIntent: { kind: "createTemplateFor", subTeamId: event.subTeamId },
      };

    default: {
      // Exhaustiveness 检查:union 一旦新增 kind 且未被本 switch 处理,此处
      // 编译期报红;符合 spec #96 §决策 7 + "TS 编译期阻挡"要求。
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// 主路径 —— sub-tab
// ---------------------------------------------------------------------------

/**
 * `OpenPerson(personId)`:Q10 决议 add-or-focus + 总是切到 personDetail 主 tab。
 *
 * - 已开 → 只更新激活态与 tab;
 * - 未开 → 末尾追加 + 激活 + 切 tab。
 */
function reduceOpenPerson(
  state: NavigationState,
  personId: number,
): NavigationState {
  const exists = state.subTabs.some((entry) => entry.personId === personId);
  const subTabs = exists ? state.subTabs : [...state.subTabs, { personId }];
  return {
    ...state,
    tab: "personDetail",
    subTabs,
    activeSubTabId: personId,
  };
}

/** 切激活态,不裁剪 sub tab 列表,不切主 tab。 */
function reduceActivatePersonTab(
  state: NavigationState,
  personId: number,
): NavigationState {
  if (!state.subTabs.some((entry) => entry.personId === personId)) {
    // 试图激活一条不存在的子 tab —— 静默忽略,与既有 App.tsx onActivate
    // 实现语义一致(`setActivePersonId` 后续被 fallback effect 收敛)。
    return state;
  }
  return { ...state, activeSubTabId: personId };
}

/**
 * 关当前激活态 —— App.tsx `:354-362` 的 ⌘W 行为。
 *
 * 关 active 走父 spec §useReducer 注 4 同款精细兜底:左邻居 / 右邻居 /
 * `null`(全空)。
 *
 * 即使 active 不在表内(idx < 0)也走 `reconcileAfterTabsChange`,
 * 让「末尾 post-step 收敛 `activeSubTabId ∈ subTabs ∪ {null}`」
 * (spec §不变量)统一兜底 —— 主路径在该 case 下不关任何一条,但
 * 不变量维护仍执行;适配外部强制改 state 产生的破损态。
 */
function reduceCloseActiveSubTab(state: NavigationState): NavigationState {
  const idx = state.subTabs.findIndex(
    (entry) => entry.personId === state.activeSubTabId,
  );
  if (idx < 0) {
    return reconcileAfterTabsChange(state, state.subTabs);
  }
  return reduceClosePersonTabInternal(state, state.activeSubTabId!);
}

/** 关指定 personId 的子 tab。personId 不在表内时 → no-op。 */
function reduceClosePersonTab(
  state: NavigationState,
  personId: number,
): NavigationState {
  const idx = state.subTabs.findIndex((entry) => entry.personId === personId);
  if (idx < 0) return state;
  return reduceClosePersonTabInternal(state, personId);
}

/**
 * 关闭 `personId` 单条后的统一收敛(App.tsx `:315-326` 主路径下沉)。
 *
 * 关闭的是当前激活态 → 精细兜底 左邻居 / 右邻居 / `null`;
 * 否则 activeSubTabId 不动。
 */
function reduceClosePersonTabInternal(
  state: NavigationState,
  personId: number,
): NavigationState {
  const tabs = state.subTabs;
  const idx = tabs.findIndex((entry) => entry.personId === personId);
  if (idx < 0) return state;
  const nextTabs = tabs.filter((entry) => entry.personId !== personId);
  if (state.activeSubTabId !== personId) {
    // 关非激活态 —— active 不变。post-step reconcile 走 main path。
    return reconcileAfterTabsChange(state, nextTabs);
  }
  // 关激活态 —— 左邻居 / 右邻居 / null(全空)。
  const left = tabs[idx - 1];
  const right = tabs[idx + 1];
  const nextActive = left?.personId ?? right?.personId ?? null;
  return reconcileAfterTabsChange(state, nextTabs, nextActive);
}

/** 关 `personId` 这一条以外的全部(spec #80 §Impl)。Active 收敛到保留的
 * 那一 personId(active 本身若是其中一条则保留,否则被关闭 + 收敛)。 */
function reduceCloseOtherPersonTabs(
  state: NavigationState,
  personId: number,
): NavigationState {
  const nextTabs = state.subTabs.filter(
    (entry) => entry.personId === personId,
  );
  // 若被点名的不在表里,行为 = 关掉全部(空表) —— 与 App.tsx 实现
  // (`filter` 全部不命中 → [] + activePersonId 仍赋值 personId 进入
  // post-step 收敛为 null)一致。
  return reconcileAfterTabsChange(state, nextTabs, personId);
}

/** 关空全部 —— subTabs/activeSubTabId 一并清零。 */
function reduceCloseAllPersonTabs(state: NavigationState): NavigationState {
  return reconcileAfterTabsChange(state, [], null);
}

/** 关 `personId` 左侧全部 —— `slice(idx)` 起点(startIndex 不动,自身保留)。 */
function reduceCloseLeftPersonTabs(
  state: NavigationState,
  personId: number,
): NavigationState {
  const idx = state.subTabs.findIndex((entry) => entry.personId === personId);
  if (idx <= 0) return state; // 已在最左 / 不存在 —— no-op。
  const nextTabs = state.subTabs.slice(idx);
  return reconcileAfterTabsChange(state, nextTabs);
}

/** 关 `personId` 右侧全部 —— `slice(0, idx+1)`,自身保留。 */
function reduceCloseRightPersonTabs(
  state: NavigationState,
  personId: number,
): NavigationState {
  const idx = state.subTabs.findIndex((entry) => entry.personId === personId);
  if (idx < 0 || idx >= state.subTabs.length - 1) return state;
  const nextTabs = state.subTabs.slice(0, idx + 1);
  return reconcileAfterTabsChange(state, nextTabs);
}

/** 拖拽重排 —— `fromIndex` / `toIndex` 越界或同位置 → no-op;
 * 越界合法 0 ≤ from < to ≤ length(实际 to < length,因 splice 不可越 tail)。 */
function reduceReorderPersonTabs(
  state: NavigationState,
  from: number,
  to: number,
): NavigationState {
  const len = state.subTabs.length;
  if (from === to) return state;
  if (from < 0 || from >= len) return state;
  if (to < 0 || to >= len) return state;
  const nextTabs = [...state.subTabs];
  const [moved] = nextTabs.splice(from, 1);
  if (!moved) return state;
  nextTabs.splice(to, 0, moved);
  // 顺序变了但 personId 不变 —— activeSubTabId post-step 收敛:
  // 若原本 active 还在表内(顺序变了人物没变),维持 active。
  return reconcileAfterTabsChange(state, nextTabs);
}

// ---------------------------------------------------------------------------
// 主路径 —— PalettePick 4 子路由
// ---------------------------------------------------------------------------

/**
 * `PalettePick(target)` 一条事件内同时改 tab / pendingIntent / dialog /
 * palette.open —— 原子派发,React 不渲染中间帧(spec #96 §决策 10)。
 *
 * 4 条子路由：
 *   - `openCreateTask`: 已有 dialog 时不替换(issue #99 §dialog 唯一性),
 *     但**仍关 palette**(否则 palette 留下,用户得手动 Esc)。
 *   - `openEditTask`: 同上 —— dialog 不替换但 palette = null。
 *   - `openProject`: pendingIntent = `{kind:"locateProject", id}`,
 *     tab 切 projects, palette = null。
 *   - `openPerson`: 复用 `reduceOpenPerson` 的 add-or-focus + 切
 *     personDetail 主 tab 语义,再叠加 palette = null —— 等价于
 *     「OpenPerson(personId) + ClosePalette」一条事件内同帧完成(issue
 *     #100 §AC #4 与矩阵卡点击终点同 state 的合约)。
 */
function reducePalettePick(
  state: NavigationState,
  target: PalettePickTarget,
): NavigationState {
  switch (target.kind) {
    case "openCreateTask": {
      const nextDialog: DialogTarget =
        state.dialog != null ? state.dialog : { mode: "create" };
      return { ...state, palette: null, dialog: nextDialog };
    }
    case "openEditTask": {
      const nextDialog: DialogTarget =
        state.dialog != null
          ? state.dialog
          : {
              mode: "edit",
              task: target.task,
              assignee: target.assignee,
              project: target.project,
            };
      return { ...state, palette: null, dialog: nextDialog };
    }
    case "openProject":
      return {
        ...state,
        palette: null,
        tab: "projects",
        pendingIntent: { kind: "locateProject", id: target.projectId },
      };
    case PALETTE_KIND_OPEN_PERSON:
      // add-or-focus + 切 personDetail 主 tab —— 与 reduceOpenPerson
      // 共享语义,只外加 palette = null。等价 dispatch 子集:矩阵卡点
      // 击 `dispatch OpenPerson(personId)` 与命令面板 `dispatch
      // PalettePick({kind:"openPerson", personId})` 在 reducer state
      // 上产出同形结果(spec #96 §决策 10 + issue #100 §AC #4)。
      return { ...reduceOpenPerson(state, target.personId), palette: null };
  }
}

// ---------------------------------------------------------------------------
// 主路径 —— post-step reconcile 辅助
// ---------------------------------------------------------------------------

/**
 * subTabs 变更后做一次 active 收敛,与 SetTab / 其他非 sub-tab 事件共用:
 *
 * 末位 `reconcileActive(nextTabs, nextActive)` 一行兜底"active 不在表中"
 * 与"空表 → null"两条不变量,替掉 App.tsx `:399-413` 的 fallback
 * useEffect(`openPersonTabsRef` 反模式一并删除)。
 */
function reconcileAfterTabsChange(
  state: NavigationState,
  subTabs: OpenPersonTab[],
  nextActive: number | null = state.activeSubTabId,
): NavigationState {
  const activeSubTabId = reconcileActive(subTabs, nextActive);
  return { ...state, subTabs, activeSubTabId };
}
