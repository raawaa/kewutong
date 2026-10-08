/**
 * Notification scheduler（#56）单元测试。
 *
 * 端口 `src-tauri/src/notifications.rs` 末尾单测（ticket #30）。包括：
 * - payload 三种 shape 序列化字段全；
 * - `renderMessage` 中文标题与正文；
 * - `runWeeklyDigest` 触发窗口（周一 / 8 点 / 非 holiday）；
 * - 同周 dedup + 跨 task dedup。
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { freshDb } from "../test/commands/fresh_db.js";
import { HolidayCalendar } from "../holiday/index.js";
import * as Scheduler from "./scheduler.js";

// ---------------------------------------------------------------------------
// Payload 形状单源
// ---------------------------------------------------------------------------

describe("notification / payload 序列化（#56）", () => {
  it("kind 字面量与 DB CHECK 对齐", () => {
    const due24: Scheduler.NotificationPayload = {
      kind: "due_24h",
      task_id: 1,
      title: "t",
      due_date: "2026-09-10",
      owner_person_id: 2,
      owner_name: "张三",
    };
    const blocked: Scheduler.NotificationPayload = {
      kind: "blocked_3d",
      task_id: 1,
      title: "t",
      blocked_at: "2026-09-10 08:00:00",
      days_blocked: 3,
      blocked_reason: "等外委",
      owner_person_id: 2,
      owner_name: "张三",
    };
    const weekly: Scheduler.NotificationPayload = {
      kind: "weekly_digest",
      week_start: "2026-09-07",
      week_end: "2026-09-13",
      overdue_count: 1,
      due_today_count: 2,
      due_tomorrow_count: 3,
      blocked_count: 4,
    };
    expect(due24.kind).toBe("due_24h");
    expect(blocked.kind).toBe("blocked_3d");
    expect(weekly.kind).toBe("weekly_digest");
  });

  it("due_24h 序列化含必填字段", () => {
    const payload: Scheduler.NotificationPayload = {
      kind: "due_24h",
      task_id: 42,
      title: "外委合同评审",
      due_date: "2026-09-15",
      owner_person_id: 7,
      owner_name: "张三",
    };
    const json = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect(json["kind"]).toBe("due_24h");
    expect(json["task_id"]).toBe(42);
    expect(json["title"]).toBe("外委合同评审");
    expect(json["due_date"]).toBe("2026-09-15");
    expect(json["owner_person_id"]).toBe(7);
    expect(json["owner_name"]).toBe("张三");
  });

  it("blocked_3d 序列化含 blocked_at / days_blocked / blocked_reason", () => {
    const payload: Scheduler.NotificationPayload = {
      kind: "blocked_3d",
      task_id: 42,
      title: "外委合同评审",
      blocked_at: "2026-09-10 08:00:00",
      days_blocked: 3,
      blocked_reason: "等外委回函",
      owner_person_id: 7,
      owner_name: "张三",
    };
    const json = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect(json["kind"]).toBe("blocked_3d");
    // ADR 0001 §3.6 约束：必须含 blocked_at / days_blocked / blocked_reason
    expect(json["blocked_at"]).toBe("2026-09-10 08:00:00");
    expect(json["days_blocked"]).toBe(3);
    expect(json["blocked_reason"]).toBe("等外委回函");
    expect(json["task_id"]).toBe(42);
    expect(json["title"]).toBe("外委合同评审");
  });

  it("weekly_digest 序列化含 4 个计数和周界", () => {
    const payload: Scheduler.NotificationPayload = {
      kind: "weekly_digest",
      week_start: "2026-09-07",
      week_end: "2026-09-13",
      overdue_count: 1,
      due_today_count: 2,
      due_tomorrow_count: 3,
      blocked_count: 4,
    };
    const json = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect(json["kind"]).toBe("weekly_digest");
    expect(json["week_start"]).toBe("2026-09-07");
    expect(json["week_end"]).toBe("2026-09-13");
    expect(json["overdue_count"]).toBe(1);
    expect(json["due_today_count"]).toBe(2);
    expect(json["due_tomorrow_count"]).toBe(3);
    expect(json["blocked_count"]).toBe(4);
  });

  it("payload 反序列化必须有 kind 字段（tagged union 约束）", () => {
    // 缺 kind 字段时 JSON.parse 不会报错——但作为 tagged union 后续分支
    // 会失败。这里验 "缺 kind 时解构不到 kind"。
    const bad = '{"task_id": 1, "title": "t"}';
    const parsed = JSON.parse(bad) as Record<string, unknown>;
    expect(parsed["kind"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Render 中文输出
// ---------------------------------------------------------------------------

describe("notification / renderMessage（#56）", () => {
  it("due_24h 返回中文标题与正文", () => {
    const payload: Scheduler.NotificationPayload = {
      kind: "due_24h",
      task_id: 1,
      title: "外委合同评审",
      due_date: "2026-09-15",
      owner_person_id: 2,
      owner_name: "张三",
    };
    const { title, body } = Scheduler.renderMessage(payload);
    expect(title).toBe("任务即将到期");
    expect(body).toContain("张三");
    expect(body).toContain("外委合同评审");
    expect(body).toContain("2026-09-15");
  });

  it("blocked_3d 标题含天数，正文含阻塞原因", () => {
    const payload: Scheduler.NotificationPayload = {
      kind: "blocked_3d",
      task_id: 1,
      title: "外委合同评审",
      blocked_at: "2026-09-10 08:00:00",
      days_blocked: 3,
      blocked_reason: "等外委回函",
      owner_person_id: 2,
      owner_name: "张三",
    };
    const { title, body } = Scheduler.renderMessage(payload);
    expect(title).toContain("3 天");
    expect(body).toContain("等外委回函");
  });

  it("weekly_digest 标题含周界，正文含 4 个计数", () => {
    const payload: Scheduler.NotificationPayload = {
      kind: "weekly_digest",
      week_start: "2026-09-07",
      week_end: "2026-09-13",
      overdue_count: 1,
      due_today_count: 2,
      due_tomorrow_count: 3,
      blocked_count: 4,
    };
    const { title, body } = Scheduler.renderMessage(payload);
    expect(title).toContain("2026-09-07");
    expect(title).toContain("2026-09-13");
    expect(body).toContain("已逾期 1");
    expect(body).toContain("今日到期 2");
  });
});

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

interface PersonFixture {
  state: ReturnType<typeof freshDb>["state"];
  clock: ReturnType<typeof freshDb>["clock"];
  close: ReturnType<typeof freshDb>["close"];
  personId: number;
}

/** 建一名人员（sub_team 占位 + person）。 */
function setupPerson(): PersonFixture {
  const ctx = freshDb();
  ctx.state.db
    .prepare(`INSERT INTO sub_team (id, name, sort_order) VALUES (1, '一组', 0)`)
    .run();
  const info = ctx.state.db
    .prepare(
      `INSERT INTO person (id, name, sub_team_id, contact) VALUES (1, '张三', 1, '123')`,
    )
    .run();
  return {
    state: ctx.state,
    clock: ctx.clock,
    close: ctx.close,
    personId: Number(info.lastInsertRowid),
  };
}

