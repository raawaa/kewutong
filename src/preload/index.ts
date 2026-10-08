/**
 * Preload script（ADR 0008 §preload）。
 *
 * `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false` 下，
 * 渲染进程只能通过 `window.api` 这一唯一通道与主进程通信。每个方法是一
 * 个手写 typed wrapper——不暴露 `ipcRenderer` 原对象。
 *
 * 通道名 = 命令名一一对应（dot.case），便于跨 domain 分类与追踪。
 */

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

import type {
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
  ListAssigneeCandidatesArgs,
  ListPeopleArgs,
  ListProjectCandidatesArgs,
  ListProjectsArgs,
  ListRecurringTemplatesArgs,
  ListTasksArgs,
  ListTasksFilteredArgs,
  PersonnelMatrix,
  PersonnelMatrixArgs,
  Person,
  PersonIdArgs,
  PingReply,
  Project,
  ProjectCandidate,
  ReorderSubTeamsArgs,
  RecurringTemplate,
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
  UpsertRecurringTemplateArgs,
} from "@/main/types";
import type {
  ClearHolidayOverrideArgs,
  HolidayCalendarArgs,
  HolidayCalendarDay,
  HolidayLoadResult,
  LoadHolidayCalendarArgs,
  SetHolidayOverrideArgs,
} from "@/main/holiday/index";
import type {
  GetNotificationArgs,
  MarkReadArgs,
  NotificationRow,
} from "@/main/notification/index";
import type {
  MaterializeIfNewWeekResult,
  MaterializeTotals,
} from "@/main/materialization/index";
import type {
  InstanceIdArgs,
  OverrideInstanceScheduledAtArgs,
  RescheduleInstanceArgs,
  UpdateTemplateZoneArgs,
} from "@/main/types";

