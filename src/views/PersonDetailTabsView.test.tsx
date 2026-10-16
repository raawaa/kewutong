/**
 * 「人员详情」子 tab 基础设施（tickets #80 / #84 T4）的组件级验证。
 *
 * 范围：
 * - 子 tab 条渲染（标题 / × / （离岗）徽章 / （已删除）徽章 / 激活态切换）
 * - × 关闭单条 / 右键菜单 4 项（关闭其他 / 全部 / 左 / 右）
 * - 同一 personId 重复 → 不新增、只激活
 * - 拖拽重排（通过 onNavigation dispatch `ReorderPersonTabs` 验证 —— jsdom
 *   不支持完整 HTML5 DnD 事件链,fireDnd 直接 fire 原生事件触发 React 合成）
 * - 子 tab 列表空 → 占位文案
 * - 内容区 `hidden` 隐藏非激活 tab —— PersonDetailView 始终挂载,
 *   useState 保留(Q23)
 *
 * 命令层覆盖在 `src/main/personnel/personnel.test.ts`；本视图只测"拿到
 * catalog + 收到 IPC 失败后,前端怎么展示 + 用户怎么操作"。
 *
 * 派发端口:issue #98 把 8 类 sub-tab 事件折到 `onNavigation(PersonTabEvent)`
 * 一端口;断言用 `toHaveBeenCalledWith({kind:"...",...})` 落 event-shape,
 * 与 reducer table-driven 测试 (`src/views/navigation/state.test.ts`) 口径一致。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonDetailTabsView } from "./PersonDetailTabsView";
import {
  getPersonDetail,
  listPeople,
  listSubTeams,
  type Person,
  type PersonDetail,
  type SubTeam,
  type Task,
} from "@/lib/api";
import type { PersonDetailTabsEvent } from "@/views/navigation/state";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getPersonDetail: vi.fn(),
  listPeople: vi.fn(),
  listSubTeams: vi.fn(),
}));

function makePerson(id: number, overrides: Partial<Person> = {}): Person {
  return {
    id,
    name: `张三${id}`,
    subTeamId: 1,
    contact: "13800000000",
    deactivatedAt: null,
    createdAt: "2026-09-01 09:00:00",
    ...overrides,
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
      Open: [],
      "In-progress": [],
      Blocked: [],
      "Waiting-on": [],
      Done: [],
      Cancelled: [],
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
  // 默认 catalog 里有张三所在的子组,PersonDetailView 走 catalog,不
  // 触发 listSubTeams 兜底 IPC。
  vi.mocked(listSubTeams).mockResolvedValue([
    {
      id: 1,
      name: "一组",
      description: null,
      sortOrder: 0,
      createdAt: "2026-09-01 09:00:00",
    },
  ]);
  vi.mocked(getPersonDetail).mockImplementation(async ({ id }) =>
    makeDetail({
      person: {
        id,
        name: `人员 ${id}`,
        subTeamId: 1,
        contact: "13800000000",
        deactivatedAt: null,
        createdAt: "2026-09-01 09:00:00",
      },
    }),
  );
});

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

describe("PersonDetailTabsView · 渲染", () => {
  it("子 tab 列表空时显示浏览网格（搜索框 + 全员卡片）", () => {
    render(
      <Harness
        people={[
          makePerson(1, { name: "张三" }),
          makePerson(2, { name: "李四" }),
        ]}
      />,
    );
    // 不再显示 T4 的占位文案
    expect(
      screen.queryByText(/还没有打开任何人员的详情/),
    ).not.toBeInTheDocument();
    // 搜索框出现
    expect(
      screen.getByRole("searchbox", { name: /姓名.*子组名/ }),
    ).toBeInTheDocument();
    // 网格卡片渲染（按姓名查询）
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("李四")).toBeInTheDocument();
  });

  it("渲染子 tab 条 + 当前激活 tab 的详情", async () => {
    render(
      <Harness
        openPersonTabs={[
          { personId: 1 },
          { personId: 2 },
        ]}
        activePersonId={1}
      />,
    );

    // 等详情加载完(挂载后异步 IPC)。active=id=1 → 详情页档案字段按
    // 钮显示"人员 1"(PersonDetailView 内部从 getPersonDetail 取
    // name,与子 tab 标题的 catalog 名"张三1"不同——生产里两者一致,
    // 测试里 mock 拆分演示这个差异)
    // T7（#87）：姓名变成行内可编辑 `<button aria-label="档案 · 姓名">`,
    // 不再是 `<h2>` heading。
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "档案 · 姓名" }),
      ).toHaveTextContent("人员 1"),
    );

    // 两个子 tab 都渲染 —— 子 tab 标题来自父层 catalog,默认 "张三N"
    expect(screen.getByRole("tab", { name: "张三1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "张三2" })).toBeInTheDocument();

    // 激活态正确(id=1 的 tab aria-selected=true)
    expect(screen.getByRole("tab", { name: "张三1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "张三2" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("离岗人员子 tab 标题加「（离岗）」徽章", async () => {
    // 详情页返回的人员名 = "李四";catalog 也有"李四" → 子 tab 显示"李四"
    vi.mocked(getPersonDetail).mockResolvedValue(
      makeDetail({
        person: {
          id: 1,
          name: "李四",
          subTeamId: 1,
          contact: "111",
          deactivatedAt: "2026-08-01 09:00:00",
          createdAt: "2026-07-01 09:00:00",
        },
      }),
    );

    render(
      <Harness
        people={[
          makePerson(1, {
            name: "李四",
            deactivatedAt: "2026-08-01 09:00:00",
          }),
        ]}
        openPersonTabs={[{ personId: 1 }]}
        activePersonId={1}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "档案 · 姓名" }),
      ).toHaveTextContent("李四"),
    );

    expect(screen.getByText("（离岗）")).toBeInTheDocument();
  });

  it("catalog 缺失的人员子 tab 标题加「（已删除）」徽章", async () => {
    render(
      <Harness
        people={[
          // 只 catalog 中有 id=2,id=99 是"已删除"
          makePerson(2),
        ]}
        openPersonTabs={[{ personId: 99 }]}
        activePersonId={99}
      />,
    );

    // 不报"人员不存在或已被删除"alert
    await waitFor(() =>
      expect(screen.getByText("（已删除）")).toBeInTheDocument(),
    );
    // id=99 的子 tab 标题显示 fallback
    expect(screen.getByText("id=99 已被删除")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 浏览网格（T5 / ticket #85）
//
// 子 tab 列表空时显示：顶部搜索框 + 人员卡片网格（姓名 / 子组 / 在岗
// 徽章 / 离岗徽章 / 联系方式前 8 字）。点击卡片 → onOpenPerson(id) 走
// App 的 openPerson 入口——与其它真入口（矩阵 / PersonnelView / ⌘K
// / 任务负责人）行为同形（Q10 / Q23 决议）。
// ---------------------------------------------------------------------------

describe("PersonDetailTabsView · 浏览网格（#85）", () => {
  it("网格卡片显示：姓名 / 子组 / 在岗徽章 / 联系方式前 8 字", () => {
    render(
      <Harness
        people={[
          // 联系方式刚好 8 字 — 严格匹配展示前 8 字;长联系方式在另一条用例验。
          makePerson(1, { name: "张三", contact: "13800001" }),
          makePerson(2, { name: "李四", contact: "abcd1234" }),
        ]}
      />,
    );
    // 姓名
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("李四")).toBeInTheDocument();
    // 子组(两张卡同一子组 → 出现 2 次)
    expect(screen.getAllByText("一组")).toHaveLength(2);
    // 在岗徽章
    expect(screen.getAllByText("在岗")).toHaveLength(2);
    // 联系方式前 8 字 —— 严格 8 字时不带省略号
    expect(screen.getByText("13800001")).toBeInTheDocument();
    expect(screen.getByText("abcd1234")).toBeInTheDocument();
    // 不显示「在飞任务数」—— 与人员矩阵的「任务负载」维度区分(Q24/Q29)
    expect(screen.queryByText(/在飞/)).not.toBeInTheDocument();
  });

  it("联系方式超过 8 字时,卡片只截前 8 字 + 省略号", () => {
    render(
      <Harness
        people={[
          makePerson(1, { name: "张三", contact: "13800001234" }),
        ]}
      />,
    );
    // 完整联系方式在 title 属性里 —— hover 能看到
    expect(
      screen.getByTitle("13800001234"),
    ).toBeInTheDocument();
    // 卡片显示前 8 字 + 省略号 —— 严格匹配 textContent
    expect(screen.getByText("13800001…")).toBeInTheDocument();
  });

  it("离岗人员显示「离岗」徽章", () => {
    render(
      <Harness
        people={[
          makePerson(1, { name: "张三", deactivatedAt: "2026-08-01 09:00:00" }),
          makePerson(2, { name: "李四" }),
        ]}
      />,
    );
    // 张三是离岗,李四是在岗
    expect(screen.getByText("离岗")).toBeInTheDocument();
    expect(screen.getByText("在岗")).toBeInTheDocument();
  });

  it("搜索框按姓名子串过滤（不区分大小写）", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        people={[
          makePerson(1, { name: "张三" }),
          makePerson(2, { name: "李四" }),
        ]}
      />,
    );

    const search = screen.getByRole("searchbox", { name: /姓名.*子组名/ });
    // 大写英文,中文姓名"张三"不匹配
    await user.type(search, "ABC");
    expect(screen.getByText(/没有匹配的人员/)).toBeInTheDocument();

    // 清空 + 输入「李」 → 仅李四留下
    await user.clear(search);
    await user.type(search, "李");
    expect(screen.getByText("李四")).toBeInTheDocument();
    expect(screen.queryByText("张三")).not.toBeInTheDocument();
  });

  it("搜索框按子组名子串过滤（不区分大小写）", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        subTeams={[
          { id: 1, name: "一组", description: null, sortOrder: 0, createdAt: "2026-09-01 09:00:00" },
          { id: 2, name: "二组", description: null, sortOrder: 1, createdAt: "2026-09-01 09:00:00" },
        ]}
        people={[
          makePerson(1, { name: "张三", subTeamId: 1 }),
          makePerson(2, { name: "李四", subTeamId: 2 }),
        ]}
      />,
    );

    const search = screen.getByRole("searchbox", { name: /姓名.*子组名/ });
    await user.type(search, "二组");
    expect(screen.getByText("李四")).toBeInTheDocument();
    expect(screen.queryByText("张三")).not.toBeInTheDocument();
  });

  it("搜索是本地 in-memory 过滤——不发 IPC", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        people={[
          makePerson(1, { name: "张三" }),
          makePerson(2, { name: "李四" }),
        ]}
      />,
    );
    const search = screen.getByRole("searchbox", { name: /姓名.*子组名/ });
    // 网格只接受父层 catalog,无独立 IPC 入口 —— 渲染中没新增 listPeople 调用,
    // 搜索纯客户端 .includes()。这是「不引入额外 IPC」的实测:
    // 整个 PersonDetailTabsView 一次渲染后,输入搜索关键字不应触发
    // listPeople 调用 —— listPeople 仍是父层 catalog 的事。
    await user.type(search, "李");

    expect(screen.getByText("李四")).toBeInTheDocument();
    // 直接断言 listPeople 没在本测试里被调到 —— 网格层无 IPC 入口。
    expect(vi.mocked(listPeople)).not.toHaveBeenCalled();
  });

  it("点击网格卡片派发 OpenPerson(personId)", async () => {
    const user = userEvent.setup();
    const onNavigation = vi.fn<(event: PersonDetailTabsEvent) => void>();
    render(
      <Harness
        people={[makePerson(42, { name: "王五" })]}
        onNavigation={onNavigation}
      />,
    );

    // 用 byText 找到名字,再找最近的 button —— 卡片 = button
    const card = screen.getByRole("button", { name: /王五/ });
    await user.click(card);

    expect(onNavigation).toHaveBeenCalledWith({
      kind: "OpenPerson",
      personId: 42,
    });
  });

  it("catalog 为空时显示「还没有人员」提示(不显示搜索框)", () => {
    render(<Harness people={[]} />);
    expect(screen.getByText(/还没有人员/)).toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: /姓名.*子组名/ }),
    ).not.toBeInTheDocument();
  });

  it("关闭最后一个子 tab → 自动回到网格", async () => {
    const onNavigation = vi.fn<(event: PersonDetailTabsEvent) => void>();
    // 单元视图层的合同是「openPersonTabs=[] → 渲染浏览网格」。
    // 父层 App.tsx 的 reducer `CloseActiveSubTab` (issue #98) 已实
    // 现「最后一条关闭时,activeSubTabId→null + 数组清空」的同步收敛
    // （state.ts:reduceCloseActiveSubTab post-step reconcileActive）;
    // 本测试不重复测 App 状态机,只断言「只要上层给空数组 + null 激
    // 活,网格自动现身」（视图合同,不变量归 reducer）。
    const { rerender } = render(
      <Harness
        people={[
          makePerson(1, { name: "张三" }),
          makePerson(2, { name: "李四" }),
        ]}
        openPersonTabs={[{ personId: 1 }]}
        activePersonId={1}
        onNavigation={onNavigation}
      />,
    );

    // 激活的子 tab 渲染了 PersonDetailView —— 等头部 "人员 1" 档案字段按钮出来
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "档案 · 姓名" }),
      ).toHaveTextContent("人员 1"),
    );
    // 此刻不应有搜索框（列表非空 → 子 tab 内容区在,网格不显示）
    expect(
      screen.queryByRole("searchbox", { name: /姓名.*子组名/ }),
    ).not.toBeInTheDocument();

    // 模拟父层 closePersonTab 收敛后:列表空、激活态 null —— 网格重新出现
    rerender(
      <Harness
        people={[
          makePerson(1, { name: "张三" }),
          makePerson(2, { name: "李四" }),
        ]}
        openPersonTabs={[]}
        activePersonId={null}
      />,
    );
    // 网格(搜索框 + 张三 / 李四 卡片)出现
    expect(
      screen.getByRole("searchbox", { name: /姓名.*子组名/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("李四")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 切换 / 关闭
// ---------------------------------------------------------------------------

describe("PersonDetailTabsView · 切换 / 关闭", () => {
  it("点击子 tab 派发 ActivatePersonTab", async () => {
    const user = userEvent.setup();
    const onNavigation = vi.fn<(event: PersonDetailTabsEvent) => void>();
    render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={1}
        onNavigation={onNavigation}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "张三2" }));

    expect(onNavigation).toHaveBeenCalledWith({
      kind: "ActivatePersonTab",
      personId: 2,
    });
  });

  it("点 × 派发 ClosePersonTab（不附带 ActivatePersonTab）", async () => {
    const user = userEvent.setup();
    const onNavigation = vi.fn<(event: PersonDetailTabsEvent) => void>();
    render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={1}
        onNavigation={onNavigation}
      />,
    );

    // × 是嵌套在按钮里的 span role=button —— 直接 by aria-label
    const closeButton = screen.getByRole("button", {
      name: /关闭子 tab · 张三1/,
    });
    await user.click(closeButton);

    expect(onNavigation).toHaveBeenCalledWith({
      kind: "ClosePersonTab",
      personId: 1,
    });
    // 没有附带 ActivatePersonTab —— × 单纯关闭不切激活
    const activateCalls = onNavigation.mock.calls.filter(
      ([event]) => event.kind === "ActivatePersonTab",
    );
    expect(activateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

describe("PersonDetailTabsView · 右键菜单", () => {
  it("右键子 tab 显示 5 项菜单", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }, { personId: 3 }]}
        activePersonId={2}
      />,
    );

    // 默认不渲染菜单
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // 在 id=2 子 tab 上触发右键
    const tab = screen.getByRole("tab", { name: /张三2/ });
    await user.pointer({ target: tab, keys: "[MouseRight]" });

    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "关闭此",
      "关闭其他",
      "关闭全部",
      "关闭左侧",
      "关闭右侧",
    ]);
  });

  it("点「关闭此」派发 ClosePersonTab", async () => {
    const user = userEvent.setup();
    const onNavigation = vi.fn<(event: PersonDetailTabsEvent) => void>();
    render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={1}
        onNavigation={onNavigation}
      />,
    );

    const tab = screen.getByRole("tab", { name: /张三1/ });
    await user.pointer({ target: tab, keys: "[MouseRight]" });

    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "关闭此" }),
    );

    expect(onNavigation).toHaveBeenCalledWith({
      kind: "ClosePersonTab",
      personId: 1,
    });
  });

  it("点「关闭其他」派发 CloseOtherPersonTabs", async () => {
    const user = userEvent.setup();
    const onNavigation = vi.fn<(event: PersonDetailTabsEvent) => void>();
    render(
      <Harness
        openPersonTabs={[
          { personId: 1 },
          { personId: 2 },
          { personId: 3 },
        ]}
        activePersonId={2}
        onNavigation={onNavigation}
      />,
    );

    await user.pointer({
      target: screen.getByRole("tab", { name: /张三2/ }),
      keys: "[MouseRight]",
    });

    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "关闭其他" }),
    );

    expect(onNavigation).toHaveBeenCalledWith({
      kind: "CloseOtherPersonTabs",
      personId: 2,
    });
  });

  it("点「关闭全部」派发 CloseAllPersonTabs", async () => {
    const user = userEvent.setup();
    const onNavigation = vi.fn<(event: PersonDetailTabsEvent) => void>();
    render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={1}
        onNavigation={onNavigation}
      />,
    );

    await user.pointer({
      target: screen.getByRole("tab", { name: /张三1/ }),
      keys: "[MouseRight]",
    });

    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "关闭全部" }),
    );

    expect(onNavigation).toHaveBeenCalledWith({ kind: "CloseAllPersonTabs" });
  });

  it("点「关闭左侧」派发 CloseLeftPersonTabs", async () => {
    const user = userEvent.setup();
    const onNavigation = vi.fn<(event: PersonDetailTabsEvent) => void>();
    render(
      <Harness
        openPersonTabs={[
          { personId: 1 },
          { personId: 2 },
          { personId: 3 },
        ]}
        activePersonId={2}
        onNavigation={onNavigation}
      />,
    );

    await user.pointer({
      target: screen.getByRole("tab", { name: /张三2/ }),
      keys: "[MouseRight]",
    });

    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "关闭左侧" }),
    );

    expect(onNavigation).toHaveBeenCalledWith({
      kind: "CloseLeftPersonTabs",
      personId: 2,
    });
  });

  it("点「关闭右侧」派发 CloseRightPersonTabs", async () => {
    const user = userEvent.setup();
    const onNavigation = vi.fn<(event: PersonDetailTabsEvent) => void>();
    render(
      <Harness
        openPersonTabs={[
          { personId: 1 },
          { personId: 2 },
          { personId: 3 },
        ]}
        activePersonId={2}
        onNavigation={onNavigation}
      />,
    );

    await user.pointer({
      target: screen.getByRole("tab", { name: /张三2/ }),
      keys: "[MouseRight]",
    });

    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "关闭右侧" }),
    );

    expect(onNavigation).toHaveBeenCalledWith({
      kind: "CloseRightPersonTabs",
      personId: 2,
    });
  });

  it("第一条子 tab 时「关闭左侧」禁用", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={1}
      />,
    );

    await user.pointer({
      target: screen.getByRole("tab", { name: /张三1/ }),
      keys: "[MouseRight]",
    });

    const closeLeft = within(screen.getByRole("menu")).getByRole("menuitem", {
      name: "关闭左侧",
    });
    expect(closeLeft).toBeDisabled();
  });

  it("最后一条子 tab 时「关闭右侧」禁用", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={2}
      />,
    );

    await user.pointer({
      target: screen.getByRole("tab", { name: /张三2/ }),
      keys: "[MouseRight]",
    });

    const closeRight = within(screen.getByRole("menu")).getByRole("menuitem", {
      name: "关闭右侧",
    });
    expect(closeRight).toBeDisabled();
  });

  it("菜单打开后,点击菜单外部关闭菜单", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={1}
      />,
    );

    await user.pointer({
      target: screen.getByRole("tab", { name: /张三1/ }),
      keys: "[MouseRight]",
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // 点其它地方(空白处)—— 这里点外层 <main> 的 sibling,通过 body 触发
    await user.click(document.body);

    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });

  it("按 Escape 关闭菜单", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={1}
      />,
    );

    await user.pointer({
      target: screen.getByRole("tab", { name: /张三1/ }),
      keys: "[MouseRight]",
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });
});

// ---------------------------------------------------------------------------
// 拖拽重排
// ---------------------------------------------------------------------------

describe("PersonDetailTabsView · 拖拽重排", () => {
  it("拖拽派发 ReorderPersonTabs(from, to)", () => {
    const onNavigation = vi.fn<(event: PersonDetailTabsEvent) => void>();
    render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }, { personId: 3 }]}
        activePersonId={1}
        onNavigation={onNavigation}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    const source = tabs[0]!; // personId=1
    const target = tabs[2]!; // personId=3

    // 模拟 HTML5 DnD —— jsdom 不提供完整 dataTransfer,但 React 的
    // onDragStart/Over/Drop 接受合成事件,只要事件被触发即可。
    fireDnd(source, "dragstart");
    fireDnd(target, "dragover");
    fireDnd(target, "drop");

    expect(onNavigation).toHaveBeenCalledWith({
      kind: "ReorderPersonTabs",
      from: 0,
      to: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// 内容区 DOM 保留
// ---------------------------------------------------------------------------

describe("PersonDetailTabsView · 内容区 DOM 保留（Q23）", () => {
  it("切换激活 tab 时,非激活 tab 的 PersonDetailView 仍挂载", async () => {
    // 给 id=1 返回特定 inFlightOpen,给 id=2 返回另一组 —— 切换激活后,
    // 不再激活的 tab 内 PersonDetailView 仍能在 DOM 中找到(只是 hidden)。
    vi.mocked(getPersonDetail).mockImplementation(async ({ id }) => {
      if (id === 1) {
        return makeDetail({
          person: {
            id: 1,
            name: "甲",
            subTeamId: 1,
            contact: "1",
            deactivatedAt: null,
            createdAt: "2026-09-01 09:00:00",
          },
          inFlight: {
            Open: [
              {
                id: 100,
                title: "甲-Open-1",
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
              },
            ],
            "In-progress": [],
            Blocked: [],
            "Waiting-on": [],
            Done: [],
            Cancelled: [],
          },
        });
      }
      return makeDetail({
        person: {
          id: 2,
          name: "乙",
          subTeamId: 1,
          contact: "2",
          deactivatedAt: null,
          createdAt: "2026-09-01 09:00:00",
        },
      });
    });

    const { rerender } = render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={1}
      />,
    );

    // 等甲详情加载完
    await waitFor(() =>
      expect(screen.getByText("甲-Open-1")).toBeInTheDocument(),
    );
    // 乙详情此时也加载了(挂载在非激活 panel,只 hidden)。
    // 用 `hidden: true` 才能查到非激活 panel 内的角色 —— testing-library
    // 默认隐藏元素不计入 a11y tree,与浏览器行为一致。
    // T7（#87）：档案姓名是 `<button aria-label="档案 · 姓名">`，不
    // 再是 `<h2>`，用该 aria-label 锁定两个 panel 内各自的姓名按钮。
    expect(
      screen.getAllByRole("button", { name: "档案 · 姓名", hidden: true })
        .find((b) => b.textContent === "乙"),
    ).toBeDefined();

    // 切换激活到 id=2
    rerender(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={2}
      />,
    );

    // 甲-Open-1 任务条目仍在 DOM 里(只是 hidden)
    expect(screen.getByText("甲-Open-1")).toBeInTheDocument();
    // 乙详情可见 —— 切换激活后,乙的姓名档案按钮 (T7 InlineEditableText)
    // 落到可见列表里。
    expect(
      screen.getByRole("button", { name: "档案 · 姓名" }),
    ).toHaveTextContent("乙");
    // 甲详情 panel 仍在 DOM,只是 hidden
    const panel1 = document.getElementById("person-tab-panel-1");
    const panel2 = document.getElementById("person-tab-panel-2");
    expect(panel1).not.toBeNull();
    expect(panel2).not.toBeNull();
    expect(panel1).toHaveAttribute("hidden");
    expect(panel2).not.toHaveAttribute("hidden");
  });

  it("refreshToken 变化时,所有已开子 tab 详情都重拉", async () => {
    let callCount = 0;
    vi.mocked(getPersonDetail).mockImplementation(async ({ id }) => {
      callCount += 1;
      return makeDetail({
        person: {
          id,
          name: `rev-${callCount}-id-${id}`,
          subTeamId: 1,
          contact: "x",
          deactivatedAt: null,
          createdAt: "2026-09-01 09:00:00",
        },
      });
    });

    const { rerender } = render(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={1}
        refreshToken={0}
      />,
    );

    await waitFor(() => expect(getPersonDetail).toHaveBeenCalledTimes(2));

    rerender(
      <Harness
        openPersonTabs={[{ personId: 1 }, { personId: 2 }]}
        activePersonId={1}
        refreshToken={1}
      />,
    );
    await waitFor(() => expect(getPersonDetail).toHaveBeenCalledTimes(4));
  });
});

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

interface HarnessProps {
  openPersonTabs?: ReadonlyArray<{ personId: number }>;
  activePersonId?: number | null;
  people?: ReadonlyArray<Person>;
  subTeams?: SubTeam[];
  refreshToken?: number;
  /**
   * 子 tab 单派发端口 —— PersonDetailTabsView 上 8 类 sub-tab 行为（`OpenPerson`
   * / 激活 / 关闭 / 重排）全折叠到这一个 callback（issue #98 AC：`PersonDetailTabsView`
   * props 仅留 `onNavigation` 一项 sub-tab event dispatch）。事件 type 由
   * `PersonTabEvent`（reducer 视图 sub-tab event 子集）TS 编译期锁定 —— 本
   * Harness 不暴露具体 `kind` 的窄 cb,只暴露完整的 `onNavigation`,断言
   * 侧 `expect(onNavigation).toHaveBeenCalledWith({ kind:"...", ... })` 落
   * event-shape 而不是命令名,贴合 reducer table-driven 测试风格
   * (`src/views/navigation/state.test.ts`)。
   */
  onNavigation?: (event: PersonDetailTabsEvent) => void;
  /** 内容区 dialog / pendingIntent 端口（非 sub-tab 事件），parent #99 /
   * #101 接 reducer case 体后,本视图承接的方式再议。 */
  onOpenTask?: (
    task: Task,
    extras: { assignee: { personId: number; name: string; subTeamName: string } },
  ) => void;
  onCreateTask?: (person: Person) => void;
}

