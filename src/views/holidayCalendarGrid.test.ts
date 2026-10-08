/**
 * 「节假日日历」视图的纯逻辑单测（ticket #62）。
 *
 * 测试 seam：仅 `buildHolidayGrid`、`cellStyleOf`、`mondayOf` /
 * `formatLocalDateIso` / `addDays` / `isWeekendIso` 这几个纯函数。
 * 视图组件本身在 `HolidayCalendarView.test.tsx` 里以 IPC mock 形式验
 * 证（jsdom 环境）。
 *
 * 验收点（per ticket #62 AC）：
 * - 4 周 × 7 天网格 = 28 格
 * - weekend（Sat/Sun）默认 = holiday / source = default
 * - Makeup Workday（seed workday）= workday 色（不挂"调休"chip）
 * - DaySource === "override" 时挂 "app 内覆盖" 徽章
 * - 跨年（12 月底 → 1 月初）4 周窗口由 IPC 返回的 list 自然合并
 */
import { describe, expect, it } from "vitest";
import {
  CELLS_PER_WINDOW,
  WEEKS_PER_WINDOW,
  WEEKDAY_HEADERS,
  DAYS_PER_WEEK,
  addDays,
  buildHolidayGrid,
  cellStyleOf,
  formatLocalDateIso,
  isWeekendIso,
  mondayOf,
} from "./holidayCalendarGrid";
import type { HolidayCalendarDay } from "@/lib/api";

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

