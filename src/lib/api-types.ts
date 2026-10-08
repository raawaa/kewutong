/**
 * 前端访问主进程命令层的唯一入口（ADR 0006 §行为契约 + ADR 0008 §渲染进程 seam）。
 *
 * 约定：前端不含业务逻辑，只调命令、显示 DTO。每个命令在这里包一层带类型的函数，
 * 组件不直接写 `window.api.*`。
 *
 * 本文件是原 `src/lib/ipc.ts` 的平迁：函数签名同形态，函数体换成
 * `window.api.<command>(args)`。完整迁移完成后删除原 `ipc.ts`（M3 ticket
 * 完成 renderer 全量切到 api.ts 后）。
 */

import type {
  AppErrorDto,
  AssigneeCandidate,
  CreatePersonArgs,
  CreateProjectArgs,
  CreateSubTeamArgs,
  CreateTaskArgs,
  DatabaseExport,
  DatabaseImportSummary,
  DeleteProjectArgs,
  DeleteSubTeamArgs,
  DueDateOption,
  ImportDatabaseJsonArgs,
  InstanceIdArgs,
  ListAssigneeCandidatesArgs,
  ListPeopleArgs,
  ListProjectCandidatesArgs,
  ListProjectsArgs,
  ListRecurringTemplatesArgs,
  ListTasksArgs,
  ListTasksFilteredArgs,
  OverrideInstanceScheduledAtArgs,
  PersonnelMatrix,
  PersonnelMatrixArgs,
  Person,
  PersonIdArgs,
  PingReply,
  Project,
  ProjectCandidate,
  ReorderSubTeamsArgs,
  RecurringTemplate,
  RescheduleInstanceArgs,
  SearchTasksArgs,
  SetRecurringTemplateEnabledArgs,
  SetTaskStatusArgs,
  SubTeam,
  Task,
  TasksCsvExport,
  TodayWeek,
  TrayStatusDto,
  UpdatePersonArgs,
  UpdateProjectArgs,
  UpdateSubTeamArgs,
  UpdateTaskArgs,
  UpdateTemplateZoneArgs,
  UpsertRecurringTemplateArgs,
  WayfinderSearchArgs,
  WayfinderSearchResults,
} from "@/main/types";
import type {
  GetNotificationArgs,
  MarkReadArgs,
  NotificationRow,
} from "@/main/notification/index";

import type {
  ClearHolidayOverrideArgs,
  HolidayCalendarArgs,
  HolidayCalendarDay,
  HolidayLoadResult,
  LoadHolidayCalendarArgs,
  SetHolidayOverrideArgs,
} from "@/main/holiday/index";

import type {
  MaterializeIfNewWeekResult,
  MaterializeTotals,
} from "@/main/materialization/index";

/** 与主进程 `AppError.toPayload()` 一一对应。 */
export type AppError = AppErrorDto;

export type {
  PingReply,
  TrayStatusDto,
  SubTeam,
  Person,
  ListPeopleArgs,
  CreateSubTeamArgs,
  UpdateSubTeamArgs,
  DeleteSubTeamArgs,
  ReorderSubTeamsArgs,
  CreatePersonArgs,
  UpdatePersonArgs,
  PersonIdArgs,
  AssigneeCandidate,
  ListAssigneeCandidatesArgs,
  PersonnelMatrixArgs,
  PersonnelMatrix,
  Task,
  CreateTaskArgs,
  UpdateTaskArgs,
  SetTaskStatusArgs,
  SearchTasksArgs,
  ListTasksArgs,
  ListTasksFilteredArgs,
  TodayWeek,
  DueDateOption,
  DatabaseExport,
  DatabaseImportSummary,
  TasksCsvExport,
  ImportDatabaseJsonArgs,
  RecurringTemplate,
  ListRecurringTemplatesArgs,
  UpsertRecurringTemplateArgs,
  SetRecurringTemplateEnabledArgs,
  RescheduleInstanceArgs,
  OverrideInstanceScheduledAtArgs,
  UpdateTemplateZoneArgs,
  InstanceIdArgs,
  HolidayCalendarArgs,
  HolidayCalendarDay,
  SetHolidayOverrideArgs,
  ClearHolidayOverrideArgs,
  LoadHolidayCalendarArgs,
  HolidayLoadResult,
  NotificationRow,
  MarkReadArgs,
  GetNotificationArgs,
  MaterializeTotals,
  MaterializeIfNewWeekResult,
  WayfinderSearchArgs,
  WayfinderSearchResults,};

