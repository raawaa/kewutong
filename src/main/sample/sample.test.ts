import { describe, expect, it } from "vitest";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Sample from "./index.js";

describe("sample / isSampleDataPresent（#31）", () => {
  it("V007 种子落库后横幅查询报 present", () => {
    const { state, close } = freshDb();
    try {
      expect(Sample.isSampleDataPresent(state)).toEqual({ present: true });
    } finally {
      close();
    }
  });

  it("五张表都没有 is_sample 行时横幅查询报 absent", () => {
    const { db, state, close } = freshDb();
    try {
      // 逐张表清掉示例行——五张表都空才谈得上「没有示例数据」。
      db.exec(`
        DELETE FROM task;
        DELETE FROM recurring_template;
        DELETE FROM project;
        DELETE FROM person;
        DELETE FROM sub_team;
      `);
      expect(Sample.isSampleDataPresent(state)).toEqual({ present: false });
    } finally {
      close();
    }
  });
});

describe("sample / clearSampleData（#31）", () => {
  it("清除 V007 种子并回传每张表的删除条数", () => {
    const { db, state, close } = freshDb();
    try {
      const summary = Sample.clearSampleData(state);

      // 条数对应 V007 种子：2 子组 / 4 人 / 1 项目 / 5 一次性 + 8 实例 /
      // 2 周期模板。
      expect(summary).toEqual({
        subTeams: 2,
        people: 4,
        projects: 1,
        tasks: 13,
        recurringTemplates: 2,
      });
      expect(Sample.isSampleDataPresent(state)).toEqual({ present: false });
      expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM task").get()?.n).toBe(0);
    } finally {
      close();
    }
  });

  it("真实数据（is_sample = 0）一行不动", () => {
    const { db, state, close } = freshDb();
    try {
      db.exec(`
        INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample)
        VALUES (900, '真实组', '真实数据', 1, datetime('now'), 0);
        INSERT INTO person (id, name, sub_team_id, contact, deactivated_at, created_at, is_sample)
        VALUES (900, '真实甲', 900, '13800000000', NULL, datetime('now'), 0);
      `);

      const summary = Sample.clearSampleData(state);

      // 真实行的 id 不落在本次删除计数里。
      expect(summary.subTeams).toBe(2);
      expect(summary.people).toBe(4);
      expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sub_team").get()?.n).toBe(1);
      expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM person").get()?.n).toBe(1);
      expect(
        db.prepare<[], { name: string }>("SELECT name FROM sub_team WHERE id = 900").get()?.name,
      ).toBe("真实组");
    } finally {
      close();
    }
  });

  it("库中没有示例数据时清除是幂等的空操作", () => {
    const { state, close } = freshDb();
    try {
      Sample.clearSampleData(state);
      expect(Sample.clearSampleData(state)).toEqual({
        subTeams: 0,
        people: 0,
        projects: 0,
        tasks: 0,
        recurringTemplates: 0,
      });
    } finally {
      close();
    }
  });
});

