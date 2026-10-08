import { describe, expect, it } from "vitest";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Notification from "./index.js";
import { AppError } from "../error.js";
import { withTx } from "../sqlite.js";

// ---------------------------------------------------------------------------
// 直接把 fixture 塞进 `notification_log`（不走调度引擎——它是后续 ticket）。
//
// Schema (V006__notification_log.sql)：
//   - `kind` ∈ {'due_24h','blocked_3d','weekly_digest'}
//   - `payload` 是合法 JSON 文本
//   - kind = 'weekly_digest' OR related_task_id 不空 OR related_template_id 不空
//   - `related_task_id` / `related_template_id` 是 FK,FK 检查在 `PRAGMA
//     foreign_keys = ON` 下强制——helper 会按需插一条 person / task 占位
//     行,确保插入不炸。
// ---------------------------------------------------------------------------

interface InsertArgs {
  triggeredAt: string;
  kind: "due_24h" | "blocked_3d" | "weekly_digest";
  relatedTaskId?: number | null;
  relatedTemplateId?: number | null;
  payload: Record<string, unknown>;
  viewedAt?: string | null;
}

/** FK 占位已建好就跳过,反之插一条 person + task 顶住外键。 */
function ensureTaskFixture(
  db: import("node:sqlite").DatabaseSync,
  taskId: number,
): void {
  const exists = db
    .prepare<[number], { id: number }>("SELECT id FROM task WHERE id = ?")
    .get(taskId);
  if (exists) return;

  const hasTeam = db
    .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sub_team")
    .get();
  if ((hasTeam?.c ?? 0) === 0) {
    db.prepare(`INSERT INTO sub_team (id, name, sort_order) VALUES (1, '一组', 0)`).run();
  }
  const hasPerson = db
    .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM person")
    .get();
  if ((hasPerson?.c ?? 0) === 0) {
    db.prepare(
      `INSERT INTO person (id, name, sub_team_id, contact) VALUES (1, '张三', 1, '123')`,
    ).run();
  }
  db.prepare(
    `INSERT INTO task (id, title, status, owner_person_id) VALUES (?, '占位', 'Open', 1)`,
  ).run(taskId);
}

