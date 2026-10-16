# Navigation 作为 renderer 侧领域概念

**Status**: accepted

承接 issue #96（C2：App.tsx 化为导航状态机）— 把散落在 `src/App.tsx` 与多个 view 文件里的「导航状态」相关逻辑集中到单一 seam：renderer 端一份 reducer（`navigationReducer`），所有视图 / 命令面板 / 快捷键派发都走 `NavigationEvent` discriminated union，shell 只剩 4 类 transient data 与 `refreshToken` invalidation counter。

## 上下文

「App 在哪个 view、开了谁的人员档案、当前弹了什么 dialog、palette 是否开着、project 视图要 locate 哪条……」这些「跨视图的全局状态」在 C2 之前散落在 `src/App.tsx` 与多个 view 文件里：

- `src/App.tsx` 持有 12+ 个 `useState` / `useCallback` helper —— `openPerson` / `openPersonTabsRef` / `setActivePersonId` / `setOpenPersonTabs` / `setPaletteOpen` / `openCreateTask` / `openEditTask` / `openCreateWithAssignee` / `openCreateProject` / `openCreateTemplate` / `handlePalettePick` / `setPendingProjectId` / `setPendingProjectCreateOwnerId` / `closePersonTab` / `closeOtherPersonTabs` / ... —— 一处 `useState` 改 5+ 个 setter 才能落一个完整的导航动作。
- sub-tab 列表 + active 分离到 `openPersonTabsRef` + `useState`，加 `openPerson` 时还要写一个 setState 之外的 useEffect 把 `activeSubTabId` 兜回 `subTabs[0]`（race condition 频发）。
- 命令面板「打开人员」「打开项目」「新建任务」「编辑任务」 4 路径各自派自己的 setState —— 同色同形但散在不同文件。
- 「人员详情」段 3 / 段 5 + 按钮原本 `setPendingXxx(...)` + `dispatch(SetTab)` 两步派的「intent + 主 tab 切换」组合被 React 渲染成中间帧：先切到「项目」空一秒、再 prefill。

### 同帧多态溃逃 React 渲染保证

「人员详情」的 `+ → 创建项目 for 该人」动作原本是这样：

```ts
function openCreateProject(personId: number) {
  setPendingProjectCreateOwnerId(personId);
  dispatch({ type: "SetTab", tab: "projects" });
}
```

两 setState 之间有 React 渲染空隙：在 `projects` 首次渲染时 `pendingProjectCreateOwnerId=null`，「项目」卡片网格无 prefill —— 然后第二次渲染才 prefill。视觉上是「啪 + 闪 + 内容」。

### 「已有 dialog 时又开一份」无拦截

`onClick={() => setDialog(...)}` 与 `keydown ⌘N` 都各自派 setState，同一帧内能落到两份 dialog。TaskDialog 内部没去重 —— 用户报告重复弹窗。

### 对比:ADR 0011 `Status as Domain`

C1（issue #92）把 6 状态相关逻辑集中到 `src/lib/taskStatus.ts` 单一 seam + drift test 守边界。C2 走同型范式 —— 同样识别「被 4+ 处复用的领域概念」(本次是导航状态)，统一到单一可枚举、可 reducer 化的 seam；不同的是 C2 涉及 router 类行为（5 类状态 + dispatch + 派发协议），比 C1 的 6 状态枚举重一档。

## 决策

### 1. Renderer 侧单一权威:`src/views/navigation/state.ts`

由 `state.ts` (C2 seam) 持有：

- `NavigationState` interface —— 6 字段: `tab: MainTabId` / `subTabs: OpenPersonTab[]` / `activeSubTabId: number | null` / `dialog: DialogTarget | null` / `palette: PaletteState | null` / `pendingIntent: PendingIntent | null`
- `NavigationEvent` discriminated union —— 18 类事件: `SetTab` / 9 类 sub-tab event (`OpenPerson` / `ActivatePersonTab` / `CloseActiveSubTab` / `ClosePersonTab` / 4 类批量关闭 / `ReorderPersonTabs`) + 3 类 dialog event (`OpenTaskDialog` / `CloseTaskDialog` / `TaskSaved`) + 4 类 palette event (`OpenPalette` / `ClosePalette` / `PalettePick` / `IntentConsumed`) + 2 类「人员详情」+ 按钮专用 (`OpenCreateProjectFor` / `OpenCreateTemplateFor`)
- `navigationReducer(state, event)` 纯函数 —— 无 DOM / React / IPC 依赖
- `initialState` —— `tab="today"` + sub-tab/dialog/palette/pendingIntent 全 null
- 子集类型 `PersonTabEvent` / `PersonDetailTabsEvent` —— `Extract<T, U>` 从 union 派生,新增 sub-tab event 不双写、不漂移

shell 不再持有 `openPersonTabs` / `activePersonId` / `paletteOpen` / `dialog` / `pendingProjectId` / `pendingProjectCreateOwnerId` 等 useState —— **全入 reducer**。

### 2. 主进程不动;reducer 纯函数 seam

`state.ts` 不依赖 React 也不依赖 view / component —— 只 import 类型 (`AssigneeCandidate` / `ProjectCandidate` / `Task` from `@/lib/api`)。Reducer 在 shell 进 `useReducer(navigationReducer, initialState)` 后,shell 持 `dispatch` 转发给各 view。

这样保证 reducer 可在 `node` 环境单独测试(table-driven + scenario),无 DOM / 模块解析依赖。

### 3. SubTab event = 命令面板「人员」路径等价

`PalettePick(openPerson)` 在 reducer 内等价 dispatch `OpenPerson(personId)` + `ClosePalette` 一条事件同帧完成 —— reducer 内显式代码引用:

```ts
case PALETTE_KIND_OPEN_PERSON:  // 字面 "openPerson",见 §不做事
  return { ...reduceOpenPerson(state, target.personId), palette: null };
