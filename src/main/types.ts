/**
 * 命令层 DTO 类型（承 ADR 0006 §行为契约）。
 *
 * 与前端 `src/lib/api-types.ts` 完全同形；本文件是契约的权威源。前端
 * wrapper 类型从 `src/lib/ipc.ts` 平迁到 `src/lib/api-types.ts` 后，从这里
 * re-export 出去（编译期保证两端一致）。
 */

export type AppErrorCode =
  | "DATABASE"
  | "MIGRATION"
  | "IO"
  | "INTERNAL"
  | "INVALID_ARGUMENT"
  | "UNKNOWN";

export interface AppErrorDto {
  code: AppErrorCode;
  message: string;
  detail: string | null;
}

export interface PingReply {
  message: string;
  now: string;
  schemaVersion: number | null;
  echo: string | null;
}

// ---------------------------------------------------------------------------
// 人员管理（ticket #17）
// ---------------------------------------------------------------------------

export interface SubTeam {
  id: number;
  name: string;
  description: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface Person {
  id: number;
  name: string;
  subTeamId: number;
  contact: string;
  deactivatedAt: string | null;
  createdAt: string;
}

export interface ListPeopleArgs {
  includeDeactivated: boolean;
  subTeamId?: number | null;
}

export interface CreateSubTeamArgs {
  name: string;
  description?: string | null;
}

export interface UpdateSubTeamArgs {
  id: number;
  name: string;
  description?: string | null;
}

export interface DeleteSubTeamArgs {
  id: number;
}

export interface ReorderSubTeamsArgs {
  orderedIds: number[];
}

export interface CreatePersonArgs {
  name: string;
  subTeamId: number;
  contact: string;
}

export interface UpdatePersonArgs {
  id: number;
  name: string;
  subTeamId: number;
  contact: string;
}

export interface PersonIdArgs {
  id: number;
}

// ---------------------------------------------------------------------------
// 任务（tickets #18 / #19 / #21 / #22 / #27）
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "Open"
  | "In-progress"
  | "Blocked"
  | "Waiting-on"
  | "Done"
  | "Cancelled";

export type ProjectStatus = "Active" | "Done" | "Cancelled";

export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  ownerPersonId: number;
  projectId: number | null;
  dueDate: string | null;
  recurringTemplateId: number | null;
  scheduledAt: string | null;
  originalScheduledAt: string | null;
  rescheduledFromId: number | null;
  isRecurring: boolean;
  effectiveDate: string | null;
  createdAt: string;
  updatedAt: string;
  blockedAt: string | null;
  blockedReason: string | null;
  waitingOnPersonId: number | null;
}

export type DueDateChip = "today" | "tomorrow" | "next-week" | "none";

export interface DueDateOption {
  chip: DueDateChip;
  label: string;
  dueDate: string | null;
}

export interface AssigneeCandidate {
  personId: number;
  name: string;
  subTeamName: string;
}

export interface ListAssigneeCandidatesArgs {
  query?: string | null;
}

export interface CreateTaskArgs {
  title: string;
  description?: string | null;
  ownerPersonId: number;
  projectId?: number | null;
  dueDate?: string | null;
  /**
   * #91：新建时可指定初始状态，缺省 = `Open`。白名单外抛
   * `AppError.invalid`——命令层自己兜底，不靠 DB CHECK 翻译。
   * 进入 Blocked / Waiting-on 时 `blockedReason` 必填；Waiting-on 还允
   * 许带 `waitingOnPersonId`（Blocked 下强制 null）。
   */
  status?: TaskStatus;
  blockedReason?: string | null;
  waitingOnPersonId?: number | null;
}

export type UpdateTaskArgs = CreateTaskArgs & { id: number };

export interface ListTasksArgs {
  includeCancelled: boolean;
  ownerPersonId?: number | null;
  projectId?: number | null;
}

export interface ListTasksFilteredArgs {
  /** 状态多选过滤；空 = 不过滤。 */
  statuses: TaskStatus[];
  /** 负责人过滤；`null` = 不过滤。 */
  ownerPersonId?: number | null;
  /** 项目过滤；`null` = 不过滤。 */
  projectId?: number | null;
  /** 截止日下界（含）；`null` = 不限。 */
  dueDateFrom?: string | null;
  /** 截止日上界（含）；`null` = 不限。 */
  dueDateTo?: string | null;
  /** 默认 false 过滤 Cancelled。 */
  includeCancelled: boolean;
  /** 默认 false 过滤掉负责人离岗的任务。 */
  includeDeactivatedOwners: boolean;
}

export interface SetTaskStatusArgs {
  taskId: number;
  status: TaskStatus;
  blockedReason?: string | null;
  waitingOnPersonId?: number | null;
}