function insertNotification(
  state: { db: import("node:sqlite").DatabaseSync },
  args: InsertArgs,
): number {
  if (args.relatedTaskId != null) {
    ensureTaskFixture(state.db, args.relatedTaskId);
  }
  const result = state.db
    .prepare(
      `INSERT INTO notification_log
         (triggered_at, kind, related_task_id, related_template_id, payload, viewed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.triggeredAt,
      args.kind,
      args.relatedTaskId ?? null,
      args.relatedTemplateId ?? null,
      JSON.stringify(args.payload),
      args.viewedAt ?? null,
    );
  return Number(result.lastInsertRowid);
}

const due24Payload = (taskId: number): Record<string, unknown> => ({
  kind: "due_24h",
  task_id: taskId,
  title: "外委合同评审",
  due_date: "2026-09-10",
  owner_person_id: 1,
  owner_name: "张三",
});

const blockedPayload = (taskId: number): Record<string, unknown> => ({
  kind: "blocked_3d",
  task_id: taskId,
  title: "外委合同评审",
  blocked_at: "2026-09-01 08:00:00",
  days_blocked: 5,
  blocked_reason: "等外委回函",
  owner_person_id: 1,
  owner_name: "张三",
});

const weeklyPayload = (): Record<string, unknown> => ({
  kind: "weekly_digest",
  week_start: "2026-09-07",
  week_end: "2026-09-13",
  overdue_count: 0,
  due_today_count: 0,
  due_tomorrow_count: 0,
  blocked_count: 0,
});

describe("notification / listUnreadNotifications（#51）", () => {
  it("空库返回空数组", () => {
    const { state, close } = freshDb();
    try {
      expect(Notification.listUnreadNotifications(state)).toEqual([]);
    } finally {
      close();
    }
  });

  it("只返 viewed_at IS NULL 的行；按 triggered_at DESC, id DESC 排序", () => {
    const { state, close } = freshDb();
    try {
      // 老未读
      const oldId = insertNotification(state, {
        triggeredAt: "2026-09-08 08:00:00",
        kind: "due_24h",
        relatedTaskId: 1,
        payload: due24Payload(1),
      });
      // 新未读
      const newId = insertNotification(state, {
        triggeredAt: "2026-09-09 09:00:00",
        kind: "due_24h",
        relatedTaskId: 2,
        payload: due24Payload(2),
      });
      // 已读 —— 不应出现在结果里
      insertNotification(state, {
        triggeredAt: "2026-09-09 10:00:00",
        kind: "due_24h",
        relatedTaskId: 3,
        payload: due24Payload(3),
        viewedAt: "2026-09-09 11:00:00",
      });

      const unread = Notification.listUnreadNotifications(state);
      expect(unread.map((n) => n.id)).toEqual([newId, oldId]);
      expect(unread.every((n) => n.viewedAt === null)).toBe(true);
    } finally {
      close();
    }
  });

  it("同 triggered_at 时按 id DESC 兜底（稳定排序）", () => {
    const { state, close } = freshDb();
    try {
      const a = insertNotification(state, {
        triggeredAt: "2026-09-08 08:00:00",
        kind: "due_24h",
        relatedTaskId: 1,
        payload: due24Payload(1),
      });
      const b = insertNotification(state, {
        triggeredAt: "2026-09-08 08:00:00",
        kind: "due_24h",
        relatedTaskId: 2,
        payload: due24Payload(2),
      });
      const unread = Notification.listUnreadNotifications(state);
      expect(unread.map((n) => n.id)).toEqual([b, a]);
    } finally {
      close();
    }
  });
});

describe("notification / listNotifications（#51）", () => {
  it("包含已读与未读", () => {
    const { state, close } = freshDb();
    try {
      insertNotification(state, {
        triggeredAt: "2026-09-08 08:00:00",
        kind: "due_24h",
        relatedTaskId: 1,
        payload: due24Payload(1),
      });
      insertNotification(state, {
        triggeredAt: "2026-09-09 09:00:00",
        kind: "due_24h",
        relatedTaskId: 2,
        payload: due24Payload(2),
        viewedAt: "2026-09-09 10:00:00",
      });
      const all = Notification.listNotifications(state);
      expect(all.length).toBe(2);
      // 按 triggered_at DESC 倒序：09-09 在前 → 已读；08-08 在后 → 未读。
      expect(all.map((n) => n.viewedAt)).toEqual(["2026-09-09 10:00:00", null]);
    } finally {
      close();
    }
  });

  it("封顶 LIST_HISTORY_LIMIT（200）", () => {
    const { state, close } = freshDb();
    try {
      // FK：task.owner_person_id → person；notification_log.related_task_id → task。
      // 一次性插好 sub_team / person / 250 条 task,再批量写 notification_log。
      withTx(state.db, () => {
        state.db.prepare(`INSERT INTO sub_team (id, name, sort_order) VALUES (1, '一组', 0)`).run();
        state.db.prepare(
          `INSERT INTO person (id, name, sub_team_id, contact) VALUES (1, '张三', 1, '123')`,
        ).run();
        const taskStmt = state.db.prepare(
          `INSERT INTO task (id, title, status, owner_person_id)
           VALUES (?, '占位', 'Open', 1)`,
        );
        for (let i = 1; i <= 250; i++) taskStmt.run(i);
        const stmt = state.db.prepare(
          `INSERT INTO notification_log
             (triggered_at, kind, related_task_id, payload)
           VALUES (?, 'due_24h', ?, ?)`,
        );
        for (let i = 0; i < 250; i++) {
          stmt.run(`2026-09-09 0${(i % 9) + 1}:00:00`, i + 1, JSON.stringify(due24Payload(i + 1)));
        }
      });
      const all = Notification.listNotifications(state);
      expect(all.length).toBe(200);
    } finally {
      close();
    }
  });

  it("weekly_digest 也能列出来（payload 含 4 计数 + 周界）", () => {
    const { state, close } = freshDb();
    try {
      const id = insertNotification(state, {
        triggeredAt: "2026-09-07 08:00:00",
        kind: "weekly_digest",
        payload: weeklyPayload(),
      });
      const all = Notification.listNotifications(state);
      expect(all.length).toBe(1);
      expect(all[0]?.id).toBe(id);
      expect(all[0]?.kind).toBe("weekly_digest");
      expect(all[0]?.relatedTaskId).toBeNull();
      expect(all[0]?.relatedTemplateId).toBeNull();
      expect(all[0]?.payload["week_start"]).toBe("2026-09-07");
    } finally {
      close();
    }
  });
});

describe("notification / markNotificationRead（#51）", () => {
  it("未读 → 已读：返回 true，viewed_at 用可注入时钟", () => {
    const { state, close } = freshDb({ now: "2026-09-09 08:00:00" });
    try {
      const id = insertNotification(state, {
        triggeredAt: "2026-09-08 08:00:00",
        kind: "due_24h",
        relatedTaskId: 1,
        payload: due24Payload(1),
      });
      expect(Notification.markNotificationRead(state, { id })).toBe(true);
      const fetched = Notification.getNotification(state, { id });
      expect(fetched.viewedAt).toBe("2026-09-09 08:00:00");
    } finally {
      close();
    }
  });

  it("已读再调：返回 false，viewed_at 不变", () => {
    const { state, clock, close } = freshDb({ now: "2026-09-09 08:00:00" });
    try {
      const id = insertNotification(state, {
        triggeredAt: "2026-09-08 08:00:00",
        kind: "due_24h",
        relatedTaskId: 1,
        payload: due24Payload(1),
        viewedAt: "2026-09-09 07:00:00",
      });
      clock.setAt("2026-09-09 12:00:00");
      expect(Notification.markNotificationRead(state, { id })).toBe(false);
      const fetched = Notification.getNotification(state, { id });
      // 没动——保持原来的 07:00
      expect(fetched.viewedAt).toBe("2026-09-09 07:00:00");
    } finally {
      close();
    }
  });

  it("标记一条后从 listUnreadNotifications 消失，从 listNotifications 仍存在", () => {
    const { state, close } = freshDb();
    try {
      const a = insertNotification(state, {
        triggeredAt: "2026-09-08 08:00:00",
        kind: "due_24h",
        relatedTaskId: 1,
        payload: due24Payload(1),
      });
      const b = insertNotification(state, {
        triggeredAt: "2026-09-08 09:00:00",
        kind: "due_24h",
        relatedTaskId: 2,
        payload: due24Payload(2),
      });
      Notification.markNotificationRead(state, { id: a });

      expect(Notification.listUnreadNotifications(state).map((n) => n.id)).toEqual([b]);
      expect(Notification.listNotifications(state).map((n) => n.id)).toEqual([b, a]);
    } finally {
      close();
    }
  });

  it("不存在的 id：返回 false，不抛", () => {
    const { state, close } = freshDb();
    try {
      expect(Notification.markNotificationRead(state, { id: 9999 })).toBe(false);
    } finally {
      close();
    }
  });
});

describe("notification / markAllNotificationsRead（#51）", () => {
  it("只动 viewed_at IS NULL 的行；返回本次实际标记的条数", () => {
    const { state, clock, close } = freshDb({ now: "2026-09-09 08:00:00" });
    try {
      // 2 条未读 + 1 条已读
      insertNotification(state, {
        triggeredAt: "2026-09-08 08:00:00",
        kind: "due_24h",
        relatedTaskId: 1,
        payload: due24Payload(1),
      });
      insertNotification(state, {
        triggeredAt: "2026-09-08 09:00:00",
        kind: "due_24h",
        relatedTaskId: 2,
        payload: due24Payload(2),
      });
      const alreadyRead = insertNotification(state, {
        triggeredAt: "2026-09-08 10:00:00",
        kind: "due_24h",
        relatedTaskId: 3,
        payload: due24Payload(3),
        viewedAt: "2026-09-08 11:00:00",
      });

      const count = Notification.markAllNotificationsRead(state);
      expect(count).toBe(2);

      // 已读那条 viewed_at 没变（仍是 11:00）
      const kept = Notification.getNotification(state, { id: alreadyRead });
      expect(kept.viewedAt).toBe("2026-09-08 11:00:00");

      // 全部已读后,未读面板空
      expect(Notification.listUnreadNotifications(state)).toEqual([]);

      // 再调一次 → 0（幂等）
      expect(Notification.markAllNotificationsRead(state)).toBe(0);

      // 时间走到 12:00,再调一次仍然是 0（前面标记的不会被覆盖）
      clock.setAt("2026-09-09 12:00:00");
      expect(Notification.markAllNotificationsRead(state)).toBe(0);
    } finally {
      close();
    }
  });

  it("混合 kind（due_24h / blocked_3d / weekly_digest）都能被批量标记", () => {
    const { state, close } = freshDb();
    try {
      insertNotification(state, {
        triggeredAt: "2026-09-08 08:00:00",
        kind: "due_24h",
        relatedTaskId: 1,
        payload: due24Payload(1),
      });
      insertNotification(state, {
        triggeredAt: "2026-09-08 09:00:00",
        kind: "blocked_3d",
        relatedTaskId: 2,
        payload: blockedPayload(2),
      });
      insertNotification(state, {
        triggeredAt: "2026-09-07 08:00:00",
        kind: "weekly_digest",
        payload: weeklyPayload(),
      });
      expect(Notification.markAllNotificationsRead(state)).toBe(3);
      expect(Notification.listUnreadNotifications(state)).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("notification / getNotification（#51）", () => {
  it("存在时返回 DTO；payload 是解析后的对象", () => {
    const { state, close } = freshDb();
    try {
      const id = insertNotification(state, {
        triggeredAt: "2026-09-08 08:00:00",
        kind: "blocked_3d",
        relatedTaskId: 7,
        payload: blockedPayload(7),
      });
      const got = Notification.getNotification(state, { id });
      expect(got.kind).toBe("blocked_3d");
      expect(got.relatedTaskId).toBe(7);
      expect(got.relatedTemplateId).toBeNull();
      expect(got.viewedAt).toBeNull();
      // payload 已被解析为对象,前端按 kind 分支渲染
      expect(got.payload["kind"]).toBe("blocked_3d");
      expect(got.payload["task_id"]).toBe(7);
      expect(got.payload["days_blocked"]).toBe(5);
    } finally {
      close();
    }
  });

  it("不存在时抛 AppError(INVALID_ARGUMENT)", () => {
    const { state, close } = freshDb();
    try {
      expect(() => Notification.getNotification(state, { id: 9999 })).toThrow(AppError);
      expect(() => Notification.getNotification(state, { id: 9999 })).toThrow(
        /通知不存在或已被删除/,
      );
    } finally {
      close();
    }
  });
});