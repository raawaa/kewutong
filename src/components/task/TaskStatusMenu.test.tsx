/**
 * 「点徽章 → 6 项菜单」手势的组件级验证（tickets #20 / #22）。
 *
 * 验收点：
 * - 点徽章弹出 6 项菜单
 * - 选中 Blocked / Waiting-on 需要先填 reason,Submit 才回调
 * - 其它状态直接回调
 * - 选中当前 status 不回调,仅关闭菜单
 * - 点击外部 / Esc 关闭
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskStatusMenu } from "./TaskStatusMenu";
import type { Task } from "@/lib/ipc";
import { listAssigneeCandidates } from "@/lib/ipc";

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  listAssigneeCandidates: vi.fn(),
}));

const 候选人 = [
  { personId: 7, name: "张三", subTeamName: "暖通" },
  { personId: 8, name: "李四", subTeamName: "电气" },
];

beforeEach(() => {
  vi.mocked(listAssigneeCandidates).mockResolvedValue(候选人);
});

const 任务: Task = {
  id: 1,
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

describe("TaskStatusMenu", () => {
  it("点徽章展开 6 项菜单", async () => {
    const user = userEvent.setup();
    render(<TaskStatusMenu task={任务} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /状态：待开始/ }));

    // 6 个状态都要列出来——按 STATUS_LABELS 的中文文案找
    for (const label of ["待开始", "进行中", "已阻塞", "等待中", "已完成", "已取消"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("选中非 Blocked/Waiting-on 的状态直接回调且关闭菜单", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStatusMenu task={任务} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /状态：待开始/ }));
    await user.click(screen.getByRole("menuitem", { name: /进行中/ }));

    expect(onChange).toHaveBeenCalledWith({
      status: "In-progress",
      blockedReason: null,
      waitingOnPersonId: null,
    });
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });

  it("进入 Blocked 必须先填 reason; 提交时把 reason 一起回调", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStatusMenu task={任务} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /状态：待开始/ }));
    await user.click(screen.getByRole("menuitem", { name: /已阻塞/ }));

    // 二次面板:不提交 reason 时保存按钮应禁用
    const save = await screen.findByRole("button", { name: "保存" });
    expect(save).toBeDisabled();

    await user.type(screen.getByPlaceholderText("写一句原因"), "等外委回函");
    expect(save).not.toBeDisabled();

    await user.click(save);

    expect(onChange).toHaveBeenCalledWith({
      status: "Blocked",
      blockedReason: "等外委回函",
      waitingOnPersonId: null,
    });
  });

  it("进入 Waiting-on 同样需要 reason;可选指定在等谁,空选 = 等系统", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStatusMenu task={任务} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /状态：待开始/ }));
    await user.click(screen.getByRole("menuitem", { name: /等待中/ }));

    // 必填 reason
    await user.type(
      await screen.findByPlaceholderText("写一句原因"),
      "等分管领导批示",
    );
    // 选人下拉被加载,默认空选("等系统")
    const picker = await screen.findByLabelText("在等谁（可空）");
    expect(picker).toBeInTheDocument();

    // 默认(空选)提交 -> waiting_on_person_id = null
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onChange).toHaveBeenLastCalledWith({
      status: "Waiting-on",
      blockedReason: "等分管领导批示",
      waitingOnPersonId: null,
    });

    // 再开一次,这次选张三
    onChange.mockClear();
    await user.click(screen.getByRole("button", { name: /状态：待开始/ }));
    await user.click(screen.getByRole("menuitem", { name: /等待中/ }));
    await user.type(
      await screen.findByPlaceholderText("写一句原因"),
      "等回函",
    );
    await user.selectOptions(
      await screen.findByLabelText("在等谁（可空）"),
      "7",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onChange).toHaveBeenLastCalledWith({
      status: "Waiting-on",
      blockedReason: "等回函",
      waitingOnPersonId: 7,
    });
  });

  it("选当前 status 不回调,只关闭菜单", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStatusMenu task={任务} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /状态：待开始/ }));
    await user.click(screen.getByRole("menuitem", { name: /待开始/ }));

    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });

  it("Esc 关菜单", async () => {
    const user = userEvent.setup();
    render(<TaskStatusMenu task={任务} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /状态：待开始/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });

  it("点击外部关菜单", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <span data-testid="outside">outside</span>
        <TaskStatusMenu task={任务} onChange={vi.fn()} />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /状态：待开始/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(screen.getByTestId("outside"));
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });
});
