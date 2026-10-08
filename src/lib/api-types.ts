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
  DeleteProjectArgs,
  DeleteSubTeamArgs,
  ListAssigneeCandidatesArgs,
  ListPeopleArgs,
  ListProjectCandidatesArgs,
  ListProjectsArgs,
  PersonnelMatrix,
  PersonnelMatrixArgs,
  Person,
  PersonIdArgs,
  PingReply,
  Project,
  ProjectCandidate,
  ReorderSubTeamsArgs,
  SubTeam,
  TrayStatusDto,
  UpdatePersonArgs,
  UpdateProjectArgs,
  UpdateSubTeamArgs,
} from "@/main/types";

import type {
  ClearHolidayOverrideArgs,
  HolidayCalendarArgs,
  HolidayCalendarDay,
  HolidayLoadResult,
  LoadHolidayCalendarArgs,
  SetHolidayOverrideArgs,
} from "@/main/holiday/index";

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
  HolidayCalendarArgs,
  HolidayCalendarDay,
  SetHolidayOverrideArgs,
  ClearHolidayOverrideArgs,
  LoadHolidayCalendarArgs,
  HolidayLoadResult,
};

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