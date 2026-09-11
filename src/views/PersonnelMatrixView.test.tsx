/**
 * 「人员矩阵」视图的组件级验证（ticket #22）。
 *
 * 验收点：
 * - 渲染分段瀑布流,每子组一段
 * - 每人卡片显示在飞数与阻塞数(命令层已算好,前端不二次聚合)
 * - 「点徽章 → 6 项菜单」改状态走同一手势,成功后乐观更新本地计数
 * - 默认不显示离岗人员;勾上"显示离岗"开关后出现
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonnelMatrixView } from "./PersonnelMatrixView";
import type {
  PersonnelMatrix,
  PersonnelMatrixSegment,
  Task,
} from "@/lib/ipc";
import {
  listPeople,
  listProjects,
  listSubTeams,
  personnelMatrix,
  setTaskStatus,
} from "@/lib/ipc";

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  listPeople: vi.fn(),
  listProjects: vi.fn(),
  listSubTeams: vi.fn(),
  personnelMatrix: vi.fn(),
  setTaskStatus: vi.fn(),
}));

const 张三的任务: Task = {
  id: 11,
  title: "整理季度报表",
  description: null,
  status: "Open",
  ownerPersonId: 7,
  projectId: null,
  dueDate: "2026-09-10",
  createdAt: "2026-09-01 09:00:00",
  updatedAt: "2026-09-01 09:00:00",
  blockedAt: null,
  blockedReason: null,
  waitingOnPersonId: null,
};

const 张三的另一条任务: Task = {
  id: 12,
  title: "等外委回函",
  description: null,
  status: "Blocked",
  ownerPersonId: 7,
  projectId: null,
  dueDate: "2026-09-11",
  createdAt: "2026-09-01 09:00:00",
  updatedAt: "2026-09-01 09:00:00",
  blockedAt: "2026-09-09 10:00:00",
  blockedReason: "卡审批",
  waitingOnPersonId: null,
};

const 王五的任务: Task = {
  id: 13,
  title: "巡检记录",
  description: null,
  status: "Open",
  ownerPersonId: 9,
  projectId: null,
  dueDate: "2026-09-10",
  createdAt: "2026-09-01 09:00:00",
  updatedAt: "2026-09-01 09:00:00",
  blockedAt: null,
  blockedReason: null,
  waitingOnPersonId: null,
};

const ROSTER = [
  {
    id: 7,
    name: "张三",
    subTeamId: 1,
    contact: "示例",
    deactivatedAt: null,
    createdAt: "2026-09-01 09:00:00",
  },
  {
    id: 8,
    name: "李四",
    subTeamId: 1,
    contact: "示例",
    deactivatedAt: null,
    createdAt: "2026-09-01 09:00:00",
  },
  {
    id: 9,
    name: "王五",
    subTeamId: 2,
    contact: "示例",
    deactivatedAt: null,
    createdAt: "2026-09-01 09:00:00",
  },
];

function makeSegment(teamId: number, teamName: string): PersonnelMatrixSegment {
  return {
    subTeam: {
      id: teamId,
      name: teamName,
      description: null,
      sortOrder: teamId - 1,
      createdAt: "2026-09-01 09:00:00",
    },
    people: [],
  };
}

beforeEach(() => {
  vi.mocked(listPeople).mockResolvedValue(ROSTER);
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(listSubTeams).mockResolvedValue([]);
  vi.mocked(setTaskStatus).mockImplementation(async (args) => ({
    ...张三的任务,
    id: args.taskId,
    status: args.status,
    blockedReason: args.blockedReason ?? null,
    waitingOnPersonId: args.waitingOnPersonId ?? null,
  }));
});

function matrixFor(_includeDeactivated: boolean): PersonnelMatrix {
  // 暖通:张三(2 在飞 / 1 阻塞)+ 李四(0 / 0);电气:王五(1 / 0)
  return {
    segments: [
      {
        ...makeSegment(1, "暖通"),
        people: [
          {
            person: ROSTER[0],
            inFlightCount: 2,
            blockedCount: 1,
            tasks: [张三的任务, 张三的另一条任务],
          },
          {
            person: ROSTER[1],
            inFlightCount: 0,
            blockedCount: 0,
            tasks: [],
          },
        ],
      },
      {
        ...makeSegment(2, "电气"),
        people: [
          {
            person: ROSTER[2],
            inFlightCount: 1,
            blockedCount: 0,
            tasks: [王五的任务],
          },
        ],
      },
    ],
  };
}

describe("PersonnelMatrixView", () => {
  it("渲染分段瀑布流:每子组一段、段内显示所有人员与两个计数", async () => {
    vi.mocked(personnelMatrix).mockResolvedValue(matrixFor(false));

    render(
      <PersonnelMatrixView refreshToken={0} onOpenTask={vi.fn()} />,
    );

    // 暖通段 + 电气段 + 段头
    expect(
      await screen.findByRole("heading", { name: "暖通" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "电气" }),
    ).toBeInTheDocument();
    // 每人名字
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("李四")).toBeInTheDocument();
    expect(screen.getByText("王五")).toBeInTheDocument();
    // 张三:在飞 2,阻塞 1
    const zhangCard = screen.getByText("张三").closest("article")!;
    expect(zhangCard).toHaveTextContent("2");
    expect(zhangCard).toHaveTextContent("1 阻塞");
    // 暖通段头:在办 2,阻塞 1
    const warmHeader = screen.getByRole("heading", { name: "暖通" })
      .parentElement!;
    expect(warmHeader).toHaveTextContent("在办 2");
    expect(warmHeader).toHaveTextContent("1 阻塞");
  });

  it("空数据时给出友好提示而不是空白", async () => {
    vi.mocked(personnelMatrix).mockResolvedValue({ segments: [] });

    render(
      <PersonnelMatrixView refreshToken={0} onOpenTask={vi.fn()} />,
    );

    expect(
      await screen.findByText(/还没有子组或人员/),
    ).toBeInTheDocument();
  });

  it("切到 Done / Cancelled 时任务从卡片列表移除并同步两个计数", async () => {
    // 第一次拉:张三两条任务。改完状态后命令层重拉:张三只剩一条(Blocked)。
    let currentMatrix = matrixFor(false);
    const updatedMatrix: PersonnelMatrix = {
      segments: [
        {
          ...makeSegment(1, "暖通"),
          people: [
            {
              person: ROSTER[0],
              inFlightCount: 1,
              blockedCount: 1,
              tasks: [张三的另一条任务],
            },
            {
              person: ROSTER[1],
              inFlightCount: 0,
              blockedCount: 0,
              tasks: [],
            },
          ],
        },
        {
          ...makeSegment(2, "电气"),
          people: [
            {
              person: ROSTER[2],
              inFlightCount: 1,
              blockedCount: 0,
              tasks: [王五的任务],
            },
          ],
        },
      ],
    };
    vi.mocked(personnelMatrix).mockImplementation(async () => {
      const m = currentMatrix;
      currentMatrix = updatedMatrix;
      return m;
    });

    const user = userEvent.setup();
    render(
      <PersonnelMatrixView
        refreshToken={0}
        onOpenTask={vi.fn()}
      />,
    );

    // 切"张三"的 Open 任务到 Done
    const openBadges = await screen.findAllByRole("button", {
      name: "状态：待开始，点击修改",
    });
    const cardBadge = openBadges.find(
      (b) => b.getAttribute("aria-haspopup") === "menu",
    );
    if (!cardBadge) throw new Error("找不到卡片徽章");
    await user.click(cardBadge);
    await user.click(screen.getByRole("menuitem", { name: /已完成/ }));

    // 命令层返回成功 → 本地 revision +1,下一次 matrix 拉到的已是更新后的视图。
    await waitFor(() => {
      const zhangCard = screen.getByText("张三").closest("article")!;
      // 计数变 1 (原 2 - 1 Done)
      expect(zhangCard.querySelector("span[title='在飞任务数']")).toHaveTextContent("1");
      // 阻塞数仍为 1(Blocked 那条还在)
      expect(zhangCard).toHaveTextContent("1 阻塞");
      // 标题列表里不再出现"整理季度报表"
      expect(zhangCard.textContent).not.toContain("整理季度报表");
    });
    // 段头"在办"也跟着减 1:2 → 1
    const warmHeader = screen.getByRole("heading", { name: "暖通" })
      .parentElement!;
    expect(warmHeader).toHaveTextContent("在办 1");
  });

  it("点任务上的徽章 → 6 项菜单 → 选进行中 → 触发 setTaskStatus 命令", async () => {
    // 改完状态后命令层重拉——但本次测试不关心重拉结果,只关心命令层被调用。
    vi.mocked(personnelMatrix).mockResolvedValue(matrixFor(false));

    const user = userEvent.setup();
    render(
      <PersonnelMatrixView refreshToken={0} onOpenTask={vi.fn()} />,
    );

    const openBadges = await screen.findAllByRole("button", {
      name: "状态：待开始，点击修改",
    });
    const cardBadge = openBadges.find(
      (b) => b.getAttribute("aria-haspopup") === "menu",
    );
    if (!cardBadge) throw new Error("找不到卡片徽章");
    await user.click(cardBadge);
    await user.click(screen.getByRole("menuitem", { name: /进行中/ }));

    await waitFor(() =>
      expect(setTaskStatus).toHaveBeenCalledWith({
        taskId: 11,
        status: "In-progress",
        blockedReason: null,
        waitingOnPersonId: null,
      }),
    );
    // 选中非 Blocked/Waiting-on 的状态时菜单自动关闭,不再有 menuitem
    await waitFor(() =>
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument(),
    );
  });

  it("点徽章改状态失败时回滚到改之前", async () => {
    vi.mocked(personnelMatrix).mockResolvedValue(matrixFor(false));
    vi.mocked(setTaskStatus).mockRejectedValueOnce({
      code: "INVALID_ARGUMENT",
      message: "阻塞原因不能为空,请填写卡在何处。",
      detail: null,
    });

    const user = userEvent.setup();
    render(
      <PersonnelMatrixView refreshToken={0} onOpenTask={vi.fn()} />,
    );

    const openBadges = await screen.findAllByRole("button", {
      name: "状态：待开始，点击修改",
    });
    const cardBadge = openBadges.find(
      (b) => b.getAttribute("aria-haspopup") === "menu",
    );
    if (!cardBadge) throw new Error("找不到卡片徽章");
    await user.click(cardBadge);
    await user.click(screen.getByRole("menuitem", { name: /已阻塞/ }));

    await user.type(
      await screen.findByPlaceholderText("写一句原因"),
      "等外委回函",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));

    // 命令层拒绝 → 徽章回退到原始状态"待开始"
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("阻塞原因不能为空");
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", {
          name: "状态：待开始，点击修改",
        }),
      ).toHaveLength(2),
    );
  });

  it("默认不显示离岗人员,勾选后才出现", async () => {
    vi.mocked(personnelMatrix).mockImplementation(async (args) => {
      // 模拟后端过滤:include_deactivated = false 时离岗人员不出现在段内
      if (!args.includeDeactivated) return matrixFor(false);
      const matrix = matrixFor(true);
      // 多挂一位离岗的"赵六"
      matrix.segments[0].people.push({
        person: {
          id: 10,
          name: "赵六",
          subTeamId: 1,
          contact: "示例",
          deactivatedAt: "2026-08-01 09:00:00",
          createdAt: "2026-07-01 09:00:00",
        },
        inFlightCount: 0,
        blockedCount: 0,
        tasks: [],
      });
      return matrix;
    });

    const user = userEvent.setup();
    render(
      <PersonnelMatrixView refreshToken={0} onOpenTask={vi.fn()} />,
    );

    // 初次渲染:没有赵六
    await screen.findByText("张三");
    expect(screen.queryByText("赵六")).not.toBeInTheDocument();

    // 勾上"显示离岗"
    const toggle = screen.getByRole("checkbox", {
      name: "显示离岗人员",
    });
    await user.click(toggle);

    expect(await screen.findByText("赵六")).toBeInTheDocument();
  });
});
