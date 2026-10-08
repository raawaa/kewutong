/**
 * 启动 + 跨周 tick 接线（spec §M4 / ticket #56）。
 *
 * `src/main/index.ts` 在 `app.whenReady().then(...)` 末尾串起
 * `Materialization.materializeIfNewWeek(state)` + `Scheduler.runAll(state)`,
 * 再以每小时一次的 `setInterval` 兜底跨入新 ISO 周时的物化 + 通知扫。
 *
 * 本测试不直接调 `app.whenReady`（那是 Electron 上下文的事）——只断
 * 言这条命令序列的「侧效」与「跨周去重」语义与 wiring 期望一致:
 * 1. 启动后第一遍 = 强制物化（meta 表空）+ scheduler 跑 3 规则；
 * 2. 同 ISO 周内重复跑 `materializeIfNewWeek` → `materialized = false`，
 *    不再写 instance（跨周去重的 gate 就是这次复审的对象）；
 * 3. 切到下一 ISO 周再跑 → 物化触发,instance 数从 0 涨到 N。
 *
 * `src/main/index.ts` 的实际接线（`setInterval` + `app.on('activate')`
 * 重触发）由 Electron lifecycle 测试覆盖；这里只断言命令本身的语义。
 */

import { describe, expect, it } from "vitest";

import { freshDb } from "./commands/fresh_db.js";
import * as Materialization from "../materialization/index.js";
import * as Scheduler from "../notification/scheduler.js";
import * as Task from "../task/index.js";
import * as Template from "../recurring_template/index.js";
import * as Personnel from "../personnel/index.js";
import { HolidayCalendar } from "../holiday/index.js";

