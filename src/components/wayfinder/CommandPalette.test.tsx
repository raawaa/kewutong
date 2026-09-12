import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette";
import {
  wayfinderSearch,
  type WayfinderPersonHit,
  type WayfinderProjectHit,
  type Task,
  type Person,
  type SubTeam,
  type Project,
} from "@/lib/ipc";

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  wayfinderSearch: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(wayfinderSearch).mockReset();
  // jsdom 不实现 scrollIntoView——挂 no-op 兜底,避免键盘导航的 effect 抛错。
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

const EMPTY_CATALOG = { people: [], subTeams: [], projects: [] };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "外委合同评审",
    description: null,
    status: "Open",
    ownerPersonId: 10,
    projectId: null,
    dueDate: "2026-09-15",
    recurringTemplateId: null,
    scheduledAt: null,
    originalScheduledAt: null,
    rescheduledFromId: null,
    isRecurring: false,
    effectiveDate: "2026-09-15",
    createdAt: "2026-09-10 09:00:00",
    updatedAt: "2026-09-10 09:00:00",
    blockedAt: null,
    blockedReason: null,
    waitingOnPersonId: null,
    ...overrides,
  };
}

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 10,
    name: "暖通甲",
    subTeamId: 1,
    contact: "示例",
    deactivatedAt: null,
    createdAt: "2026-09-10 09:00:00",
    ...overrides,
  };
}

function makeSubTeam(overrides: Partial<SubTeam> = {}): SubTeam {
  return {
    id: 1,
    name: "暖通",
    description: null,
    sortOrder: 0,
    createdAt: "2026-09-10 09:00:00",
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 100,
    name: "综合楼改造",
    ownerPersonId: 10,
    subTeamId: 1,
    startDate: null,
    dueDate: null,
    notes: null,
    createdAt: "2026-09-10 09:00:00",
    status: "Active",
    ...overrides,
  };
}

function makePersonHit(overrides: Partial<WayfinderPersonHit> = {}): WayfinderPersonHit {
  return {
    personId: 10,
    name: "暖通甲",
    subTeamId: 1,
    subTeamName: "暖通",
    matchKind: "name",
    ...overrides,
  };
}

function makeProjectHit(overrides: Partial<WayfinderProjectHit> = {}): WayfinderProjectHit {
  return {
    projectId: 100,
    name: "综合楼改造",
    subTeamId: 1,
    subTeamName: "暖通",
    status: "Active",
    matchKind: "name",
    ...overrides,
  };
}