interface TaskInsertArgs {
  title: string;
  status:
    | "Open"
    | "In-progress"
    | "Blocked"
    | "Waiting-on"
    | "Done"
    | "Cancelled";
  ownerPersonId: number;
  dueDate?: string | null;
  blockedAt?: string | null;
  blockedReason?: string | null;
  recurringTemplateId?: number | null;
  scheduledAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

function rawInsertTask(
  db: Database.Database,
  fields: TaskInsertArgs,
): number {
  // 一次性 task（recurring_template_id IS NULL）必须 scheduled_at IS NULL；
  // instance（recurring_template_id IS NOT NULL）必须 scheduled_at IS NOT NULL。
  // 这里一次性 task 不传 recurring_template_id，scheduled_at 留 null。
  const scheduledAt = fields.scheduledAt ?? null;
  const result = db
    .prepare(
      `INSERT INTO task
         (title, status, owner_person_id, due_date, recurring_template_id,
          scheduled_at, created_at, updated_at, blocked_at, blocked_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.title,
      fields.status,
      fields.ownerPersonId,
      fields.dueDate ?? null,
      fields.recurringTemplateId ?? null,
      scheduledAt,
      fields.createdAt ?? "2026-09-10 08:00:00",
      fields.updatedAt ?? "2026-09-10 08:00:00",
      fields.blockedAt ?? null,
      fields.blockedReason ?? null,
    );
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// runDue24h
// ---------------------------------------------------------------------------

describe("notification / runDue24h（#56）", () => {
  it("扫描今天 + 明天到期的一次性任务", () => {
    const ctx = setupPerson();
    try {
      // 今天到期
      rawInsertTask(ctx.state.db, {
        title: "今天到期",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-10",
      });
      // 明天到期
      rawInsertTask(ctx.state.db, {
        title: "明天到期",
        status: "In-progress",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-11",
      });
      // 昨天到期（不在窗口）
      rawInsertTask(ctx.state.db, {
        title: "昨天到期",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-09",
      });
      // 完成后天到期（不在窗口）
      rawInsertTask(ctx.state.db, {
        title: "后天到期",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-12",
      });
      // 今天到期但是 Done（不在飞）
      rawInsertTask(ctx.state.db, {
        title: "今天到期但 Done",
        status: "Done",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-10",
      });
      // 今天到期但是 Cancelled（不在飞）
      rawInsertTask(ctx.state.db, {
        title: "今天到期但 Cancelled",
        status: "Cancelled",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-10",
      });

      ctx.clock.setAt("2026-09-10 08:00:00");
      const inserted = Scheduler.runDue24h(ctx.state);

      expect(inserted.length).toBe(2);
      const titles = inserted.map((n) => n.payload["title"]);
      expect(titles).toContain("今天到期");
      expect(titles).toContain("明天到期");
      // 排序：今天在前，明天在后
      expect(inserted[0]?.payload["title"]).toBe("今天到期");
      expect(inserted[1]?.payload["title"]).toBe("明天到期");

      // 校验 payload 字段
      const todayNotif = inserted[0];
      expect(todayNotif?.kind).toBe("due_24h");
      expect(todayNotif?.payload["due_date"]).toBe("2026-09-10");
      expect(todayNotif?.payload["owner_name"]).toBe("张三");
    } finally {
      ctx.close();
    }
  });

  it("同一 task 多次扫描只产生一条（dedup）", () => {
    const ctx = setupPerson();
    try {
      rawInsertTask(ctx.state.db, {
        title: "今天到期",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-10",
      });

      ctx.clock.setAt("2026-09-10 08:00:00");
      const first = Scheduler.runDue24h(ctx.state);
      const second = Scheduler.runDue24h(ctx.state);
      const third = Scheduler.runDue24h(ctx.state);

      expect(first.length).toBe(1);
      expect(second.length).toBe(0);
      expect(third.length).toBe(0);
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// runBlocked3d
// ---------------------------------------------------------------------------

describe("notification / runBlocked3d（#56）", () => {
  it("扫描 Blocked / Waiting-on 超 3 天的任务", () => {
    const ctx = setupPerson();
    try {
      // 阻塞 4 天前 —— 应触发
      rawInsertTask(ctx.state.db, {
        title: "阻塞 4 天",
        status: "Blocked",
        ownerPersonId: ctx.personId,
        blockedAt: "2026-09-06 08:00:00",
        blockedReason: "等外委回函",
      });
      // 阻塞 1 天前 —— 不应触发（< 3 天）
      rawInsertTask(ctx.state.db, {
        title: "阻塞 1 天",
        status: "Blocked",
        ownerPersonId: ctx.personId,
        blockedAt: "2026-09-09 08:00:00",
        blockedReason: "刚阻塞",
      });
      // 阻塞 5 天前，但是 Waiting-on —— 应触发
      rawInsertTask(ctx.state.db, {
        title: "等待 5 天",
        status: "Waiting-on",
        ownerPersonId: ctx.personId,
        blockedAt: "2026-09-05 08:00:00",
        blockedReason: "等客户确认",
      });
      // 阻塞 4 天前，但是 Open（不在 Blocked/Waiting-on）—— 不应触发
      rawInsertTask(ctx.state.db, {
        title: "阻塞但已恢复",
        status: "Open",
        ownerPersonId: ctx.personId,
        blockedAt: "2026-09-06 08:00:00",
      });

      ctx.clock.setAt("2026-09-10 08:00:00");
      const inserted = Scheduler.runBlocked3d(ctx.state);

      expect(inserted.length).toBe(2);
      const titles = inserted.map((n) => n.payload["title"]);
      expect(titles).toContain("阻塞 4 天");
      expect(titles).toContain("等待 5 天");

      const blocked = inserted.find((n) => n.payload["title"] === "阻塞 4 天");
      expect(blocked?.kind).toBe("blocked_3d");
      expect(blocked?.payload["days_blocked"]).toBe(4);
      expect(blocked?.payload["blocked_reason"]).toBe("等外委回函");
    } finally {
      ctx.close();
    }
  });

  it("blocked_at 边界：恰好 3 天前不算", () => {
    const ctx = setupPerson();
    try {
      // 刚好 3 天前 —— 应被滤掉（SQL `blocked_at < datetime('now', '-3 days')`）
      rawInsertTask(ctx.state.db, {
        title: "刚好 3 天",
        status: "Blocked",
        ownerPersonId: ctx.personId,
        blockedAt: "2026-09-07 08:00:00",
        blockedReason: "边界",
      });

      ctx.clock.setAt("2026-09-10 08:00:00");
      const inserted = Scheduler.runBlocked3d(ctx.state);
      // 3 天前 julianday 差 = 3.0，CAST AS INTEGER = 3；触发条件是 `< 3 days` 即 `< -3 days from now`：
      // `blocked_at < datetime('now', '-3 days')` —— 当前 09-10 08:00，-3 days = 09-07 08:00
      // 故 blocked_at = 09-07 08:00 与 datetime('now', '-3 days') 相等，不满足 `<`，被排除。
      expect(inserted.length).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("blocked_at 边界：3 天零 1 秒前算", () => {
    const ctx = setupPerson();
    try {
      // 比 3 天多 1 秒 —— 应触发
      rawInsertTask(ctx.state.db, {
        title: "刚超 3 天",
        status: "Blocked",
        ownerPersonId: ctx.personId,
        blockedAt: "2026-09-07 07:59:59",
        blockedReason: "刚超 3 天",
      });

      ctx.clock.setAt("2026-09-10 08:00:00");
      const inserted = Scheduler.runBlocked3d(ctx.state);
      expect(inserted.length).toBe(1);
      // 3 天零 1 秒 → julianday 差 ≈ 3.0，CAST AS INTEGER = 3
      expect(inserted[0]?.payload["days_blocked"]).toBe(3);
    } finally {
      ctx.close();
    }
  });

  it("同一 task 多次扫描只产生一条（dedup）", () => {
    const ctx = setupPerson();
    try {
      rawInsertTask(ctx.state.db, {
        title: "阻塞 4 天",
        status: "Blocked",
        ownerPersonId: ctx.personId,
        blockedAt: "2026-09-06 08:00:00",
        blockedReason: "等外委",
      });

      ctx.clock.setAt("2026-09-10 08:00:00");
      const first = Scheduler.runBlocked3d(ctx.state);
      const second = Scheduler.runBlocked3d(ctx.state);

      expect(first.length).toBe(1);
      expect(second.length).toBe(0);
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// runWeeklyDigest
// ---------------------------------------------------------------------------

describe("notification / runWeeklyDigest（#56）", () => {
  it("非周一不触发（任意小时都返空）", () => {
    const { state, close } = freshDb({ now: "2026-09-08 08:00:00" }); // Tue 08:00
    try {
      const result = Scheduler.runWeeklyDigest(state);
      expect(result).toEqual([]);
    } finally {
      close();
    }
  });

  it("周一但非 8 点不触发", () => {
    // Mon 07:59 UTC = 15:59 local
    let ctx = freshDb({ now: "2026-09-07 07:59:00" });
    try {
      expect(Scheduler.runWeeklyDigest(ctx.state)).toEqual([]);
    } finally {
      ctx.close();
    }
    // Mon 09:00 UTC = 17:00 local
    ctx = freshDb({ now: "2026-09-07 09:00:00" });
    try {
      expect(Scheduler.runWeeklyDigest(ctx.state)).toEqual([]);
    } finally {
      ctx.close();
    }
    // Mon 00:00 UTC = 08:00 local —— 应触发
    ctx = freshDb({ now: "2026-09-07 00:00:00" });
    try {
      // 先放一个 task 阻塞，让 weekly_digest 的 blocked_count > 0
      ctx.state.db
        .prepare(`INSERT INTO sub_team (id, name, sort_order) VALUES (1, '一组', 0)`)
        .run();
      ctx.state.db
        .prepare(
          `INSERT INTO person (id, name, sub_team_id, contact) VALUES (1, '张三', 1, '123')`,
        )
        .run();
      ctx.state.db
        .prepare(
          `INSERT INTO task (id, title, status, owner_person_id, blocked_at, blocked_reason)
           VALUES (1, '阻塞中', 'Blocked', 1, '2026-09-01 08:00:00', '原因')`,
        )
        .run();
      const result = Scheduler.runWeeklyDigest(ctx.state);
      expect(result.length).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it("周一 8 点且非 holiday 触发一次", () => {
    const { state, close } = freshDb({ now: "2026-09-07 00:00:00" });
    try {
      // state.calendar 是 emptyCalendar → 所有日期返回 "workday"
      const result = Scheduler.runWeeklyDigest(state);
      expect(result.length).toBe(1);
      const notif = result[0];
      expect(notif?.kind).toBe("weekly_digest");
      expect(notif?.payload["week_start"]).toBe("2026-09-07");
      expect(notif?.payload["week_end"]).toBe("2026-09-13");
      // 默认空库 → 全是 0
      expect(notif?.payload["overdue_count"]).toBe(0);
      expect(notif?.payload["due_today_count"]).toBe(0);
      expect(notif?.payload["due_tomorrow_count"]).toBe(0);
      expect(notif?.payload["blocked_count"]).toBe(0);
    } finally {
      close();
    }
  });

  it("周一 8 点且今天是 override holiday 不触发", () => {
    const { state, close } = freshDb({ now: "2026-09-07 00:00:00" });
    try {
      // 把 2026-09-07 标记为 holiday override
      state.db
        .prepare(
          `INSERT INTO holiday_override (date, kind) VALUES ('2026-09-07', 'holiday')`,
        )
        .run();
      // 装日历并 reload（不走 seed 文件——空 seedDir）
      const calendar = HolidayCalendar.load(state.db, "", 2026);
      state.calendar = calendar;

      const result = Scheduler.runWeeklyDigest(state);
      expect(result).toEqual([]);
    } finally {
      close();
    }
  });

  it("周一 8 点触发后,再次触发返回同一条（dedup）", () => {
    const { state, close } = freshDb({ now: "2026-09-07 00:00:00" });
    try {
      const first = Scheduler.runWeeklyDigest(state);
      const second = Scheduler.runWeeklyDigest(state);
      const third = Scheduler.runWeeklyDigest(state);

      expect(first.length).toBe(1);
      expect(second.length).toBe(1);
      expect(third.length).toBe(1);
      // dedup 命中 —— id 必须一致
      expect(first[0]?.id).toBe(second[0]?.id);
      expect(second[0]?.id).toBe(third[0]?.id);
    } finally {
      close();
    }
  });

  it("周一 8 点 + 不同 task 状态 → 4 个计数", () => {
    const { state, close } = freshDb({ now: "2026-09-07 00:00:00" });
    try {
      // fixture：sub_team + person
      state.db
        .prepare(`INSERT INTO sub_team (id, name, sort_order) VALUES (1, '一组', 0)`)
        .run();
      state.db
        .prepare(
          `INSERT INTO person (id, name, sub_team_id, contact) VALUES (1, '张三', 1, '123')`,
        )
        .run();

      // overdue 1 条（昨天到期、Open）
      state.db
        .prepare(
          `INSERT INTO task (id, title, status, owner_person_id, due_date)
           VALUES (1, '已逾期', 'Open', 1, '2026-09-06')`,
        )
        .run();
      // due today 2 条
      state.db
        .prepare(
          `INSERT INTO task (id, title, status, owner_person_id, due_date)
           VALUES (2, '今天到期 1', 'Open', 1, '2026-09-07')`,
        )
        .run();
      state.db
        .prepare(
          `INSERT INTO task (id, title, status, owner_person_id, due_date)
           VALUES (3, '今天到期 2', 'In-progress', 1, '2026-09-07')`,
        )
        .run();
      // due tomorrow 3 条
      for (let i = 4; i <= 6; i++) {
        state.db
          .prepare(
            `INSERT INTO task (id, title, status, owner_person_id, due_date)
             VALUES (?, ?, 'Open', 1, '2026-09-08')`,
          )
          .run(i, `明天到期 ${i}`);
      }
      // blocked 4 条
      for (let i = 7; i <= 10; i++) {
        state.db
          .prepare(
            `INSERT INTO task (id, title, status, owner_person_id, blocked_at, blocked_reason)
             VALUES (?, ?, 'Blocked', 1, '2026-09-01 08:00:00', '原因')`,
          )
          .run(i, `阻塞 ${i}`);
      }

      const result = Scheduler.runWeeklyDigest(state);
      expect(result.length).toBe(1);
      expect(result[0]?.payload["overdue_count"]).toBe(1);
      expect(result[0]?.payload["due_today_count"]).toBe(2);
      expect(result[0]?.payload["due_tomorrow_count"]).toBe(3);
      expect(result[0]?.payload["blocked_count"]).toBe(4);
    } finally {
      close();
    }
  });

  it("周一 8 点,waiting-on 也计入 blocked_count", () => {
    const { state, close } = freshDb({ now: "2026-09-07 00:00:00" });
    try {
      state.db
        .prepare(`INSERT INTO sub_team (id, name, sort_order) VALUES (1, '一组', 0)`)
        .run();
      state.db
        .prepare(
          `INSERT INTO person (id, name, sub_team_id, contact) VALUES (1, '张三', 1, '123')`,
        )
        .run();
      // 1 个 Blocked + 1 个 Waiting-on → blocked_count = 2
      state.db
        .prepare(
          `INSERT INTO task (id, title, status, owner_person_id, blocked_at, blocked_reason)
           VALUES (1, '阻塞', 'Blocked', 1, '2026-09-01 08:00:00', '等外委')`,
        )
        .run();
      state.db
        .prepare(
          `INSERT INTO task (id, title, status, owner_person_id, blocked_at, blocked_reason, waiting_on_person_id)
           VALUES (2, '等待', 'Waiting-on', 1, '2026-09-01 08:00:00', '等客户', 1)`,
        )
        .run();

      const result = Scheduler.runWeeklyDigest(state);
      expect(result[0]?.payload["blocked_count"]).toBe(2);
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// runAll 三规则聚合
// ---------------------------------------------------------------------------

describe("notification / runAll（#56）", () => {
  it("聚合三规则的产出", () => {
    const ctx = setupPerson();
    try {
      // due_24h 候选 1 条
      rawInsertTask(ctx.state.db, {
        title: "今天到期",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-10",
      });
      // blocked_3d 候选 1 条
      rawInsertTask(ctx.state.db, {
        title: "阻塞 4 天",
        status: "Blocked",
        ownerPersonId: ctx.personId,
        blockedAt: "2026-09-06 08:00:00",
        blockedReason: "等外委",
      });

      ctx.clock.setAt("2026-09-10 08:00:00");
      const summary = Scheduler.runAll(ctx.state);

      expect(summary.due24h.length).toBe(1);
      expect(summary.blocked3d.length).toBe(1);
      // 周四不触发 weekly_digest
      expect(summary.weeklyDigest.length).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("周一 8 点时 weekly_digest 也会跑", () => {
    const ctx = setupPerson();
    try {
      ctx.clock.setAt("2026-09-07 00:00:00"); // Mon 00:00 UTC = 08:00 local
      const summary = Scheduler.runAll(ctx.state);
      expect(summary.due24h.length).toBe(0);
      expect(summary.blocked3d.length).toBe(0);
      expect(summary.weeklyDigest.length).toBe(1);
    } finally {
      ctx.close();
    }
  });
});
