// @vitest-environment jsdom
/**
 * App 外壳的组件级验证（ticket #19 验收点：「顶栏按钮与 ⌘N 都能在任意界面
 * 唤起新建弹窗」）。
 *
 * 这条验收点的要害是**在任意界面**——所以两个入口都要在切到另一个 tab
 * 之后再验一遍。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import {
  dataFileLocation,
  getPersonDetail,
  isSampleDataPresent,
  listDueDateOptions,
  listPeople,
  listProjects,
  listSubTeams,
  listTasks,
  personnelMatrix,
  todayWeek,
  trayStatus,
} from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  listDueDateOptions: vi.fn(),
  listAssigneeCandidates: vi.fn(),
  listTasks: vi.fn(),
  listPeople: vi.fn(),
  listSubTeams: vi.fn(),
  listProjects: vi.fn(),
  todayWeek: vi.fn(),
  trayStatus: vi.fn(),
  isSampleDataPresent: vi.fn(),
  dataFileLocation: vi.fn(),
  getPersonDetail: vi.fn(),
  personnelMatrix: vi.fn(),
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
  // 示例数据 banner——默认不存在,避免 banner 干扰断言。
  vi.mocked(isSampleDataPresent).mockResolvedValue({ present: false });
  vi.mocked(dataFileLocation).mockResolvedValue(null);
  // 默认未调用 getPersonDetail —— DEV 按钮不在 test 模式出现,
  // 但 mock 必须存在以防后续渲染中其它路径触发。
  vi.mocked(getPersonDetail).mockResolvedValue({
    person: {
      id: 1,
      name: "示例",
      subTeamId: 1,
      contact: "示例",
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
  });
});

/** 弹窗开着的判据：新建任务的对话框在 DOM 里。 */
function 新建弹窗() {
  return screen.queryByRole("dialog", { name: "新建任务" });
}

/**
 * 给一组默认 catalog —— 浏览网格（#85）的两个用例共享同一份人员 +
 * 子组种子数据,避免每个用例各写一份造成漂移。其余 list* 系列保持 beforeEach
 * 里的空数组默认(不关心时不应假手维护)。
 */
