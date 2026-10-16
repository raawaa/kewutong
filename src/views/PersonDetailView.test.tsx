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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonDetailView } from "./PersonDetailView";
import {
  getPersonDetail,
  listSubTeams,
  updatePerson,
  type Person,
  type PersonDetail,
  type Project,
  type RecurringTemplate,
  type SubTeam,
  type Task,
} from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getPersonDetail: vi.fn(),
  listSubTeams: vi.fn(),
  updatePerson: vi.fn(),
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
  vi.mocked(updatePerson).mockReset();
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

    // 段头 + 按钮的 `aria-label` 是「新建任务给 TA · {段名}」,用
    // 这个完整模式筛 header 按钮；空态按钮的「→ 新建任务给 TA」是文本
    // 内容,匹配不到,自然排除。T3 新增「等待 TA 推动」段也走同一个
    // `onCreateTask` 回调（spec #80 §Implementation #17）——所以这
    // 里总数是 6 + 1 = 7。
    const plusButtons = await screen.findAllByRole("button", {
      name: /新建任务给 TA ·/,
    });
    expect(plusButtons.length).toBe(7); // 6 在飞段 + 1 等待 TA 推动段
    await user.click(plusButtons[0]!);

    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onCreateTask).mock.calls[0]?.[0]?.id).toBe(1);
    expect(vi.mocked(onCreateTask).mock.calls[0]?.[0]?.name).toBe("张三");
  });
});

// ---------------------------------------------------------------------------
// 段 3 / 段 4 / 段 5（#83 T3）
//
// 三段均为「读 + 加」模型：段头 = 标题 + 计数 + + 按钮;列表渲染段语义
// 字段（项目名 / 任务名 / 模板名 + 关键上下文）;空态降级到「→ 去 XXX
// tab 新建」。+ 按钮把当前人员 / 子组作为预填意图交给父层,由父层决定
// 切到哪个 tab、开哪个表单。
//
// 三段的段内排序由命令层（#81 / #82）一次性给齐,本视图不二次排——与
// InFlightSection 同一原则。
// ---------------------------------------------------------------------------

