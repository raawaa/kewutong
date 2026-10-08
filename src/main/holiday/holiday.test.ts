import { describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { freshDb } from "../test/commands/fresh_db.js";
import { AppError } from "../error.js";
import * as Holiday from "./index.js";
import { HolidayCalendar } from "./index.js";

// ---------------------------------------------------------------------------
// 测试 fixture：临时目录写一份 cn-<year>.json，再 HolidayCalendar.load。
// ---------------------------------------------------------------------------

interface SeedFixture {
  dir: string;
  write(year: number, json: object): void;
  cleanup: () => void;
}

function seedDir(): SeedFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kewutong-holiday-"));
  return {
    dir,
    write(year, json) {
      fs.writeFileSync(path.join(dir, `cn-${year}.json`), JSON.stringify(json), "utf8");
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// 解析层 / 日历加载
// ---------------------------------------------------------------------------

describe("holiday / 种子文件解析与加载", () => {
  it("两个文件都缺时降级为空日历", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      const cal = HolidayCalendar.load(state.db, fx.dir, 2026);
      expect(cal.getLoadedYears()).toEqual([]);
      // 周末默认 = holiday
      expect(cal.kindOf("2026-10-03")).toBe("holiday"); // Sat
      // 普通 weekday = workday（不算调休）
      expect(cal.kindOf("2026-10-05")).toBe("workday"); // Mon
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("只缺下一年，当前年存在可启动", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, {
        holidays: [{ start: "2026-10-01", end: "2026-10-01", name: "国庆节" }],
        workdays: [],
      });
      const cal = HolidayCalendar.load(state.db, fx.dir, 2026);
      expect(cal.getLoadedYears()).toEqual([2026]);
      expect(cal.kindOf("2026-10-01")).toBe("holiday");
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("跨年区间按文件名年份截断", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      // 故意写一个跨年的区间——loader 应只保留属于本年的部分
      fx.write(2026, {
        holidays: [{ start: "2025-12-30", end: "2026-01-02", name: "元旦" }],
        workdays: [],
      });
      const cal = HolidayCalendar.load(state.db, fx.dir, 2026);
      expect(cal.kindOf("2026-01-01")).toBe("holiday");
      expect(cal.kindOf("2026-01-02")).toBe("holiday");
      // 2025 部分不在加载范围 → 回到默认 weekday
      // （2025-12-30 是 Tue，所以是 workday）
      expect(cal.kindOf("2025-12-30")).toBe("workday");
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("非法 JSON 抛 AppError.internal", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fs.writeFileSync(path.join(fx.dir, "cn-2026.json"), "{ this is not json", "utf8");
      let caught: unknown;
      try {
        HolidayCalendar.load(state.db, fx.dir, 2026);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).code).toBe("INTERNAL");
      expect((caught as AppError).detail).toMatch(/解析节假日文件/);
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("非 YYYY-MM-DD 日期字段被拒", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, {
        holidays: [{ start: "2026/10/01", end: "2026-10-01", name: "国庆节" }],
        workdays: [],
      });
      let caught: unknown;
      try {
        HolidayCalendar.load(state.db, fx.dir, 2026);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).detail).toMatch(/holidays\[0\].start 非法/);
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("顶层未知结构被拒", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fs.writeFileSync(path.join(fx.dir, "cn-2026.json"), JSON.stringify({ foo: 1 }), "utf8");
      let caught: unknown;
      try {
        HolidayCalendar.load(state.db, fx.dir, 2026);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).detail).toMatch(/顶层结构/);
    } finally {
      close();
      fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// kindOf / info 语义
// ---------------------------------------------------------------------------

describe("holiday / kindOf 与 info", () => {
  it("默认 weekday 既非 holiday 也非调休（makeup=false）", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, { holidays: [], workdays: [] });
      const cal = HolidayCalendar.load(state.db, fx.dir, 2026);
      // 2026-09-14 ~ 09-18 全是 Mon~Fri
      for (const d of ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"]) {
        expect(cal.kindOf(d)).toBe("workday");
      }
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("种子调休工作日返 makeup", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, {
        holidays: [],
        workdays: [{ start: "2026-10-10", end: "2026-10-10", name: "国庆节" }],
      });
      const cal = HolidayCalendar.load(state.db, fx.dir, 2026);
      expect(cal.kindOf("2026-10-10")).toBe("makeup");
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("默认周末返 holiday", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, { holidays: [], workdays: [] });
      const cal = HolidayCalendar.load(state.db, fx.dir, 2026);
      // 2026-10-03 = Sat, 10-04 = Sun
      expect(cal.kindOf("2026-10-03")).toBe("holiday");
      expect(cal.kindOf("2026-10-04")).toBe("holiday");
    } finally {
      close();
      fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// override 写入 / 优先级
// ---------------------------------------------------------------------------

describe("holiday / override 优先级与持久化", () => {
  it("override 覆盖 seed.kind", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, {
        holidays: [{ start: "2026-10-01", end: "2026-10-07", name: "国庆节" }],
        workdays: [],
      });
      const cal = HolidayCalendar.load(state.db, fx.dir, 2026);
      cal.setOverride(state.db, "2026-10-01", "workday");
      const info = cal.info("2026-10-01");
      expect(info.kind).toBe("workday");
      expect(info.source).toBe("override");
      // 其它日期仍是种子
      const info2 = cal.info("2026-10-02");
      expect(info2.kind).toBe("holiday");
      expect(info2.source).toBe("seed");
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("override 可把普通工作日翻成 holiday", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, { holidays: [], workdays: [] });
      const cal = HolidayCalendar.load(state.db, fx.dir, 2026);
      // 2026-09-14 = Mon 默认 workday
      cal.setOverride(state.db, "2026-09-14", "holiday");
      const info = cal.info("2026-09-14");
      expect(info.kind).toBe("holiday");
      expect(info.source).toBe("override");
      expect(cal.kindOf("2026-09-14")).toBe("holiday");
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("clearOverride 恢复种子", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, {
        holidays: [{ start: "2026-10-01", end: "2026-10-01", name: "国庆节" }],
        workdays: [],
      });
      const cal = HolidayCalendar.load(state.db, fx.dir, 2026);
      cal.setOverride(state.db, "2026-10-01", "workday");
      cal.clearOverride(state.db, "2026-10-01");
      const info = cal.info("2026-10-01");
      expect(info.kind).toBe("holiday");
      expect(info.source).toBe("seed");
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("setOverride 同日两次 → 后者覆盖前者（upsert）", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, { holidays: [], workdays: [] });
      const cal = HolidayCalendar.load(state.db, fx.dir, 2026);
      cal.setOverride(state.db, "2026-09-14", "holiday");
      cal.setOverride(state.db, "2026-09-14", "workday");
      expect(cal.info("2026-09-14").kind).toBe("workday");
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("跨进程：写 DB 后重 load 仍能见到 override", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, { holidays: [], workdays: [] });
      const a = HolidayCalendar.load(state.db, fx.dir, 2026);
      a.setOverride(state.db, "2026-09-14", "holiday");
      // 新 calendar 实例：模拟重启后从 DB 重读
      const b = HolidayCalendar.load(state.db, fx.dir, 2026);
      expect(b.info("2026-09-14")).toEqual({ kind: "holiday", name: null, source: "override" });
    } finally {
      close();
      fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 命令：loadHolidayCalendar
// ---------------------------------------------------------------------------

describe("holiday / loadHolidayCalendar 命令（#47）", () => {
  it("挂到 state.calendar 后 kindOf 生效", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, {
        holidays: [{ start: "2026-10-01", end: "2026-10-03", name: "国庆节" }],
        workdays: [],
      });
      const result = Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });
      expect(result.loadedYears).toEqual([2026]);
      expect(state.calendar.kindOf("2026-10-01")).toBe("holiday");
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("种子目录为空字符串拒绝", () => {
    const { state, close } = freshDb();
    try {
      expect(() => Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: "  " })).toThrow(
        /种子目录不能为空/,
      );
    } finally {
      close();
    }
  });

  it("year 非整数拒绝", () => {
    const { state, close } = freshDb();
    try {
      expect(() =>
        Holiday.loadHolidayCalendar(state, {
          year: 2026.5,
          seedDir: "/tmp",
        }),
      ).toThrow(/年份应为整数/);
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// 命令：holidayCalendar（#23 验收点）
// ---------------------------------------------------------------------------

describe("holiday / holidayCalendar 命令", () => {
  it("仅返回 Seed/Override 的 Holiday/Workday，默认工作日不返", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, {
        holidays: [{ start: "2026-10-01", end: "2026-10-03", name: "国庆节" }],
        workdays: [{ start: "2026-10-10", end: "2026-10-10", name: "国庆节" }],
      });
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });
      Holiday.setHolidayOverride(state, { date: "2026-10-15", kind: "holiday" });

      const days = Holiday.holidayCalendar(state, {
        startInclusive: "2026-10-01",
        endInclusive: "2026-10-31",
      });

      // 10/1 ~ 10/3 (3 条 seed holiday) + 10/10 (seed workday) + 10/15 (override holiday)
      // 不含 10/4 Sun（默认） / 10/5~10/9 Mon~Fri / 10/11~10/14 等
      expect(days.map((d) => d.date)).toEqual([
        "2026-10-01",
        "2026-10-02",
        "2026-10-03",
        "2026-10-10",
        "2026-10-15",
      ]);
      expect(days.find((d) => d.date === "2026-10-01")?.kind).toBe("holiday");
      expect(days.find((d) => d.date === "2026-10-01")?.source).toBe("seed");
      expect(days.find((d) => d.date === "2026-10-01")?.name).toBe("国庆节");
      expect(days.find((d) => d.date === "2026-10-10")?.kind).toBe("workday");
      expect(days.find((d) => d.date === "2026-10-15")?.source).toBe("override");
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("起始日 > 结束日拒绝", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });
      expect(() =>
        Holiday.holidayCalendar(state, {
          startInclusive: "2026-10-10",
          endInclusive: "2026-10-01",
        }),
      ).toThrow(/起始日不能晚于结束日/);
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("范围超过 92 天拒绝", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });
      expect(() =>
        Holiday.holidayCalendar(state, {
          startInclusive: "2026-01-01",
          endInclusive: "2026-05-01", // 120 天
        }),
      ).toThrow(/日历视图范围最多 92 天/);
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("非法日期格式拒绝（带字段名）", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });
      for (const bad of ["2026/09/10", "10-01", "2026-13-01", "明天", ""]) {
        expect(() =>
          Holiday.holidayCalendar(state, {
            startInclusive: bad,
            endInclusive: "2026-10-01",
          }),
        ).toThrow(/起始日/);
      }
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("单日范围（start == end）允许", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, {
        holidays: [{ start: "2026-10-01", end: "2026-10-01", name: "国庆节" }],
        workdays: [],
      });
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });
      const days = Holiday.holidayCalendar(state, {
        startInclusive: "2026-10-01",
        endInclusive: "2026-10-01",
      });
      expect(days).toEqual([
        { date: "2026-10-01", kind: "holiday", name: "国庆节", source: "seed" },
      ]);
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("空范围（无任何 seed/override）返空数组", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, { holidays: [], workdays: [] });
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });
      const days = Holiday.holidayCalendar(state, {
        startInclusive: "2026-10-01",
        endInclusive: "2026-10-31",
      });
      expect(days).toEqual([]);
    } finally {
      close();
      fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 命令：setHolidayOverride / clearHolidayOverride
// ---------------------------------------------------------------------------

describe("holiday / override 命令", () => {
  it("setHolidayOverride 写入并立即在 holidayCalendar 中可见", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, { holidays: [], workdays: [] });
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });

      Holiday.setHolidayOverride(state, { date: "2026-09-14", kind: "holiday" });

      const days = Holiday.holidayCalendar(state, {
        startInclusive: "2026-09-14",
        endInclusive: "2026-09-14",
      });
      expect(days).toEqual([
        { date: "2026-09-14", kind: "holiday", name: null, source: "override" },
      ]);
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("setHolidayOverride 拒绝非法类别", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });
      expect(() =>
        Holiday.setHolidayOverride(state, {
          date: "2026-09-14",
          // @ts-expect-error -- 故意传入非法值测试运行时校验
          kind: "bogus",
        }),
      ).toThrow(/holiday.*workday/);
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("setHolidayOverride 拒绝非法日期", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });
      expect(() =>
        Holiday.setHolidayOverride(state, { date: "2026/09/14", kind: "holiday" }),
      ).toThrow(/覆盖日期格式不对/);
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("clearHolidayOverride 后 holidayCalendar 立刻不见 override", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      fx.write(2026, { holidays: [], workdays: [] });
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });

      Holiday.setHolidayOverride(state, { date: "2026-09-14", kind: "holiday" });
      Holiday.clearHolidayOverride(state, { date: "2026-09-14" });

      const days = Holiday.holidayCalendar(state, {
        startInclusive: "2026-09-14",
        endInclusive: "2026-09-14",
      });
      expect(days).toEqual([]); // 09-14 周一，默认 workday → 不返
    } finally {
      close();
      fx.cleanup();
    }
  });

  it("clearHolidayOverride 拒绝非法日期", () => {
    const { state, close } = freshDb();
    const fx = seedDir();
    try {
      Holiday.loadHolidayCalendar(state, { year: 2026, seedDir: fx.dir });
      expect(() =>
        Holiday.clearHolidayOverride(state, { date: "not-a-date" }),
      ).toThrow(/覆盖日期格式不对/);
    } finally {
      close();
      fx.cleanup();
    }
  });
});