function Harness(props: HarnessProps) {
  const subTeams: SubTeam[] =
    props.subTeams ?? [
      { id: 1, name: "一组", description: null, sortOrder: 0, createdAt: "2026-09-01 09:00:00" },
    ];
  const people: ReadonlyArray<Person> =
    props.people ?? [makePerson(1), makePerson(2), makePerson(3)];
  return (
    <PersonDetailTabsView
      openPersonTabs={props.openPersonTabs ?? []}
      activePersonId={props.activePersonId ?? null}
      people={people}
      subTeams={subTeams}
      refreshToken={props.refreshToken ?? 0}
      onNavigation={props.onNavigation ?? vi.fn()}
      onOpenTask={props.onOpenTask ?? vi.fn()}
      onCreateTask={props.onCreateTask ?? vi.fn()}
    />
  );
}

/**
 * jsdom 不实现 HTML5 DnD 的完整 dataTransfer 协议,但 React 用合成事件
 * 触发 `onDragStart/Over/Drop` 时,只要事件能正常 dispatch,业务回调
 * 就会被调用。`fireDnd` 用 `fireEvent` 风格合成原生事件 —— dragstart
 * 必需 (`dataTransfer.setData`),dragover / drop 走 bubbles + cancelable。
 */
function fireDnd(target: HTMLElement, kind: "dragstart" | "dragover" | "drop") {
  const cancelable = kind !== "dragstart";
  const event = new Event(kind, { bubbles: true, cancelable });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      setData: () => undefined,
      effectAllowed: "",
      dropEffect: "",
    },
  });
  target.dispatchEvent(event);
}