describe("sample / clearSampleData 的 FK 安全顺序（#31）", () => {
  it("示例任务同时引用示例周期模板 / 项目 / 人员时仍能清除", () => {
    const { db, state, close } = freshDb();
    try {
      // 清掉 V007 种子，另起一套最小但 FK 齐全的示例图：
      // task → (recurring_template, project, owner/waiting person) → sub_team
      Sample.clearSampleData(state);
      db.exec(`
        INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample)
        VALUES (1, '示例一组', NULL, 1, datetime('now'), 1);
        INSERT INTO person (id, name, sub_team_id, contact, deactivated_at, created_at, is_sample)
        VALUES (1, '张三', 1, '示例-工号 001', NULL, datetime('now'), 1),
               (2, '李四', 1, '示例-工号 002', NULL, datetime('now'), 1);
        INSERT INTO project (id, name, owner_person_id, sub_team_id, start_date, due_date, notes, created_at, is_sample)
        VALUES (1, '示例项目', 1, 1, NULL, NULL, NULL, datetime('now'), 1);
        INSERT INTO recurring_template (
          id, name, freq, byday_mask, bymonthday, bymonth, byhour, byminute,
          iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text,
          project_id, sub_team_id, enabled, notes, created_at, is_sample
        ) VALUES (
          1, '周一例会', 'WEEKLY', 1, NULL, NULL, 8, 0, 'Asia/Shanghai',
          '2099-12-31', NULL, 'SKIP', 'FREQ=WEEKLY;BYDAY=MO',
          1, 1, 1, NULL, datetime('now'), 1
        );
        INSERT INTO task (
          id, title, description, status, owner_person_id, project_id, due_date,
          recurring_template_id, scheduled_at, original_scheduled_at,
          rescheduled_from_id, created_at, updated_at, blocked_at, blocked_reason,
          waiting_on_person_id, is_sample
        ) VALUES (
          1, '等赵六确认', NULL, 'Waiting-on', 1, 1, NULL,
          1, '2026-09-14 00:00:00', '2026-09-14 00:00:00', NULL,
          datetime('now'), datetime('now'), NULL, NULL,
          2, 1
        );
      `);

      expect(Sample.clearSampleData(state)).toEqual({
        subTeams: 1,
        people: 2,
        projects: 1,
        tasks: 1,
        recurringTemplates: 1,
      });
      expect(Sample.isSampleDataPresent(state)).toEqual({ present: false });
      for (const table of ["task", "recurring_template", "project", "person", "sub_team"]) {
        expect(db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
      }
    } finally {
      close();
    }
  });

  it("示例任务挂在真实人员名下时，先删 task 才能删 person", () => {
    const { db, state, close } = freshDb();
    try {
      Sample.clearSampleData(state);
      db.exec(`
        INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample)
        VALUES (900, '真实组', NULL, 1, datetime('now'), 0);
        INSERT INTO person (id, name, sub_team_id, contact, deactivated_at, created_at, is_sample)
        VALUES (900, '真实甲', 900, '13800000000', NULL, datetime('now'), 0);
        INSERT INTO task (
          id, title, description, status, owner_person_id, project_id, due_date,
          recurring_template_id, scheduled_at, original_scheduled_at,
          rescheduled_from_id, created_at, updated_at, blocked_at, blocked_reason,
          waiting_on_person_id, is_sample
        ) VALUES (
          1, '示例任务', NULL, 'Open', 900, NULL, NULL,
          NULL, NULL, NULL, NULL, datetime('now'), datetime('now'), NULL, NULL,
          NULL, 1
        );
      `);

      // 若 task 不先删，这一步会被 task.owner_person_id 的 FK 拒掉。
      const summary = Sample.clearSampleData(state);
      expect(summary.tasks).toBe(1);
      expect(summary.people).toBe(0);
      expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM task").get()?.n).toBe(0);
      expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM person").get()?.n).toBe(1);
    } finally {
      close();
    }
  });

  it("先删父表会被 FK 拒——说明上面的顺序不可调换", () => {
    const { db, close } = freshDb();
    try {
      // V007 种子里的 task 1 引用 project 1。
      expect(
        db.prepare<[], { n: number }>(
          `SELECT COUNT(*) AS n FROM task WHERE project_id = 1 AND is_sample = 1`,
        ).get()?.n,
      ).toBeGreaterThan(0);

      expect(() =>
        db.transaction(() => {
          db.prepare("DELETE FROM project WHERE is_sample = 1").run();
        })(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      close();
    }
  });
});

describe("sample / seedRealTeams（#31）", () => {
  it("库里没有真实子组时灌入 4 子组 + 20 人", () => {
    const { db, state, close } = freshDb();
    try {
      expect(Sample.seedRealTeams(state)).toEqual({
        subTeamsInserted: 4,
        peopleInserted: 20,
        seeded: true,
      });

      const teams = db
        .prepare<[], { id: number; name: string; sort_order: number }>(
          "SELECT id, name, sort_order FROM sub_team WHERE is_sample = 0 ORDER BY sort_order ASC",
        )
        .all();
      expect(teams.map((t) => t.name)).toEqual(["暖通", "电气", "行政", "运行"]);
      expect(teams.map((t) => t.id)).toEqual([100, 101, 102, 103]);
      expect(teams.map((t) => t.sort_order)).toEqual([1, 2, 3, 4]);

      // docs/data/initial-sub-teams.md 的分桶：5 / 5 / 4 / 6。
      const perTeam = db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM person WHERE is_sample = 0 GROUP BY sub_team_id ORDER BY sub_team_id ASC",
        )
        .all()
        .map((r) => r.n);
      expect(perTeam).toEqual([5, 5, 4, 6]);

      // 联系方式是占位文案，提示科长去人员管理补录。
      expect(
        db
          .prepare<[], { contact: string }>(
            "SELECT contact FROM person WHERE id = 100",
          )
          .get()?.contact,
      ).toBe("请在人员管理补录联系方式");
      // 离岗列留空——新灌的人都在岗。
      expect(
        db
          .prepare<[], { n: number }>(
            "SELECT COUNT(*) AS n FROM person WHERE is_sample = 0 AND deactivated_at IS NOT NULL",
          )
          .get()?.n,
      ).toBe(0);
    } finally {
      close();
    }
  });

  it("库里已有真实子组时整段跳过并返回 seeded = false", () => {
    const { db, state, close } = freshDb();
    try {
      db.exec(`
        INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample)
        VALUES (500, '既有真实组', NULL, 1, datetime('now'), 0);
      `);

      expect(Sample.seedRealTeams(state)).toEqual({
        subTeamsInserted: 0,
        peopleInserted: 0,
        seeded: false,
      });
      // 一行都没多灌——「有数据就不灌」是业务规则，不是 SQL 报错。
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sub_team WHERE is_sample = 0").get()
          ?.n,
      ).toBe(1);
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM person WHERE is_sample = 0").get()
          ?.n,
      ).toBe(0);
    } finally {
      close();
    }
  });

  it("重复调用不重复灌（同步执行版语义与命令版一致）", () => {
    const { db, state, close } = freshDb();
    try {
      Sample.seedRealTeamsViaState(state);
      const second = Sample.seedRealTeamsViaState(state);
      expect(second.seeded).toBe(false);
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sub_team WHERE is_sample = 0").get()
          ?.n,
      ).toBe(4);
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM person WHERE is_sample = 0").get()
          ?.n,
      ).toBe(20);
    } finally {
      close();
    }
  });
});