function mockRosterCatalog(): void {
  vi.mocked(listPeople).mockResolvedValue([
    {
      id: 1,
      name: "张三",
      subTeamId: 1,
      contact: "13800001234",
      deactivatedAt: null,
      createdAt: "2026-09-01 09:00:00",
    },
  ]);
  vi.mocked(listSubTeams).mockResolvedValue([
    {
      id: 1,
      name: "一组",
      description: null,
      sortOrder: 0,
      createdAt: "2026-09-01 09:00:00",
    },
  ]);
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

describe("App · 「人员详情」主 tab（tickets #80 / #84 T4）", () => {
  it("「人员详情」tab 出现在主导航", async () => {
    render(<App />);

    // 6 个 tab 标签全可见（spec #80 §Implementation #1: TABS 5 → 6）
    expect(
      screen.getByRole("button", { name: "今日 / 本周" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "人员矩阵" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "项目" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "人员" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "人员详情" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "节假日" })).toBeInTheDocument();
  });

  it("切到「人员详情」tab 显示浏览网格（搜索框 + 卡片）", async () => {
    const user = userEvent.setup();
    mockRosterCatalog();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "人员详情" }));

    // 子 tab 列表空 → 显示浏览网格（搜索框）
    expect(
      await screen.findByRole("searchbox", { name: /姓名.*子组名/ }),
    ).toBeInTheDocument();
    // 卡片渲染
    expect(await screen.findByText("张三")).toBeInTheDocument();
  });

  it("切到「人员详情」tab 时,⌘N 仍唤起新建弹窗", async () => {
    const user = userEvent.setup();
    mockRosterCatalog();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "人员详情" }));
    await screen.findByRole("searchbox", { name: /姓名.*子组名/ });
    await user.keyboard("{Meta>}n{/Meta}");

    await waitFor(() => expect(新建弹窗()).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// ticket #86 T6：dev-only「打开 person id=1 的子 tab」按钮已下线。
//
// 本期验证 T1 临时 seam **不再渲染**——4 个真入口（矩阵 / PersonnelView
// / TaskDialog / ⌘K）已替代该按钮。test 模式下 `import.meta.env.DEV` 不
// 为 true,但测试也覆盖了 prod 隐藏语义：DOM 中不该有"打开 person id=1"
// 按钮。
// ---------------------------------------------------------------------------

describe("App · T1 临时按钮已下线（#86 T6）", () => {
  it("test 模式不渲染 DEV 临时按钮", () => {
    render(<App />);

    expect(
      screen.queryByRole("button", { name: /打开 person id=1/ }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ticket #86 T6 配套：openPerson 共享入口的「add or focus」行为 + 子 tab
// 「关闭其他」锁定行为（review 时发现 closeOtherPersonTabs 之前曾被
// 误改成 !== —— 该用法与 JSDoc / 函数名相反，本块用集成测试锁死正确
// 行为 = filter 保留被点名的子 tab）。
// ---------------------------------------------------------------------------

describe("App · openPerson + 子 tab 关闭（#86 T6）", () => {
  /**
   * 给 App 准备一份足以让 4 个真入口（矩阵 / PersonnelView / TaskDialog
   * / ⌘K）都跑通转的最小 catalog：1 个子组 + 2 个不同人 + 一些任务，
   * 让矩阵卡片与 PersonnelView 行都各能点开两个不同 person。
   *
   * 测试既验证 openPerson 升级后的行为，又验证「关闭其他」语义——
   * 这里跑了一个端到端集成；openPerson 的命令面板分支单独写在
   * CommandPalette.test.tsx。
   */
  function setupCatalog() {
    vi.mocked(listPeople).mockResolvedValue([
      {
        id: 1,
        name: "张三",
        subTeamId: 1,
        contact: "13800000001",
        deactivatedAt: null,
        createdAt: "2026-09-01 09:00:00",
      },
      {
        id: 2,
        name: "李四",
        subTeamId: 1,
        contact: "13800000002",
        deactivatedAt: null,
        createdAt: "2026-09-01 09:00:00",
      },
    ]);
    vi.mocked(listSubTeams).mockResolvedValue([
      {
        id: 1,
        name: "暖通",
        description: null,
        sortOrder: 0,
        createdAt: "2026-09-01 09:00:00",
      },
    ]);
    vi.mocked(personnelMatrix).mockResolvedValue({
      segments: [
        {
          subTeam: {
            id: 1,
            name: "暖通",
            description: null,
            sortOrder: 0,
            createdAt: "2026-09-01 09:00:00",
          },
          people: [
            {
              person: {
                id: 1,
                name: "张三",
                subTeamId: 1,
                contact: "13800000001",
                deactivatedAt: null,
                createdAt: "2026-09-01 09:00:00",
              },
              inFlightCount: 0,
              blockedCount: 0,
              tasks: [],
            },
            {
              person: {
                id: 2,
                name: "李四",
                subTeamId: 1,
                contact: "13800000002",
                deactivatedAt: null,
                createdAt: "2026-09-01 09:00:00",
              },
              inFlightCount: 0,
              blockedCount: 0,
              tasks: [],
            },
          ],
        },
      ],
    });
    vi.mocked(getPersonDetail).mockImplementation(async ({ id }) => ({
      person: {
        id,
        name: id === 1 ? "张三" : "李四",
        subTeamId: 1,
        contact: id === 1 ? "13800000001" : "13800000002",
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
    }));
  }

  it("矩阵点两个不同人 → 打开两个子 tab;再点其中一个 → 切到该子 tab(聚焦,不复新增)", async () => {
    const user = userEvent.setup();
    setupCatalog();
    render(<App />);

    // 切到「人员矩阵」,两张卡片渲染完
    await user.click(screen.getByRole("button", { name: "人员矩阵" }));
    const zhangBtn = await screen.findByRole("button", {
      name: /打开 张三 的详情/,
    });
    await user.click(zhangBtn);

    // 子 tab 渲染,切到「人员详情」tab
    await user.click(screen.getByRole("button", { name: "人员详情" }));
    const zhangTab = await screen.findByRole("tab", { name: /张三/ });
    expect(zhangTab).toBeInTheDocument();

    // 回矩阵再点李四 → 应**新增**第二条子 tab
    await user.click(screen.getByRole("button", { name: "人员矩阵" }));
    const liBtn = await screen.findByRole("button", {
      name: /打开 李四 的详情/,
    });
    await user.click(liBtn);
    await user.click(screen.getByRole("button", { name: "人员详情" }));

    // 两条子 tab 都出现
    expect(screen.getByRole("tab", { name: /张三/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /李四/ })).toBeInTheDocument();

    // 再点张三(已开) → 应聚焦已开条,**不新增第三条**
    await user.click(screen.getByRole("button", { name: "人员矩阵" }));
    const zhangBtn2 = await screen.findByRole("button", {
      name: /打开 张三 的详情/,
    });
    await user.click(zhangBtn2);
    await user.click(screen.getByRole("button", { name: "人员详情" }));

    // tab 总数仍 = 2;不新增
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("右键菜单「关闭其他」仅保留被点名的子 tab(锁定 review 发现过的回归)", async () => {
    // ticket #84 T4 起的 closeOtherPersonTabs 语义是"保留 personId
    // 这一条,关闭其余"。本块用集成测试锁死该合约——之前曾被误改为
    // `!==` 把被点名的也关掉了,review 时发现并修正。
    const user = userEvent.setup();
    setupCatalog();
    render(<App />);

    // 开两个人
    await user.click(screen.getByRole("button", { name: "人员矩阵" }));
    await user.click(
      await screen.findByRole("button", { name: /打开 张三 的详情/ }),
    );
    await user.click(screen.getByRole("button", { name: "人员详情" }));

    await user.click(screen.getByRole("button", { name: "人员矩阵" }));
    await user.click(
      await screen.findByRole("button", { name: /打开 李四 的详情/ }),
    );
    await user.click(screen.getByRole("button", { name: "人员详情" }));

    // 等两条子 tab 都在
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    // 右键「张三」tab → 「关闭其他」
    await user.pointer({
      target: screen.getByRole("tab", { name: /张三/ }),
      keys: "[MouseRight]",
    });
    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: "关闭其他",
      }),
    );

    // 现在只剩「张三」一条 ——李四这条被关闭,而不是张三自己
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: /张三/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /李四/ }),
    ).not.toBeInTheDocument();
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
