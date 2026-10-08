/**
 * @vitest-environment jsdom
 *
 * 「节假日日历」视图的组件级验证（ticket #62）。
 *
 * 验收点：
 * - 4 周 × 7 天 = 28 格（DOM 计数）
 * - 跨年 IPC 区间拉一次：起 = 当周 Monday / 止 = Monday + 27 天
 * - source=override 的格子挂"app 内覆盖"徽章
 * - DTO 字段名全程 camelCase,与主进程 `HolidayCalendarArgs` 对齐
 * - 缺种子 / 空响应时正常渲染 28 格,周末 = holiday 底
 *
 * 注入 today：组件接受 `now` prop,测试用固定日期；生产不传,组件
 * 内部 `new Date()`。这样既不依赖全局 fake timers（避免 jsdom 调
 * 度阻塞）,又能精确断言跨年窗口。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { screen, waitFor } from "@testing-library/dom";
import { HolidayCalendarView } from "./HolidayCalendarView";
import { holidayCalendar, type HolidayCalendarDay } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  holidayCalendar: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(holidayCalendar).mockReset();
});

/** 测试基准日期：2026-10-07 周三。窗口 = 2026-10-05..2026-11-01。 */
const NOW_OCT = new Date(2026, 9, 7, 10, 0, 0);
/** 跨年基准日期：2026-12-16 周三。窗口 = 2026-12-14..2027-01-10。 */
const NOW_DEC = new Date(2026, 11, 16, 16, 0, 0);

/** 构造一条 IPC DTO——只填测试关心的字段。 */
function entry(
  date: string,
  overrides: Partial<HolidayCalendarDay> = {},
): HolidayCalendarDay {
  return {
    date,
    kind: "holiday",
    name: null,
    source: "seed",
    ...overrides,
  };
}

describe("HolidayCalendarView", () => {
  it("渲染 28 格(4 周 × 7 天),列头 Mon..Sun", async () => {
    vi.mocked(holidayCalendar).mockResolvedValue([]);

    render(<HolidayCalendarView refreshToken={0} now={NOW_OCT} />);

    await waitFor(() =>
      expect(vi.mocked(holidayCalendar)).toHaveBeenCalledTimes(1),
    );
    expect(screen.getAllByRole("gridcell")).toHaveLength(28);
    // 列头
    expect(screen.getByRole("columnheader", { name: "一" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "日" })).toBeInTheDocument();
  });

  it("IPC 拉闭区间[当周 Monday, +27 天],字段名 camelCase(startInclusive / endInclusive)", async () => {
    vi.mocked(holidayCalendar).mockResolvedValue([]);

    render(<HolidayCalendarView refreshToken={0} now={NOW_OCT} />);

    await waitFor(() =>
      expect(vi.mocked(holidayCalendar)).toHaveBeenCalledWith({
        startInclusive: "2026-10-05",
        endInclusive: "2026-11-01",
      }),
    );
  });

  it("周末(无 IPC 行)默认 holiday 底,工作日默认 workday 底", async () => {
    vi.mocked(holidayCalendar).mockResolvedValue([]);

    render(<HolidayCalendarView refreshToken={0} now={NOW_OCT} />);

    // 等首次拉完
    await screen.findAllByRole("gridcell");
    // 2026-10-10 (Sat) + 2026-10-11 (Sun) 都是默认 holiday
    const sat = screen.getByRole("gridcell", { name: /2026-10-10/ });
    const sun = screen.getByRole("gridcell", { name: /2026-10-11/ });
    expect(sat.className).toMatch(/rose/);
    expect(sun.className).toMatch(/rose/);
    expect(sat.getAttribute("data-source")).toBe("default");
    // 2026-10-09 (Fri) 默认 workday
    const fri = screen.getByRole("gridcell", { name: /2026-10-09/ });
    expect(fri.className).toMatch(/sky/);
  });

  it("seed holiday 行带 name chip + rose 底", async () => {
    vi.mocked(holidayCalendar).mockResolvedValue([
      entry("2026-10-10", { kind: "holiday", name: "国庆", source: "seed" }),
    ]);

    render(<HolidayCalendarView refreshToken={0} now={NOW_OCT} />);

    const sat = await screen.findByRole("gridcell", { name: /2026-10-10/ });
    expect(sat.className).toMatch(/rose/);
    expect(sat.getAttribute("data-source")).toBe("seed");
    expect(sat.textContent).toContain("国庆");
  });

  it("override 行挂'app 内覆盖'徽章 + violet 底 + 不显示 name chip(name=null)", async () => {
    vi.mocked(holidayCalendar).mockResolvedValue([
      entry("2026-10-08", {
        kind: "holiday",
        name: null,
        source: "override",
      }),
    ]);

    render(<HolidayCalendarView refreshToken={0} now={NOW_OCT} />);

    const thu = await screen.findByRole("gridcell", { name: /2026-10-08/ });
    expect(thu.className).toMatch(/violet/);
    expect(thu.getAttribute("data-source")).toBe("override");
    // aria-label 包含"app 内覆盖"
    expect(thu.getAttribute("aria-label")).toMatch(/app 内覆盖/);
    // 徽章文案
    expect(thu.textContent).toContain("覆盖");
    // name chip 不显示（override 的 name 永远 null）
    expect(thu.textContent).not.toContain("国庆");
  });

  it("跨年窗口(12/16 周三 → 1/10 周日):IPC 区间正确,种子行从两端都填上", async () => {
    // 2026-12-16 Wed → 周一 = 2026-12-14,窗口止于 +27 天 = 2027-01-10
    vi.mocked(holidayCalendar).mockResolvedValue([
      entry("2026-12-25", { kind: "holiday", name: "圣诞", source: "seed" }),
      entry("2027-01-01", { kind: "holiday", name: "元旦", source: "seed" }),
    ]);

    render(<HolidayCalendarView refreshToken={0} now={NOW_DEC} />);

    // 窗口 = 2026-12-14 (Mon) ~ 2027-01-10 (Sun)
    await waitFor(() =>
      expect(vi.mocked(holidayCalendar)).toHaveBeenCalledWith({
        startInclusive: "2026-12-14",
        endInclusive: "2027-01-10",
      }),
    );
    // 两端 seed 都进了视图
    const dec25 = await screen.findByRole("gridcell", { name: /2026-12-25/ });
    expect(dec25.textContent).toContain("圣诞");
    const jan1 = screen.getByRole("gridcell", { name: /2027-01-01/ });
    expect(jan1.textContent).toContain("元旦");
  });

  it("refreshToken 增加时重新拉一次", async () => {
    vi.mocked(holidayCalendar).mockResolvedValue([]);

    const { rerender } = render(
      <HolidayCalendarView refreshToken={0} now={NOW_OCT} />,
    );
    await waitFor(() =>
      expect(vi.mocked(holidayCalendar)).toHaveBeenCalledTimes(1),
    );

    rerender(<HolidayCalendarView refreshToken={1} now={NOW_OCT} />);
    await waitFor(() =>
      expect(vi.mocked(holidayCalendar)).toHaveBeenCalledTimes(2),
    );
  });
});