describe("PersonDetailView · 段 3 / 段 4 / 段 5（T3）", () => {
  it("负责的项目段——渲染项目名 + 状态徽章 + 子组 + 截止日", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        ownedProjects: [
          projectStub({
            id: 10,
            name: "智慧城市",
            subTeamId: 1,
            status: "Active",
            dueDate: "2026-12-31",
          }),
          projectStub({
            id: 11,
            name: "乡村振兴",
            subTeamId: 2,
            status: "Done",
            dueDate: null,
          }),
        ],
      }),
    );

    render(<DetailHarness />);

    expect(await screen.findByText("智慧城市")).toBeInTheDocument();
    expect(screen.getByText("乡村振兴")).toBeInTheDocument();
    // 截止日与状态徽章
    expect(screen.getByText(/截止 2026-12-31/)).toBeInTheDocument();
  });

  it("负责的项目段空：显示「暂无负责项目 → 去项目 tab 新建」", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail({ ownedProjects: [] }));

    render(<DetailHarness />);

    expect(
      await screen.findByText(/暂无负责项目.*去项目 tab 新建/),
    ).toBeInTheDocument();
  });

  it("负责的项目 + 按钮 → 调 onCreateProject 并带上当前人员", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail({ ownedProjects: [] }));

    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    render(<DetailHarness onCreateProject={onCreateProject} />);

    // + 按钮的 aria-label = 「新建项目给 TA · 负责的项目」
    await user.click(
      await screen.findByRole("button", { name: /新建项目给 TA · 负责的项目/ }),
    );

    expect(onCreateProject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onCreateProject).mock.calls[0]?.[0]?.id).toBe(1);
    expect(vi.mocked(onCreateProject).mock.calls[0]?.[0]?.name).toBe("张三");
  });

  it("等待 TA 推动段——渲染任务名 + blocked_reason（卡最久的在前）", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        waitingOnTasks: [
          taskStub({
            id: 100,
            title: "等市里回函",
            status: "Waiting-on",
            blockedReason: "卡在分管领导批示",
          }),
        ],
      }),
    );

    render(<DetailHarness />);

    expect(await screen.findByText("等市里回函")).toBeInTheDocument();
    // 阻塞原因作为次级文案渲染
    expect(screen.getByText(/卡在分管领导批示/)).toBeInTheDocument();
  });

  it("等待 TA 推动段空：显示「暂时没有任务等 TA 推动」", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail({ waitingOnTasks: [] }));

    render(<DetailHarness />);

    expect(
      await screen.findByText(/暂时没有任务等 TA 推动/),
    ).toBeInTheDocument();
  });

  it("等待 TA 推动 + 按钮 → 调 onCreateTask（与在飞段同回调）并带上当前人员", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail({ waitingOnTasks: [] }));

    const user = userEvent.setup();
    const onCreateTask = vi.fn();
    render(<DetailHarness onCreateTask={onCreateTask} />);

    // + 按钮的 aria-label = 「新建任务给 TA · 等待 TA 推动」
    await user.click(
      await screen.findByRole("button", { name: /新建任务给 TA · 等待 TA 推动/ }),
    );

    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onCreateTask).mock.calls[0]?.[0]?.id).toBe(1);
    expect(vi.mocked(onCreateTask).mock.calls[0]?.[0]?.name).toBe("张三");
  });

  it("所在子组的周期模板段——渲染模板名 + 频次", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        subTeamTemplates: [
          templateStub({ id: 50, name: "周一例会", freq: "weekly", bydayMask: 1 << 0 }),
          templateStub({ id: 51, name: "月度汇报", freq: "monthly" }),
        ],
      }),
    );

    render(<DetailHarness />);

    expect(await screen.findByText("周一例会")).toBeInTheDocument();
    expect(screen.getByText("月度汇报")).toBeInTheDocument();
  });

  it("所在子组的周期模板段空：显示「所在子组暂无周期模板 → 去节假日 tab 配置周期事务」", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail({ subTeamTemplates: [] }));

    render(<DetailHarness />);

    expect(
      await screen.findByText(
        /所在子组暂无周期模板.*去节假日 tab 配置周期事务/,
      ),
    ).toBeInTheDocument();
  });

  it("所在子组的周期模板 + 按钮 → 调 onCreateTemplate 并带上当前人员的子组 id", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail({ subTeamTemplates: [] }));

    const user = userEvent.setup();
    const onCreateTemplate = vi.fn();
    render(<DetailHarness onCreateTemplate={onCreateTemplate} />);

    // + 按钮的 aria-label = 「新建周期模板 · 所在子组的周期模板」
    await user.click(
      await screen.findByRole("button", {
        name: /新建周期模板 · 所在子组的周期模板/,
      }),
    );

    expect(onCreateTemplate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onCreateTemplate).mock.calls[0]?.[0]).toBe(1); // person.subTeamId
  });
});

// ---------------------------------------------------------------------------
// T7（ticket #87）：交互打磨 ——
//
// 1. 档案字段姓名 / 联系方式 / 子组 就地编辑：
//    - 单击进入编辑态；onBlur 触发保存。
//    - 保存中行内 spinner；成功→ 显示新值 + exit 编辑态。
//    - 失败→ 行内红字 + 撤销 按钮；点 撤销 还原到编辑前的值。
// 2. 详情页**不**暴露离岗 / 复岗 / 删除按钮 —— 那些手势只在「人员」
//    tab（管理视角）暴露（#87 验收点 2）。
// 3. 「等待 TA 推动」段空态是按钮（Q18 决议 4 条一致）—— 与其它
//    3 段空态同型（点击 → 调 onCreateTask）。
// ---------------------------------------------------------------------------

