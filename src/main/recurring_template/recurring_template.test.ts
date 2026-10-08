import { describe, expect, it } from "vitest";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Personnel from "../personnel/index.js";
import * as Project from "../project/index.js";
import * as RT from "./index.js";
import type {
  RecurringTemplate,
  StructuredRule,
  UpsertRecurringTemplateArgs,
} from "../types.js";

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

interface World {
  state: ReturnType<typeof freshDb>["state"];
  close: () => void;
  teamId: number;
  personId: number;
  projectId: number;
}

function setupWorld(): World {
  const ctx = freshDb({ now: "2026-09-10 08:00:00" });
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
  return { state: ctx.state, close: ctx.close, teamId: team.id, personId: person.id, projectId: project.id };
}

/** 每周一/三 08:00 到 2026-12-31 的代表性规则。 */
function weeklyRule(): StructuredRule {
  return {
    freq: "weekly",
    bydayMask: RT.BYDAY_MO | RT.BYDAY_WE,
    bymonthday: null,
    bymonth: null,
    byhour: 8,
    byminute: 0,
    ianaZone: "Asia/Shanghai",
    ends: { kind: "on", date: "2026-12-31" },
    holidayBehavior: "skip",
  };
}

/** 每月 1/15 号 09:00 持续 24 次。 */
function monthlyRule(): StructuredRule {
  return {
    freq: "monthly",
    bydayMask: 0,
    bymonthday: [1, 15],
    bymonth: null,
    byhour: 9,
    byminute: 0,
    ianaZone: "Asia/Shanghai",
    ends: { kind: "after", n: 24 },
    holidayBehavior: "shift",
  };
}

/** 每月末 16:30 到 2027-06-30。 */
function monthlyLastDayRule(): StructuredRule {
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

/** 每季（1/4/7/10 月）1 号 10:00 到 2030-01-01。 */
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

function makeUpsertArgs(
  world: World,
  overrides: Partial<UpsertRecurringTemplateArgs> & { name: string; rule: StructuredRule },
): UpsertRecurringTemplateArgs {
  return {
    id: overrides.id ?? null,
    name: overrides.name,
    rule: overrides.rule,
    projectId: overrides.projectId ?? world.projectId,
    subTeamId: overrides.subTeamId ?? null,
    notes: overrides.notes ?? null,
  };
}

// ===========================================================================
// upsert
// ===========================================================================

describe("recurring_template / upsert（#24 / #46）", () => {
  it("新建 weekly 模板并读回结构化字段与 rrule_text", () => {
    const world = setupWorld();
    try {
      const template = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, { name: "周一周三早会", rule: weeklyRule() }),
      });

      expect(template.id).toBeGreaterThan(0);
      expect(template.name).toBe("周一周三早会");
      expect(template.freq).toBe("weekly");
      expect(template.bydayMask).toBe(RT.BYDAY_MO | RT.BYDAY_WE);
      expect(template.byhour).toBe(8);
      expect(template.byminute).toBe(0);
      expect(template.ianaZone).toBe("Asia/Shanghai");
      expect(template.ends).toEqual({ kind: "on", date: "2026-12-31" });
      expect(template.holidayBehavior).toBe("skip");
      expect(template.projectId).toBe(world.projectId);
      expect(template.subTeamId).toBeNull();
      expect(template.enabled).toBe(true);
      expect(template.createdAt).toBe("2026-09-10 08:00:00");

      // rrule_text 是 sanity check 用的；结构化字段才是真理来源。
      expect(template.rruleText).toBe(
        "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=0;UNTIL=20261231T235959Z",
      );
    } finally {
      world.close();
    }
  });

  it("新建 monthly_1_15 模板：bymonthday JSON round-trip 保留顺序", () => {
    const world = setupWorld();
    try {
      const template = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, { name: "月报", rule: monthlyRule() }),
      });
      expect(template.bymonthday).toEqual([1, 15]);
      expect(template.ends).toEqual({ kind: "after", n: 24 });
      expect(template.holidayBehavior).toBe("shift");
      expect(template.rruleText).toBe(
        "FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0;COUNT=24",
      );
    } finally {
      world.close();
    }
  });

  it("新建 monthly 月末规则：byday day 0 → RRULE BYMONTHDAY=-1", () => {
    const world = setupWorld();
    try {
      const template = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, { name: "月末对账", rule: monthlyLastDayRule() }),
      });
      expect(template.bymonthday).toEqual([0]);
      expect(template.rruleText).toBe(
        "FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=16;BYMINUTE=30;UNTIL=20270630T235959Z",
      );
    } finally {
      world.close();
    }
  });

  it("新建 quarterly 规则：RRULE 同时含 BYMONTH 与 BYMONTHDAY", () => {
    const world = setupWorld();
    try {
      const template = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, { name: "季度汇报", rule: quarterlyRule() }),
      });
      expect(template.bymonth).toEqual([1, 4, 7, 10]);
      expect(template.rruleText).toBe(
        "FREQ=YEARLY;BYMONTHDAY=1;BYMONTH=1,4,7,10;BYHOUR=10;BYMINUTE=0;UNTIL=20300101T235959Z",
      );
    } finally {
      world.close();
    }
  });

  it("编辑（id 非空）：结构化字段全部刷新，enabled 保持不变", () => {
    const world = setupWorld();
    try {
      const created = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, { name: "周一周三早会", rule: weeklyRule() }),
      });
      // 先停用
      const disabled = RT.setRecurringTemplateEnabled(world.state, {
        id: created.id,
        enabled: false,
      });
      expect(disabled.enabled).toBe(false);

      // 编辑：换 freq / bydayMask / ends / notes——enabled 应当保持 false
      const edited = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, {
          id: created.id,
          name: "周一周三早会 v2",
          rule: {
            ...weeklyRule(),
            byhour: 7,
            ends: { kind: "after", n: 12 },
          },
          notes: "  7 点开档  ",
        }),
      });

      expect(edited.id).toBe(created.id);
      expect(edited.name).toBe("周一周三早会 v2");
      expect(edited.byhour).toBe(7);
      expect(edited.ends).toEqual({ kind: "after", n: 12 });
      expect(edited.notes).toBe("7 点开档"); // trim 后落库
      expect(edited.enabled).toBe(false); // 编辑不复活
      expect(edited.rruleText).toBe(
        "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=7;BYMINUTE=0;COUNT=12",
      );
    } finally {
      world.close();
    }
  });

  it("编辑不存在的 id 抛 INVALID_ARGUMENT", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, { id: 9999, name: "x", rule: weeklyRule() }),
        }),
      ).toThrow(/模板不存在或已被删除/);
    } finally {
      world.close();
    }
  });

  it("拒绝空名 / 全空白名", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, { name: "   ", rule: weeklyRule() }),
        }),
      ).toThrow(/模板名称不能为空/);
    } finally {
      world.close();
    }
  });

  it("同名允许：两张模板可以同名（DB 层无 UNIQUE 约束）", () => {
    const world = setupWorld();
    try {
      const a = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, { name: "周报", rule: weeklyRule() }),
      });
      const b = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, {
          name: "周报",
          rule: { ...weeklyRule(), byhour: 9 },
        }),
      });
      expect(a.id).not.toBe(b.id);
      expect(a.name).toBe(b.name);
    } finally {
      world.close();
    }
  });

  it("拒绝不存在的 project_id", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: weeklyRule(),
            projectId: 9999,
          }),
        }),
      ).toThrow(/所属项目不存在/);
    } finally {
      world.close();
    }
  });

  it("拒绝不存在的 sub_team_id", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: weeklyRule(),
            projectId: null,
            subTeamId: 9999,
          }),
        }),
      ).toThrow(/所属子组不存在/);
    } finally {
      world.close();
    }
  });
});

