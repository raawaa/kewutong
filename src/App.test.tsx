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
} from "@/lib/ipc";

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  listDueDateOptions: vi.fn(),
  listAssigneeCandidates: vi.fn(),
  listTasks: vi.fn(),
  listPeople: vi.fn(),
  listSubTeams: vi.fn(),
  listProjects: vi.fn(),
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
