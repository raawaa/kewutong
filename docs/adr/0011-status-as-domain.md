# Status 作为 renderer 侧领域概念

**Status**: accepted

承接 issue #92（C1）— 把散落在 6 个文件里的「任务 6 状态」相关逻辑集中到单一 seam；renderer 与 main 各自一份声明、`lib/taskStatus.test.ts` 的 drift test 在 CI 拦住漂移。

## 上下文

任务 6 状态（`Open / In-progress / Blocked / Waiting-on / Done / Cancelled`）在本仓的描述散落如下：

- **main 侧**：`src/main/task/index.ts:41-58` 的 `TASK_STATUSES` / `IN_FLIGHT_STATUSES` / `BLOCKED_STATUSES`；`src/main/personnel/index.ts:511-594` 的 `bucketByStatus` + 三个具名 comparator；`src/main/personnel/index.ts:425-426` 的 `tasks.filter(t => t.status === "Blocked" || t.status === "Waiting-on")` 字面比较。
- **renderer 侧**：`src/components/task/TaskStatusMenu.tsx:24-40` 的 `STATUSES` + `STATUS_LABELS`；`src/components/task/TaskDialog.tsx:44-51` 的 `TASK_STATUS_ORDER`；`src/views/ProjectsView.tsx:25-32` 的 `STATUS_COLUMNS`；`src/views/PersonDetailView.tsx:294-317` 的 `SEGMENT_ORDER` + `BUCKET_KEY`；`src/views/PersonnelMatrixView.tsx` 通过 `PersonnelMatrixPerson.blockedCount` 间接依赖字面比较；`src/lib/taskStatusStyle.ts` 的 `STATUS_STYLE`。

每个状态出现 ≥2 次（label、className、排序、桶名、子集判定各算一次），共 17 处识别为深度重复。新增第 7 状态时需要编辑 6 处以上，编译期无任何一处的「漏改」守护。

### 形状漂移

`PersonDetailInFlight` 是 6 个手命名字段 `{open, inProgress, blocked, waitingOn, done, cancelled}: Task[]`。视图侧维护 `BUCKET_KEY: Record<TaskStatus, keyof PersonDetailInFlight>` 翻译表只为消解「SQL/dict 形状」与「TaskStatus 字面」之间的漂移——`buckets[BUCKET_KEY["In-progress"]]` 这种代码不是字面，而是「翻译表 + 字面」的二层结构。

### 排序权威双实现

longest-stuck 排序在两处独立实现：

- **SQL**：`src/main/personnel/index.ts:486-488` 的 `ORDER BY blocked_at ASC, id ASC`（`fetchWaitingOnTasksForPerson`）
- **TS**：`src/main/personnel/index.ts:574-587` 的 `compareByBlockedAtAsc`

规则改一处就得改两处，且两处的语义一致只靠人工 review 守。

### null 兜底吞错

`compareByBlockedAtAsc` / `compareByUpdatedAtDesc` 之前在 `null` 输入时静默「排末」。DB schema 已用 NOT NULL 强制（`task.blocked_at` / `task.updated_at`），如果 `null` 真进比较器说明 schema 被绕过——沉默排序分支在该 Observer 等于吞错。

## 决策

### 1. Renderer 侧单一权威：`src/lib/taskStatus.ts`

由 `src/lib/taskStatusStyle.ts` git rename 而来，扩展导出：

- `TASK_STATUS_ORDER: readonly TaskStatus[]` —— 6 状态渲染顺序（Open 在前，Cancelled 在后）
- `IN_FLIGHT: readonly InFlight[]` —— 在飞四态
- `BLOCKED: readonly Blocked[]` —— 阻塞二态
- `STATUS_META: Record<TaskStatus, {label, className}>` —— 原 `STATUS_STYLE`，label + Tailwind 锁定色板
- 类型 `InFlight = Exclude<TaskStatus, "Done" | "Cancelled">` / `Blocked = Extract<TaskStatus, "Blocked" | "Waiting-on">` —— `Extract` / `Exclude` 在编译期保证子集不写错