// ===========================================================================
// 入参校验（结构化字段 → rrule_text）
// ===========================================================================

describe("recurring_template / 结构化字段校验", () => {
  it("weekly 缺星期被拒", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: { ...weeklyRule(), bydayMask: 0 },
          }),
        }),
      ).toThrow(/每周规则必须至少选一天/);
    } finally {
      world.close();
    }
  });

  it("monthly 缺日期被拒", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: { ...monthlyRule(), bymonthday: null },
          }),
        }),
      ).toThrow(/每月规则必须指定日期/);
    } finally {
      world.close();
    }
  });

  it("monthly 月末与其它日期混填被拒", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: { ...monthlyRule(), bymonthday: [0, 1] },
          }),
        }),
      ).toThrow(/「月末」/);
    } finally {
      world.close();
    }
  });

  it("monthly bymonthday 越界值被拒", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: { ...monthlyRule(), bymonthday: [32] },
          }),
        }),
      ).toThrow(/日期/);
    } finally {
      world.close();
    }
  });

  it("yearly 缺月份被拒", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: { ...quarterlyRule(), bymonth: null },
          }),
        }),
      ).toThrow(/每年规则必须指定月份/);
    } finally {
      world.close();
    }
  });

  it("daily 不能带 bymonthday", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: {
              freq: "daily",
              bydayMask: 0,
              bymonthday: [1],
              bymonth: null,
              byhour: 9,
              byminute: 0,
              ianaZone: "Asia/Shanghai",
              ends: { kind: "after", n: 7 },
              holidayBehavior: "skip",
            },
          }),
        }),
      ).toThrow(/仅每月\/每年规则能指定日期/);
    } finally {
      world.close();
    }
  });

  it("非 Asia/Shanghai 时区被拒", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: { ...weeklyRule(), ianaZone: "America/New_York" },
          }),
        }),
      ).toThrow(/Asia\/Shanghai/);
    } finally {
      world.close();
    }
  });

  it("byhour / byminute 越界被拒", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: { ...weeklyRule(), byhour: 24 },
          }),
        }),
      ).toThrow(/小时/);
    } finally {
      world.close();
    }

    const world2 = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world2.state, {
          ...makeUpsertArgs(world2, {
            name: "x",
            rule: { ...weeklyRule(), byminute: 60 },
          }),
        }),
      ).toThrow(/分钟/);
    } finally {
      world2.close();
    }
  });

  it("终止日格式非法被拒", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: { ...weeklyRule(), ends: { kind: "on", date: "2026/12/31" } },
          }),
        }),
      ).toThrow(/终止日/);
    } finally {
      world.close();
    }
  });

  it("after n < 1 被拒", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.upsertRecurringTemplate(world.state, {
          ...makeUpsertArgs(world, {
            name: "x",
            rule: { ...weeklyRule(), ends: { kind: "after", n: 0 } },
          }),
        }),
      ).toThrow(/出现次数/);
    } finally {
      world.close();
    }
  });
});

