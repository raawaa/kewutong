/**
 * 前端访问 Rust 命令层的唯一入口。
 *
 * 约定：前端不含业务逻辑，只调命令、显示 DTO。每个命令在这里包一层带类型的函数，
 * 组件不直接写 `invoke`。
 */
import { invoke } from "@tauri-apps/api/core";

/** 与 Rust 端 `AppError` 的序列化形状一一对应。 */
export type AppError = {
  /** 机器可读的错误码，如 `INVALID_ARGUMENT`。 */
  code: string;
  /** 可直接展示给科长的中文消息。 */
  message: string;
  /** 给维护者排查用的技术细节，可能为空。 */
  detail: string | null;
};

export type PingReply = {
  message: string;
  now: string;
  schemaVersion: number | null;
  echo: string | null;
};

/** 探活：确认命令层、数据库、时钟都接好了。 */
export function ping(echo?: string): Promise<PingReply> {
  return invoke<PingReply>("ping", { echo });
}

// ---------------------------------------------------------------------------
// 人员管理（ticket #17）
// ---------------------------------------------------------------------------

/** 子组 DTO（与 Rust `commands::personnel::SubTeam` 一一对应）。 */
export type SubTeam = {
  id: number;
  name: string;
  description: string | null;
  sortOrder: number;
  createdAt: string;
};

/** 人员 DTO。`deactivatedAt` 为空即在岗。 */
export type Person = {
  id: number;
  name: string;
  subTeamId: number;
  contact: string;
  deactivatedAt: string | null;
  createdAt: string;
};

/** `listPeople` 的入参：可选按子组过滤，可选是否隐藏离岗人员。 */
export type ListPeopleArgs = {
  includeDeactivated: boolean;
  subTeamId?: number | null;
};

/** 新增子组的入参。 */
export type CreateSubTeamArgs = {
  name: string;
  description?: string | null;
};

/** 编辑子组的入参。 */
export type UpdateSubTeamArgs = {
  id: number;
  name: string;
  description?: string | null;
};

/** 删除子组的入参。 */
export type DeleteSubTeamArgs = { id: number };

/** 重排子组的入参：`orderedIds` 即新顺序下的 id 列表。 */
export type ReorderSubTeamsArgs = { orderedIds: number[] };

/** 新增人员的入参。 */
export type CreatePersonArgs = {
  name: string;
  subTeamId: number;
  contact: string;
};

/** 编辑人员（含调岗）的入参。 */
export type UpdatePersonArgs = {
  id: number;
  name: string;
  subTeamId: number;
  contact: string;
};

/** 用 id 寻址单条人员的命令入参。 */
export type PersonIdArgs = { id: number };

// —— 子组命令 ——

export function listSubTeams(): Promise<SubTeam[]> {
  return invoke<SubTeam[]>("list_sub_teams");
}

export function createSubTeam(args: CreateSubTeamArgs): Promise<SubTeam> {
  return invoke<SubTeam>("create_sub_team", { args });
}

export function updateSubTeam(args: UpdateSubTeamArgs): Promise<SubTeam> {
  return invoke<SubTeam>("update_sub_team", { args });
}

export function deleteSubTeam(args: DeleteSubTeamArgs): Promise<void> {
  return invoke<void>("delete_sub_team", { args });
}

export function reorderSubTeams(args: ReorderSubTeamsArgs): Promise<void> {
  return invoke<void>("reorder_sub_teams", { args });
}

// —— 人员命令 ——

export function listPeople(args: ListPeopleArgs): Promise<Person[]> {
  return invoke<Person[]>("list_people", { args });
}

export function createPerson(args: CreatePersonArgs): Promise<Person> {
  return invoke<Person>("create_person", { args });
}

export function updatePerson(args: UpdatePersonArgs): Promise<Person> {
  return invoke<Person>("update_person", { args });
}

export function deactivatePerson(args: PersonIdArgs): Promise<Person> {
  return invoke<Person>("deactivate_person", { args });
}

export function reactivatePerson(args: PersonIdArgs): Promise<Person> {
  return invoke<Person>("reactivate_person", { args });
}

export function deletePerson(args: PersonIdArgs): Promise<void> {
  return invoke<void>("delete_person", { args });
}

// ---------------------------------------------------------------------------
// 任务（tickets #18 / #19）
// ---------------------------------------------------------------------------

/** 任务的 6 个状态。状态变更的唯一入口是 `set_task_status`，不在本票范围。 */
export type TaskStatus =
  | "Open"
  | "In-progress"
  | "Blocked"
  | "Waiting-on"
  | "Done"
  | "Cancelled";

/** 任务 DTO（与 Rust `commands::task::Task` 一一对应）。 */
export type Task = {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  ownerPersonId: number;
  projectId: number | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  blockedAt: string | null;
  blockedReason: string | null;
  waitingOnPersonId: number | null;
};

/** 截止 chip 行的一格。`none` 那格的 `dueDate` 是 `null`。 */
export type DueDateChip = "today" | "tomorrow" | "next-week" | "none";

/**
 * 截止 chip 连同它此刻代表的日期。
 *
 * `label` 与 `dueDate` 都由命令层给出——「今天」是哪一天由 Rust 的可注入
 * 时钟说了算，前端不自己算日期。
 */
export type DueDateOption = {
  chip: DueDateChip;
  label: string;
  dueDate: string | null;
};

/** `@` 下拉里的一条候选。 */
export type AssigneeCandidate = {
  personId: number;
  name: string;
  subTeamName: string;
};

/** `listAssigneeCandidates` 的入参：`query` 是 `@` 后面已经打出的部分。 */
export type ListAssigneeCandidatesArgs = { query?: string | null };