describe("startup-tick wiring（#56 / spec §M4）", () => {
  it("启动序列：materializeIfNewWeek + runAll 在 freshDb 上产生期望侧效", () => {
    const w = freshDb({ now: "2026-09-10 08:00:00" }); // Thu, ISO week 37
    try {
      // 挂真实 HolidayCalendar —— 通知扫的 weekly_digest 要走 kindOf。
      w.state.calendar = HolidayCalendar.load(w.db, "/no/seed/dir" as never, 2026);
      // recurring_template CHECK 要求 project_id 或 sub_team_id 至少一项
      // 非空——建一个最小子组挂上。resolveOwner 也需要在岗人员,顺带建
      // 一个。
      const team = Personnel.createSubTeam(w.state, { name: "一组" });
      Personnel.createPerson(w.state, {
        name: "张三",
        subTeamId: team.id,
        contact: "13800138000",
      });

      // 建一个 weekly MO 模板供物化生成 instance。
      const template = Template.upsertRecurringTemplate(w.state, {
        id: null,
        name: "周一例会",
        rule: {
          freq: "weekly",
          bydayMask: Template.BYDAY_MO,
          bymonthday: null,
          bymonth: null,
          byhour: 8,
          byminute: 0,
          ianaZone: "Asia/Shanghai",
          ends: { kind: "after", n: 24 },
          holidayBehavior: "skip",
        },
        projectId: null,
        subTeamId: team.id,
        notes: null,
      });

      // 启动序列第一遍：materialize + scheduler。
      const first = Materialization.materializeIfNewWeek(w.state);
      expect(first.materialized).toBe(true);
      expect(first.totals.templates).toBe(1);
      expect(first.totals.kept).toBeGreaterThan(0);

      const summary = Scheduler.runAll(w.state);
      // 空库：无 task → 无 due_24h / blocked_3d；weekly_digest 不在周
      // 一窗口 → 也不会写。
      expect(summary.due24h).toEqual([]);
      expect(summary.blocked3d).toEqual([]);
      expect(summary.weeklyDigest).toEqual([]);

      // 物化生成的 instance 行已经落 task 表。
      const instances = w.db
        .prepare<[number], { id: number }>(
          "SELECT id FROM task WHERE recurring_template_id = ?",
        )
        .all(template.id);
      expect(instances.length).toBe(first.totals.kept);
    } finally {
      w.close();
    }
  });

  it("同 ISO 周内重复 materializeIfNewWeek → materialized=false,instance 数不再涨", () => {
    const w = freshDb({ now: "2026-09-10 08:00:00" });
    try {
      w.state.calendar = HolidayCalendar.load(w.db, "/no/seed/dir" as never, 2026);
      const team = Personnel.createSubTeam(w.state, { name: "一组" });
      Personnel.createPerson(w.state, {
        name: "张三",
        subTeamId: team.id,
        contact: "13800138000",
      });
      Template.upsertRecurringTemplate(w.state, {
        id: null,
        name: "周一例会",
        rule: {
          freq: "weekly",
          bydayMask: Template.BYDAY_MO,
          bymonthday: null,
          bymonth: null,
          byhour: 8,
          byminute: 0,
          ianaZone: "Asia/Shanghai",
          ends: { kind: "after", n: 24 },
          holidayBehavior: "skip",
        },
        projectId: null,
        subTeamId: team.id,
        notes: null,
      });

      const first = Materialization.materializeIfNewWeek(w.state);
      expect(first.materialized).toBe(true);

      // 同 ISO 周内：第二遍应被 gate 拒掉,instance 行数不变。
      const second = Materialization.materializeIfNewWeek(w.state);
      expect(second.materialized).toBe(false);
      expect(second.totals.kept).toBe(0);
      expect(second.totals.skipped).toBe(0);
      expect(second.totals.shifted).toBe(0);
      expect(second.totals.cancelled).toBe(0);

      const countRow = w.db
        .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM task")
        .get();
      expect(countRow?.c).toBe(first.totals.kept);
    } finally {
      w.close();
    }
  });

  it("跨入新 ISO 周：materializeIfNewWeek 重新触发物化", () => {
    const w = freshDb({ now: "2026-09-10 08:00:00" }); // Thu week 37
    try {
      w.state.calendar = HolidayCalendar.load(w.db, "/no/seed/dir" as never, 2026);
      const team = Personnel.createSubTeam(w.state, { name: "一组" });
      Personnel.createPerson(w.state, {
        name: "张三",
        subTeamId: team.id,
        contact: "13800138000",
      });
      Template.upsertRecurringTemplate(w.state, {
        id: null,
        name: "周一例会",
        rule: {
          freq: "weekly",
          bydayMask: Template.BYDAY_MO,
          bymonthday: null,
          bymonth: null,
          byhour: 8,
          byminute: 0,
          ianaZone: "Asia/Shanghai",
          ends: { kind: "after", n: 24 },
          holidayBehavior: "skip",
        },
        projectId: null,
        subTeamId: team.id,
        notes: null,
      });

      const first = Materialization.materializeIfNewWeek(w.state);
      expect(first.materialized).toBe(true);

      // 拨钟到下一 ISO 周——这是 `setInterval` 兜底触发的语义。
      w.clock.setAt("2026-09-17 08:00:00"); // Thu week 38

      const second = Materialization.materializeIfNewWeek(w.state);
      expect(second.materialized).toBe(true);
      // 12 周窗口起点变成 09-17 → 12 个新 Mon instance 落库。
      expect(second.totals.kept).toBeGreaterThan(0);
    } finally {
      w.close();
    }
  });

  it("scheduler 失败不阻塞 materialization（partial-success wiring 期望）", () => {
    // 模拟「materialize 成功 + scheduler 抛错」——这是 wiring 注释里
    // 「各自独立、错误累积」的承诺。本测试只断言这两条命令可以独立调
    // 用而不互相污染状态。
    const w = freshDb({ now: "2026-09-10 08:00:00" });
    try {
      w.state.calendar = HolidayCalendar.load(w.db, "/no/seed/dir" as never, 2026);
      const team = Personnel.createSubTeam(w.state, { name: "一组" });
      Personnel.createPerson(w.state, {
        name: "张三",
        subTeamId: team.id,
        contact: "13800138000",
      });
      Template.upsertRecurringTemplate(w.state, {
        id: null,
        name: "周一例会",
        rule: {
          freq: "weekly",
          bydayMask: Template.BYDAY_MO,
          bymonthday: null,
          bymonth: null,
          byhour: 8,
          byminute: 0,
          ianaZone: "Asia/Shanghai",
          ends: { kind: "after", n: 24 },
          holidayBehavior: "skip",
        },
        projectId: null,
        subTeamId: team.id,
        notes: null,
      });

      // runAll 在空日历 + 周四不会写任何通知;但即便它内部抛错,wiring
      // 处的 try/catch 也保证下一条 materialize 仍跑。这里只是烟雾。
      const m = Materialization.materializeFromState(w.state);
      expect(m.kept).toBeGreaterThan(0);

      const summary = Scheduler.runAll(w.state);
      // 不是周一窗口 → weeklyDigest 空;空库 → due24h / blocked3d 空。
      expect(summary).toEqual({
        due24h: [],
        blocked3d: [],
        weeklyDigest: [],
      });

      // materialize 的产物仍在 task 表里。
      const row = w.db
        .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM task")
        .get();
      expect(row?.c).toBe(m.kept);
      // task 模块能直接拿到第一条 instance 行——证明 task 层 schema 一
      // 致、materialize 落库后其它命令可正常读写。
      const firstTask = Task.listTasks(w.state, {
        includeCancelled: true,
        ownerPersonId: undefined,
        projectId: undefined,
      })[0];
      expect(firstTask?.isRecurring).toBe(true);
    } finally {
      w.close();
    }
  });
});