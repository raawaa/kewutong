/**
 * 新建 / 编辑弹窗的组件级验证（ticket #19）。
 *
 * 盯的是验收点里跨组件的那几条：新建与编辑字段一致、改期走同一 chip 行、
 * 存下去的入参是命令层能直接消费的形状。命令层本身在 Rust 侧有集成测试，
 * 这里把 `@/lib/ipc` 整个换掉，只看前端交出去了什么。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDialog } from "./TaskDialog";
import type { AssigneeCandidate, DueDateOption, Task } from "@/lib/ipc";
import {
  createTask,
  listAssigneeCandidates,
  listDueDateOptions,
  updateTask,
} from "@/lib/ipc";

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  listDueDateOptions: vi.fn(),
  listAssigneeCandidates: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
}));

/** 命令层在 2026-09-10 这天算出来的 chip 行。 */
const OPTIONS: DueDateOption[] = [
  { chip: "today", label: "今天", dueDate: "2026-09-10" },
  { chip: "tomorrow", label: "明天", dueDate: "2026-09-11" },
  { chip: "next-week", label: "一周后", dueDate: "2026-09-17" },
  { chip: "none", label: "无", dueDate: null },
];

const 张三: AssigneeCandidate = { personId: 7, name: "张三", subTeamName: "暖通" };
const 李四: AssigneeCandidate = { personId: 8, name: "李四", subTeamName: "电气" };

const 已有任务: Task = {
  id: 42,
  title: "整理季度报表",
  description: "记得附上上季度对比",
  status: "In-progress",
  ownerPersonId: 张三.personId,
  projectId: null,
  dueDate: "2026-09-10",
  createdAt: "2026-09-01 09:00:00",
  updatedAt: "2026-09-01 09:00:00",
  blockedAt: null,
  blockedReason: null,
  waitingOnPersonId: null,
};

beforeEach(() => {
  vi.mocked(listDueDateOptions).mockResolvedValue(OPTIONS);
  vi.mocked(listAssigneeCandidates).mockImplementation(async ({ query }) =>
    [张三, 李四].filter((c) => c.name.includes(query ?? "")),
  );
  vi.mocked(createTask).mockImplementation(async (args) => ({
    ...已有任务,
    ...args,
    id: 99,
  }));
  vi.mocked(updateTask).mockImplementation(async (args) => ({
    ...已有任务,
    ...args,
  }));
});

function renderDialog(target: Parameters<typeof TaskDialog>[0]["target"]) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const user = userEvent.setup();
  render(<TaskDialog target={target} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved, user };
}

describe("TaskDialog · 新建", () => {
  it("chip 行渲染的是命令层算出来的日期", async () => {
    renderDialog({ mode: "create" });

    for (const option of OPTIONS) {
      expect(
        await screen.findByRole("button", { name: option.label }),
      ).toBeInTheDocument();
    }
  });

  it("新建时截止日默认留空——避免悄悄给每条任务塞 deadline", async () => {
    renderDialog({ mode: "create" });

    // 等 chip 行铺出来
    for (const option of OPTIONS) {
      await screen.findByRole("button", { name: option.label });
    }
    // 四格都不选中；日期精确选日的值也是空
    for (const option of OPTIONS) {
      expect(
        screen.getByRole("button", { name: option.label }),
      ).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getByLabelText("精确选日")).toHaveValue("");
  });

  it("一句话录完：打标题 + @ 挑人 + 点截止 chip", async () => {
    const { user, onSaved } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    const box = screen.getByRole("textbox", { name: "任务标题" });
    await user.click(box);
    await user.type(box, "整理季度报表 @张");
    await user.click(await screen.findByRole("option", { name: /张三/ }));
    await user.click(screen.getByRole("button", { name: "今天" }));
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith({
        title: "整理季度报表",
        description: null,
        ownerPersonId: 张三.personId,
        projectId: null,
        dueDate: "2026-09-10",
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("可填自由文本描述", async () => {
    const { user } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    const box = screen.getByRole("textbox", { name: "任务标题" });
    await user.click(box);
    await user.type(box, "开会@张");
    await user.click(await screen.findByRole("option", { name: /张三/ }));
    await user.type(screen.getByLabelText("描述"), "带上图纸");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({ description: "带上图纸" }),
      ),
    );
  });

  it("没指派负责人就存不了——任务必须有负责人", async () => {
    const { user } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    const box = screen.getByRole("textbox", { name: "任务标题" });
    await user.click(box);
    await user.type(box, "整理季度报表");

    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    expect(screen.getByText(/还没指派负责人/)).toBeInTheDocument();
  });

  it("命令层拒绝时把中文消息摆出来", async () => {
    vi.mocked(createTask).mockRejectedValue({
      code: "INVALID_ARGUMENT",
      message: "截止日格式不对,应形如 2026-09-10。",
      detail: null,
    });
    const { user, onSaved } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    const box = screen.getByRole("textbox", { name: "任务标题" });
    await user.click(box);
    await user.type(box, "开会@张");
    await user.click(await screen.findByRole("option", { name: /张三/ }));
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "截止日格式不对",
    );
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("TaskDialog · 编辑即详情", () => {
  it("点开已有任务，字段与新建一致且已预填", async () => {
    renderDialog({ mode: "edit", task: 已有任务, assignee: 张三 });

    const box = await screen.findByRole("textbox", { name: "任务标题" });
    expect(box).toHaveTextContent("整理季度报表");
    expect(box).toHaveTextContent("@张三");
    expect(screen.getByLabelText("描述")).toHaveValue("记得附上上季度对比");
    // 同一套 chip 行，当前截止日那格选中
    expect(await screen.findByRole("button", { name: "今天" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("改期走同一套 chip 行", async () => {
    const { user } = renderDialog({
      mode: "edit",
      task: 已有任务,
      assignee: 张三,
    });
    await screen.findByRole("button", { name: "一周后" });

    await user.click(screen.getByRole("button", { name: "一周后" }));
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 42, dueDate: "2026-09-17" }),
      ),
    );
  });

  it("改期到「无」把截止日清掉", async () => {
    const { user } = renderDialog({
      mode: "edit",
      task: 已有任务,
      assignee: 张三,
    });
    await screen.findByRole("button", { name: "无" });

    await user.click(screen.getByRole("button", { name: "无" }));
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith(
        expect.objectContaining({ dueDate: null }),
      ),
    );
  });

  it("转派：在标题里重新 @ 一个人", async () => {
    const { user } = renderDialog({
      mode: "edit",
      task: 已有任务,
      assignee: 张三,
    });
    const box = await screen.findByRole("textbox", { name: "任务标题" });

    await user.click(box);
    await user.type(box, "@李");
    await user.click(await screen.findByRole("option", { name: /李四/ }));
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith(
        expect.objectContaining({ ownerPersonId: 李四.personId }),
      ),
    );
  });
});

describe("TaskDialog · 关闭", () => {
  it("Esc 关弹窗", async () => {
    const { user, onClose } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it("候选下拉开着时，Esc 只收下拉不关弹窗", async () => {
    const { user, onClose } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    const box = screen.getByRole("textbox", { name: "任务标题" });
    await user.click(box);
    await user.type(box, "@张");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
