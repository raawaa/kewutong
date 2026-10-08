import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Sample from "./index.js";

/**
 * 本文件不依赖 V007 迁移里的示例行——`freshDb()` 交付的是空库，示例行
 * 由下面的 helper 按需搭出来。这样每条用例的「示例数据长什么样」都是
 * 本文件自己写死的字面量，读测试的人不必去翻迁移文件对账。
 */

/** 搭一套 FK 齐全的示例图，可选带上真实行（`is_sample = 0`）。 */
function seedSampleGraphAndRealRows(db: Database.Database, withRealRows = true): void {
  const realRows = withRealRows
    ? `
    -- 真实侧（is_sample = 0）先落——示例任务有 owner 挂在真实人员下。
    INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample)
    VALUES (900, '真实组', NULL, 1, datetime('now'), 0);
    INSERT INTO person (id, name, sub_team_id, contact, deactivated_at, created_at, is_sample)
    VALUES (900, '真实甲', 900, '13800000000', NULL, datetime('now'), 0);
    INSERT INTO project (id, name, owner_person_id, sub_team_id, start_date, due_date, notes, created_at, is_sample)
    VALUES (900, '真实项目', 900, 900, NULL, NULL, NULL, datetime('now'), 0);
`
    : "";

  // 一次性任务的 owner 挂在 id 900 上——没有真实行时改挂示例人员 1。
  const oneOffOwner = withRealRows ? 900 : 1;

  db.exec(`
    ${realRows}
    -- 示例侧（is_sample = 1）
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
    -- instance 任务：同时挂周期模板 + 项目 + owner/waiting 人员。
    INSERT INTO task (
      id, title, description, status, owner_person_id, project_id, due_date,
      recurring_template_id, scheduled_at, original_scheduled_at,
      rescheduled_from_id, created_at, updated_at, blocked_at, blocked_reason,
      waiting_on_person_id, is_sample
    ) VALUES (
      1, '等李四确认', NULL, 'Waiting-on', 1, 1, NULL,
      1, '2026-09-14 00:00:00', '2026-09-14 00:00:00', NULL,
      datetime('now'), datetime('now'), NULL, NULL, 2, 1
    );
    -- 一次性任务：有真实行时 owner 挂在**真实**人员下——删 person 前必须
    -- 先删它。
    INSERT INTO task (
      id, title, description, status, owner_person_id, project_id, due_date,
      recurring_template_id, scheduled_at, original_scheduled_at,
      rescheduled_from_id, created_at, updated_at, blocked_at, blocked_reason,
      waiting_on_person_id, is_sample
    ) VALUES (
      2, '示例一次性任务', NULL, 'Open', ${oneOffOwner}, NULL, NULL,
      NULL, NULL, NULL, NULL, datetime('now'), datetime('now'), NULL, NULL, NULL, 1
    );
  `);
}

function countRows(db: Database.Database, table: string): number {
  return db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
}