// ===========================================================================
// list
// ===========================================================================

describe("recurring_template / list（#24 / #46）", () => {
  it("空库时返回空数组", () => {
    const world = setupWorld();
    try {
      expect(
        RT.listRecurringTemplates(world.state, { includeDisabled: false }),
      ).toEqual([]);
    } finally {
      world.close();
    }
  });

  it("默认只看启用（includeDisabled = false 把停用的过滤掉）", () => {
    const world = setupWorld();
    try {
      const a = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, { name: "周一周三", rule: weeklyRule() }),
      });
      const b = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, {
          name: "月报",
          rule: monthlyRule(),
        }),
      });
      RT.setRecurringTemplateEnabled(world.state, {
        id: b.id,
        enabled: false,
      });

      const activeOnly = RT.listRecurringTemplates(world.state, {
        includeDisabled: false,
      });
      expect(activeOnly.map((t: RecurringTemplate) => t.id)).toEqual([a.id]);

      const all = RT.listRecurringTemplates(world.state, {
        includeDisabled: true,
      });
      expect(all.length).toBe(2);
      // 排序：enabled DESC, created_at ASC, id ASC——启用的优先；停用的后置
      expect(all[0]?.id).toBe(a.id);
      expect(all[1]?.id).toBe(b.id);
    } finally {
      world.close();
    }
  });
});

// ===========================================================================
// set_enabled
// ===========================================================================

describe("recurring_template / set_enabled（#24 / #46）", () => {
  it("启用 / 停用状态切换", () => {
    const world = setupWorld();
    try {
      const created = RT.upsertRecurringTemplate(world.state, {
        ...makeUpsertArgs(world, { name: "周一周三", rule: weeklyRule() }),
      });
      expect(created.enabled).toBe(true);

      const disabled = RT.setRecurringTemplateEnabled(world.state, {
        id: created.id,
        enabled: false,
      });
      expect(disabled.enabled).toBe(false);

      const reEnabled = RT.setRecurringTemplateEnabled(world.state, {
        id: created.id,
        enabled: true,
      });
      expect(reEnabled.enabled).toBe(true);
    } finally {
      world.close();
    }
  });

  it("不存在的 id 抛 INVALID_ARGUMENT", () => {
    const world = setupWorld();
    try {
      expect(() =>
        RT.setRecurringTemplateEnabled(world.state, {
          id: 9999,
          enabled: false,
        }),
      ).toThrow(/模板不存在或已被删除/);
    } finally {
      world.close();
    }
  });
});

// ===========================================================================
// RRULE 反向解析（sanity check 路径）
// ===========================================================================

describe("recurring_template / parseRruleIntoStructured", () => {
  it("派生 → 反解 → 与原结构化字段一致（不含 ianaZone / holidayBehavior）", () => {
    for (const rule of [weeklyRule(), monthlyRule(), monthlyLastDayRule(), quarterlyRule()]) {
      const text = RT.deriveRrule(rule);
      const parsed = RT.parseRruleIntoStructured(text);
      expect(parsed.freq).toBe(rule.freq);
      expect(parsed.bydayMask).toBe(rule.bydayMask);
      expect(parsed.bymonthday).toEqual(rule.bymonthday);
      expect(parsed.bymonth).toEqual(rule.bymonth);
      expect(parsed.byhour).toBe(rule.byhour);
      expect(parsed.byminute).toBe(rule.byminute);
      expect(parsed.ends).toEqual(rule.ends);
    }
  });
});

// ===========================================================================
// byday bitmask 编码常量
// ===========================================================================

describe("recurring_template / byday bitmask 常量", () => {
  it("七位常量与文档一致", () => {
    expect(RT.BYDAY_MO).toBe(1);
    expect(RT.BYDAY_TU).toBe(2);
    expect(RT.BYDAY_WE).toBe(4);
    expect(RT.BYDAY_TH).toBe(8);
    expect(RT.BYDAY_FR).toBe(16);
    expect(RT.BYDAY_SA).toBe(32);
    expect(RT.BYDAY_SU).toBe(64);
    expect(RT.BYDAY_ALL).toBe(127);
  });
});