/**
 * ⌘K 命令面板 / 任务搜索入参（ticket #45 · FTS5 平迁）。
 *
 * - `query` 走 FTS5 trigram；不足 3 字时 LIKE 兜底（短查询召回）。
 * - `includeCancelled` / `includeDeactivatedOwners` 默认 false，与
 *   [`ListTasksFilteredArgs`] 同语义——「在岗 + 在飞」是命令面板的默认
 *   视图。
 * - `limit` 由命令层封顶 `SEARCH_TASKS_LIMIT = 50`；传 null = 用默认。
 */
export interface SearchTasksArgs {
  query: string;
  includeCancelled: boolean;
  includeDeactivatedOwners: boolean;
  limit?: number | null;
}

export interface TodayWeekCounts {
  activePeople: number;
  inProgress: number;
  blocked: number;
}

export interface TodayWeekBuckets {
  overdue: Task[];
  today: Task[];
  tomorrow: Task[];
  thisWeekRest: Task[];
}

export interface TodayWeek {
  counts: TodayWeekCounts;
  buckets: TodayWeekBuckets;
  /** 物化窗口右端（今天 + 12 周）。UI 在此日期之后的「下周/下下周」
   * 等视图给"未物化,可能没安排"提示,而不是空白或错误。 */
  materializationWindowEnd: string;
}

export interface PersonnelMatrixArgs {
  includeDeactivated: boolean;
}

export interface PersonnelMatrixPerson {
  person: Person;
  inFlightCount: number;
  blockedCount: number;
  tasks: Task[];
}

export interface PersonnelMatrixSegment {
  subTeam: SubTeam;
  people: PersonnelMatrixPerson[];
}

export interface PersonnelMatrix {
  segments: PersonnelMatrixSegment[];
}

// ---------------------------------------------------------------------------
// 人员详情（ticket #80 / #81 T1）
// ---------------------------------------------------------------------------

/**
 * 人员详情的「在飞任务按 6 状态分组」段。
 *
 * `waitingOn` 与顶层 [`PersonDetail.waitingOnTasks`] 是两个独立概念：
 * - `inFlight.waitingOn`：owner 是本人且 `waiting_on_person_id` 指向**别人**
 *   ——「本人在等别人的任务」；
 * - `PersonDetail.waitingOnTasks`：owner 是别人且 `waiting_on_person_id`
 *   指向**本人** ——「别人等的任务由本人推动」。
 */
/**
 * 人员详情第 2 段「在飞任务」——按 `TaskStatus` 6 桶平铺（ticket #92 C1 P2）。
 *
 * **`Record<TaskStatus, Task[]>`** 让桶 key 与 `TaskStatus` 字面量同形，视图
 * 侧不再需要 `BUCKET_KEY: Record<TaskStatus, keyof PersonDetailInFlight>`
 * 翻译表；任何新增 status 由 `TaskStatus` 联合 + `Record` 缺键在编译期
 * 拦下。
 *
 * 排序唯一权威在 [`task/inflight_sort.ts`] 的 `comparatorFor(status)`；
 * 空桶的语义是「这个 status 下没有任务」，不是「缺字段」，所以每个
 * status 都必有 `Task[]` 字段（即便为 `[]`）。
 */
export type PersonDetailInFlight = Record<TaskStatus, Task[]>;

/**
 * 人员详情聚合 DTO——`get_person_detail` 命令一次返回。
 *
 * 五段：
 * 1. `person` ——人员档案（姓名 / 联系方式 / 子组 / 离岗状态 / 录入时间）；
 * 2. `inFlight` ——owner 是本人的任务按 6 状态分组；
 * 3. `ownedProjects` ——`project.owner_person_id = 本人` 的项目（跨组也算）；
 * 4. `waitingOnTasks` ——`task.waiting_on_person_id = 本人` 的任务；
 * 5. `subTeamTemplates` ——`recurring_template.sub_team_id = person.sub_team_id`
 *    的模板。
 *
 * 排序由主进程在组装时一次性给齐：Open / In-progress 按 `due_date` 升序
 * （NULL 末）；Blocked / Waiting-on 按 `blocked_at` 升序（longest-stuck
 * 在前）；Done / Cancelled 按 `updated_at` 降序；`waitingOnTasks` 按
 * `blocked_at` 升序。前端拿到直接渲染，不二次聚合 / 重排。
 */
export interface PersonDetail {
  person: Person;
  inFlight: PersonDetailInFlight;
  ownedProjects: Project[];
  waitingOnTasks: Task[];
  subTeamTemplates: RecurringTemplate[];
}

// ---------------------------------------------------------------------------
// 项目（ticket #20）
// ---------------------------------------------------------------------------