describe("sample / isSampleDataPresent（#31）", () => {
  it("空库时横幅查询报 absent", () => {
    const { state, close } = freshDb();
    try {
      expect(Sample.isSampleDataPresent(state)).toEqual({ present: false });
    } finally {
      close();
    }
  });

  it("五张表里任何一张出现示例行就报 present", () => {
    // 逐张表单独验证——漏掉任何一张都会让「只剩那一类示例数据」的库
    // 误报 absent，横幅就再也退不掉了。
    const cases: Array<{ table: string; sql: string }> = [
      {
        table: "sub_team",
        sql: `INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample)
              VALUES (1, '示例一组', NULL, 1, datetime('now'), 1)`,
      },
      {
        table: "person",
        sql: `INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample)
                VALUES (900, '真实组', NULL, 1, datetime('now'), 0);
              INSERT INTO person (id, name, sub_team_id, contact, deactivated_at, created_at, is_sample)
              VALUES (1, '张三', 900, '工号', NULL, datetime('now'), 1)`,
      },
      {
        table: "project",
        sql: `INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample)
                VALUES (900, '真实组', NULL, 1, datetime('now'), 0);
              INSERT INTO person (id, name, sub_team_id, contact, deactivated_at, created_at, is_sample)
              VALUES (900, '真实甲', 900, '13800000000', NULL, datetime('now'), 0);
              INSERT INTO project (id, name, owner_person_id, sub_team_id, start_date, due_date, notes, created_at, is_sample)
              VALUES (1, '示例项目', 900, 900, NULL, NULL, NULL, datetime('now'), 1)`,
      },
      {
        table: "recurring_template",
        sql: `INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample)
                VALUES (900, '真实组', NULL, 1, datetime('now'), 0);
              INSERT INTO recurring_template (
                id, name, freq, byday_mask, bymonthday, bymonth, byhour, byminute,
                iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text,
                project_id, sub_team_id, enabled, notes, created_at, is_sample
              ) VALUES (
                1, '周一例会', 'WEEKLY', 1, NULL, NULL, 8, 0, 'Asia/Shanghai',
                '2099-12-31', NULL, 'SKIP', 'FREQ=WEEKLY;BYDAY=MO',
                NULL, 900, 1, NULL, datetime('now'), 1
              )`,
      },
    ];

    for (const { table, sql } of cases) {
      const { db, state, close } = freshDb();
      try {
        db.exec(sql);
        expect(Sample.isSampleDataPresent(state), `${table} 有示例行时应报 present`).toEqual({
          present: true,
        });
      } finally {
        close();
      }
    }
  });

  it("task 里的示例行也算 present", () => {
    const { db, state, close } = freshDb();
    try {
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
          NULL, NULL, NULL, NULL, datetime('now'), datetime('now'), NULL, NULL, NULL, 1
        );
      `);
      expect(Sample.isSampleDataPresent(state)).toEqual({ present: true });
    } finally {
      close();
    }
  });
});

describe("sample / clearSampleData（#31）", () => {
  it("只删示例行，回传每张表的删除条数，真实行原样留下", () => {
    const { db, state, close } = freshDb();
    try {
      seedSampleGraphAndRealRows(db);

      expect(Sample.clearSampleData(state)).toEqual({
        subTeams: 1,
        people: 2,
        projects: 1,
        tasks: 2,
        recurringTemplates: 1,
      });

      // 真实行一个不少地留着。
      expect(countRows(db, "sub_team")).toBe(1);
      expect(countRows(db, "person")).toBe(1);
      expect(countRows(db, "project")).toBe(1);
      expect(countRows(db, "recurring_template")).toBe(0);
      expect(countRows(db, "task")).toBe(0);
      expect(db.prepare<[], { name: string }>("SELECT name FROM sub_team").get()?.name).toBe(
        "真实组",
      );
      expect(Sample.isSampleDataPresent(state)).toEqual({ present: false });
    } finally {
      close();
    }
  });

  it("示例任务挂在真实人员名下时清除成功（task 必须先删）", () => {
    const { db, state, close } = freshDb();
    try {
      seedSampleGraphAndRealRows(db);

      const summary = Sample.clearSampleData(state);

      expect(summary.tasks).toBe(2);
      // 若 task 不先删，删 person 会被 task.owner_person_id 的 FK 拒掉。
      expect(summary.people).toBe(2);
      expect(countRows(db, "person")).toBe(1);
      expect(
        db.prepare<[], { name: string }>("SELECT name FROM person").get()?.name,
      ).toBe("真实甲");
    } finally {
      close();
    }
  });

  it("清除是幂等的空操作", () => {
    const { state, close } = freshDb();
    try {
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

  it("先删父表会被 FK 拒——说明上面的顺序不可调换", () => {
    const { db, close } = freshDb();
    try {
      seedSampleGraphAndRealRows(db);
      expect(
        db
          .prepare<[], { n: number }>(
            "SELECT COUNT(*) AS n FROM task WHERE project_id = 1 AND is_sample = 1",
          )
          .get()?.n,
      ).toBe(1);

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

      // docs/data/initial-sub-teams.md 的分桶：暖通 5 / 电气 5 / 行政 4 /
      // 运行 6 = 20 人。
      const perTeam = db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM person WHERE is_sample = 0 GROUP BY sub_team_id ORDER BY sub_team_id ASC",
        )
        .all()
        .map((r) => r.n);
      expect(perTeam).toEqual([5, 5, 4, 6]);

      // 联系方式是占位文案，提示科长去人员管理补录；离岗列留空。
      expect(
        db
          .prepare<[], { contact: string }>("SELECT contact FROM person WHERE id = 100")
          .get()?.contact,
      ).toBe("请在人员管理补录联系方式");
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
      expect(countRows(db, "sub_team")).toBe(1);
      expect(countRows(db, "person")).toBe(0);
    } finally {
      close();
    }
  });

  it("只有示例子组时照样灌真实子组（is_sample = 0 才算数）", () => {
    const { db, state, close } = freshDb();
    try {
      seedSampleGraphAndRealRows(db, false);

      expect(Sample.seedRealTeams(state).seeded).toBe(true);
      expect(countRows(db, "sub_team")).toBe(5); // 1 示例 + 4 新灌
      expect(countRows(db, "person")).toBe(22); // 2 示例 + 20 新灌
    } finally {
      close();
    }
  });

  it("重复调用不重复灌（同步执行版语义与命令版一致）", () => {
    const { db, state, close } = freshDb();
    try {
      expect(Sample.seedRealTeamsViaState(state).seeded).toBe(true);
      expect(Sample.seedRealTeamsViaState(state)).toEqual({
        subTeamsInserted: 0,
        peopleInserted: 0,
        seeded: false,
      });
      expect(countRows(db, "sub_team")).toBe(4);
      expect(countRows(db, "person")).toBe(20);
    } finally {
      close();
    }
  });
});