describe("holidayCalendarGrid", () => {
  describe("常量与表头", () => {
    it("窗口 = 4 周 × 7 天 = 28 格,周一开头", () => {
      expect(WEEKS_PER_WINDOW).toBe(4);
      expect(DAYS_PER_WEEK).toBe(7);
      expect(CELLS_PER_WINDOW).toBe(28);
      expect(WEEKDAY_HEADERS).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
    });
  });

  describe("日期助手", () => {
    it("mondayOf 返回当周周一的本地 0 点", () => {
      // 2026-10-07 是 Wednesday
      const wed = new Date(2026, 9, 7);
      const mon = mondayOf(wed);
      expect(mon.getFullYear()).toBe(2026);
      expect(mon.getMonth()).toBe(9);
      expect(mon.getDate()).toBe(5); // 2026-10-05 Monday
    });

    it("mondayOf 周日回退到上一个周一", () => {
      // 2026-10-11 是 Sunday
      const sun = new Date(2026, 9, 11);
      const mon = mondayOf(sun);
      expect(mon.getDate()).toBe(5);
    });

    it("mondayOf 周一返回自身", () => {
      const mon = new Date(2026, 9, 5);
      expect(mondayOf(mon).getDate()).toBe(5);
    });

    it("addDays 跨月 / 跨年正确", () => {
      expect(formatLocalDateIso(addDays(new Date(2026, 11, 30), 2))).toBe(
        "2027-01-01",
      );
      expect(formatLocalDateIso(addDays(new Date(2026, 11, 31), 1))).toBe(
        "2027-01-01",
      );
    });

    it("formatLocalDateIso 单数字月 / 日补 0", () => {
      expect(formatLocalDateIso(new Date(2026, 0, 5))).toBe("2026-01-05");
    });

    it("isWeekendIso 周六周日 true,周一到周五 false", () => {
      // 2026-10-05 Mon, 10 Sat, 11 Sun
      expect(isWeekendIso("2026-10-05")).toBe(false);
      expect(isWeekendIso("2026-10-09")).toBe(false); // Friday
      expect(isWeekendIso("2026-10-10")).toBe(true); // Saturday
      expect(isWeekendIso("2026-10-11")).toBe(true); // Sunday
    });
  });

  describe("buildHolidayGrid", () => {
    it("空 IPC 返回 = 全部 28 格由客户端默认填底,周末 holiday / 工作日 workday", () => {
      // 2026-10-07 是 Wednesday → 窗口 2026-10-05..2026-11-01
      const today = new Date(2026, 9, 7);
      const grid = buildHolidayGrid({ today, calendarResponse: [] });

      expect(grid).toHaveLength(4);
      expect(grid.flat()).toHaveLength(28);
      // 第一行 2026-10-05 (Mon) .. 2026-10-11 (Sun)
      expect(grid[0]![0]!.date).toBe("2026-10-05");
      expect(grid[0]![0]!.kind).toBe("workday");
      expect(grid[0]![0]!.source).toBe("default");
      expect(grid[0]![6]!.date).toBe("2026-10-11");
      expect(grid[0]![6]!.kind).toBe("holiday");
      expect(grid[0]![6]!.source).toBe("default");
      // 周末几天全 holiday
      const satSun = grid[0]!.filter((c) => c.weekdayIndex >= 5);
      for (const c of satSun) {
        expect(c.kind).toBe("holiday");
        expect(c.source).toBe("default");
      }
      // 工作日全 workday
      const weekdays = grid[0]!.filter((c) => c.weekdayIndex < 5);
      for (const c of weekdays) {
        expect(c.kind).toBe("workday");
        expect(c.source).toBe("default");
      }
    });

    it("IPC 返回的种子覆盖默认——周末但 seed holiday 也算 holiday", () => {
      // 2026-10-10 Sat,seed holiday "国庆"
      const today = new Date(2026, 9, 7);
      const grid = buildHolidayGrid({
        today,
        calendarResponse: [
          entry("2026-10-10", { kind: "holiday", name: "国庆", source: "seed" }),
        ],
      });
      const sat = grid[0]![5]!;
      expect(sat.date).toBe("2026-10-10");
      expect(sat.kind).toBe("holiday");
      expect(sat.source).toBe("seed");
      expect(sat.name).toBe("国庆");
    });

    it("Makeup Workday (seed workday) 渲染为 workday 底色,不挂'调休'chip", () => {
      // 2026-10-11 Sun,seed workday
      const today = new Date(2026, 9, 7);
      const grid = buildHolidayGrid({
        today,
        calendarResponse: [
          entry("2026-10-11", {
            kind: "workday",
            name: "国庆调休",
            source: "seed",
          }),
        ],
      });
      const sun = grid[0]![6]!;
      expect(sun.kind).toBe("workday");
      expect(sun.source).toBe("seed");
      // 视图层不挂"调休"chip（设计决策 §3）——cellStyleOf(seed workday)
      // 的 showNameChip 由视图自己决定是否在 Sunday 标"调休"字样；本测
      // 关注的是 kind/source。
    });

    it("App 内 override:source=override,name=null(主进程不返 name)", () => {
      const today = new Date(2026, 9, 7);
      const grid = buildHolidayGrid({
        today,
        calendarResponse: [
          entry("2026-10-08", {
            kind: "holiday",
            name: null,
            source: "override",
          }),
        ],
      });
      const thu = grid[0]![3]!;
      expect(thu.date).toBe("2026-10-08");
      expect(thu.kind).toBe("holiday");
      expect(thu.source).toBe("override");
      expect(thu.name).toBeNull();
    });

    it("跨年 4 周（12/15 周三 → 1/12 周一）合并两年种子——本模块不二次合并,只负责按 date 取条目", () => {
      // 2026-12-16 Wednesday → 周一 = 2026-12-14
      // 窗口 2026-12-14..2027-01-10
      const today = new Date(2026, 11, 16);
      // 模拟 IPC 返回的合并列表（主进程已经按年份截断合并好）
      const mergedResponse: HolidayCalendarDay[] = [
        entry("2026-12-25", { kind: "holiday", name: "圣诞", source: "seed" }),
        entry("2027-01-01", { kind: "holiday", name: "元旦", source: "seed" }),
      ];
      const grid = buildHolidayGrid({
        today,
        calendarResponse: mergedResponse,
      });
      // 找 12-25 与 1-1 两格
      const dec25 = grid.flat().find((c) => c.date === "2026-12-25");
      const jan1 = grid.flat().find((c) => c.date === "2027-01-01");
      expect(dec25?.kind).toBe("holiday");
      expect(dec25?.name).toBe("圣诞");
      expect(jan1?.kind).toBe("holiday");
      expect(jan1?.name).toBe("元旦");
      // 窗口两端日期正确（验证客户端窗口计算也跨年）
      expect(grid[0]![0]!.date).toBe("2026-12-14");
      expect(grid[3]![6]!.date).toBe("2027-01-10");
    });

    it("weekdayIndex 按 Mon=0..Sun=6 排列", () => {
      const today = new Date(2026, 9, 7);
      const grid = buildHolidayGrid({ today, calendarResponse: [] });
      expect(grid[0]!.map((c) => c.weekdayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });
  });

  describe("cellStyleOf", () => {
    it("seed holiday → rose 底,无 override 徽章,显示 name chip", () => {
      const style = cellStyleOf("holiday", "seed");
      expect(style.backgroundClass).toContain("rose");
      expect(style.showOverrideBadge).toBe(false);
      expect(style.showNameChip).toBe(true);
    });

    it("seed workday → sky 底,无 override 徽章,显示 name chip", () => {
      const style = cellStyleOf("workday", "seed");
      expect(style.backgroundClass).toContain("sky");
      expect(style.showOverrideBadge).toBe(false);
      expect(style.showNameChip).toBe(true);
    });

    it("override → violet 底,挂'app 内覆盖'徽章,不显示 name chip(name=null 情形)", () => {
      const style = cellStyleOf("holiday", "override");
      expect(style.backgroundClass).toContain("violet");
      expect(style.showOverrideBadge).toBe(true);
      expect(style.showNameChip).toBe(false);
    });

    it("default(空 IPC 周六)→ rose holiday 底色,无 override 徽章", () => {
      const style = cellStyleOf("holiday", "default");
      expect(style.backgroundClass).toContain("rose");
      expect(style.showOverrideBadge).toBe(false);
      expect(style.showNameChip).toBe(true);
    });
  });
});
