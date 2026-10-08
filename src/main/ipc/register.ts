/**
 * 主进程 IPC 注册中心（ADR 0008 §主进程注册）。
 *
 * 每个 domain 一个 registerXxx 模块，channel 名与命令名一一对应
 * （如 `personnel.list_sub_teams`）。错误统一收敛成 AppError
 * 形状（`{ code, message, detail }`）抛给 renderer。
 */

import { app, ipcMain } from "electron";
import type { IpcMain } from "electron";
import * as path from "node:path";
import { AppError } from "../error.js";
import { schemaVersion } from "../db.js";
import type { AppState } from "../state.js";
import * as Personnel from "../personnel/index.js";
import * as Project from "../project/index.js";
import * as Export from "../export/index.js";

/**
 * 把命令函数包装成 ipcMain.handle 的 handler。
 */
export function handle<TArgs, TReturn>(
  channel: string,
  command: (state: AppState, args: TArgs) => TReturn | Promise<TReturn>,
): (ipc: IpcMain, state: AppState) => void {
  return (ipc, state) => {
    ipc.handle(channel, async (_event, args: TArgs) => {
      try {
        return await command(state, args);
      } catch (cause) {
        if (cause instanceof AppError) {
          throw cause.toPayload();
        }
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw AppError.internal(detail).toPayload();
      }
    });
  };
}

/** 一个无入参命令。 */
export function handleVoid<TReturn>(
  channel: string,
  command: (state: AppState) => TReturn | Promise<TReturn>,
): (ipc: IpcMain, state: AppState) => void {
  return handle<undefined, TReturn>(channel, async (state, _args) => command(state));
}

/** 注册所有 IPC 处理器——每个 domain 在这里串起来。 */
export function registerAllIpc(state: AppState): void {
  registerDiagnostics(state);
  registerPersonnel(state);
  registerProject(state);
  registerExport(state);
}

/** M1 探活 / 数据文件位置 / 托盘状态。 */
function registerDiagnostics(state: AppState): void {
  handle<string | null | undefined, import("../types.js").PingReply>(
    "ping",
    async (_state, echo) => {
      if (echo !== undefined && echo !== null && echo.trim().length === 0) {
        throw AppError.invalid("回声内容不能为空。");
      }
      return {
        message: "pong",
        now: state.clock.nowSql(),
        schemaVersion: schemaVersion(state.db),
        echo: echo ?? null,
      };
    },
  )(ipcMain, state);

  handleVoid<string | null>("dataFileLocation", (s) => s.dbPath)(ipcMain, state);

  handleVoid<import("../types.js").TrayStatusDto>("trayStatus", (s) => {
    const status = s.trayStatus;
    return status.kind === "available"
      ? { available: true, reason: "" }
      : { available: false, reason: status.reason };
  })(ipcMain, state);
}

