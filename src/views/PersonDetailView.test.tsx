/**
 * 「人员详情」视图的组件级验证（ticket #81 T1）。
 *
 * T1 本期只覆盖 header 段：
 * - 姓名 / 子组徽章 / 联系方式 / 录入时间 / 离岗时间（如有）
 * - 在飞任务数 / 阻塞任务数
 *
 * 后续 T2~T5 ticket 落实 5 段后,本文件再扩段。命令层 5 段聚合已在
 * `src/main/personnel/personnel.test.ts` 覆盖——本视图只测「拿到
 * PersonDetail DTO 后,前端怎么展示」。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonDetailView } from "./PersonDetailView";
import {
  getPersonDetail,
  listSubTeams,
  type Person,
  type PersonDetail,
  type SubTeam,
  type Task,
} from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getPersonDetail: vi.fn(),
  listSubTeams: vi.fn(),
}));

function makeSubTeam(id: number, name: string): SubTeam {
  return {
    id,
    name,
    description: null,
    sortOrder: id - 1,
    createdAt: "2026-09-01 09:00:00",
  };
}

function makeDetail(overrides: Partial<PersonDetail> = {}): PersonDetail {
  return {
    person: {
      id: 1,
      name: "张三",
      subTeamId: 1,
      contact: "13800000000",
      deactivatedAt: null,
      createdAt: "2026-09-01 09:00:00",
    },
    inFlight: {
      open: [],
      inProgress: [],
      blocked: [],
      waitingOn: [],
      done: [],
      cancelled: [],
    },
    ownedProjects: [],
    waitingOnTasks: [],
    subTeamTemplates: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getPersonDetail).mockReset();
  vi.mocked(listSubTeams).mockReset();
  // 默认 catalog 里已有张三所在的子组,不走 fallback IPC。
  vi.mocked(listSubTeams).mockResolvedValue([makeSubTeam(1, "一组")]);
});

describe("PersonDetailView · header（T1）", () => {
  it("渲染姓名 + 子组徽章 + 联系方式 + 录入时间 + 在飞 / 阻塞数", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        // 2 Open + 1 In-progress + 1 Blocked + 1 Waiting-on = 在飞 5,阻塞 2
        inFlight: {
          open: [taskStub({ id: 1 }), taskStub({ id: 2 })],
          inProgress: [taskStub({ id: 3 })],
          blocked: [taskStub({ id: 4 })],
          waitingOn: [taskStub({ id: 5 })],
          done: [],
          cancelled: [],
        },
      }),
    );

    render(<DetailHarness />);

    expect(await screen.findByText("张三")).toBeInTheDocument();
    expect(screen.getByText("一组")).toBeInTheDocument();
    expect(screen.getByText("13800000000")).toBeInTheDocument();
    expect(screen.getByText("2026-09-01 09:00:00")).toBeInTheDocument();
    // 在飞 5 (Open 2 + In-progress 1 + Blocked 1 + Waiting-on 1)
    expect(screen.getByTitle(/在飞任务数/)).toHaveTextContent("在飞 5");
    // 阻塞 2 (Blocked 1 + Waiting-on 1)
    expect(screen.getByTitle(/阻塞任务数/)).toHaveTextContent("阻塞 2");
  });

  it("离岗人员展示「离岗 · <deactivated_at>」徽章", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        person: {
          id: 2,
          name: "李四",
          subTeamId: 1,
          contact: "111",
          deactivatedAt: "2026-08-01 09:00:00",
          createdAt: "2026-07-01 09:00:00",
        },
      }),
    );

    render(<DetailHarness />);

    expect(await screen.findByText("李四")).toBeInTheDocument();
    // 离岗徽章 + 离岗时间字段同时渲染
    expect(screen.getByText(/离岗 · 2026-08-01 09:00:00/)).toBeInTheDocument();
    expect(screen.getByText("2026-08-01 09:00:00")).toBeInTheDocument();
  });

  it("catalog 缺子组时兜底拉一次 listSubTeams,渲染真实子组名", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        person: {
          id: 1,
          name: "张三",
          subTeamId: 99, // 不在父层 catalog 里
          contact: "123",
          deactivatedAt: null,
          createdAt: "2026-09-01 09:00:00",
        },
      }),
    );
    vi.mocked(listSubTeams).mockResolvedValue([makeTeamAt(99, "新组")]);

    render(<DetailHarness />);

    expect(await screen.findByText("张三")).toBeInTheDocument();
    await waitFor(() => expect(listSubTeams).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("新组")).toBeInTheDocument();
  });

  it("catalog 缺子组且 listSubTeams 失败时回退到「未知子组 (id=...)」", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        person: {
          id: 1,
          name: "张三",
          subTeamId: 99,
          contact: "123",
          deactivatedAt: null,
          createdAt: "2026-09-01 09:00:00",
        },
      }),
    );
    vi.mocked(listSubTeams).mockRejectedValue(new Error("ipc 断了"));

    render(<DetailHarness />);

    expect(await screen.findByText("张三")).toBeInTheDocument();
    await waitFor(() => expect(listSubTeams).toHaveBeenCalledTimes(1));
    expect(screen.getByText("未知子组 (id=99)")).toBeInTheDocument();
  });

  it("命令层抛 AppError.invalid 时显示中文错误而非崩", async () => {
    vi.mocked(getPersonDetail).mockRejectedValue({
      code: "INVALID_ARGUMENT",
      message: "人员不存在或已被删除。",
      detail: null,
    });

    render(<DetailHarness />);

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("人员不存在或已被删除。");
  });

  it("阻塞数为 0 时不渲染橙色（与默认色一致）", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        inFlight: {
          open: [taskStub({ id: 1 })],
          inProgress: [],
          blocked: [],
          waitingOn: [],
          done: [],
          cancelled: [],
        },
      }),
    );

    render(<DetailHarness />);

    await screen.findByText("张三");
    const blockedBadge = screen.getByTitle(/阻塞任务数/);
    expect(blockedBadge).toHaveTextContent("阻塞 0");
    // 阻塞数为 0 时不走 orange-600 className
    expect(blockedBadge.className).not.toMatch(/text-orange-600/);
  });

  it("refreshToken 变化触发重拉", async () => {
    let count = 0;
    vi.mocked(getPersonDetail).mockImplementation(async () => {
      count += 1;
      return makeDetail({
        person: {
          id: 1,
          name: count === 1 ? "张三" : "李四",
          subTeamId: 1,
          contact: "123",
          deactivatedAt: null,
          createdAt: "2026-09-01 09:00:00",
        },
      });
    });

    const { rerender } = render(<DetailHarness refreshToken={0} />);
    expect(await screen.findByText("张三")).toBeInTheDocument();
    expect(vi.mocked(getPersonDetail)).toHaveBeenCalledTimes(1);

    rerender(<DetailHarness refreshToken={1} />);
    expect(await screen.findByText("李四")).toBeInTheDocument();
    expect(vi.mocked(getPersonDetail)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 在飞任务段（#82 T2）
//
// T2 渲染段 2 的「在飞任务按 6 状态分组」视图：
// - 6 状态各一段,段头显示状态名 + 计数 + 颜色
// - 每段默认 5 条 + 「展开全部」
// - 段内空数据时显示空态文案
// - 任务条目点击 → 调 onOpenTask
// - 段头 + 按钮 → 调 onCreateTask（预填负责人为本人员）
// 段内排序在命令层（`bucketByStatus`）已一次性给齐,本视图不做二次排。
// ---------------------------------------------------------------------------

describe("PersonDetailView · 在飞任务段（T2）", () => {
  it("渲染 6 状态段头（状态名 + 计数）", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        inFlight: {
          open: [taskStub({ id: 1 }), taskStub({ id: 2 })],
          inProgress: [taskStub({ id: 3, status: "In-progress" })],
          blocked: [taskStub({ id: 4, status: "Blocked" })],
          waitingOn: [taskStub({ id: 5, status: "Waiting-on" })],
          done: [taskStub({ id: 6, status: "Done" })],
          cancelled: [taskStub({ id: 7, status: "Cancelled" })],
        },
      }),
    );

    render(<DetailHarness />);

    // 6 段的状态名（来自 STATUS_STYLE）
    expect(await screen.findByText("待开始")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(screen.getByText("已阻塞")).toBeInTheDocument();
    expect(screen.getByText("等待中")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
  });

  it("每段默认展示 5 条,溢出时显示「展开全部」", async () => {
    // 给 Open 段塞 7 条,验证默认只展示前 5 条 + 出现「展开全部」
    const sevenOpen = Array.from({ length: 7 }, (_, i) =>
      taskStub({ id: 100 + i, title: `Open 任务 ${i + 1}` }),
    );
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        inFlight: {
          open: sevenOpen,
          inProgress: [],
          blocked: [],
          waitingOn: [],
          done: [],
          cancelled: [],
        },
      }),
    );

    render(<DetailHarness />);

    // 默认看到前 5 条
    expect(await screen.findByText("Open 任务 1")).toBeInTheDocument();
    expect(screen.getByText("Open 任务 5")).toBeInTheDocument();
    // 后 2 条还没显示
    expect(screen.queryByText("Open 任务 6")).not.toBeInTheDocument();
    expect(screen.queryByText("Open 任务 7")).not.toBeInTheDocument();
    // 「展开全部」按钮出现
    expect(screen.getByRole("button", { name: /展开全部/ })).toBeInTheDocument();
  });

  it("点「展开全部」显示完整列表", async () => {
    const sevenOpen = Array.from({ length: 7 }, (_, i) =>
      taskStub({ id: 100 + i, title: `Open 任务 ${i + 1}` }),
    );
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        inFlight: {
          open: sevenOpen,
          inProgress: [],
          blocked: [],
          waitingOn: [],
          done: [],
          cancelled: [],
        },
      }),
    );

    const user = userEvent.setup();
    render(<DetailHarness />);

    await user.click(await screen.findByRole("button", { name: /展开全部/ }));

    expect(screen.getByText("Open 任务 1")).toBeInTheDocument();
    expect(screen.getByText("Open 任务 6")).toBeInTheDocument();
    expect(screen.getByText("Open 任务 7")).toBeInTheDocument();
  });

  it("点任务条目 → 调 onOpenTask 并带上本人员作为 assignee", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        inFlight: {
          open: [taskStub({ id: 1, title: "整理报表" })],
          inProgress: [],
          blocked: [],
          waitingOn: [],
          done: [],
          cancelled: [],
        },
      }),
    );

    const user = userEvent.setup();
    const onOpenTask = vi.fn();
    render(<DetailHarness onOpenTask={onOpenTask} />);

    await user.click(await screen.findByText("整理报表"));

    expect(onOpenTask).toHaveBeenCalledTimes(1);
    const [task, extras] = vi.mocked(onOpenTask).mock.calls[0]!;
    expect(task.id).toBe(1);
    expect(extras?.assignee?.personId).toBe(1);
    expect(extras?.assignee?.name).toBe("张三");
    expect(extras?.assignee?.subTeamName).toBe("一组");
  });

  it("段内空数据时显示空态文案 + 跳转新建按钮", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        inFlight: {
          open: [],
          inProgress: [],
          blocked: [],
          waitingOn: [],
          done: [],
          cancelled: [],
        },
      }),
    );

    render(<DetailHarness />);

    // 6 段全部空 → 6 段都展示空态
    const empty = await screen.findAllByText(/手上没有/);
    expect(empty.length).toBe(6);
  });

  it("段头 + 按钮 → 调 onCreateTask 并带上当前人员", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        inFlight: {
          open: [],
          inProgress: [],
          blocked: [],
          waitingOn: [],
          done: [],
          cancelled: [],
        },
      }),
    );

    const user = userEvent.setup();
    const onCreateTask = vi.fn();
    render(<DetailHarness onCreateTask={onCreateTask} />);

    // 段头 + 按钮的 `aria-label` 是「新建任务给 TA · {状态名}」,用
    // 这个完整模式筛 header 按钮；空态按钮的「→ 新建任务给 TA」是文本
    // 内容,匹配不到,自然排除。
    const plusButtons = await screen.findAllByRole("button", {
      name: /新建任务给 TA ·/,
    });
    expect(plusButtons.length).toBe(6); // 每个段一个
    await user.click(plusButtons[0]!);

    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onCreateTask).mock.calls[0]?.[0]?.id).toBe(1);
    expect(vi.mocked(onCreateTask).mock.calls[0]?.[0]?.name).toBe("张三");
  });
});

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

interface TaskStubOverrides {
  id: number;
  title?: string;
  status?: Task["status"];
}

function taskStub(overrides: TaskStubOverrides): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? "示例",
    description: null,
    status: overrides.status ?? "Open",
    ownerPersonId: 1,
    projectId: null,
    dueDate: null,
    recurringTemplateId: null,
    scheduledAt: null,
    originalScheduledAt: null,
    rescheduledFromId: null,
    isRecurring: false,
    effectiveDate: null,
    createdAt: "2026-09-01 09:00:00",
    updatedAt: "2026-09-01 09:00:00",
    blockedAt: null,
    blockedReason: null,
    waitingOnPersonId: null,
  };
}

function makeTeamAt(id: number, name: string): SubTeam {
  return makeSubTeam(id, name);
}

/**
 * T1 + T2 测试用统一壳——包一层 PersonDetailView,把 mock 化的两个回
 * 调 + 子组 catalog + 默认 refreshToken 收口在一处,各 case 只覆盖差
 * 异。`refreshToken` 默认 0;需要变更的 case（如 #81 的重拉测试）显
 * 式传入。
 */
function DetailHarness({
  onOpenTask,
  onCreateTask,
  refreshToken = 0,
}: {
  onOpenTask?: (
    task: Task,
    extras: { assignee: { personId: number; name: string; subTeamName: string } },
  ) => void;
  onCreateTask?: (person: Person) => void;
  refreshToken?: number;
}) {
  return (
    <PersonDetailView
      personId={1}
      subTeams={[makeSubTeam(1, "一组")]}
      refreshToken={refreshToken}
      onOpenTask={onOpenTask ?? vi.fn()}
      onCreateTask={onCreateTask ?? vi.fn()}
    />
  );
}
