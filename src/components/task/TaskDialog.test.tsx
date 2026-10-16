// @vitest-environment jsdom
/**
 * 新建 / 编辑弹窗的组件级验证（ticket #19）。
 *
 * 盯的是验收点里跨组件的那几条：新建与编辑字段一致、改期走同一 chip 行、
 * 存下去的入参是命令层能直接消费的形状。命令层本身在 Rust 侧有集成测试，
 * 这里把 `@/lib/api` 整个换掉，只看前端交出去了什么。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDialog } from "./TaskDialog";
import type { AssigneeCandidate, DueDateOption, Task } from "@/lib/api";
import {
  createTask,
  listAssigneeCandidates,
  listDueDateOptions,
  updateTask,
  upsertRecurringTemplate,
} from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  listDueDateOptions: vi.fn(),
  listAssigneeCandidates: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  upsertRecurringTemplate: vi.fn(),
  listProjectCandidates: vi.fn(async () => [
    { projectId: 11, name: "Q4 业务汇报", subTeamName: "业务一组" },
  ]),
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
  recurringTemplateId: null,
  scheduledAt: null,
  originalScheduledAt: null,
  rescheduledFromId: null,
  isRecurring: false,
  effectiveDate: "2026-09-10",
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
  vi.mocked(upsertRecurringTemplate).mockResolvedValue({
    id: 1,
    name: "",
    freq: "weekly",
    bydayMask: 0,
    bymonthday: null,
    bymonth: null,
    byhour: 9,
    byminute: 0,
    ianaZone: "Asia/Shanghai",
    ends: { kind: "on", date: "2026-12-31" },
    holidayBehavior: "skip",
    rruleText: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=0;UNTIL=20261231T235959Z",
    projectId: 11,
    subTeamId: null,
    enabled: true,
    notes: null,
    createdAt: "2026-09-10 09:00:00",
  });
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
        status: "Open",
        blockedReason: null,
        waitingOnPersonId: null,
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
    renderDialog({ mode: "edit", task: 已有任务, assignee: 张三, project: null });

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
      project: null,
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
      project: null,
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
      project: null,
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

describe("TaskDialog · 周期性", () => {
  it("勾上 toggle → 立刻打开侧抽屉,无内联摘要", async () => {
    const { user } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    await user.click(screen.getByTestId("recurring-toggle"));

    expect(await screen.findByRole("dialog", { name: "配置周期性规则" }))
      .toBeInTheDocument();
    // 抽屉里没把规则拍到主弹窗上去——主弹窗仍只看见 toggle 行
    expect(screen.queryByText("派生 RRULE")).not.toBeInTheDocument();
  });

  it("抽屉里点取消 → 不算周期性,toggle 也不亮", async () => {
    const { user } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    await user.click(screen.getByTestId("recurring-toggle"));
    const sheet = await screen.findByRole("dialog", { name: "配置周期性规则" });
    await user.click(within(sheet).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog", { name: "配置周期性规则" }))
      .not.toBeInTheDocument();
    // 关闭后,rule 没被确认,periodic 视为关
    const toggle = screen.getByTestId("recurring-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("抽屉里点确认 → 写入 task + 调用 upsert_recurring_template", async () => {
    const { user } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    // 标题 + 选人 + 选项目
    const box = screen.getByRole("textbox", { name: "任务标题" });
    await user.click(box);
    await user.type(box, "周一三早会 @张");
    await user.click(await screen.findByRole("option", { name: /张三/ }));
    await user.type(box, " #Q4");
    await user.click(await screen.findByRole("option", { name: /Q4/ }));

    // 打开抽屉 → 选 周一 + 周三 → 确认
    await user.click(screen.getByTestId("recurring-toggle"));
    const sheet = await screen.findByRole("dialog", { name: "配置周期性规则" });
    await user.click(within(sheet).getByRole("button", { name: "一" }));
    await user.click(within(sheet).getByRole("button", { name: "三" }));
    await user.click(within(sheet).getByRole("button", { name: "确认 →" }));

    // 创建按钮可点 → 点
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "周一三早会",
          projectId: 11,
        }),
      ),
    );
    await waitFor(() =>
      expect(upsertRecurringTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: null,
          projectId: 11,
          rule: expect.objectContaining({ freq: "weekly" }),
        }),
      ),
    );
  });

  it("周期开但没选项目 → 创建按钮被锁,提示挂项目", async () => {
    const { user } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    // 标题 + 选人(不选项目)
    const box = screen.getByRole("textbox", { name: "任务标题" });
    await user.click(box);
    await user.type(box, "周一例会 @张");
    await user.click(await screen.findByRole("option", { name: /张三/ }));

    // 开周期 → 选周一 → 确认
    await user.click(screen.getByTestId("recurring-toggle"));
    const sheet = await screen.findByRole("dialog", { name: "配置周期性规则" });
    await user.click(within(sheet).getByRole("button", { name: "一" }));
    await user.click(within(sheet).getByRole("button", { name: "确认 →" }));

    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    expect(screen.getByText(/周期性任务需要挂一个项目/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ticket #86 T6：负责人 / 等待谁 两个字段可点 → onOpenPerson(personId)
//
// 入口 ③ = 任务详情弹窗负责人字段；入口 ④ = 等待谁字段。
// 本块验证「弹窗里点该字段」触发回调,不破坏 #19 时代的既有行为(创建
// 按钮、关闭、转派等仍按原合约)。
// ---------------------------------------------------------------------------

describe("TaskDialog · 入口③④ #86 T6 负责人 / 等待谁 可点", () => {
  it("编辑模式有负责人时:显示负责人按钮,点击触发 onOpenPerson(personId)", async () => {
    const user = userEvent.setup();
    const onOpenPerson = vi.fn();
    render(
      <TaskDialog
        target={{
          mode: "edit",
          task: 已有任务,
          assignee: 张三,
          project: null,
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onOpenPerson={onOpenPerson}
      />,
    );

    await screen.findByRole("button", { name: "今天" });
    // 等任务标题铺出来,确认弹窗已就绪再点
    await screen.findByRole("textbox", { name: "任务标题" });

    const 负责人按钮 = screen.getByRole("button", {
      name: /打开 张三 的详情/,
    });
    await user.click(负责人按钮);

    expect(onOpenPerson).toHaveBeenCalledWith(张三.personId);
  });

  it("编辑模式负责人按钮不点任务标题里的 pill:两条入口互不串扰", async () => {
    // 标题里的 @张三 pill 是「转派 = 改负责人」的入口;新加的「负责人」
    // 按钮是「openPerson = 看档案」的入口。点负责人按钮不应触发 onSaved
    // / onClose / 转派,只触发 onOpenPerson。
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const onOpenPerson = vi.fn();

    render(
      <TaskDialog
        target={{
          mode: "edit",
          task: 已有任务,
          assignee: 张三,
          project: null,
        }}
        onClose={onClose}
        onSaved={onSaved}
        onOpenPerson={onOpenPerson}
      />,
    );

    await screen.findByRole("textbox", { name: "任务标题" });
    await user.click(
      screen.getByRole("button", { name: /打开 张三 的详情/ }),
    );

    expect(onOpenPerson).toHaveBeenCalledTimes(1);
    expect(onOpenPerson).toHaveBeenCalledWith(张三.personId);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("编辑模式有 waitingOnPersonId 时:显示「等待谁」按钮,点击触发 onOpenPerson", async () => {
    const user = userEvent.setup();
    const onOpenPerson = vi.fn();
    const 编辑用任务: Task = {
      ...已有任务,
      status: "Waiting-on",
      waitingOnPersonId: 999,
      blockedAt: "2026-09-09 10:00:00",
      blockedReason: "等对方",
    };
    render(
      <TaskDialog
        target={{ mode: "edit", task: 编辑用任务, assignee: 张三, project: null }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onOpenPerson={onOpenPerson}
      />,
    );
    await screen.findByRole("textbox", { name: "任务标题" });

    const 等TA按钮 = screen.getByRole("button", {
      name: /打开等待人 id=999 的详情/,
    });
    await user.click(等TA按钮);

    expect(onOpenPerson).toHaveBeenCalledWith(999);
  });

  it("编辑模式无 waitingOnPersonId 时:「等待谁」字段显示 — 文本", async () => {
    // 已有任务 waitingOnPersonId = null —— 字段退化为占位,不可点。
    const onOpenPerson = vi.fn();
    render(
      <TaskDialog
        target={{
          mode: "edit",
          task: 已有任务,
          assignee: 张三,
          project: null,
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onOpenPerson={onOpenPerson}
      />,
    );
    await screen.findByRole("textbox", { name: "任务标题" });

    expect(
      screen.getByText("等待谁"),
    ).toBeInTheDocument();
    // 「等待谁」行没有任何按钮可点。
    expect(
      screen.queryByRole("button", { name: /打开等待人/ }),
    ).not.toBeInTheDocument();
  });

  it("新建模式无 assignee 时:「负责人」字段显示 — 文本(不可点)", async () => {
    renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    // 新建模式下,assignee 还没选——负责人字段退化为 — 文本。
    expect(screen.getByText("负责人")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /打开.*的详情/ }),
    ).not.toBeInTheDocument();
  });

  it("未传 onOpenPerson 时:弹窗仍能渲染,字段降级为纯文本", async () => {
    // 防御合约:command 层不强制传 onOpenPerson 时,弹窗仍按 ticket #19
    // 行为渲染 / 保存。这条约束避免 #86 的接口扩展打断既有调用方。
    const { onSaved } = renderDialog({
      mode: "edit",
      task: 已有任务,
      assignee: 张三,
      project: null,
    });

    await screen.findByRole("button", { name: "今天" });
    expect(
      screen.queryByRole("button", { name: /打开 张三 的详情/ }),
    ).not.toBeInTheDocument();
    // 字段退化为纯文本 —— 标题里 @张三 pill 也算一处匹配,这里只断
    // 言「字段区出现子组名」即可(不能简单 byText("@张三"):标题 pill
    // 与新字段都会命中)。
    expect(screen.getByText(/暖通/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled(); // 没保存
  });
});

// ---------------------------------------------------------------------------
// ticket #91：状态选择控件（6 状态枚举，默认 Open）。
// ---------------------------------------------------------------------------

describe("TaskDialog · 状态选择控件 #91", () => {
  it("新建模式：状态控件可见，默认 Open 选中", async () => {
    renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    // 6 个 chip 都在；Open 默认选中。
    expect(screen.getByRole("button", { name: "待开始" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "进行中" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "已阻塞" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "等待中" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "已完成" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "已取消" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("新建模式：选 '进行中' → IPC 入参 status = 'In-progress'", async () => {
    const { user } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    const box = screen.getByRole("textbox", { name: "任务标题" });
    await user.click(box);
    await user.type(box, "跑外委 @张");
    await user.click(await screen.findByRole("option", { name: /张三/ }));
    await user.click(screen.getByRole("button", { name: "进行中" }));
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({ status: "In-progress" }),
      ),
    );
  });

  it("新建模式：选 '已阻塞' + 填阻塞原因 → IPC 入参带 status + blockedReason", async () => {
    const { user } = renderDialog({ mode: "create" });
    await screen.findByRole("button", { name: "今天" });

    const box = screen.getByRole("textbox", { name: "任务标题" });
    await user.click(box);
    await user.type(box, "等外委 @张");
    await user.click(await screen.findByRole("option", { name: /张三/ }));

    // 切到 Blocked → 出现原因输入框
    await user.click(screen.getByRole("button", { name: "已阻塞" }));
    const reasonBox = await screen.findByLabelText(/阻塞原因/);
    await user.type(reasonBox, "对方未回函");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "Blocked",
          blockedReason: "对方未回函",
        }),
      ),
    );
  });

  it("编辑模式：状态控件显示当前值（In-progress），可改", async () => {
    const { user } = renderDialog({
      mode: "edit",
      task: 已有任务, // status: "In-progress"
      assignee: 张三,
      project: null,
    });
    await screen.findByRole("textbox", { name: "任务标题" });

    expect(screen.getByRole("button", { name: "进行中" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "已完成" }));
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 42, status: "Done" }),
      ),
    );
  });

  it("编辑模式：打开 Blocked 任务时 reason 预填,不点状态也能保存", async () => {
    // 模拟「编辑即详情」:用户进弹窗看一下,不动 picker,直接保存 ——
    // pre-fill 必须把现有 reason 灌进 state,避免 UI 误报「reason 为空」
    // 而锁住保存按钮。
    const blockedTask: Task = {
      ...已有任务,
      status: "Blocked",
      blockedReason: "等外委回函",
      blockedAt: "2026-09-09 10:00:00",
    };
    const { user } = renderDialog({
      mode: "edit",
      task: blockedTask,
      assignee: 张三,
      project: null,
    });
    await screen.findByRole("textbox", { name: "任务标题" });

    // picker 已阻塞选中,reason 也已预填
    expect(screen.getByRole("button", { name: "已阻塞" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("阻塞原因")).toHaveValue("等外委回函");

    // 用户不动 picker,直接保存
    expect(screen.getByRole("button", { name: "保存修改" })).not.toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 42,
          status: "Blocked",
          blockedReason: "等外委回函",
        }),
      ),
    );
  });

  it("编辑 Waiting-on 任务：保存时透传 waitingOnPersonId,不静默清空", async () => {
    // #91 review 反馈:tautological `null : null` 让编辑 Waiting-on 任
    // 务时保存会把 waitingOnPersonId 抹掉。这条回归:打开已有 waitingOn
    // PersonId,不改任何字段直接保存,IPC 入参必须保留原值。
    const waitingOnTask: Task = {
      ...已有任务,
      status: "Waiting-on",
      waitingOnPersonId: 999,
      blockedAt: "2026-09-09 10:00:00",
      blockedReason: "等对方回函",
    };
    const { user } = renderDialog({
      mode: "edit",
      task: waitingOnTask,
      assignee: 张三,
      project: null,
    });
    await screen.findByRole("textbox", { name: "任务标题" });

    expect(screen.getByRole("button", { name: "等待中" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("等待原因")).toHaveValue("等对方回函");

    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 42,
          status: "Waiting-on",
          blockedReason: "等对方回函",
          waitingOnPersonId: 999,
        }),
      ),
    );
  });
});
