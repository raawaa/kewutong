/**
 * Navigation reducer — App.tsx 路由的纯函数 seam(tickets #96 / #97)。
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
 * 本期 (#97) 实现的 case:
 *   - SetTab / OpenPerson / ActivatePersonTab
 *   - CloseActiveSubTab / ClosePersonTab
 *   - CloseOtherPersonTabs / CloseAllPersonTabs
 *   - CloseLeftPersonTabs / CloseRightPersonTabs
 *   - ReorderPersonTabs
 *   - post-step 收敛 `activeSubTabId` ∈ subTabs
 *
 * union 已就位但 case 体延后到 #98-#101 实施的 kind(本期收到它们返
 * 回 state 不变,消费路径尚未接线,语义兜底):OpenTaskDialog /
 * CloseTaskDialog / TaskSaved / OpenPalette / ClosePalette / PalettePick /
 * IntentConsumed。
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
  // dialog / palette / intent 的 case 骨架在 union 里就位,case 体在
  // #98-#101 实施 —— 本期 reducer 对未实现的 kind 返回 state 不变,
  // consumption path 还未接线,语义兜底。
  | { kind: "OpenTaskDialog"; target: DialogTarget }
  | { kind: "CloseTaskDialog" }
  | { kind: "TaskSaved" }
  | { kind: "OpenPalette" }
  | { kind: "ClosePalette" }
  | { kind: "PalettePick"; target: PalettePickTarget }
  | { kind: "IntentConsumed" };

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

    // ----- dialog / palette / intent (本期未实施,case 体在 #98-#101 接入) -----
    //
    // 暂时返 state 不变:消费路径(#99 #100 等)尚未接到这里,API 已就位;
    // 一旦新增 case 体,返回类型仍兼容(都是 `NavigationState`)。
    case "OpenTaskDialog":
    case "CloseTaskDialog":
    case "TaskSaved":
    case "OpenPalette":
    case "ClosePalette":
    case "PalettePick":
    case "IntentConsumed":
      return state;

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