/** Personnel domain（tickets #17 / #19 / #22）。 */
function registerPersonnel(state: AppState): void {
  handleVoid<import("../types.js").SubTeam[]>("personnel.list_sub_teams", (s) =>
    Personnel.listSubTeams(s),
  )(ipcMain, state);

  handle<import("../types.js").CreateSubTeamArgs, import("../types.js").SubTeam>(
    "personnel.create_sub_team",
    (s, args) => Personnel.createSubTeam(s, args),
  )(ipcMain, state);

  handle<import("../types.js").UpdateSubTeamArgs, import("../types.js").SubTeam>(
    "personnel.update_sub_team",
    (s, args) => Personnel.updateSubTeam(s, args),
  )(ipcMain, state);

  handle<import("../types.js").DeleteSubTeamArgs, void>(
    "personnel.delete_sub_team",
    (s, args) => Personnel.deleteSubTeam(s, args),
  )(ipcMain, state);

  handle<import("../types.js").ReorderSubTeamsArgs, void>(
    "personnel.reorder_sub_teams",
    (s, args) => Personnel.reorderSubTeams(s, args),
  )(ipcMain, state);

  handle<import("../types.js").ListPeopleArgs, import("../types.js").Person[]>(
    "personnel.list_people",
    (s, args) => Personnel.listPeople(s, args),
  )(ipcMain, state);

  handle<import("../types.js").CreatePersonArgs, import("../types.js").Person>(
    "personnel.create_person",
    (s, args) => Personnel.createPerson(s, args),
  )(ipcMain, state);

  handle<import("../types.js").UpdatePersonArgs, import("../types.js").Person>(
    "personnel.update_person",
    (s, args) => Personnel.updatePerson(s, args),
  )(ipcMain, state);

  handle<import("../types.js").PersonIdArgs, import("../types.js").Person>(
    "personnel.deactivate_person",
    (s, args) => Personnel.deactivatePerson(s, args),
  )(ipcMain, state);

  handle<import("../types.js").PersonIdArgs, import("../types.js").Person>(
    "personnel.reactivate_person",
    (s, args) => Personnel.reactivatePerson(s, args),
  )(ipcMain, state);

  handle<import("../types.js").PersonIdArgs, void>(
    "personnel.delete_person",
    (s, args) => Personnel.deletePerson(s, args),
  )(ipcMain, state);

  handle<
    import("../types.js").ListAssigneeCandidatesArgs,
    import("../types.js").AssigneeCandidate[]
  >("personnel.list_assignee_candidates", (s, args) =>
    Personnel.listAssigneeCandidates(s, args),
  )(ipcMain, state);

  handle<import("../types.js").PersonnelMatrixArgs, import("../types.js").PersonnelMatrix>(
    "personnel.personnel_matrix",
    (s, args) => Personnel.personnelMatrix(s, args),
  )(ipcMain, state);
}

/** Project domain（ticket #20）。 */
function registerProject(state: AppState): void {
  handle<import("../types.js").ListProjectsArgs, import("../types.js").Project[]>(
    "project.list_projects",
    (s, args) => Project.listProjects(s, args),
  )(ipcMain, state);

  handle<
    import("../types.js").ListProjectCandidatesArgs,
    import("../types.js").ProjectCandidate[]
  >("project.list_project_candidates", (s, args) =>
    Project.listProjectCandidates(s, args),
  )(ipcMain, state);

  handle<import("../types.js").CreateProjectArgs, import("../types.js").Project>(
    "project.create_project",
    (s, args) => Project.createProject(s, args),
  )(ipcMain, state);

  handle<import("../types.js").UpdateProjectArgs, import("../types.js").Project>(
    "project.update_project",
    (s, args) => Project.updateProject(s, args),
  )(ipcMain, state);

  handle<import("../types.js").DeleteProjectArgs, void>(
    "project.delete_project",
    (s, args) => Project.deleteProject(s, args),
  )(ipcMain, state);
}

/** Export domain（ticket #53）。 */
function registerExport(state: AppState): void {
  handleVoid<import("../types.js").DatabaseExport>(
    "export.export_database_json",
    (s) => Export.exportDatabaseJson(s),
  )(ipcMain, state);

  handle<Export.ImportDatabaseJsonArgs, import("../types.js").DatabaseImportSummary>(
    "export.import_database_json",
    (s, args) => Export.importDatabaseJson(s, args),
  )(ipcMain, state);

  handleVoid<import("../types.js").TasksCsvExport>(
    "export.export_tasks_csv",
    (s) => Export.exportTasksCsv(s),
  )(ipcMain, state);
}

/** dev 模式下解析 migrations 目录位置。 */
export function resolveMigrationsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "migrations");
  }
  return path.join(app.getAppPath(), "src/main/migrations");
}

/** dev 模式下解析 holidays 目录。 */
export function resolveHolidaysDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "holidays");
  }
  return path.join(app.getAppPath(), "holidays");
}