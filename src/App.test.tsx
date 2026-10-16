// @vitest-environment jsdom
/**
 * App 外壳的 shell 集成测试（ticket #101）。
 *
 * Shell 只持有 4 类 transient 状态（catalog / `refreshToken` / `trayStatusDto`），
 * 导航状态全入 `navigationReducer`。本测试只覆盖**shell**层契约:
 *
 *   1. catalog effect:初次 mount 触发重拉
 *   2. tray effect:mount 时拉一次(失败 = banner 保持 null,不臆测)
 *   3. window keydown gate:`tab !== "personDetail"` 时 ⌘W / ⌘⇧← / ⌘⇧→ 不拦截
 *   4. 全局 accelerator:⌘N / ⌘K 任意 tab 生效(不受 gate 影响)
 *   5. dispatch + render smoke:click → reducer → DOM 落地一条流
 *   6. 主 tab 表渲染(`state.ts` `TABS` 字面与渲染文本同源)
 *
 * 原 700+ LOC 的 DOM 路径测试（矩阵点两人增 tab / 右键关闭其他 / ⌘W 关激
 * 活子 tab / ⌘⇧← → clamp 切换 …）已在 `src/views/navigation/state.test.ts`
 * 1429 LOC reducer 表驱动 + scenario 里覆盖——本测试**不重复** reducer
 * 契约,只盯 shell 层「拉取策略 + 全局 keydown 入口 + 渲染落地」。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import {
  dataFileLocation,
  isSampleDataPresent,
  listAssigneeCandidates,
  listDueDateOptions,
  listPeople,
  listProjectCandidates,
  listProjects,
  listSubTeams,
  todayWeek,
  trayStatus,
  wayfinderSearch,
} from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  listPeople: vi.fn(),
  listSubTeams: vi.fn(),
  listProjects: vi.fn(),
  trayStatus: vi.fn(),
  todayWeek: vi.fn(),
  isSampleDataPresent: vi.fn(),
  dataFileLocation: vi.fn(),
  listDueDateOptions: vi.fn(),
  listAssigneeCandidates: vi.fn(),
  listProjectCandidates: vi.fn(),
  wayfinderSearch: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(listPeople).mockResolvedValue([]);
  vi.mocked(listSubTeams).mockResolvedValue([]);
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(trayStatus).mockResolvedValue({ available: true, reason: "" });
  vi.mocked(todayWeek).mockResolvedValue({
    counts: { activePeople: 0, inProgress: 0, blocked: 0 },
    buckets: { overdue: [], today: [], tomorrow: [], thisWeekRest: [] },
    materializationWindowEnd: "2026-12-31",
  });
  vi.mocked(isSampleDataPresent).mockResolvedValue({ present: false });
  vi.mocked(dataFileLocation).mockResolvedValue(null);
  vi.mocked(listDueDateOptions).mockResolvedValue([
    { chip: "today", label: "今天", dueDate: "2026-09-10" },
    { chip: "next-week", label: "一周后", dueDate: "2026-09-17" },
    { chip: "none", label: "无", dueDate: null },
  ]);
  vi.mocked(listAssigneeCandidates).mockResolvedValue([]);
  vi.mocked(listProjectCandidates).mockResolvedValue([]);
  vi.mocked(wayfinderSearch).mockResolvedValue({
    people: [],
    projects: [],
    tasks: [],
  });
});

describe("App · catalog effect（listPeople+listSubTeams+listProjects 同帧）", () => {
  it("初次 mount 各拉一次(StrictMode 下 ≥ 1 即覆盖 mount-once 合约)", async () => {
    render(<App />);
    await waitFor(() => {
      expect(listPeople).toHaveBeenCalled();
      expect(listSubTeams).toHaveBeenCalled();
      expect(listProjects).toHaveBeenCalled();
    });
  });
});

describe("App · tray effect on mount", () => {
  it("mount 时调一次 trayStatus（ticker #29）", async () => {
    render(<App />);
    await waitFor(() => expect(trayStatus).toHaveBeenCalled());
  });

  it("trayStatus rejected 时 banner 不渲染（不臆测 reason,issue #29 决策）", async () => {
    vi.mocked(trayStatus).mockRejectedValue(new Error("ipc 断了"));
    render(<App />);
    await waitFor(() => expect(trayStatus).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("trayStatus 不可用时渲染 reason banner", async () => {
    vi.mocked(trayStatus).mockResolvedValue({
      available: false,
      reason: "托盘初始化失败：缺少 libappindicator3-1",
    });
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("托盘初始化失败：缺少 libappindicator3-1");
  });
});

describe("App · window keydown gate（tab !== 'personDetail' 提前 return）", () => {
  it("默认 tab=today 时 ⌘W 不拦截（让 Electron 关窗手势走默认路径）", async () => {
    const user = userEvent.setup();
    render(<App />);
    // 默认 tab=today —— ⌘W 不该 preventDefault。不引发任何渲染反应,
    // 仅断言「键按下后 DOM 仍正常 + 主 tab 还在 today」。
    await user.keyboard("{Meta>}w{/Meta}");
    expect(screen.getByRole("button", { name: "今日 / 本周" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("默认 tab=today 时 ⌘⇧← 不拦截", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Meta>}{Shift>}{ArrowLeft}{/Shift}{/Meta}");
    expect(screen.getByRole("button", { name: "今日 / 本周" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("默认 tab=today 时 ⌘⇧→ 不拦截", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Meta>}{Shift>}{ArrowRight}{/Shift}{/Meta}");
    expect(screen.getByRole("button", { name: "今日 / 本周" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

describe("App · 全局 accelerator（⌘N / ⌘K 任意 tab 生效）", () => {
  it("⌘N 唤起新建弹窗 — shell useEffect 注册全局 keydown 并 dispatch OpenTaskDialog", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Meta>}n{/Meta}");
    expect(
      await screen.findByRole("dialog", { name: "新建任务" }),
    ).toBeInTheDocument();
  });

  it("⌘K 唤起命令面板 — dispatcher OpenPalette reducer 事件", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Meta>}k{/Meta}");
    // 命令面板 open 后一定有 input 元素（搜索框）
    expect(
      await screen.findByPlaceholderText(/搜人员|新建任务/),
    ).toBeInTheDocument();
  });
});

describe("App · dispatch + render smoke（→ reducer → DOM 落地一条流）", () => {
  it("点顶栏「新建任务」按钮 — click → OpenTaskDialog → dialog 落 DOM", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /新建任务/ }));
    expect(
      screen.getByRole("dialog", { name: "新建任务" }),
    ).toBeInTheDocument();
  });
});

describe("App · 主 tab 表渲染（state.ts TABS 字面同源）", () => {
  it("6 个主 tab 按钮全部可见", () => {
    render(<App />);
    expect(
      screen.getByRole("button", { name: "今日 / 本周" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "人员矩阵" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "项目" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "人员" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "人员详情" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "节假日" })).toBeInTheDocument();
  });

  it("点「项目」tab 切换 — dispatch SetTab + aria-current 落地", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "项目" }));
    expect(screen.getByRole("button", { name: "项目" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