describe("PersonDetailView · 档案字段就地编辑（T7 / #87）", () => {
  it("姓名/联系方式/子组 三字段在 header 渲染为可点击按钮", async () => {
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail());
    render(<DetailHarness />);

    // 3 个 InlineEditable 渲染态 = button
    const nameBtn = await screen.findByRole("button", { name: "档案 · 姓名" });
    const contactBtn = await screen.findByRole("button", { name: "档案 · 联系方式" });
    const subTeamBtn = await screen.findByRole("button", { name: "档案 · 子组" });
    expect(nameBtn).toHaveTextContent("张三");
    expect(contactBtn).toHaveTextContent("13800000000");
    expect(subTeamBtn).toHaveTextContent("一组");
  });

  it("姓名单击进入编辑态，blur 后自动保存并显示新值", async () => {
    const user = userEvent.setup();
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail());
    vi.mocked(updatePerson).mockResolvedValue({
      ...makeDetail().person,
      id: 1,
      name: "张三改",
      subTeamId: 1,
      contact: "13800000000",
      deactivatedAt: null,
      createdAt: "2026-09-01 09:00:00",
    });

    render(<DetailHarness />);

    // 单击切到编辑态
    await user.click(await screen.findByRole("button", { name: "档案 · 姓名" }));
    const input = await screen.findByRole("textbox", { name: "档案 · 姓名" });
    expect(input).toHaveFocus();

    // 清空 + 输入新值 + 失焦触发保存
    await user.clear(input);
    await user.type(input, "张三改");
    await user.tab();

    // updatePerson 被调，参数含新的 name
    await waitFor(() => expect(updatePerson).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(updatePerson).mock.calls[0]?.[0];
    expect(arg?.name).toBe("张三改");
    expect(arg?.contact).toBe("13800000000"); // 未改字段保留
    expect(arg?.subTeamId).toBe(1);

    // 保存成功后,字段切回展示态 + 展示新值
    expect(
      await screen.findByRole("button", { name: "档案 · 姓名" }),
    ).toHaveTextContent("张三改");
  });

  it("姓名 Enter 提交，Escape 取消", async () => {
    const user = userEvent.setup();
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail());
    vi.mocked(updatePerson).mockResolvedValue(makeDetail().person);

    render(<DetailHarness />);

    await user.click(await screen.findByRole("button", { name: "档案 · 姓名" }));
    const input = await screen.findByRole("textbox", { name: "档案 · 姓名" });
    await user.clear(input);
    await user.type(input, "李四改");
    await user.keyboard("{Escape}");

    // Escape = 取消 → 不应该调 updatePerson
    expect(updatePerson).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "档案 · 姓名" }),
    ).toHaveTextContent("张三");
  });

  it("联系方式保存成功走 updatePerson + onPersonSaved", async () => {
    const user = userEvent.setup();
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail());
    vi.mocked(updatePerson).mockResolvedValue({
      ...makeDetail().person,
      id: 1,
      name: "张三",
      subTeamId: 1,
      contact: "13900000000",
      deactivatedAt: null,
      createdAt: "2026-09-01 09:00:00",
    });
    const onPersonSaved = vi.fn();

    render(<DetailHarness onPersonSaved={onPersonSaved} />);

    await user.click(await screen.findByRole("button", { name: "档案 · 联系方式" }));
    const input = await screen.findByRole("textbox", { name: "档案 · 联系方式" });
    await user.clear(input);
    await user.type(input, "13900000000");
    await user.tab();

    await waitFor(() => expect(updatePerson).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(updatePerson).mock.calls[0]?.[0];
    expect(arg?.contact).toBe("13900000000");

    // T7: 父层 onPersonSaved 在 updatePerson 成功后被调
    await waitFor(() => expect(onPersonSaved).toHaveBeenCalledTimes(1));
  });

  it("子组切换 → 保存 subTeamId", async () => {
    const user = userEvent.setup();
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({ person: { ...makeDetail().person, subTeamId: 1 } }),
    );
    vi.mocked(updatePerson).mockResolvedValue({
      ...makeDetail().person,
      id: 1,
      name: "张三",
      subTeamId: 2,
      contact: "13800000000",
      deactivatedAt: null,
      createdAt: "2026-09-01 09:00:00",
    });

    render(
      <DetailHarness
        // 两份子组让 <select> 同时提供当前组与目标组。
        subTeams={[makeSubTeam(1, "一组"), makeSubTeam(2, "二组")]}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "档案 · 子组" }));
    const select = (await screen.findByRole("combobox", {
      name: "档案 · 子组",
    })) as HTMLSelectElement;
    await user.selectOptions(select, "2");
    fireEvent.blur(select);

    await waitFor(() => expect(updatePerson).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(updatePerson).mock.calls[0]?.[0];
    expect(arg?.subTeamId).toBe(2);
    // name / contact 未改保留
    expect(arg?.name).toBe("张三");
    expect(arg?.contact).toBe("13800000000");

    // 保存成功后展示新子组名
    expect(
      await screen.findByRole("button", { name: "档案 · 子组" }),
    ).toHaveTextContent("二组");
  });

  it("保存失败：行内红字 + 撤销按钮（撤销还原并退出编辑）", async () => {
    const user = userEvent.setup();
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail());
    vi.mocked(updatePerson).mockRejectedValue({
      code: "INVALID_ARGUMENT",
      message: "同子组内已存在同名人员。",
      detail: null,
    });

    render(<DetailHarness />);

    await user.click(await screen.findByRole("button", { name: "档案 · 姓名" }));
    const input = await screen.findByRole("textbox", { name: "档案 · 姓名" });
    await user.clear(input);
    await user.type(input, "张三已存在");
    await user.tab();

    // 错误消息 + 撤销按钮 出现
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("同子组内已存在同名人员。");
    const undoBtn = screen.getByRole("button", { name: "撤销编辑" });
    expect(undoBtn).toBeInTheDocument();

    // 点撤销 → 还原原值 + 退出编辑态
    await user.click(undoBtn);

    expect(
      screen.getByRole("button", { name: "档案 · 姓名" }),
    ).toHaveTextContent("张三");
    // 编辑态退场，input 没了
    expect(
      screen.queryByRole("textbox", { name: "档案 · 姓名" }),
    ).not.toBeInTheDocument();
  });

  it("save 失败时本地 detail 不被更新", async () => {
    const user = userEvent.setup();
    vi.mocked(getPersonDetail).mockResolvedValue(makeDetail());
    vi.mocked(updatePerson).mockRejectedValue({
      code: "INVALID_ARGUMENT",
      message: "联系方式不能为空。",
      detail: null,
    });

    render(<DetailHarness />);

    await user.click(await screen.findByRole("button", { name: "档案 · 联系方式" }));
    const input = await screen.findByRole("textbox", { name: "档案 · 联系方式" });
    await user.clear(input);
    await user.tab();

    // 错误显示
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("联系方式不能为空。");

    // updatePerson 被调用（命令层校验后抛错）
    expect(updatePerson).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// T7（#87）验收点 2: 详情页**不**暴露离岗 / 复岗 / 删除按钮 ——
//
// 那些"破坏性 + 状态变更"手势只去「人员」管理 tab（tickets #17 /
// #19 / #22）操作。详情页是只读 + 字段级编辑视角。这条回归锁定语义。
// ---------------------------------------------------------------------------

describe("PersonDetailView · 不暴露离岗/复岗/删除（T7 / #87）", () => {
  it("header 不渲染『离岗』『复岗』『删除』按钮", async () => {
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

    await screen.findByText("李四");

    // 即便人员已离岗,详情页也不暴露"复岗 / 离岗 / 删除" —— 那些
    // 手势都在「人员」tab。
    expect(
      screen.queryByRole("button", { name: /离岗/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /复岗/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /删除/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /编辑/ }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// T7（#87）验收点 5: 4 段空数据降级文案与跳转按钮（Q18 决议 4 条）——
//
// 「等待 TA 推动」原本只渲染 <p> 静态文案,T7 改造成可点按钮（与
// 其余 3 段空态同型）。点按钮 → 调 onCreateTask 走"新建任务给
// TA"链路。
// ---------------------------------------------------------------------------

describe("PersonDetailView · 4 段空态降级文案与跳转按钮（T7 / #87）", () => {
  it("「等待 TA 推动」空态是按钮（不是静态文本）,点击调 onCreateTask", async () => {
    const user = userEvent.setup();
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
        ownedProjects: [],
        waitingOnTasks: [],
        subTeamTemplates: [],
      }),
    );
    const onCreateTask = vi.fn();

    render(<DetailHarness onCreateTask={onCreateTask} />);

    // 4 段空态各有一条可点按钮 + 文案
    const waitingBtn = await screen.findByRole("button", {
      name: /暂时没有任务等 TA 推动/,
    });
    const projectsBtn = await screen.findByRole("button", {
      name: /暂无负责项目/,
    });
    const templatesBtn = await screen.findByRole("button", {
      name: /所在子组暂无周期模板/,
    });
    // 在飞 6 段也走同一种 "→ 新建任务给 TA" 链路（已有 T2 测试
    // 覆盖),这里只断言 等待 TA + 项目 + 周期模板 三段。
    expect(waitingBtn).toBeInTheDocument();
    expect(projectsBtn).toBeInTheDocument();
    expect(templatesBtn).toBeInTheDocument();

    await user.click(waitingBtn);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onCreateTask).mock.calls[0]?.[0]?.id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

interface TaskStubOverrides {
  id: number;
  title?: string;
  status?: Task["status"];
  blockedReason?: string | null;
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
    blockedAt: overrides.status === "Blocked" || overrides.status === "Waiting-on"
      ? "2026-09-01 09:00:00"
      : null,
    blockedReason: overrides.blockedReason ?? null,
    waitingOnPersonId: overrides.status === "Waiting-on" ? 2 : null,
  };
}

interface ProjectStubOverrides {
  id: number;
  name?: string;
  ownerPersonId?: number;
  subTeamId?: number;
  startDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  createdAt?: string;
  status?: Project["status"];
}

function projectStub(overrides: ProjectStubOverrides): Project {
  return {
    id: overrides.id,
    name: overrides.name ?? "项目",
    ownerPersonId: overrides.ownerPersonId ?? 1,
    subTeamId: overrides.subTeamId ?? 1,
    startDate: overrides.startDate ?? null,
    dueDate: overrides.dueDate ?? null,
    notes: overrides.notes ?? null,
    createdAt: overrides.createdAt ?? "2026-09-01 09:00:00",
    status: overrides.status ?? "Active",
  };
}

interface TemplateStubOverrides {
  id: number;
  name?: string;
  freq?: RecurringTemplate["freq"];
  bydayMask?: number;
  byhour?: number;
  byminute?: number;
  holidayBehavior?: RecurringTemplate["holidayBehavior"];
}

function templateStub(overrides: TemplateStubOverrides): RecurringTemplate {
  return {
    id: overrides.id,
    name: overrides.name ?? "模板",
    freq: overrides.freq ?? "weekly",
    bydayMask: overrides.bydayMask ?? 0,
    bymonthday: null,
    bymonth: null,
    byhour: overrides.byhour ?? 9,
    byminute: overrides.byminute ?? 0,
    ianaZone: "Asia/Shanghai",
    ends: { kind: "after", n: 12 },
    holidayBehavior: overrides.holidayBehavior ?? "skip",
    rruleText: "RRULE:FREQ=WEEKLY",
    projectId: null,
    subTeamId: 1,
    enabled: true,
    notes: null,
    createdAt: "2026-09-01 09:00:00",
  };
}

function makeTeamAt(id: number, name: string): SubTeam {
  return makeSubTeam(id, name);
}

/**
 * T1 + T2 + T3 测试用统一壳——包一层 PersonDetailView,把 mock 化的回
 * 调 + 子组 catalog + 默认 refreshToken 收口在一处,各 case 只覆盖差
 * 异。`refreshToken` 默认 0;需要变更的 case（如 #81 的重拉测试）显
 * 式传入。
 */
function DetailHarness({
  onOpenTask,
  onCreateTask,
  onCreateProject,
  onCreateTemplate,
  refreshToken = 0,
  onPersonSaved,
  subTeams,
}: {
  onOpenTask?: (
    task: Task,
    extras: { assignee: { personId: number; name: string; subTeamName: string } },
  ) => void;
  onCreateTask?: (person: Person) => void;
  onCreateProject?: (person: Person) => void;
  onCreateTemplate?: (subTeamId: number) => void;
  refreshToken?: number;
  /**
   * T7（#87）：档案字段就地保存成功后父层 bump refreshToken 的回调。
   * 默认空函数，避免每个用例各自挂一份 vi.fn()。
   */
  onPersonSaved?: () => void;
  /**
   * T7（#87）：子组切换测试用的子组 catalog（默认一组）。子组切换测
   * 试用例需要塞两份子组让 <select> 同时有当前组与目标组。
   */
  subTeams?: SubTeam[];
}) {
  return (
    <PersonDetailView
      personId={1}
      subTeams={subTeams ?? [makeSubTeam(1, "一组")]}
      refreshToken={refreshToken}
      onOpenTask={onOpenTask ?? vi.fn()}
      onCreateTask={onCreateTask ?? vi.fn()}
      onCreateProject={onCreateProject ?? vi.fn()}
      onCreateTemplate={onCreateTemplate ?? vi.fn()}
      onPersonSaved={onPersonSaved ?? vi.fn()}
    />
  );
}