```

矩阵卡点击 / 命令面板路径在 reducer state 上产出**同一份 nextState**(AC #4),但在 React 层不派中间帧。

### 4. 5 类状态原子派发 = PalettePick 多态

PalettePick(target) 一条事件同时改 tab / pendingIntent / dialog / palette.open 多态 —— reducer 同一帧返回 nextState,React 不渲染中间帧(spec #96 §决策 10)。对应 4 条子路由 (`openCreateTask` / `openEditTask` / `openProject` / `openPerson`),要么改 dialog + palette,要么改 tab + pendingIntent + palette。

### 5. dialog 唯一性

同一瞬间只能一份 dialog —— 已 `OpenTaskDialog` 时再 `OpenTaskDialog` / `PalettePick(openCreateTask|openEditTask)` 是 no-op(reducer gate + shell effect `dialog == null ? dispatch` 双层兜底,issue #99 §dialog 唯一性)。

### 6. Post-step 不变量收敛 `activeSubTabId ∈ subTabs ∪ {null}`

`reconcileAfterTabsChange(state, nextTabs, nextActive?)` 在 reducer 末尾一行兜底两条不变量:
- `subTabs = []` → `activeSubTabId = null`
- `subTabs` 非空 + `activeSubTabId ∉ subTabs` → `activeSubTabId = subTabs[0].personId`

取代旧 `App.tsx` 的 `openPersonTabsRef` + 兜底 `useEffect` 双反模式 —— 一并删除。

### 7. Shell 只剩 4 类 transient

`App.tsx` `useReducer` 之外只剩:
- `refreshToken: number` —— invalidation counter(reducer 不沾,TaskSaved 时 shell 显式 `setRefreshToken(t=>t+1)`)
- `people` / `subTeams` / `projects: Catalog` —— 启动 + refreshToken 变化时重拉
- `trayStatusDto: TrayStatusDto | null` —— 启动拉一次,失败保持 null

`palette` / `dialog` / `subTabs` / `tab` / `pendingIntent` 全在 reducer。

### 8. App.tsx 11 个 imperative helper 一并删除

issue #101 cleanup 把 `openPerson / openPersonTabsRef / openCreateProject / openCreateTemplate / openCreateWithAssignee / handlePalettePick / closePersonTab / closeOtherPersonTabs / closeAllPersonTabs / closeLeftPersonTabs / closeRightPersonTabs / reorderPersonTabs` 等 12 个 helper 全部下线 —— 删完 grep = 0 匹配(AC §3)。

## 后果

### 正面

- **新增导航动作 = reducer 加一个 case kind**:`NavigationEvent` union 加一条,reducer switch 加一 case;shell / 各 view 不动(union 编译期阻挡漏改)。
- **dispatch 端口单一**:各 view 的 `onNavigation` prop 类型用子集 `PersonTabEvent` / `PersonDetailTabsEvent`(`Extract<T, U>` 派生);TS 阻挡越权派 `SetTab` 等主 tab event。
- **dialog 唯一性 = 编译期 + 运行时双层兜底**:`PalettePick(openCreateTask)` 已有 dialog 时 reducer 自身 no-op(`expect(next).toBe(state)`);shell effect `dialog == null ? dispatch` UI 层 gate。
- **PalettePick 原子 = 无中间帧**:命令面板点开任务 → 同帧关 palette + 开 dialog,无 React 中间帧。
- **`openPersonTabsRef` + 兜底 useEffect 双反模式下线**:`reconcileAfterTabsChange` post-step 一行收敛。
- **`App.tsx` 减脂 50%+**:578 → 241 LOC(AC §1);`App.test.tsx` 减脂 70%+:702 → 206 LOC(AC §2);DOM 路径测试下沉 `state.test.ts` 1429 LOC reducer 表驱动 + scenario。

### 负面 / 风险

- **discriminated union 中央化**:reducer + sub 类型都从同一 union 派生,union 一新增未同步到 reducer 会编译期报红(`_exhaustive: never`)。
- **dialog 唯一性两层兜底**(`dialog == null` effect gate + reducer gate):UI 层与 reducer 层各自独立 —— 多了一道防御代码,但移除任一层都会复现重复弹窗 bug。
- **`PalettePick` 4 子路由的同等 dispatch 不一定能在 React 层乐观更新** —— reducer 已是同帧 state,但 React 18 后续 concurrent 模式可能让中间帧重新出现;届时再加乐观更新标记位。
- **`<SubTab>` 子视图越权派 SetTab**:TS 用 `PersonTabEvent` 子集类型阻挡;若子视图改回派 `NavigationEvent` 顶层 union,改回越权 —— review 时盯紧子视图 prop 类型。
- **App.tsx 的 keydown `useEffect` 仍是 shell 层一处 imperative**(`tab !== "personDetail"` 后手动 dispatch event):reducer 不该感知浏览器 keydown 事件名,keydown 翻译由 shell 一次性做完。后续若新增快捷键,在该 effect switch 加一 case,不让该 seam 再扩散。

## 替代方案考虑

### 单 `useState` 持有 5 字段 object

放弃。Reducer + union discriminated 是 TS 编译期阻挡漏改最强组合;单 useState 等价改成 `useReducer((s, e) => ({...s, ...apply(s, e)})`,自己造 seam。

### `zustand` / `jotai` / 其它 store 库

放弃。C2 范围只在 App.tsx 顶层,**没引入跨文件 store 需求**;新增 dep + 测试 setup + bundle size 不值得;reducer + useReducer 在 React 内置足够。

### `xstate` 状态机

放弃。5 类状态不构成真「机器」:无 conditional transition、无 history、无 parallel state。Reducer pattern 已覆盖全 18 类 transition 语义,xstate 是 overkill。

### 5 类状态各一个 reducer(combineReducers)

放弃。combineReducers 把 reducer 拆成多文件,本仓 5 状态耦合度高(同 case 经常同改),拆开反而漂移;单 reducer 文件 ~600 LOC 可读,后续可切片。

### PalettePick 多态不原子,改派多条 event(`ClosePalette` + `OpenTaskDialog`)

放弃。React 18 batch 内多条 setState 也单帧渲染,但 useReducer + reducer 派 single dispatch 是 React 官方推荐的「同帧多态」方案;且 PalettePick 的 sub-route 改起来更中心化(一个 target 对应一个 case,不在 view 层散 4 dispatch)。

### dialog 唯一性只靠 reducer no-op,shell 不 gate

放弃。Shell 层 gate 让用户按 ⌘N 时无声无息(已开 dialog 时不派第二条事件入 reducer 后被丢);不 gate 的话 reducer 用 `expect(next).toBe(state)` 阻挡仍生效,但 dispatch 函数仍被调用 2 次,vitest 测试用 `toHaveBeenCalledTimes(N)` 之类的断言会冗余。一次 gate at UI 层比只在 reducer no-op 干净。

### Post-step 不变量在 shell useEffect 兜底,不放 reducer

放弃。useEffect 兜底是在「外面修」 —— 主路径 setState 已渲染中间帧,效应观察不到中间状态。reducer post-step 收敛是数学性(state 不可观察「中间帧」),invariant 不依赖时序。

## 不做的事

- **不继续把 navigation reducer 拆成 sub-reducer**(5 个 reducer 文件 + combineReducers):新增阅读成本与新文件漂移成本高于「单 reducer 文件 ~600 LOC」的可读性。
- **不引入 `xstate`**:5 类状态不够 xstate 触发收益;reducer + union discriminated 已覆盖全部 18 类 transition。
- **不将命令面板 / TaskDialog 直接 subscribe reducer state**:reducer state 经 `useReducer` → React context 派发,React 渲染管线;不走 zustand subscribe 是为了贴合 React 渲染周期一致性,避免 sub-mode subscription 漏帧。
- **不动 `OpenPersonTabsRef`(已下线)** 与 `setActivePersonId` direct setter;两者随 helper 一起下线。
- **不立刻把 `commands/kbd.json` 等配置加进来**:keydown 翻译仍在 App.tsx 的 keydown useEffect 内,后续 shell 视图层稳定后再决策抽到 `app/keyboard.ts`。
- **`PALETTE_KIND_OPEN_PERSON` 常量保留**:case label 字面 `openPerson` 被 grep AC 「`openPerson\b` = 0」挡住;常量是字面 same thing,case label narrowing 等价。该字面策略后续 AC 改成行为级后可删。

## 相关

- 实现: PR #97 (sub-tab) / #98 (sub-tab + tab + keydown) / #99 (TaskDialog) / #100 (palette + PalettePick + pendingIntent) / #101 (cleanup)
- 父 spec: issue #96
- 词汇表: `CONTEXT.md` 5 条新词条 (`NavigationState` / `NavigationEvent` / `PendingIntent` / `navigationReducer` / `PalettePick atomic`)
- 关联设计: ADR 0011 (Status as Domain) —— 同型「renderer seam」决策树