export interface Project {
  id: number;
  name: string;
  ownerPersonId: number;
  subTeamId: number;
  startDate: string | null;
  dueDate: string | null;
  notes: string | null;
  createdAt: string;
  status: ProjectStatus;
}

export interface ProjectCandidate {
  projectId: number;
  name: string;
  subTeamName: string;
}

export interface ListProjectCandidatesArgs {
  query?: string | null;
}

export interface ListProjectsArgs {
  includeDone: boolean;
}

export type CreateProjectArgs = {
  name: string;
  ownerPersonId: number;
  subTeamId: number;
  startDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
};

export type UpdateProjectArgs = CreateProjectArgs & { id: number };

export interface DeleteProjectArgs {
  id: number;
}

// ---------------------------------------------------------------------------
// 周期性模板（ticket #24）
// ---------------------------------------------------------------------------

export type RecurringFreq = "daily" | "weekly" | "monthly" | "yearly";
export type RecurringHolidayBehavior = "skip" | "shift";

export type RecurringEnds = { kind: "on"; date: string } | { kind: "after"; n: number };

export interface StructuredRule {
  freq: RecurringFreq;
  bydayMask: number;
  bymonthday: number[] | null;
  bymonth: number[] | null;
  byhour: number;
  byminute: number;
  ianaZone: string;
  ends: RecurringEnds;
  holidayBehavior: RecurringHolidayBehavior;
}

export interface RecurringTemplate {
  id: number;
  name: string;
  freq: RecurringFreq;
  bydayMask: number;
  bymonthday: number[] | null;
  bymonth: number[] | null;
  byhour: number;
  byminute: number;
  ianaZone: string;
  ends: RecurringEnds;
  holidayBehavior: RecurringHolidayBehavior;
  rruleText: string;
  projectId: number | null;
  subTeamId: number | null;
  enabled: boolean;
  notes: string | null;
  createdAt: string;
}

export interface UpsertRecurringTemplateArgs {
  id: number | null;
  name: string;
  rule: StructuredRule;
  projectId: number | null;
  subTeamId: number | null;
  notes: string | null;
}

export interface ListRecurringTemplatesArgs {
  includeDisabled: boolean;
}

export interface SetRecurringTemplateEnabledArgs {
  id: number;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// 实例动作与改期溯源（ticket #26）
// ---------------------------------------------------------------------------

export interface RescheduleInstanceArgs {
  taskId: number;
  newScheduledAt: string;
}

export interface OverrideInstanceScheduledAtArgs {
  taskId: number;
  newScheduledAt: string;
}

export interface UpdateTemplateZoneArgs {
  templateId: number;
  ianaZone: string;
}

export interface InstanceIdArgs {
  taskId: number;
}

// ---------------------------------------------------------------------------
// ⌘K 全局命令面板（ticket #28）
// ---------------------------------------------------------------------------

export interface WayfinderSearchArgs {
  query: string;
  peopleLimit?: number | null;
  projectsLimit?: number | null;
  tasksLimit?: number | null;
  includeCancelledTasks?: boolean;
  includeDeactivatedPeople?: boolean;
}

export type WayfinderMatchKind = "name" | "sub-team" | "both";

export interface WayfinderPersonHit {
  personId: number;
  name: string;
  subTeamId: number;
  subTeamName: string;
  matchKind: WayfinderMatchKind;
}

export interface WayfinderProjectHit {
  projectId: number;
  name: string;
  subTeamId: number;
  subTeamName: string;
  status: string;
  matchKind: WayfinderMatchKind;
}

export interface WayfinderSearchResults {
  people: WayfinderPersonHit[];
  projects: WayfinderProjectHit[];
  tasks: Task[];
}

// ---------------------------------------------------------------------------
// 托盘可达性（ticket #29）
// ---------------------------------------------------------------------------

export interface TrayStatusDto {
  available: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// 示例数据 / 数据文件位置 / 导出（ticket #31）
// ---------------------------------------------------------------------------

export interface SamplePresence {
  present: boolean;
}

export interface ClearSampleSummary {
  subTeams: number;
  people: number;
  projects: number;
  tasks: number;
  recurringTemplates: number;
}

export interface RealTeamsSeedSummary {
  subTeamsInserted: number;
  peopleInserted: number;
  seeded: boolean;
}

export interface DatabaseExport {
  jsonText: string;
  schemaVersion: number;
  byteSize: number;
}

export interface DatabaseImportSummary {
  tablesImported: number;
  rowsImported: number;
}

export interface ImportDatabaseJsonArgs {
  jsonText: string;
}

export interface TasksCsvExport {
  csvText: string;
  rowCount: number;
}