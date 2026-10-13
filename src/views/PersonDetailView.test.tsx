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
import { PersonDetailView } from "./PersonDetailView";
import {
  getPersonDetail,
  listSubTeams,
  type PersonDetail,
  type SubTeam,
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

    render(
      <PersonDetailView
        personId={1}
        subTeams={[makeSubTeam(1, "一组")]}
        refreshToken={0}
      />,
    );

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

    render(
      <PersonDetailView
        personId={2}
        subTeams={[makeSubTeam(1, "一组")]}
        refreshToken={0}
      />,
    );

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

    render(
      <PersonDetailView
        personId={1}
        subTeams={[makeSubTeam(1, "一组")]}
        refreshToken={0}
      />,
    );

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

    render(
      <PersonDetailView
        personId={1}
        subTeams={[makeSubTeam(1, "一组")]}
        refreshToken={0}
      />,
    );

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

    render(
      <PersonDetailView
        personId={999}
        subTeams={[]}
        refreshToken={0}
      />,
    );

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

    render(
      <PersonDetailView
        personId={1}
        subTeams={[makeSubTeam(1, "一组")]}
        refreshToken={0}
      />,
    );

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

    const { rerender } = render(
      <PersonDetailView
        personId={1}
        subTeams={[makeSubTeam(1, "一组")]}
        refreshToken={0}
      />,
    );
    expect(await screen.findByText("张三")).toBeInTheDocument();
    expect(vi.mocked(getPersonDetail)).toHaveBeenCalledTimes(1);

    rerender(
      <PersonDetailView
        personId={1}
        subTeams={[makeSubTeam(1, "一组")]}
        refreshToken={1}
      />,
    );
    expect(await screen.findByText("李四")).toBeInTheDocument();
    expect(vi.mocked(getPersonDetail)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

interface TaskStubOverrides {
  id: number;
}

function taskStub(overrides: TaskStubOverrides): {
  id: number;
  title: string;
  description: null;
  status: "Open";
  ownerPersonId: number;
  projectId: null;
  dueDate: null;
  recurringTemplateId: null;
  scheduledAt: null;
  originalScheduledAt: null;
  rescheduledFromId: null;
  isRecurring: false;
  effectiveDate: null;
  createdAt: string;
  updatedAt: string;
  blockedAt: null;
  blockedReason: null;
  waitingOnPersonId: null;
} {
  return {
    id: overrides.id,
    title: "示例",
    description: null,
    status: "Open",
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
