/**
 * App 外壳的组件级验证（ticket #19 验收点：「顶栏按钮与 ⌘N 都能在任意界面
 * 唤起新建弹窗」）。
 *
 * 这条验收点的要害是**在任意界面**——所以两个入口都要在切到另一个 tab
 * 之后再验一遍。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import {
  listDueDateOptions,
  listPeople,
  listProjects,
  listSubTeams,
  listTasks,
  todayWeek,
  trayStatus,
} from "@/lib/ipc";

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  listDueDateOptions: vi.fn(),
  listAssigneeCandidates: vi.fn(),
  listTasks: vi.fn(),
  listPeople: vi.fn(),
  listSubTeams: vi.fn(),
  listProjects: vi.fn(),
  todayWeek: vi.fn(),
  trayStatus: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(listDueDateOptions).mockResolvedValue([
    { chip: "today", label: "今天", dueDate: "2026-09-10" },
    { chip: "next-week", label: "一周后", dueDate: "2026-09-17" },
    { chip: "none", label: "无", dueDate: null },
  ]);
  vi.mocked(listTasks).mockResolvedValue([]);
  vi.mocked(listPeople).mockResolvedValue([]);
  vi.mocked(listSubTeams).mockResolvedValue([]);
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(todayWeek).mockResolvedValue({
    counts: { activePeople: 0, inProgress: 0, blocked: 0 },
    buckets: { overdue: [], today: [], tomorrow: [], thisWeekRest: [] },
    materializationWindowEnd: "2026-12-31",
  });
  // 默认托盘可用——App.test 不关心 banner,显式给可用避免 banner 在这
  // 些测试里冒出来干扰断言；专门测 banner 行为去 TrayStatusBanner.test。
  vi.mocked(trayStatus).mockResolvedValue({ available: true, reason: "" });
});

/** 弹窗开着的判据：新建任务的对话框在 DOM 里。 */
function 新建弹窗() {
  return screen.queryByRole("dialog", { name: "新建任务" });
}

describe("App · 全局新建入口", () => {
  it("顶栏按钮唤起新建弹窗", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(新建弹窗()).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /新建任务/ }));

    expect(新建弹窗()).toBeInTheDocument();
  });

  it("⌘N 唤起新建弹窗", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.keyboard("{Meta>}n{/Meta}");

    await waitFor(() => expect(新建弹窗()).toBeInTheDocument());
  });

  it("非 mac 的 Ctrl+N 一样唤起", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.keyboard("{Control>}n{/Control}");

    await waitFor(() => expect(新建弹窗()).toBeInTheDocument());
  });

  it("切到人员界面后，⌘N 仍然唤起新建弹窗", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "人员" }));
    await screen.findByText(/分子组、调岗/);
    await user.keyboard("{Meta>}n{/Meta}");

    await waitFor(() => expect(新建弹窗()).toBeInTheDocument());
  });

  it("切到人员界面后，顶栏按钮仍然唤起新建弹窗", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "人员" }));
    await screen.findByText(/分子组、调岗/);
    await user.click(screen.getByRole("button", { name: /新建任务/ }));

    expect(新建弹窗()).toBeInTheDocument();
  });
});

describe("App · 托盘不可用 banner（ticket #29）", () => {
  it("tray_status 返回不可用时,主界面渲染 reason banner", async () => {
    vi.mocked(trayStatus).mockResolvedValue({
      available: false,
      reason: "托盘初始化失败：缺少 libappindicator3-1",
    });
    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("托盘初始化失败：缺少 libappindicator3-1");
  });

  it("tray_status 返回可用时,主界面不渲染 banner", async () => {
    vi.mocked(trayStatus).mockResolvedValue({ available: true, reason: "" });
    render(<App />);

    // 等待 useEffect 跑完——再断言没有 alert
    await waitFor(() => expect(trayStatus).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("tray_status 命令本身抛错时不臆测状态——banner 保持 null 不渲染", async () => {
    vi.mocked(trayStatus).mockRejectedValue(new Error("ipc 断了"));
    render(<App />);

    // 等 effect 跑完——只断言 banner 不出现,理由是 reason 是后端拥有的
    // 字段,前端不在 catch 里编一个;不渲染比渲染错的内容更安全。
    await waitFor(() => expect(trayStatus).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