// ---------------------------------------------------------------------------
// 探活 / 数据文件位置 / 托盘（tickets #38 / #40 + 后续 #54）
// ---------------------------------------------------------------------------

export function ping(echo?: string | null): Promise<PingReply> {
  return window.api.ping(echo ?? null);
}

export function dataFileLocation(): Promise<string | null> {
  return window.api.dataFileLocation();
}

export function trayStatus(): Promise<TrayStatusDto> {
  return window.api.trayStatus();
}

export function onTrayStatus(handler: (status: TrayStatusDto) => void): () => void {
  return window.api.onTrayStatus(handler);
}

// ---------------------------------------------------------------------------
// Main → renderer 事件总线（ticket #55）
// ---------------------------------------------------------------------------

/**
 * 通用 main → renderer 事件订阅——任意 `webContents.send` 通道都能透
 * 过它接到 renderer。`T` 由调用方声明,TS 在编译期校验 payload 形状。
 *
 * 返回 unsubscribe 函数——`useEffect(() => api.onEvent(...), [])` 在
 * cleanup 里调,避免热重载后 listener 累加。
 */
export function onEvent<T>(channel: string, handler: (payload: T) => void): () => void {
  return window.api.onEvent<T>(channel, handler);
}

/**
 * ⌘K / Ctrl+K 全局快捷键触发——主进程 globalShortcut 触发后,renderer
 * 在这里收到 `{ shortcut }` payload,App 层据此打开命令面板。
 *
 * App 层窗口 keydown 也会同时触发面板,但这条 IPC 通道作为「兜底通
 * 道」存在:即便 keydown 被输入框截获、面板仍会通过 IPC 被打开(参考
 * ticket #55 验收点 #5)。
 */
export function onCommandPaletteShortcut(
  handler: (payload: { shortcut: string }) => void,
): () => void {
  return window.api.onCommandPaletteShortcut(handler);
}

/**
 * 命令抛出来的一律是 `AppError` 形状；非预期异常也收敛成同一形状。
 */
export function toAppError(thrown: unknown): AppError {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    "message" in thrown
  ) {
    return thrown as AppError;
  }
  return {
    code: "UNKNOWN",
    message: "发生了未知错误，请重试。",
    detail: String(thrown),
  };
}

// ---------------------------------------------------------------------------
// 人员管理（tickets #17 / #19 / #22）
// ---------------------------------------------------------------------------

export function listSubTeams(): Promise<SubTeam[]> {
  return window.api.personnel.listSubTeams();
}

export function createSubTeam(args: CreateSubTeamArgs): Promise<SubTeam> {
  return window.api.personnel.createSubTeam(args);
}

export function updateSubTeam(args: UpdateSubTeamArgs): Promise<SubTeam> {
  return window.api.personnel.updateSubTeam(args);
}

export function deleteSubTeam(args: DeleteSubTeamArgs): Promise<void> {
  return window.api.personnel.deleteSubTeam(args);
}

export function reorderSubTeams(args: ReorderSubTeamsArgs): Promise<void> {
  return window.api.personnel.reorderSubTeams(args);
}

export function listPeople(args: ListPeopleArgs): Promise<Person[]> {
  return window.api.personnel.listPeople(args);
}

export function createPerson(args: CreatePersonArgs): Promise<Person> {
  return window.api.personnel.createPerson(args);
}

export function updatePerson(args: UpdatePersonArgs): Promise<Person> {
  return window.api.personnel.updatePerson(args);
}