describe("CommandPalette (⌘K 全局命令面板)", () => {
  // 验收点：⌘K 唤起命令面板——`open` 为 true 时渲染对话框。
  it("open=false_时不渲染_对话框", () => {
    render(
      <CommandPalette
        open={false}
        catalog={EMPTY_CATALOG}
        onClose={() => {}}
        onPick={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("open=true_渲染_对话框_与_搜索输入", () => {
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [],
      projects: [],
      tasks: [],
    });
    render(
      <CommandPalette
        open
        catalog={EMPTY_CATALOG}
        onClose={() => {}}
        onPick={() => {}}
      />,
    );
    expect(screen.getByRole("dialog", { name: "全局命令面板" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/搜人员/)).toBeInTheDocument();
  });

  // 验收点：候选查询走命令层,前端不含匹配逻辑。
  it("输入_触发_wayfinderSearch_不_自己_filter", async () => {
    const user = userEvent.setup();
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [makePersonHit()],
      projects: [],
      tasks: [makeTask()],
    });
    render(
      <CommandPalette
        open
        catalog={EMPTY_CATALOG}
        onClose={() => {}}
        onPick={() => {}}
      />,
    );
    await user.type(screen.getByPlaceholderText(/搜人员/), "暖通");
    await waitFor(() => {
      expect(wayfinderSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: "暖通" }),
      );
    });
  });

  // 验收点：面板内可直接触发新建任务。
  it("默认_top_条目_是_新建任务_回车_触发_openCreateTask", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [],
      projects: [],
      tasks: [],
    });
    render(
      <CommandPalette
        open
        catalog={EMPTY_CATALOG}
        onClose={() => {}}
        onPick={onPick}
      />,
    );
    // 等开窗副作用的 wayfinderSearch 调用收尾——再按回车。
    await waitFor(() => {
      expect(wayfinderSearch).toHaveBeenCalled();
    });
    const input = screen.getByPlaceholderText(/搜人员/);
    input.focus();
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith({ kind: "openCreateTask" });
  });

  // 验收点：键盘全程可操作（上下选择 / 回车确认 / Esc 关闭）。
  it("键盘_down_选择_下一项", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [],
      projects: [],
      tasks: [makeTask({ id: 1, title: "任务甲" }), makeTask({ id: 2, title: "任务乙" })],
    });
    render(
      <CommandPalette
        open
        catalog={EMPTY_CATALOG}
        onClose={() => {}}
        onPick={onPick}
      />,
    );
    await waitFor(() => {
      expect(wayfinderSearch).toHaveBeenCalled();
    });
    const input = screen.getByPlaceholderText(/搜人员/);
    input.focus();
    // 默认选中 index 0 = 新建任务；按一次 ↓ 选中 index 1 = 任务甲
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "openEditTask",
        task: expect.objectContaining({ id: 1, title: "任务甲" }),
      }),
    );
  });

  it("键盘_up_选择_上一项", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [],
      projects: [],
      tasks: [makeTask({ id: 1, title: "任务甲" })],
    });
    render(
      <CommandPalette
        open
        catalog={EMPTY_CATALOG}
        onClose={() => {}}
        onPick={onPick}
      />,
    );
    await waitFor(() => {
      expect(wayfinderSearch).toHaveBeenCalled();
    });
    const input = screen.getByPlaceholderText(/搜人员/);
    input.focus();
    // 默认 index 0 = 新建任务；按 ↓ 跳到 index 1 (任务甲)，再按 ↑ 回到 0
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith({ kind: "openCreateTask" });
  });

  it("键盘_esc_触发_onClose_且_不_调用_onPick", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onPick = vi.fn();
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [],
      projects: [],
      tasks: [],
    });
    render(
      <CommandPalette
        open
        catalog={EMPTY_CATALOG}
        onClose={onClose}
        onPick={onPick}
      />,
    );
    await waitFor(() => {
      expect(wayfinderSearch).toHaveBeenCalled();
    });
    const input = screen.getByPlaceholderText(/搜人员/);
    input.focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  // 验收点：选中目标跳转到对应视图并定位（导航由 App.tsx 决定,palette
  // 只负责把"选中谁"传出去）。
  it("选中_人员_emit_openPerson", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [makePersonHit({ personId: 42, subTeamId: 1 })],
      projects: [],
      tasks: [],
    });
    render(
      <CommandPalette
        open
        catalog={EMPTY_CATALOG}
        onClose={() => {}}
        onPick={onPick}
      />,
    );
    await waitFor(() => {
      expect(wayfinderSearch).toHaveBeenCalled();
    });
    const input = screen.getByPlaceholderText(/搜人员/);
    input.focus();
    await user.keyboard("{ArrowDown}"); // 跳过"新建任务"
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith({
      kind: "openPerson",
      personId: 42,
      subTeamId: 1,
    });
  });

  it("选中_项目_emit_openProject", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [],
      projects: [makeProjectHit({ projectId: 999 })],
      tasks: [],
    });
    render(
      <CommandPalette
        open
        catalog={EMPTY_CATALOG}
        onClose={() => {}}
        onPick={onPick}
      />,
    );
    await waitFor(() => {
      expect(wayfinderSearch).toHaveBeenCalled();
    });
    const input = screen.getByPlaceholderText(/搜人员/);
    input.focus();
    await user.keyboard("{ArrowDown}"); // 跳过"新建任务"
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith({
      kind: "openProject",
      projectId: 999,
    });
  });

  it("选中_任务_emit_openEditTask_并_从_catalog_填_candidates", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [],
      projects: [],
      tasks: [makeTask({ id: 7, ownerPersonId: 11, projectId: 22 })],
    });
    const catalog = {
      people: [
        makePerson({ id: 11, name: "暖通甲", subTeamId: 5 }),
        makePerson({ id: 99, name: "未使用", subTeamId: 6 }),
      ],
      subTeams: [
        makeSubTeam({ id: 5, name: "暖通组" }),
        makeSubTeam({ id: 6, name: "电气组" }),
        makeSubTeam({ id: 7, name: "项目所在组" }),
      ],
      projects: [
        makeProject({ id: 22, name: "综合楼改造", subTeamId: 7 }),
      ],
    };
    render(
      <CommandPalette
        open
        catalog={catalog}
        onClose={() => {}}
        onPick={onPick}
      />,
    );
    await waitFor(() => {
      expect(wayfinderSearch).toHaveBeenCalled();
    });
    const input = screen.getByPlaceholderText(/搜人员/);
    input.focus();
    await user.keyboard("{ArrowDown}"); // 跳过"新建任务"
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith({
      kind: "openEditTask",
      task: expect.objectContaining({ id: 7 }),
      assignee: {
        personId: 11,
        name: "暖通甲",
        subTeamName: "暖通组",
      },
      project: {
        projectId: 22,
        name: "综合楼改造",
        subTeamName: "项目所在组",
      },
    });
  });

  it("无_命中_显示_empty_hint", async () => {
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [],
      projects: [],
      tasks: [],
    });
    render(
      <CommandPalette
        open
        catalog={EMPTY_CATALOG}
        onClose={() => {}}
        onPick={() => {}}
      />,
    );
    await waitFor(() => {
      expect(wayfinderSearch).toHaveBeenCalled();
    });
    expect(screen.getByText(/没有命中任何人员/)).toBeInTheDocument();
  });

  // ticket #28 评审遗留：之前的 `Highlight` 只在 `match === "both"` 时加粗,
  // 但调用点用三元把 `"both"` 改写成 `"name"`,结果两段都没加粗——`"both"`
  // 分支是死代码。这条断言确认 `matchKind === "both"` 时 name 与 sub-team
  // 两段都加粗。
  it("match_kind_both_时_name_与_sub_team_两段_都_加粗", async () => {
    vi.mocked(wayfinderSearch).mockResolvedValue({
      people: [
        makePersonHit({
          personId: 5,
          name: "暖通甲",
          subTeamName: "暖通",
          matchKind: "both",
        }),
      ],
      projects: [],
      tasks: [],
    });
    render(
      <CommandPalette
        open
        catalog={EMPTY_CATALOG}
        onClose={() => {}}
        onPick={() => {}}
      />,
    );
    await waitFor(() => {
      expect(wayfinderSearch).toHaveBeenCalled();
    });
    // 扁平列表顺序：index 0 是 "新建任务" 占位条目,index 1 才是人员。
    const personOption = screen.getAllByRole("option")[1];
    // name 与 subTeamName 都应被 <strong> 包裹
    const strongs = personOption.querySelectorAll("strong");
    expect(strongs.length).toBe(2);
    expect(strongs[0].textContent).toBe("暖通甲");
    expect(strongs[1].textContent).toBe("暖通");
  });
});