/** 新建任务的入参。 */
export type CreateTaskArgs = {
  title: string;
  description?: string | null;
  ownerPersonId: number;
  projectId?: number | null;
  dueDate?: string | null;
};

/** 编辑态保存的入参。字段集与新建一致，不含 status。 */
export type UpdateTaskArgs = CreateTaskArgs & { id: number };

/** `listTasks` 的入参。 */
export type ListTasksArgs = {
  includeCancelled: boolean;
  ownerPersonId?: number | null;
  projectId?: number | null;
};

export function listTasks(args: ListTasksArgs): Promise<Task[]> {
  return invoke<Task[]>("list_tasks", { args });
}

export function createTask(args: CreateTaskArgs): Promise<Task> {
  return invoke<Task>("create_task", { args });
}

export function updateTask(args: UpdateTaskArgs): Promise<Task> {
  return invoke<Task>("update_task", { args });
}

/** 状态变更入参（拖拽改状态、徽章菜单改状态都走这里——全 app 唯一入口）。 */
export type SetTaskStatusArgs = {
  taskId: number;
  status: TaskStatus;
  blockedReason?: string | null;
  waitingOnPersonId?: number | null;
};

export function setTaskStatus(args: SetTaskStatusArgs): Promise<Task> {
  return invoke<Task>("set_task_status", { args });
}

/** 截止 chip 行此刻的取值——今天 / 明天 / 一周后 / 无。 */
export function listDueDateOptions(): Promise<DueDateOption[]> {
  return invoke<DueDateOption[]>("list_due_date_options");
}

// ---------------------------------------------------------------------------
// 今日 / 本周视图（ticket #21）
// ---------------------------------------------------------------------------

/** 「今日 / 本周」计数瓦片（数字由命令层算出，全局范围）。 */
export type TodayWeekCounts = {
  /** 在岗人数：`person.deactivated_at IS NULL` 的行数。 */
  activePeople: number;
  /** 全局进行中任务数（不限截止日）。 */
  inProgress: number;
  /** 全局阻塞中等任务数（Blocked + Waiting-on，不限截止日）。 */
  blocked: number;
};

/** 四列时间轴各自桶里的任务。 */
export type TodayWeekBuckets = {
  /** 已逾期：`due_date < today` 的在飞任务。 */
  overdue: Task[];
  /** 今天：`due_date == today` 的在飞任务。 */
  today: Task[];
  /** 明天：`due_date == today + 1` 的在飞任务。 */
  tomorrow: Task[];
  /** 本周剩余：`today + 2 <= due_date <= 本周日` 的在飞任务。 */
  thisWeekRest: Task[];
};

/** 「今日 / 本周」视图的 DTO。 */
export type TodayWeek = {
  counts: TodayWeekCounts;
  buckets: TodayWeekBuckets;
};

export function todayWeek(): Promise<TodayWeek> {
  return invoke<TodayWeek>("today_week");
}

/** `@` 内联选人的候选：已按输入过滤、已排除离岗人员、已封顶条数。 */
export function listAssigneeCandidates(
  args: ListAssigneeCandidatesArgs,
): Promise<AssigneeCandidate[]> {
  return invoke<AssigneeCandidate[]>("list_assignee_candidates", { args });
}

// ---------------------------------------------------------------------------
// 项目（ticket #20）
// ---------------------------------------------------------------------------

/** 项目状态——视图层由 task.status 聚合派生，不入库。 */
export type ProjectStatus = "Active" | "Done" | "Cancelled";

/** 项目 DTO（与 Rust `commands::project::Project` 一一对应）。 */
export type Project = {
  id: number;
  name: string;
  ownerPersonId: number;
  subTeamId: number;
  startDate: string | null;
  dueDate: string | null;
  notes: string | null;
  createdAt: string;
  status: ProjectStatus;
};

/** `#` 下拉里的一条候选。 */
export type ProjectCandidate = {
  projectId: number;
  name: string;
  subTeamName: string;
};

/** `listProjectCandidates` 的入参：`query` 是 `#` 后面已经打出的部分。 */
export type ListProjectCandidatesArgs = { query?: string | null };

/** `listProjects` 的入参。 */
export type ListProjectsArgs = {
  /** `true` = 含 Done / Cancelled 的项目；`false`（默认）= 只看在飞。 */
  includeDone: boolean;
};

/** 新建项目的入参。 */
export type CreateProjectArgs = {
  name: string;
  ownerPersonId: number;
  subTeamId: number;
  startDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
};

/** 编辑项目的入参。 */
export type UpdateProjectArgs = CreateProjectArgs & { id: number };

/** 删除项目的入参。 */
export type DeleteProjectArgs = { id: number };

export function listProjects(args: ListProjectsArgs): Promise<Project[]> {
  return invoke<Project[]>("list_projects", { args });
}

export function createProject(args: CreateProjectArgs): Promise<Project> {
  return invoke<Project>("create_project", { args });
}

export function updateProject(args: UpdateProjectArgs): Promise<Project> {
  return invoke<Project>("update_project", { args });
}

export function deleteProject(args: DeleteProjectArgs): Promise<void> {
  return invoke<void>("delete_project", { args });
}

/** `#` 内联选项目的候选：已排除 Done / Cancelled、已按 query 过滤、已封顶。 */
export function listProjectCandidates(
  args: ListProjectCandidatesArgs,
): Promise<ProjectCandidate[]> {
  return invoke<ProjectCandidate[]>("list_project_candidates", { args });
}

/** 命令抛出来的一律是 `AppError` 形状；非预期异常也收敛成同一形状。 */
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