所有 view / component（`TaskStatusMenu` / `TaskDialog` / `ProjectsView` / `PersonnelMatrixView` / `PersonDetailView` / `TodayWeekView`）的 status 列表 / label / color 取值都从这里走。本地 `STATUSES` / `TASK_STATUS_ORDER` / `STATUS_COLUMNS` / `STATUS_LABELS` 全部删除。

### 2. 主进程唯一排序权威：`src/main/task/inflight_sort.ts`

新文件，导出三个具名 comparator + 聚合入口 `comparatorFor(status: TaskStatus)`：

```ts
const COMPARATORS: Record<TaskStatus, Comparator<Task>> = {
  Open: compareByDueDateAscNullLast,
  "In-progress": compareByDueDateAscNullLast,
  Blocked: compareByBlockedAtAsc,
  "Waiting-on": compareByBlockedAtAsc,
  Done: compareByUpdatedAtDesc,
  Cancelled: compareByUpdatedAtDesc,
};

export function comparatorFor(status: TaskStatus): Comparator<Task> {
  return COMPARATORS[status];
}
```

`bucketByStatus` 内部用 `comparatorFor(status)` 调度，`waitingOnTasks` 段也走同一入口。新增 status 时 `Record<TaskStatus, Comparator>` 缺键编译期拦截。

### 3. `PersonDetailInFlight = Record<TaskStatus, Task[]>`

`src/main/types.ts:264-271` 6 具名字段扁平化为字面 key。视图侧的 `BUCKET_KEY` 翻译表整表删除（42 行消失），`inFlight[status]` 直接索引。`Record<TaskStatus, T[]>` 在编译期保证所有 status 都有桶。

### 4. SQL `ORDER BY` 唯一权威让位

`fetchTasksForPerson`（合并自 `fetchAllTasksForPerson` + `fetchWaitingOnTasksForPerson`，XOR 签名 `{owner} | {waitingOn}`）的 SQL `ORDER BY` 只留 `id ASC` 兜底 tiebreaker。段内语义排序由调用方 `bucketByStatus → comparatorFor` 在 TS 端做。

### 5. NOT NULL 列的 null 路径走 `AppError.internal`

`compareByBlockedAtAsc` / `compareByUpdatedAtDesc` 删 null 兜底，改抛 `AppError.internal("...taskId=${id} status=${status}")`。`compareByDueDateAscNullLast` 仍走「null 排末」——`due_date` 业务上可空，不是 invariant violation。

### 6. Drift test 覆盖三对数组

`src/lib/taskStatus.test.ts` 用 vitest 在 node 环境跑：

- `TASK_STATUS_ORDER === TASK_STATUSES`
- `IN_FLIGHT === IN_FLIGHT_STATUSES`
- `BLOCKED === BLOCKED_STATUSES`
- `BLOCKED ⊂ IN_FLIGHT`
- `Done / Cancelled ∉ IN_FLIGHT`

新加状态或重排时，CI 红 + 错误信息精确到元素差异。

## 后果

### 正面

- **新增状态 = 单点编辑**：主进程 `TaskStatus` 联合 + `TASK_STATUSES` + `COMPARATORS` 映射表；renderer adapter 的 `TASK_STATUS_ORDER` + `IN_FLIGHT` / `BLOCKED` + `STATUS_META`；SQL CHECK 列约束。drift test 兜「漏改某一边」。
- **`BUCKET_KEY` 翻译表整表消失**：视图层 42 行删除；`inFlight[status]` 直接索引。
- **排序唯一权威**：`comparatorFor(status)` 单一入口；SQL 端不背语义。
- **NOT NULL 列违规立即 `AppError.internal`**：DB schema 失效时不再沉默吞错，error payload 携带 `taskId` + `status`，生产日志可 grep 关联。
- **`Blocked` 桶的「`Waiting-on` 自反等待」规则独立为 `isWaitingOnOther(task)` 谓词**：可单测、可重用。