export function deactivatePerson(args: PersonIdArgs): Promise<Person> {
  return window.api.personnel.deactivatePerson(args);
}

export function reactivatePerson(args: PersonIdArgs): Promise<Person> {
  return window.api.personnel.reactivatePerson(args);
}

export function deletePerson(args: PersonIdArgs): Promise<void> {
  return window.api.personnel.deletePerson(args);
}

export function listAssigneeCandidates(
  args: ListAssigneeCandidatesArgs,
): Promise<AssigneeCandidate[]> {
  return window.api.personnel.listAssigneeCandidates(args);
}

export function personnelMatrix(args: PersonnelMatrixArgs): Promise<PersonnelMatrix> {
  return window.api.personnel.personnelMatrix(args);
}

// ---------------------------------------------------------------------------
// 项目（ticket #20）
// ---------------------------------------------------------------------------

export function listProjects(args: ListProjectsArgs): Promise<Project[]> {
  return window.api.project.listProjects(args);
}

export function listProjectCandidates(
  args: ListProjectCandidatesArgs,
): Promise<ProjectCandidate[]> {
  return window.api.project.listProjectCandidates(args);
}

export function createProject(args: CreateProjectArgs): Promise<Project> {
  return window.api.project.createProject(args);
}

export function updateProject(args: UpdateProjectArgs): Promise<Project> {
  return window.api.project.updateProject(args);
}

export function deleteProject(args: DeleteProjectArgs): Promise<void> {
  return window.api.project.deleteProject(args);
}

// ---------------------------------------------------------------------------
// 任务（tickets #43 / #44）
// ---------------------------------------------------------------------------

export function createTask(args: CreateTaskArgs): Promise<Task> {
  return window.api.task.createTask(args);
}

export function updateTask(args: UpdateTaskArgs): Promise<Task> {
  return window.api.task.updateTask(args);
}

export function setTaskStatus(args: SetTaskStatusArgs): Promise<Task> {
  return window.api.task.setTaskStatus(args);
}

export function listTasks(args: ListTasksArgs): Promise<Task[]> {
  return window.api.task.listTasks(args);
}

export function listTasksFiltered(args: ListTasksFilteredArgs): Promise<Task[]> {
  return window.api.task.listTasksFiltered(args);
}

export function todayWeek(): Promise<TodayWeek> {
  return window.api.task.todayWeek();
}

export function listDueDateOptions(): Promise<DueDateOption[]> {
  return window.api.task.listDueDateOptions();
}

export function searchTasks(args: SearchTasksArgs): Promise<Task[]> {
  return window.api.task.searchTasks(args);
}

// ---------------------------------------------------------------------------
// 导出（ticket #53）
// ---------------------------------------------------------------------------

export function exportDatabaseJson(): Promise<DatabaseExport> {
  return window.api.export.exportDatabaseJson();
}

export function importDatabaseJson(args: ImportDatabaseJsonArgs): Promise<DatabaseImportSummary> {
  return window.api.export.importDatabaseJson(args);
}

export function exportTasksCsv(): Promise<TasksCsvExport> {
  return window.api.export.exportTasksCsv();
}

// ---------------------------------------------------------------------------
// 周期性模板（tickets #24 / #46）
// ---------------------------------------------------------------------------

export function upsertRecurringTemplate(
  args: UpsertRecurringTemplateArgs,
): Promise<RecurringTemplate> {
  return window.api.recurringTemplate.upsertRecurringTemplate(args);
}

export function listRecurringTemplates(
  args: ListRecurringTemplatesArgs,
): Promise<RecurringTemplate[]> {
  return window.api.recurringTemplate.listRecurringTemplates(args);
}

export function setRecurringTemplateEnabled(
  args: SetRecurringTemplateEnabledArgs,
): Promise<RecurringTemplate> {
  return window.api.recurringTemplate.setRecurringTemplateEnabled(args);
}

// ---------------------------------------------------------------------------
// 节假日管理（tickets #23 / #47）
// ---------------------------------------------------------------------------