/** 渲染进程只能看到这一份 typed API。 */
const api = {
  // 探活 / 诊断（tickets #38 / #40 + 后续 #54）
  ping: (echo: string | null): Promise<PingReply> => ipcRenderer.invoke("ping", echo),
  dataFileLocation: (): Promise<string | null> => ipcRenderer.invoke("dataFileLocation"),
  trayStatus: (): Promise<TrayStatusDto> => ipcRenderer.invoke("trayStatus"),
  onTrayStatus: (handler: (status: TrayStatusDto) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, status: TrayStatusDto): void => handler(status);
    ipcRenderer.on("tray.status", listener);
    return () => ipcRenderer.off("tray.status", listener);
  },

  // 人员管理（tickets #17 / #19 / #22）
  personnel: {
    listSubTeams: (): Promise<SubTeam[]> => ipcRenderer.invoke("personnel.list_sub_teams"),
    createSubTeam: (args: CreateSubTeamArgs): Promise<SubTeam> =>
      ipcRenderer.invoke("personnel.create_sub_team", args),
    updateSubTeam: (args: UpdateSubTeamArgs): Promise<SubTeam> =>
      ipcRenderer.invoke("personnel.update_sub_team", args),
    deleteSubTeam: (args: DeleteSubTeamArgs): Promise<void> =>
      ipcRenderer.invoke("personnel.delete_sub_team", args),
    reorderSubTeams: (args: ReorderSubTeamsArgs): Promise<void> =>
      ipcRenderer.invoke("personnel.reorder_sub_teams", args),
    listPeople: (args: ListPeopleArgs): Promise<Person[]> =>
      ipcRenderer.invoke("personnel.list_people", args),
    createPerson: (args: CreatePersonArgs): Promise<Person> =>
      ipcRenderer.invoke("personnel.create_person", args),
    updatePerson: (args: UpdatePersonArgs): Promise<Person> =>
      ipcRenderer.invoke("personnel.update_person", args),
    deactivatePerson: (args: PersonIdArgs): Promise<Person> =>
      ipcRenderer.invoke("personnel.deactivate_person", args),
    reactivatePerson: (args: PersonIdArgs): Promise<Person> =>
      ipcRenderer.invoke("personnel.reactivate_person", args),
    deletePerson: (args: PersonIdArgs): Promise<void> =>
      ipcRenderer.invoke("personnel.delete_person", args),
    listAssigneeCandidates: (args: ListAssigneeCandidatesArgs): Promise<AssigneeCandidate[]> =>
      ipcRenderer.invoke("personnel.list_assignee_candidates", args),
    personnelMatrix: (args: PersonnelMatrixArgs): Promise<PersonnelMatrix> =>
      ipcRenderer.invoke("personnel.personnel_matrix", args),
  },

  // 项目管理（ticket #20）
  project: {
    listProjects: (args: ListProjectsArgs): Promise<Project[]> =>
      ipcRenderer.invoke("project.list_projects", args),
    listProjectCandidates: (args: ListProjectCandidatesArgs): Promise<ProjectCandidate[]> =>
      ipcRenderer.invoke("project.list_project_candidates", args),
    createProject: (args: CreateProjectArgs): Promise<Project> =>
      ipcRenderer.invoke("project.create_project", args),
    updateProject: (args: UpdateProjectArgs): Promise<Project> =>
      ipcRenderer.invoke("project.update_project", args),
    deleteProject: (args: DeleteProjectArgs): Promise<void> =>
      ipcRenderer.invoke("project.delete_project", args),
  },

  // 任务管理（tickets #43 / #44）
  task: {
    createTask: (args: CreateTaskArgs): Promise<Task> =>
      ipcRenderer.invoke("task.create_task", args),
    updateTask: (args: UpdateTaskArgs): Promise<Task> =>
      ipcRenderer.invoke("task.update_task", args),
    setTaskStatus: (args: SetTaskStatusArgs): Promise<Task> =>
      ipcRenderer.invoke("task.set_task_status", args),
    listTasks: (args: ListTasksArgs): Promise<Task[]> =>
      ipcRenderer.invoke("task.list_tasks", args),
    listTasksFiltered: (args: ListTasksFilteredArgs): Promise<Task[]> =>
      ipcRenderer.invoke("task.list_tasks_filtered", args),
    todayWeek: (): Promise<TodayWeek> => ipcRenderer.invoke("task.today_week"),
    listDueDateOptions: (): Promise<DueDateOption[]> =>
      ipcRenderer.invoke("task.list_due_date_options"),
    searchTasks: (args: SearchTasksArgs): Promise<Task[]> =>
      ipcRenderer.invoke("task.search_tasks", args),
  },

  // 导出（ticket #53）
  export: {
    exportDatabaseJson: (): Promise<DatabaseExport> =>
      ipcRenderer.invoke("export.export_database_json"),
    importDatabaseJson: (args: ImportDatabaseJsonArgs): Promise<DatabaseImportSummary> =>
      ipcRenderer.invoke("export.import_database_json", args),
    exportTasksCsv: (): Promise<TasksCsvExport> =>
      ipcRenderer.invoke("export.export_tasks_csv"),
  },

  // 周期性模板（tickets #24 / #46）
  recurringTemplate: {
    upsertRecurringTemplate: (args: UpsertRecurringTemplateArgs): Promise<RecurringTemplate> =>
      ipcRenderer.invoke("recurring_template.upsert_recurring_template", args),
    listRecurringTemplates: (args: ListRecurringTemplatesArgs): Promise<RecurringTemplate[]> =>
      ipcRenderer.invoke("recurring_template.list_recurring_templates", args),
    setRecurringTemplateEnabled: (
      args: SetRecurringTemplateEnabledArgs,
    ): Promise<RecurringTemplate> =>
      ipcRenderer.invoke("recurring_template.set_recurring_template_enabled", args),
  },

  // 节假日管理（tickets #23 / #47）
  holiday: {
    loadHolidayCalendar: (args: LoadHolidayCalendarArgs): Promise<HolidayLoadResult> =>
      ipcRenderer.invoke("holiday.load_holiday_calendar", args),
    holidayCalendar: (args: HolidayCalendarArgs): Promise<HolidayCalendarDay[]> =>
      ipcRenderer.invoke("holiday.holiday_calendar", args),
    setHolidayOverride: (args: SetHolidayOverrideArgs): Promise<void> =>
      ipcRenderer.invoke("holiday.set_holiday_override", args),
    clearHolidayOverride: (args: ClearHolidayOverrideArgs): Promise<void> =>
      ipcRenderer.invoke("holiday.clear_holiday_override", args),
  },

  // 通知（ticket #51）
  notification: {
    listUnreadNotifications: (): Promise<NotificationRow[]> =>
      ipcRenderer.invoke("notification.list_unread_notifications"),
    listNotifications: (): Promise<NotificationRow[]> =>
      ipcRenderer.invoke("notification.list_notifications"),
    markNotificationRead: (args: MarkReadArgs): Promise<boolean> =>
      ipcRenderer.invoke("notification.mark_notification_read", args),
    markAllNotificationsRead: (): Promise<number> =>
      ipcRenderer.invoke("notification.mark_all_notifications_read"),
    getNotification: (args: GetNotificationArgs): Promise<NotificationRow> =>
      ipcRenderer.invoke("notification.get_notification", args),
  },

  // 物化（tickets #25 / #48）
  materialization: {
    materializeNow: (): Promise<MaterializeTotals> =>
      ipcRenderer.invoke("materialization.materialize_now"),
    materializeIfNewWeek: (): Promise<MaterializeIfNewWeekResult> =>
      ipcRenderer.invoke("materialization.materialize_if_new_week"),
  },

  // 实例动作（tickets #26 / #49）
  instance: {
    rescheduleInstance: (args: RescheduleInstanceArgs): Promise<Task> =>
      ipcRenderer.invoke("instance.reschedule_instance", args),
    overrideInstanceScheduledAt: (args: OverrideInstanceScheduledAtArgs): Promise<Task> =>
      ipcRenderer.invoke("instance.override_instance_scheduled_at", args),
    updateRecurringTemplateZone: (args: UpdateTemplateZoneArgs): Promise<RecurringTemplate> =>
      ipcRenderer.invoke("instance.update_recurring_template_zone", args),
    instanceRescheduleChain: (args: InstanceIdArgs): Promise<Task[]> =>
      ipcRenderer.invoke("instance.instance_reschedule_chain", args),
  },
};

contextBridge.exposeInMainWorld("api", api);

/** 给 TypeScript 一个 window.api 的声明。 */
export type KewutongApi = typeof api;