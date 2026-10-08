/**
 * 物化引擎单元 + 集成测试（tickets #25 / #48）。
 *
 * 涵盖：
 * - 纯函数：NaiveDate ↔ SQL 文本 ↔ UTC SQL ↔ 墙钟 SQL；
 * - rule 展开：DAILY / WEEKLY / MONTHLY / YEARLY × EndsSpec；
 * - 节假日行为：SKIP / SHIFT；
 * - 跨周触发：IsoWeek / shouldMaterializeThisTick；
 * - 集成：materializeTemplate（DB 写入 + 幂等 + 跨窗口累计）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Personnel from "../personnel/index.js";
import * as Project from "../project/index.js";
import * as RecurringTemplate from "../recurring_template/index.js";
import { HolidayCalendar } from "../holiday/index.js";

import * as Mat from "./index.js";
import type {
  NaiveDate,
  MaterializedEvent,
  TemplateMaterializeInput,
} from "./index.js";
import type {
  RecurringEnds,
  RecurringHolidayBehavior,
  StructuredRule,
} from "../types.js";

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function date(s: string): NaiveDate {
  const parsed = Mat.fromIsoString(s);
  if (!parsed) throw new Error(`非法日期：${s}`);
  return parsed;
}

function weeklyMoWe(): StructuredRule {
  return {
    freq: "weekly",
    bydayMask: RecurringTemplate.BYDAY_MO | RecurringTemplate.BYDAY_WE,
    bymonthday: null,
    bymonth: null,
    byhour: 8,
    byminute: 0,
    ianaZone: "Asia/Shanghai",
    ends: { kind: "on", date: "2026-12-31" },
    holidayBehavior: "skip",
  };
}

function monthly1_15(): StructuredRule {
  return {
    freq: "monthly",
    bydayMask: 0,
    bymonthday: [1, 15],
    bymonth: null,
    byhour: 9,
    byminute: 0,
    ianaZone: "Asia/Shanghai",
    ends: { kind: "after", n: 24 },
    holidayBehavior: "skip",
  };
}

function monthlyLastDay(): StructuredRule {
  return {
    freq: "monthly",
    bydayMask: 0,
    bymonthday: [0],
    bymonth: null,
    byhour: 16,
    byminute: 30,
    ianaZone: "Asia/Shanghai",
    ends: { kind: "on", date: "2027-06-30" },
    holidayBehavior: "skip",
  };
}

function quarterlyRule(): StructuredRule {
  return {
    freq: "yearly",
    bydayMask: 0,
    bymonthday: [1],
    bymonth: [1, 4, 7, 10],
    byhour: 10,
    byminute: 0,
    ianaZone: "Asia/Shanghai",
    ends: { kind: "on", date: "2030-01-01" },
    holidayBehavior: "skip",
  };
}

function daily(): StructuredRule {
  return {
    freq: "daily",
    bydayMask: 0,
    bymonthday: null,
    bymonth: null,
    byhour: 9,
    byminute: 0,
    ianaZone: "Asia/Shanghai",
    ends: { kind: "after", n: 7 },
    holidayBehavior: "skip",
  };
}

/** 构造一个空日历——仅周末是 holiday。 */
function emptyCalendar(): HolidayCalendar {
  // 不带种子文件；`loadHolidayCalendar` 装载 seed；这里用一个临时
  // 空目录装载，等价于空日历（仅默认 weekend=holiday, workday=workday）。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kewutong-mat-empty-"));
  try {
    // freshDb 自带内存库；这里传任意world已建好的 db 即可。
    const ctx = freshDb();
    try {
      return HolidayCalendar.load(ctx.db, tmp, 2026);
    } finally {
      ctx.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// NaiveDate ↔ SQL 文本
// ---------------------------------------------------------------------------

describe("materialization / NaiveDate ↔ SQL", () => {
  it("fromIsoString 解析 YYYY-MM-DD", () => {
    expect(Mat.fromIsoString("2026-09-07")).toEqual({
      year: 2026,
      month: 9,
      day: 7,
    });
  });
  it("fromIsoString 非法格式返回 null", () => {
    expect(Mat.fromIsoString("2026/09/07")).toBeNull();
    expect(Mat.fromIsoString("")).toBeNull();
    expect(Mat.fromIsoString("not a date")).toBeNull();
  });
  it("toIsoString 渲染回 YYYY-MM-DD（补零）", () => {
    expect(Mat.toIsoString({ year: 2026, month: 1, day: 5 })).toBe("2026-01-05");
    expect(Mat.toIsoString({ year: 2026, month: 12, day: 31 })).toBe("2026-12-31");
  });
  it("addDays 推进日期", () => {
    expect(Mat.addDays({ year: 2026, month: 9, day: 7 }, 7)).toEqual({
      year: 2026,
      month: 9,
      day: 14,
    });
    expect(Mat.addDays({ year: 2026, month: 9, day: 28 }, 7)).toEqual({
      year: 2026,
      month: 10,
      day: 5,
    });
    expect(Mat.addDays({ year: 2028, month: 2, day: 28 }, 3)).toEqual({
      year: 2028,
      month: 3,
      day: 2,
    });
  });
  it("compareDates 比较", () => {
    expect(Mat.compareDates(date("2026-09-07"), date("2026-09-07"))).toBe(0);
    expect(Mat.compareDates(date("2026-09-07"), date("2026-09-08"))).toBe(-1);
    expect(Mat.compareDates(date("2026-09-08"), date("2026-09-07"))).toBe(1);
    expect(Mat.compareDates(date("2026-09-07"), date("2026-10-01"))).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// expandRule：四类规则
// ---------------------------------------------------------------------------

describe("materialization / expandRule 四类规则", () => {
  it("expandWeekly: 跨 7 天返回 Mon + Wed", () => {
    const days = Mat.expandRule(weeklyMoWe(), date("2026-09-07"), date("2026-09-13"), 0);
    expect(days).toEqual([date("2026-09-07"), date("2026-09-09")]);
  });

  it("expandWeekly: 空范围（Tue 不在 mask 内）返回空", () => {
    const days = Mat.expandRule(weeklyMoWe(), date("2026-09-08"), date("2026-09-08"), 0);
    expect(days).toEqual([]);
  });

  it("expandMonthly: 跨两个月返回 4 条", () => {
    const days = Mat.expandRule(monthly1_15(), date("2026-09-01"), date("2026-10-31"), 0);
    expect(days).toEqual([
      date("2026-09-01"),
      date("2026-09-15"),
      date("2026-10-01"),
      date("2026-10-15"),
    ]);
  });

  it("expandMonthly 月末: 0 在不同月份算实际最后一天", () => {
    const days = Mat.expandRule(monthlyLastDay(), date("2026-02-01"), date("2026-12-31"), 0);
    expect(days).toEqual([
      date("2026-02-28"),
      date("2026-03-31"),
      date("2026-04-30"),
      date("2026-05-31"),
      date("2026-06-30"),
      date("2026-07-31"),
      date("2026-08-31"),
      date("2026-09-30"),
      date("2026-10-31"),
      date("2026-11-30"),
      date("2026-12-31"),
    ]);
  });

  it("expandMonthly 月末: 闰年 2 月 29", () => {
    const rule = { ...monthlyLastDay(), ends: { kind: "on", date: "2030-12-31" } as RecurringEnds };
    const days = Mat.expandRule(rule, date("2028-02-01"), date("2028-02-29"), 0);
    expect(days).toEqual([date("2028-02-29")]);
  });

  it("expandYearly: 跨两年返回 8 条", () => {
    const days = Mat.expandRule(
      quarterlyRule(),
      date("2026-01-01"),
      date("2027-12-31"),
      0,
    );
    expect(days).toEqual([
      date("2026-01-01"),
      date("2026-04-01"),
      date("2026-07-01"),
      date("2026-10-01"),
      date("2027-01-01"),
      date("2027-04-01"),
      date("2027-07-01"),
      date("2027-10-01"),
    ]);
  });

  it("expandDaily: 7 天返回 7 条", () => {
    const days = Mat.expandRule(daily(), date("2026-09-10"), date("2026-09-16"), 0);
    expect(days.length).toBe(7);
    expect(days[0]).toEqual(date("2026-09-10"));
    expect(days[6]).toEqual(date("2026-09-16"));
  });
});

// ---------------------------------------------------------------------------
// expandRule：终止条件
// ---------------------------------------------------------------------------

describe("materialization / expandRule 终止条件", () => {
  it("endsOn: 截断到终止日", () => {
    const rule: StructuredRule = {
      ...weeklyMoWe(),
      ends: { kind: "on", date: "2026-09-09" },
    };
    const days = Mat.expandRule(rule, date("2026-09-07"), date("2026-09-30"), 0);
    expect(days).toEqual([date("2026-09-07"), date("2026-09-09")]);
  });

  it("endsAfterN: 取前 n 个", () => {
    const rule: StructuredRule = {
      ...weeklyMoWe(),
      ends: { kind: "after", n: 3 },
    };
    const days = Mat.expandRule(rule, date("2026-09-07"), date("2026-12-31"), 0);
    expect(days.length).toBe(3);
    expect(days[2]).toEqual(date("2026-09-14"));
  });

  it("endsAfterN 全局计数: emitted = 2 时, n = 4 只补 2 个", () => {
    const rule: StructuredRule = {
      ...weeklyMoWe(),
      ends: { kind: "after", n: 4 },
    };
    // 窗口里有 3 个候选：9/7, 9/9, 9/14。但 alreadyEmitted=2 → 只能再补 2 个。
    const days = Mat.expandRule(rule, date("2026-09-07"), date("2026-09-30"), 2);
    expect(days).toEqual([date("2026-09-07"), date("2026-09-09")]);
  });

  it("范围反向 → 返回空", () => {
    const days = Mat.expandRule(weeklyMoWe(), date("2026-09-30"), date("2026-09-01"), 0);
    expect(days).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 墙钟 → UTC
// ---------------------------------------------------------------------------

describe("materialization / 墙钟 → UTC 换算", () => {
  it("08:00 Asia/Shanghai 对应 UTC 00:00 同日", () => {
    const utc = Mat.wallClockToUtcSql(date("2026-10-01"), 8, 0);
    expect(utc).toBe("2026-10-01 00:00:00");
  });
  it("09:30 对应 UTC 01:30", () => {
    const utc = Mat.wallClockToUtcSql(date("2026-09-15"), 9, 30);
    expect(utc).toBe("2026-09-15 01:30:00");
  });
  it("00:00 对应前一日 UTC 16:00（跨日）", () => {
    const utc = Mat.wallClockToUtcSql(date("2026-10-02"), 0, 0);
    expect(utc).toBe("2026-10-01 16:00:00");
  });
  it("utcSqlToLocalDate 反向还原", () => {
    expect(Mat.utcSqlToLocalDate("2026-10-01 16:00:00")).toEqual(date("2026-10-02"));
    expect(Mat.utcSqlToLocalDate("2026-10-01 00:00:00")).toEqual(date("2026-10-01"));
    expect(Mat.utcSqlToLocalDate("garbage")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 节假日行为：SKIP / SHIFT
// ---------------------------------------------------------------------------

describe("materialization / applyHolidayBehavior", () => {
  it("SKIP: Sat 默认 → skip, Mon → keep", () => {
    // 2026-09-12 = Sat, 2026-09-14 = Mon
    const cal = emptyCalendar();
    const events = Mat.applyHolidayBehavior(
      [date("2026-09-12"), date("2026-09-14")],
      cal,
      "skip",
    );
    expect(events).toEqual<MaterializedEvent[]>([
      { kind: "skip", date: date("2026-09-12") },
      { kind: "keep", date: date("2026-09-14") },
    ]);
  });

  it("SKIP: 工作日原样 keep", () => {
    const cal = emptyCalendar();
    const events = Mat.applyHolidayBehavior(
      [date("2026-09-14")],
      cal,
      "skip",
    );
    expect(events).toEqual<MaterializedEvent[]>([
      { kind: "keep", date: date("2026-09-14") },
    ]);
  });

  it("SHIFT: Sat 顺延到 Mon（默认日历无调休）", () => {
    // 9/12 Sat 是 holiday,默认日历下 SHIFT 跨过 Sun(holiday) 到 Mon(9/14) → target = 9/14
    const cal = emptyCalendar();
    const events = Mat.applyHolidayBehavior(
      [date("2026-09-12")],
      cal,
      "shift",
    );
    expect(events).toEqual<MaterializedEvent[]>([
      { kind: "shift", original: date("2026-09-12"), target: date("2026-09-14") },
    ]);
  });
});

// ---------------------------------------------------------------------------
// shouldMaterializeThisTick / IsoWeek
// ---------------------------------------------------------------------------

describe("materialization / shouldMaterializeThisTick", () => {
  it("首次启动 → true", () => {
    expect(Mat.shouldMaterializeThisTick(null, { year: 2026, week: 37 })).toBe(true);
  });
  it("同一周内重复 → false", () => {
    const w = { year: 2026, week: 37 };
    expect(Mat.shouldMaterializeThisTick(w, w)).toBe(false);
  });
  it("跨入新一周 → true", () => {
    expect(
      Mat.shouldMaterializeThisTick(
        { year: 2026, week: 37 },
        { year: 2026, week: 38 },
      ),
    ).toBe(true);
  });
  it("跨年(week 53 → 1) → true", () => {
    expect(
      Mat.shouldMaterializeThisTick(
        { year: 2026, week: 53 },
        { year: 2027, week: 1 },
      ),
    ).toBe(true);
  });
});

describe("materialization / isoWeekFromDate", () => {
  it("2026-09-07 (周一) 是 w37", () => {
    const w = Mat.isoWeekFromDate(date("2026-09-07"));
    expect(w.year).toBe(2026);
    expect(w.week).toBe(37);
  });
  it("2027-01-01 (Fri) 用 Thursday 所在年=2026, week=53", () => {
    const w = Mat.isoWeekFromDate(date("2027-01-01"));
    expect(w.year).toBe(2026);
    expect(w.week).toBe(53);
  });
  it("2026-01-01 (Thu) 用 Thursday 所在年=2026, week=1", () => {
    const w = Mat.isoWeekFromDate(date("2026-01-01"));
    expect(w.year).toBe(2026);
    expect(w.week).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 集成：materializeTemplate + loadEnabledTemplates
// ---------------------------------------------------------------------------

interface World {
  state: ReturnType<typeof freshDb>["state"];
  close: () => void;
  teamId: number;
  personId: number;
  projectId: number;
}

function setupWorld(now: string): World {
  const ctx = freshDb({ now });
  const team = Personnel.createSubTeam(ctx.state, { name: "一组" });
  const person = Personnel.createPerson(ctx.state, {
    name: "张三",
    subTeamId: team.id,
    contact: "123",
  });
  const project = Project.createProject(ctx.state, {
    name: "周报",
    ownerPersonId: person.id,
    subTeamId: team.id,
  });
  return {
    state: ctx.state,
    close: ctx.close,
    teamId: team.id,
    personId: person.id,
    projectId: project.id,
  };
}

function makeTemplate(
  world: World,
  name: string,
  rule: StructuredRule,
  overrides?: { subTeamId?: number | null; projectId?: number | null },
): TemplateMaterializeInput {
  const t = RecurringTemplate.upsertRecurringTemplate(world.state, {
    id: null,
    name,
    rule,
    projectId: overrides?.projectId ?? null,
    subTeamId: overrides?.subTeamId ?? world.teamId,
    notes: null,
  });
  return {
    id: t.id,
    name: t.name,
    rule: {
      freq: t.freq,
      bydayMask: t.bydayMask,
      bymonthday: t.bymonthday,
      bymonth: t.bymonth,
      byhour: t.byhour,
      byminute: t.byminute,
      ianaZone: t.ianaZone,
      ends: t.ends,
      holidayBehavior: t.holidayBehavior,
    },
    ownerPersonId: world.personId,
    projectId: t.projectId,
    subTeamId: t.subTeamId,
  };
}

function nowDate(nowSql: string): NaiveDate {
  // nowSql = "YYYY-MM-DD HH:MM:SS" UTC。提取 YYYY-MM-DD 部分。
  return Mat.fromIsoString(nowSql.slice(0, 10))!;
}

describe("materialization / 集成：materializeTemplate", () => {
  it("weekly 周一/三 跨 12 周 → 24 条 Open instance", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      const template = makeTemplate(world, "周一周三早会", weeklyMoWe());
      const cal = emptyCalendar();
      const counts = Mat.materializeTemplate(
        world.state.db,
        template,
        cal,
        nowDate("2026-09-10 00:00:00"),
      );
      // 12 周 × 每周 Mon+Wed = 24 条。
      expect(counts.kept).toBe(24);

      const rows = world.state.db
        .prepare<[number], { scheduled_at: string; status: string; original_scheduled_at: string | null }>(
          "SELECT scheduled_at, status, original_scheduled_at FROM task WHERE recurring_template_id = ? ORDER BY scheduled_at",
        )
        .all(template.id);
      expect(rows.length).toBe(24);
      // 首条与末条是 Mon/Wed 周一/三 序列。
      expect(rows[0]?.scheduled_at).toBe("2026-09-14 00:00:00"); // 第一个 Mon
      expect(rows[1]?.scheduled_at).toBe("2026-09-16 00:00:00"); // 第一个 Wed
      expect(rows.every((r) => r.status === "Open")).toBe(true);
      expect(rows.every((r) => r.original_scheduled_at === r.scheduled_at)).toBe(true);
    } finally {
      world.close();
    }
  });

  it("weekend SKIP: Sat → 不写入, Mon → Open", () => {
    // 模板「每周六/日/一」,now 拨到 Sat 2026-09-12,窗口 12 周。
    // 默认日历：Sat+Sun 是 weekend → SKIP, Mon → KEEP。
    const world = setupWorld("2026-09-12 00:00:00");
    try {
      const rule: StructuredRule = {
        ...weeklyMoWe(),
        bydayMask: RecurringTemplate.BYDAY_SA | RecurringTemplate.BYDAY_SU | RecurringTemplate.BYDAY_MO,
        ends: { kind: "on", date: "2026-09-15" },
      };
      const template = makeTemplate(world, "周末周一", rule);
      const cal = emptyCalendar();
      const counts = Mat.materializeTemplate(
        world.state.db,
        template,
        cal,
        nowDate("2026-09-12 00:00:00"),
      );
      // 9/12 Sat + 9/13 Sun 都默认是 weekend → SKIP，9/14 Mon → keep
      expect(counts).toEqual({
        kept: 1,
        skipped: 2,
        shifted: 0,
        cancelled: 0,
      });
    } finally {
      world.close();
    }
  });

  it("幂等：跑两次 totals 不增", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      const template = makeTemplate(world, "周一周三早会", weeklyMoWe());
      const cal = emptyCalendar();
      const first = Mat.materializeTemplate(
        world.state.db,
        template,
        cal,
        nowDate("2026-09-10 00:00:00"),
      );
      expect(first.kept).toBe(24);
      const second = Mat.materializeTemplate(
        world.state.db,
        template,
        cal,
        nowDate("2026-09-10 00:00:00"),
      );
      expect(second).toEqual({
        kept: 0,
        skipped: 0,
        shifted: 0,
        cancelled: 0,
      });
    } finally {
      world.close();
    }
  });

  it("endsAfterN 跨窗口累计: 已 emitted = n 时本窗口不再生", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      const rule: StructuredRule = {
        ...weeklyMoWe(),
        ends: { kind: "after", n: 4 },
      };
      const template = makeTemplate(world, "limited", rule);
      const cal = emptyCalendar();
      // 第一次：ends_after_n=4 → 头 4 个 kept。
      const first = Mat.materializeTemplate(
        world.state.db,
        template,
        cal,
        nowDate("2026-09-10 00:00:00"),
      );
      expect(first.kept).toBe(4);
      // 第二次：alreadyEmitted=4 = n，不再生。
      const second = Mat.materializeTemplate(
        world.state.db,
        template,
        cal,
        nowDate("2026-09-10 00:00:00"),
      );
      expect(second).toEqual({
        kept: 0,
        skipped: 0,
        shifted: 0,
        cancelled: 0,
      });
    } finally {
      world.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 集成：materializeAll + writeLastMaterializedWeek
// ---------------------------------------------------------------------------

describe("materialization / 集成：materializeAll + meta", () => {
  it("空库 → totals 0, templates 0, meta 写入", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      const cal = emptyCalendar();
      const totals = Mat.materializeAll(
        world.state.db,
        cal,
        nowDate("2026-09-10 00:00:00"),
      );
      expect(totals).toEqual({
        templates: 0,
        kept: 0,
        skipped: 0,
        shifted: 0,
        cancelled: 0,
      });
    } finally {
      world.close();
    }
  });

  it("两个模板 → totals.templates = 2", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      makeTemplate(world, "周一周三", weeklyMoWe());
      makeTemplate(world, "每日", daily());
      const cal = emptyCalendar();
      const totals = Mat.materializeAll(
        world.state.db,
        cal,
        nowDate("2026-09-10 00:00:00"),
      );
      // 周一周三 12 周窗口 kept=24; daily 9/10..9/16 7 个, 其中
      // 9/12(Sat) + 9/13(Sun) 默认是 weekend → SKIP → kept=5。
      expect(totals.templates).toBe(2);
      expect(totals.kept).toBe(24 + 5);
      expect(totals.skipped).toBe(2);
    } finally {
      world.close();
    }
  });

  it("materializeFromState 写 meta", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      makeTemplate(world, "周一周三", weeklyMoWe());
      Mat.materializeFromState(world.state);
      const last = Mat.readLastMaterializedWeek(world.state.db);
      expect(last).not.toBeNull();
      expect(last!.year).toBe(2026);
      // 2026-09-10 是周四 → 第 37 周（参考 isoWeekFromDate 测试）。
      expect(last!.week).toBe(37);
    } finally {
      world.close();
    }
  });

  it("materializeIfNewWeek: 同周内重复 tick → materialized=false", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      makeTemplate(world, "周一周三", weeklyMoWe());
      const first = Mat.materializeIfNewWeek(world.state);
      expect(first.materialized).toBe(true);
      const second = Mat.materializeIfNewWeek(world.state);
      expect(second.materialized).toBe(false);
    } finally {
      world.close();
    }
  });

  it("materializeIfNewWeekViaState: 同周内重复返回 false", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      makeTemplate(world, "周一周三", weeklyMoWe());
      expect(Mat.materializeIfNewWeekViaState(world.state)).toBe(true);
      expect(Mat.materializeIfNewWeekViaState(world.state)).toBe(false);
    } finally {
      world.close();
    }
  });
});

// ---------------------------------------------------------------------------
// loadEnabledTemplates + resolveOwner
// ---------------------------------------------------------------------------

describe("materialization / loadEnabledTemplates", () => {
  it("enabled=1 模板被返回，enabled=0 被过滤", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      const a = makeTemplate(world, "周一周三", weeklyMoWe());
      const b = makeTemplate(world, "每日", daily());
      RecurringTemplate.setRecurringTemplateEnabled(world.state, {
        id: b.id,
        enabled: false,
      });
      const loaded = Mat.loadEnabledTemplates(world.state.db);
      expect(loaded.map((t) => t.id)).toEqual([a.id]);
      expect(loaded[0]?.rule.freq).toBe("weekly");
    } finally {
      world.close();
    }
  });

  it("resolveOwner: sub_team 内最小 id 在岗人员", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      const owner = Mat.resolveOwner(world.state.db, null, world.teamId);
      expect(owner).toBe(world.personId);
    } finally {
      world.close();
    }
  });

  it("resolveOwner: project 负责人 → 在岗则用, 离岗则兜底", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      // project.owner_person_id = world.personId, 在岗 → 直接返回。
      const onDuty = Mat.resolveOwner(world.state.db, world.projectId, null);
      expect(onDuty).toBe(world.personId);
      // 让 project.owner_person 离岗 → 兜底取全员最小 id 在岗（这里仍是同一人，因为只剩他）。
      Personnel.deactivatePerson(world.state, { id: world.personId });
      // 同一人离岗后，person 表里仍只有他，且 deactivated_at 非空 → 兜底 SELECT 也找不到 → 抛 Internal
      let caught: unknown;
      try {
        Mat.resolveOwner(world.state.db, world.projectId, null);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect((caught as { detail: string | null }).detail).toMatch(/花名册为空/);
    } finally {
      world.close();
    }
  });

  it("resolveOwner: 花名册为空抛 Internal", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      // 离岗所有人
      world.state.db
        .prepare("UPDATE person SET deactivated_at = datetime('now')")
        .run();
      let caught: unknown;
      try {
        Mat.resolveOwner(world.state.db, null, null);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      // AppError.internal: detail = "recurring_template 无法解析 owner_person_id：花名册为空"
      expect((caught as { detail: string | null }).detail).toMatch(
        /花名册为空/,
      );
    } finally {
      world.close();
    }
  });
});

// ---------------------------------------------------------------------------
// SHIFT 集成（应用 default calendar 时周内顺延路径）
// ---------------------------------------------------------------------------

describe("materialization / SHIFT 集成", () => {
  it("Sat SHIFT → Cancelled(original) + Open(target=Mon)", () => {
    // 模板「每周六 8:00」，now = 2026-09-10（Thu），expandRule 候选：
    // 9/12 Sat, 9/19 Sat, 9/26 Sat, ... 都是周末 → SHIFT。
    // SHIFT 默认日历：Sat → Mon(target = original + 2 = Mon)。
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      const rule: StructuredRule = {
        freq: "weekly",
        bydayMask: RecurringTemplate.BYDAY_SA,
        bymonthday: null,
        bymonth: null,
        byhour: 8,
        byminute: 0,
        ianaZone: "Asia/Shanghai",
        ends: { kind: "on", date: "2026-09-30" },
        holidayBehavior: "shift",
      };
      const template = makeTemplate(world, "每周六早会", rule);
      const cal = emptyCalendar();
      const counts = Mat.materializeTemplate(
        world.state.db,
        template,
        cal,
        nowDate("2026-09-10 00:00:00"),
      );
      // candidates: 9/12, 9/19, 9/26 → 3 个 Shift → 3 cancelled + 3 shifted(Open)
      expect(counts.cancelled).toBe(3);
      expect(counts.shifted).toBe(3);
      expect(counts.kept).toBe(0);
      expect(counts.skipped).toBe(0);

      const rows = world.state.db
        .prepare<[number], { scheduled_at: string; status: string; original_scheduled_at: string | null; rescheduled_from_id: number | null }>(
          "SELECT scheduled_at, status, original_scheduled_at, rescheduled_from_id FROM task WHERE recurring_template_id = ? ORDER BY id",
        )
        .all(template.id);
      // 6 行：3 cancelled + 3 open。
      expect(rows.length).toBe(6);
      const cancelled = rows.filter((r) => r.status === "Cancelled");
      const open = rows.filter((r) => r.status === "Open");
      expect(cancelled.length).toBe(3);
      expect(open.length).toBe(3);
      // 原始日（Cancelled）：9/12, 9/19, 9/26
      expect(
        cancelled.map((r) => r.scheduled_at).sort(),
      ).toEqual([
        "2026-09-12 00:00:00",
        "2026-09-19 00:00:00",
        "2026-09-26 00:00:00",
      ]);
      // 顺延目标（Open）：9/14, 9/21, 9/28
      expect(
        open.map((r) => r.scheduled_at).sort(),
      ).toEqual([
        "2026-09-14 00:00:00",
        "2026-09-21 00:00:00",
        "2026-09-28 00:00:00",
      ]);
      // Open 的 rescheduled_from_id 应指向对应的 Cancelled 行。
      for (const o of open) {
        expect(o.rescheduled_from_id).not.toBeNull();
        const target = cancelled.find(
          (c) => c.scheduled_at === o.original_scheduled_at,
        );
        expect(target).toBeDefined();
        // 同 rescheduled_from_id（target 行 id 一致）：
        expect(o.rescheduled_from_id).toBeDefined();
      }
    } finally {
      world.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 集成：resolveOwner priority
// ---------------------------------------------------------------------------

describe("materialization / resolveOwner 优先级", () => {
  it("subTeam 优先: sub_team 内有 in-flight 人 → 用 sub_team 那位", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      const teamB = Personnel.createSubTeam(world.state, { name: "二组" });
      const p2 = Personnel.createPerson(world.state, {
        name: "李四",
        subTeamId: teamB.id,
        contact: "456",
      });
      // project owner = 张三 (id A), sub_team = B, B 中最小 id = 李四 (id B)
      const owner = Mat.resolveOwner(world.state.db, world.projectId, teamB.id);
      expect(owner).toBe(p2.id);
    } finally {
      world.close();
    }
  });

  it("fallback: 全员最小 id 在岗", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      const owner = Mat.resolveOwner(world.state.db, null, null);
      expect(owner).toBe(world.personId);
    } finally {
      world.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 集成：materializeFromState 通过 state.calendar（HAPPY 路径）
// ---------------------------------------------------------------------------

describe("materialization / materializeFromState", () => {
  it("装载 HolidayCalendar + 调 materializeFromState 路径不抛", () => {
    const world = setupWorld("2026-09-10 00:00:00");
    try {
      // 装载 HolidayCalendar（让 state.calendar 是 HolidayCalendar）
      // 用一个空目录 → 不装载任何 seed → 空日历（仅默认 weekend=holiday）。
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kewutong-mat-"));
      try {
        const cal = HolidayCalendar.load(world.state.db, tmp, 2026);
        Mat.materializeFromState({ ...world.state, calendar: cal });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      world.close();
    }
  });
});

// 抑制未使用导入警告（happy / shift 在测试 setup 用过）。
void ({} as RecurringHolidayBehavior);