export function loadHolidayCalendar(args: LoadHolidayCalendarArgs): Promise<HolidayLoadResult> {
  return window.api.holiday.loadHolidayCalendar(args);
}

export function holidayCalendar(args: HolidayCalendarArgs): Promise<HolidayCalendarDay[]> {
  return window.api.holiday.holidayCalendar(args);
}

export function setHolidayOverride(args: SetHolidayOverrideArgs): Promise<void> {
  return window.api.holiday.setHolidayOverride(args);
}

export function clearHolidayOverride(args: ClearHolidayOverrideArgs): Promise<void> {
  return window.api.holiday.clearHolidayOverride(args);
}

// ---------------------------------------------------------------------------
// 通知（ticket #51）
// ---------------------------------------------------------------------------

export function listUnreadNotifications(): Promise<NotificationRow[]> {
  return window.api.notification.listUnreadNotifications();
}

export function listNotifications(): Promise<NotificationRow[]> {
  return window.api.notification.listNotifications();
}

export function markNotificationRead(args: MarkReadArgs): Promise<boolean> {
  return window.api.notification.markNotificationRead(args);
}

export function markAllNotificationsRead(): Promise<number> {
  return window.api.notification.markAllNotificationsRead();
}

export function getNotification(args: GetNotificationArgs): Promise<NotificationRow> {
  return window.api.notification.getNotification(args);
}

// ---------------------------------------------------------------------------
// 物化（tickets #25 / #48）
// ---------------------------------------------------------------------------

/** 立即跑一次物化——UI 的「立即刷新」按钮、调停模板后想看到新 instance
 *  等场景手动调。返回合计。 */
export function materializeNow(): Promise<MaterializeTotals> {
  return window.api.materialization.materializeNow();
}

/** 后台 tick 调用——只在跨入新 ISO 周时跑物化。`materialized = false`
 *  表示本次没真跑（前端不弹提示）。 */
export function materializeIfNewWeek(): Promise<MaterializeIfNewWeekResult> {
  return window.api.materialization.materializeIfNewWeek();
}

// ---------------------------------------------------------------------------
// 实例动作（tickets #26 / #49）
// ---------------------------------------------------------------------------

/** 手工改期单次 instance——原 instance → `Cancelled` + 新 instance →
 *  `Open`，`rescheduled_from_id` 串起来（与 SHIFT 路径同形）。 */
export function rescheduleInstance(args: RescheduleInstanceArgs): Promise<Task> {
  return window.api.instance.rescheduleInstance(args);
}

/** 仅覆盖单 instance 的 `scheduled_at`——不取消、不挂
 *  `rescheduled_from_id`。出差场景的轻量手势。 */
export function overrideInstanceScheduledAt(
  args: OverrideInstanceScheduledAtArgs,
): Promise<Task> {
  return window.api.instance.overrideInstanceScheduledAt(args);
}

/** 整体改模板的 `iana_zone`。v1 仅允许 `Asia/Shanghai`。 */
export function updateRecurringTemplateZone(
  args: UpdateTemplateZoneArgs,
): Promise<RecurringTemplate> {
  return window.api.instance.updateRecurringTemplateZone(args);
}

/** 沿 `rescheduled_from_id` 一路回溯，返回整条链（含自身，自身在最前）。
 *  深度上限 32——防同步漂移引入的环路。 */
export function instanceRescheduleChain(args: InstanceIdArgs): Promise<Task[]> {
  return window.api.instance.instanceRescheduleChain(args);
}

// ---------------------------------------------------------------------------
// ⌘K 全局命令面板（tickets #28 / #50）
// ---------------------------------------------------------------------------

/**
 * ⌘K 命令面板搜索——一次拉回三类候选（人员 / 项目 / 任务）。
 *
 * `query` 空 = 默认候选；非空 = 子串 / FTS5 搜索。
 * 命令层是候选列表的权威,前端不再二次过滤 / 排序 / 截断。
 */
export function wayfinderSearch(args: WayfinderSearchArgs): Promise<WayfinderSearchResults> {
  return window.api.wayfinder.wayfinderSearch(args);
}