### 负面 / 风险

- **wire format 变化**：`PersonDetailInFlight` 在 P1 / P2 之间变了（IPC payload 的字节级序列化不变，但字段名变了）。renderer 端视图 + 测试同步重写 8 个文件。规避：`pnpm test` 现行 600 / 600。
- **renderer 端与 main 端两份声明**：drift 风险常驻；规避：drift test 在 CI。
- **`inflight_sort` 模块的 comparator 在 `bucketByStatus` 之外的复用面**：当前唯一调用方是 personnel 的两段；如果未来 task list 也按状态分组，可能出现「task 模块自己又维护一份排序」——届时再决策。
- **i18n 留位未做**：`STATUS_META.label` 仍是中文字面。后续上 i18n 时，把 `label` 字段改为 i18n key，文案走 `t("status.Open")` 即可——本次不改。

## 替代方案考虑

### 排序全放 SQL

放弃。一条 SQL 无法对不同行用不同 `ORDER BY`，等于拆 6 条查询，丢掉「单次命令一次拉回」（C1 P2 注解里的设计意图）。

### 保留 `PersonDetailInFlight` 6 字段 + mapped type 推导

放弃。`buckets[camelCase]` 的字段名是 SQL/dict 的形状，`buckets["In-progress"]` 是 TaskStatus 的字面形状——`BUCKET_KEY` 翻译表仍在，半成品。C1 的承诺是「`BUCKET_KEY` 整表消失」。

### `TaskStatus` 移到 `src/lib/taskStatus.ts` 作为单一权威

放弃。main 模块不能 type-only import renderer adapter（adapter 有 `as const satisfies` 等 TS 特性，跨进程导入会污染 main 编译）；让 renderer 适配器只持 value、type 仍来自 `main/types`，drift test 兜漂移，足够。

### `STATUS_META` 加 `isInFlight` / `isBlocked` 字段

放弃。`Record<TaskStatus, StatusMeta>` + `BLOCKED.includes(status)` 双权威——新增状态时两处都得改。当前决策：`STATUS_META` 只承担渲染元数据（label + className），子集归属查询走 `BLOCKED.includes` / `IN_FLIGHT.includes`。

### `inflight_sort` 与 `bucketByStatus` 合并

放弃。`bucketByStatus` 是 person detail 的领域编排（分桶 + 自反等待过滤 + 段内排序三合一），`inflight_sort` 是 task 域的排序原语。person 与 task 不该 1:1 合并——前者承担 DTO 装配，后者承担纯函数排序。合并后接口变胖，person 侧需要懂 task 排序细节，task 侧需要懂 person 自反等待——泄漏 cross-cutting。

## 不做的事

- **不开 `Blocked` 之外的「in-flight 子分类」枚举**（如 `SelfBlocked` / `Waiting-on-Self` 等）：`isWaitingOnOther` 谓词已经把自反情况处理掉，不需要新增 status。
- **不引入 i18n**：当前未上 i18n；label 字面保留中文，`STATUS_META` 的 `label` 字段留作未来 i18n key 替换位。
- **不动 `TodayWeekView` / `Wayfinder` / `listTasks` / `listTasksFiltered` 的 SQL `status NOT IN ('Done','Cancelled')` / `inFlightTaskOrderBy`**：这些是独立 SQL 模式，不在 C1 范围。

## 相关

- 实现：PR #93 (P1) / PR #94 (P2) / PR #95 (P3)
- 设计树：`/improve-codebase-architecture` 9 轮 grilling 37 决定
- 详细规格：本地 `tmpdir/c1-spec.md`
- 关联：T2 #82 (Longest-Stuck 排序) / TaskDialog #91 (status picker) / 人员详情 #80 (#81 T1 → #87 T7)
- 词汇表：`CONTEXT.md` 新增 6 条（`STATUS_META` / `IN_FLIGHT` / `BLOCKED` / `inflight_sort` / `comparatorFor` / `isWaitingOnOther`）