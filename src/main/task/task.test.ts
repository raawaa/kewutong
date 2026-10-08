import { describe, expect, it } from "vitest";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Personnel from "../personnel/index.js";
import * as Task from "./index.js";
import type { TaskStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Test fixture: 建一名人员 + 一个项目，简化后续测试的样板。
// ---------------------------------------------------------------------------

interface World {
  state: ReturnType<typeof freshDb>["state"];
  clock: ReturnType<typeof freshDb>["clock"];
  close: ReturnType<typeof freshDb>["close"];
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
  // 直接 INSERT 一个项目（占位骨架已就位，V001 后是 placeholder；ticket #20
  // 的 Project.createProject 需要 sub_team_id，所以这里用 Project 命令层）。
  // 让 SQLite 自动分配 id——V007/V008 的种子数据可能已占用 id=1。
  const info = ctx.state.db
    .prepare(
      `INSERT INTO project (name, owner_person_id, sub_team_id) VALUES (?, ?, ?)`,
    )
    .run("P-综合", person.id, team.id);
  return {
    state: ctx.state,
    clock: ctx.clock,
    close: ctx.close,
    teamId: team.id,
    personId: person.id,
    projectId: Number(info.lastInsertRowid),
  };
}

function rawInsert(
  state: ReturnType<typeof freshDb>["state"],
  fields: {
    title: string;
    status: TaskStatus;
    ownerPersonId: number;
    projectId?: number | null;
    dueDate?: string | null;
    description?: string | null;
    createdAt?: string;
    updatedAt?: string;
    blockedAt?: string | null;
    blockedReason?: string | null;
    waitingOnPersonId?: number | null;
    recurringTemplateId?: number | null;
    scheduledAt?: string | null;
  },
): number {
  const now = fields.createdAt ?? "2026-09-10 08:00:00";
  const info = state.db
    .prepare(
      `INSERT INTO task
         (title, description, status, owner_person_id, project_id, due_date,
          created_at, updated_at, blocked_at, blocked_reason, waiting_on_person_id,
          recurring_template_id, scheduled_at, original_scheduled_at, rescheduled_from_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      fields.title,
      fields.description ?? null,
      fields.status,
      fields.ownerPersonId,
      fields.projectId ?? null,
      fields.dueDate ?? null,
      now,
      fields.updatedAt ?? now,
      fields.blockedAt ?? null,
      fields.blockedReason ?? null,
      fields.waitingOnPersonId ?? null,
      fields.recurringTemplateId ?? null,
      fields.scheduledAt ?? null,
      fields.scheduledAt ?? null, // original_scheduled_at
    );
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe("task / createTask（#18）", () => {
  it("默认 status = Open，blocked_* 全空", () => {
    const ctx = setupWorld();
    try {
      const t = Task.createTask(ctx.state, {
        title: "审合同",
        ownerPersonId: ctx.personId,
        projectId: null,
      });
      expect(t.status).toBe("Open");
      expect(t.blockedAt).toBeNull();
      expect(t.blockedReason).toBeNull();
      expect(t.waitingOnPersonId).toBeNull();
      expect(t.isRecurring).toBe(false);
      expect(t.effectiveDate).toBeNull();
      expect(t.createdAt).toBe("2026-09-10 08:00:00");
    } finally {
      ctx.close();
    }
  });

  it("空白 title 拒绝", () => {
    const ctx = setupWorld();
    try {
      expect(() =>
        Task.createTask(ctx.state, {
          title: "   ",
          ownerPersonId: ctx.personId,
        }),
      ).toThrow(/任务标题不能为空/);
    } finally {
      ctx.close();
    }
  });

  it("不存在的负责人 / 项目拒绝", () => {
    const ctx = setupWorld();
    try {
      expect(() =>
        Task.createTask(ctx.state, { title: "x", ownerPersonId: 999 }),
      ).toThrow(/负责人不存在/);
      expect(() =>
        Task.createTask(ctx.state, {
          title: "x",
          ownerPersonId: ctx.personId,
          projectId: 999,
        }),
      ).toThrow(/所属项目不存在/);
    } finally {
      ctx.close();
    }
  });

  it("非法 due_date 拒绝", () => {
    const ctx = setupWorld();
    try {
      expect(() =>
        Task.createTask(ctx.state, {
          title: "x",
          ownerPersonId: ctx.personId,
          dueDate: "2026/09/10",
        }),
      ).toThrow(/截止日格式不对/);
    } finally {
      ctx.close();
    }
  });
});

describe("task / updateTask（#19）", () => {
  it("改 5 字段 + updated_at；不碰 status / blocked_*", () => {
    const ctx = setupWorld();
    try {
      const created = Task.createTask(ctx.state, {
        title: "原标题",
        description: "原描述",
        ownerPersonId: ctx.personId,
        projectId: ctx.projectId,
        dueDate: "2026-09-10",
      });
      ctx.clock.setAt("2026-09-11 09:00:00");

      const updated = Task.updateTask(ctx.state, {
        id: created.id,
        title: "新标题",
        description: "新描述",
        ownerPersonId: ctx.personId,
        projectId: null,
        dueDate: "2026-09-20",
      });
      expect(updated.title).toBe("新标题");
      expect(updated.description).toBe("新描述");
      expect(updated.projectId).toBeNull();
      expect(updated.dueDate).toBe("2026-09-20");
      expect(updated.updatedAt).toBe("2026-09-11 09:00:00");
      // status / blocked_* 不变
      expect(updated.status).toBe("Open");
      expect(updated.blockedAt).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("不存在的 id 拒绝", () => {
    const ctx = setupWorld();
    try {
      expect(() =>
        Task.updateTask(ctx.state, {
          id: 99999,
          title: "x",
          ownerPersonId: ctx.personId,
        }),
      ).toThrow(/任务不存在或已被删除/);
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

describe("task / setTaskStatus — 状态机（#44）", () => {
  it("进入 Blocked：要求 reason，写 blocked_at，waiting_on 清空", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "t",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      ctx.clock.setAt("2026-09-12 10:00:00");
      const t = Task.setTaskStatus(ctx.state, {
        taskId: id,
        status: "Blocked",
        blockedReason: "等外委回函",
        waitingOnPersonId: null,
      });
      expect(t.status).toBe("Blocked");
      expect(t.blockedReason).toBe("等外委回函");
      expect(t.blockedAt).toBe("2026-09-12 10:00:00");
      // Blocked 下 waitingOnPersonId 必须为 null（即使传了也会被清空）。
      expect(t.waitingOnPersonId).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("进入 Waiting-on：允许 waiting_on_person_id", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "t",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const t = Task.setTaskStatus(ctx.state, {
        taskId: id,
        status: "Waiting-on",
        blockedReason: "等分管领导批示",
        waitingOnPersonId: ctx.personId,
      });
      expect(t.status).toBe("Waiting-on");
      expect(t.waitingOnPersonId).toBe(ctx.personId);
    } finally {
      ctx.close();
    }
  });

  it("切出 Blocked：blocked_* 三列全部清空", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "t",
        status: "Blocked",
        ownerPersonId: ctx.personId,
        blockedAt: "2026-09-10 08:00:00",
        blockedReason: "等外委回函",
        waitingOnPersonId: null,
      });
      const t = Task.setTaskStatus(ctx.state, {
        taskId: id,
        status: "Open",
        blockedReason: "应被忽略",
        waitingOnPersonId: 99,
      });
      expect(t.status).toBe("Open");
      expect(t.blockedAt).toBeNull();
      expect(t.blockedReason).toBeNull();
      expect(t.waitingOnPersonId).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("Blocked / Waiting-on 缺 reason 被拒", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "t",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      expect(() =>
        Task.setTaskStatus(ctx.state, {
          taskId: id,
          status: "Blocked",
          blockedReason: "   ",
          waitingOnPersonId: null,
        }),
      ).toThrow(/阻塞原因不能为空/);
      expect(() =>
        Task.setTaskStatus(ctx.state, {
          taskId: id,
          status: "Waiting-on",
          blockedReason: null,
          waitingOnPersonId: null,
        }),
      ).toThrow(/等待原因不能为空/);
    } finally {
      ctx.close();
    }
  });

  it("Blocked / Waiting-on reason > 500 字符被拒", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "t",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const long = "啊".repeat(501);
      expect(() =>
        Task.setTaskStatus(ctx.state, {
          taskId: id,
          status: "Blocked",
          blockedReason: long,
          waitingOnPersonId: null,
        }),
      ).toThrow(/500/);
    } finally {
      ctx.close();
    }
  });

  it("不存在的 taskId 拒绝", () => {
    const ctx = setupWorld();
    try {
      expect(() =>
        Task.setTaskStatus(ctx.state, {
          taskId: 99999,
          status: "Open",
          blockedReason: null,
          waitingOnPersonId: null,
        }),
      ).toThrow(/任务不存在或已被删除/);
    } finally {
      ctx.close();
    }
  });

  it("6 状态切换：每次进入阻塞态刷新 blocked_at", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "t",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      // Open → Blocked @ t1
      ctx.clock.setAt("2026-09-10 09:00:00");
      let t = Task.setTaskStatus(ctx.state, {
        taskId: id,
        status: "Blocked",
        blockedReason: "r1",
        waitingOnPersonId: null,
      });
      expect(t.blockedAt).toBe("2026-09-10 09:00:00");
      // Blocked → Waiting-on @ t2
      ctx.clock.setAt("2026-09-10 10:00:00");
      t = Task.setTaskStatus(ctx.state, {
        taskId: id,
        status: "Waiting-on",
        blockedReason: "r2",
        waitingOnPersonId: ctx.personId,
      });
      expect(t.blockedAt).toBe("2026-09-10 10:00:00"); // 覆盖
      expect(t.status).toBe("Waiting-on");
      // Waiting-on → Open
      t = Task.setTaskStatus(ctx.state, {
        taskId: id,
        status: "Open",
        blockedReason: null,
        waitingOnPersonId: null,
      });
      expect(t.blockedAt).toBeNull();
      expect(t.blockedReason).toBeNull();
      expect(t.waitingOnPersonId).toBeNull();
      // Open → In-progress
      t = Task.setTaskStatus(ctx.state, {
        taskId: id,
        status: "In-progress",
        blockedReason: null,
        waitingOnPersonId: null,
      });
      expect(t.status).toBe("In-progress");
      // In-progress → Done
      t = Task.setTaskStatus(ctx.state, {
        taskId: id,
        status: "Done",
        blockedReason: null,
        waitingOnPersonId: null,
      });
      expect(t.status).toBe("Done");
      // Done → Cancelled
      t = Task.setTaskStatus(ctx.state, {
        taskId: id,
        status: "Cancelled",
        blockedReason: null,
        waitingOnPersonId: null,
      });
      expect(t.status).toBe("Cancelled");
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// deriveBlockColumns 纯函数
// ---------------------------------------------------------------------------

describe("task / deriveBlockColumns 纯函数", () => {
  it("进入 Blocked 时清掉 waiting_on_person_id", () => {
    const r = Task.deriveBlockColumns("Blocked", "等外委回函", 7, "2026-09-10 08:00:00");
    expect(r.blockedAt).toBe("2026-09-10 08:00:00");
    expect(r.blockedReason).toBe("等外委回函");
    expect(r.waitingOnPersonId).toBeNull();
  });

  it("进入 Waiting-on 时保留 waiting_on_person_id", () => {
    const r = Task.deriveBlockColumns("Waiting-on", "等批示", 42, "2026-09-10 08:00:00");
    expect(r.blockedAt).toBe("2026-09-10 08:00:00");
    expect(r.blockedReason).toBe("等批示");
    expect(r.waitingOnPersonId).toBe(42);
  });

  it("切出到 Open：三列全部清空", () => {
    const r = Task.deriveBlockColumns("Open", "应被忽略", 99, "now");
    expect(r.blockedAt).toBeNull();
    expect(r.blockedReason).toBeNull();
    expect(r.waitingOnPersonId).toBeNull();
  });

  it("reason 超 500 字符被拒", () => {
    const long = "啊".repeat(501);
    expect(() => Task.deriveBlockColumns("Blocked", long, null, "now")).toThrow(/500/);
  });

  it("缺 reason 被拒（中文消息）", () => {
    expect(() => Task.deriveBlockColumns("Blocked", "   ", null, "now")).toThrow(/阻塞原因不能为空/);
    expect(() => Task.deriveBlockColumns("Waiting-on", null, null, "now")).toThrow(/等待原因不能为空/);
  });
});

// ---------------------------------------------------------------------------
// listTasks
// ---------------------------------------------------------------------------

describe("task / listTasks（#18）", () => {
  it("默认 includeCancelled=false：过滤 Cancelled", () => {
    const ctx = setupWorld();
    try {
      const idOpen = rawInsert(ctx.state, {
        title: "a",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      rawInsert(ctx.state, {
        title: "b",
        status: "Cancelled",
        ownerPersonId: ctx.personId,
      });
      // 按 owner 过滤，避免 V007/V008 种子数据干扰。
      const ts = Task.listTasks(ctx.state, {
        includeCancelled: false,
        ownerPersonId: ctx.personId,
      });
      expect(ts.map((t) => t.id)).toEqual([idOpen]);
    } finally {
      ctx.close();
    }
  });

  it("owner / project 过滤", () => {
    const ctx = setupWorld();
    try {
      const idProj = rawInsert(ctx.state, {
        title: "p1",
        status: "Open",
        ownerPersonId: ctx.personId,
        projectId: ctx.projectId,
      });
      rawInsert(ctx.state, {
        title: "no_proj",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const byProj = Task.listTasks(ctx.state, {
        includeCancelled: false,
        projectId: ctx.projectId,
        ownerPersonId: ctx.personId,
      });
      expect(byProj.map((t) => t.id)).toEqual([idProj]);
    } finally {
      ctx.close();
    }
  });

  it("在飞优先排序：Done 排在在飞后面", () => {
    const ctx = setupWorld();
    try {
      const idOpen = rawInsert(ctx.state, {
        title: "open",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-10",
      });
      const idDone = rawInsert(ctx.state, {
        title: "done",
        status: "Done",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-11",
      });
      const ts = Task.listTasks(ctx.state, {
        includeCancelled: true,
        ownerPersonId: ctx.personId,
      });
      // 在飞优先：Open 在前，Done 在后（owner's 两个 task）。
      expect(ts.map((t) => t.id)).toEqual([idOpen, idDone]);
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// listTasksFiltered
// ---------------------------------------------------------------------------

describe("task / listTasksFiltered（#27）", () => {
  it("statuses 过滤", () => {
    const ctx = setupWorld();
    try {
      rawInsert(ctx.state, {
        title: "open",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const idBlocked = rawInsert(ctx.state, {
        title: "blocked",
        status: "Blocked",
        ownerPersonId: ctx.personId,
        blockedReason: "r",
      });
      const ts = Task.listTasksFiltered(ctx.state, {
        statuses: ["Blocked"],
        ownerPersonId: ctx.personId,
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      expect(ts.map((t) => t.id)).toEqual([idBlocked]);
    } finally {
      ctx.close();
    }
  });

  it("due_date 区间", () => {
    const ctx = setupWorld();
    try {
      rawInsert(ctx.state, {
        title: "early",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-08",
      });
      rawInsert(ctx.state, {
        title: "mid",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-10",
      });
      const idLate = rawInsert(ctx.state, {
        title: "late",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-15",
      });
      const ts = Task.listTasksFiltered(ctx.state, {
        statuses: [],
        ownerPersonId: ctx.personId,
        dueDateFrom: "2026-09-08",
        dueDateTo: "2026-09-10",
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      const ids = ts.map((t) => t.id);
      expect(ids).not.toContain(idLate);
      expect(ts.map((t) => t.title).sort()).toEqual(["early", "mid"]);
    } finally {
      ctx.close();
    }
  });

  it("includeDeactivatedOwners=true 保留离岗人员的任务", () => {
    const ctx = setupWorld();
    try {
      const a = Personnel.createPerson(ctx.state, {
        name: "李四",
        subTeamId: ctx.teamId,
        contact: "999",
      });
      Personnel.deactivatePerson(ctx.state, { id: a.id });
      const idA = rawInsert(ctx.state, {
        title: "by_a",
        status: "Open",
        ownerPersonId: a.id,
      });
      const noOff = Task.listTasksFiltered(ctx.state, {
        statuses: [],
        ownerPersonId: a.id,
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      expect(noOff).toEqual([]);
      const withOff = Task.listTasksFiltered(ctx.state, {
        statuses: [],
        ownerPersonId: a.id,
        includeCancelled: false,
        includeDeactivatedOwners: true,
      });
      expect(withOff.map((t) => t.id)).toEqual([idA]);
    } finally {
      ctx.close();
    }
  });

  it("dueDateFrom 非法格式拒绝", () => {
    const ctx = setupWorld();
    try {
      expect(() =>
        Task.listTasksFiltered(ctx.state, {
          statuses: [],
          dueDateFrom: "2026/09/10",
          includeCancelled: false,
          includeDeactivatedOwners: false,
        }),
      ).toThrow(/截止日起格式不对/);
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// todayWeek
// ---------------------------------------------------------------------------

describe("task / todayWeek（#21）", () => {
  it("4 桶：Mon 周一 → 跨到周日；周日当天 → 空", () => {
    // 2026-09-07 = 周一
    const monday = freshDb({ now: "2026-09-07 08:00:00" });
    try {
      const team = Personnel.createSubTeam(monday.state, { name: "一组" });
      const person = Personnel.createPerson(monday.state, {
        name: "甲",
        subTeamId: team.id,
        contact: "1",
      });
      // 周一到周日范围内建几条任务
      rawInsert(monday.state, {
        title: "overdue",
        status: "Open",
        ownerPersonId: person.id,
        dueDate: "2026-09-05",
      });
      rawInsert(monday.state, {
        title: "today",
        status: "Open",
        ownerPersonId: person.id,
        dueDate: "2026-09-07",
      });
      rawInsert(monday.state, {
        title: "tomorrow",
        status: "Open",
        ownerPersonId: person.id,
        dueDate: "2026-09-08",
      });
      rawInsert(monday.state, {
        title: "this_week_rest",
        status: "Open",
        ownerPersonId: person.id,
        dueDate: "2026-09-13",
      });
      const tw = Task.todayWeek(monday.state);
      // 按 owner 过滤，避开 V007/V008 种子。
      const ownerBucket = (b: typeof tw.buckets.overdue) =>
        b.filter((t) => t.ownerPersonId === person.id);
      expect(ownerBucket(tw.buckets.overdue).map((t) => t.title)).toEqual(["overdue"]);
      expect(ownerBucket(tw.buckets.today).map((t) => t.title)).toEqual(["today"]);
      expect(ownerBucket(tw.buckets.tomorrow).map((t) => t.title)).toEqual(["tomorrow"]);
      expect(ownerBucket(tw.buckets.thisWeekRest).map((t) => t.title)).toEqual([
        "this_week_rest",
      ]);
      expect(tw.materializationWindowEnd).toBe("2026-11-30"); // 2026-09-07 + 84d
    } finally {
      monday.close();
    }

    // 2026-09-13 = 周日
    const sunday = freshDb({ now: "2026-09-13 08:00:00" });
    try {
      const team = Personnel.createSubTeam(sunday.state, { name: "一组" });
      const person = Personnel.createPerson(sunday.state, {
        name: "甲",
        subTeamId: team.id,
        contact: "1",
      });
      rawInsert(sunday.state, {
        title: "today",
        status: "Open",
        ownerPersonId: person.id,
        dueDate: "2026-09-13",
      });
      const tw = Task.todayWeek(sunday.state);
      // 周日：今天 = 周日，今天 + 1 = 周一(下周)，本周剩余 = 今天..今天 = today。
      // 但 spec 说「周日当天桶为空（再往后就是下周）」——指 thisWeekRest 空。
      expect(tw.buckets.today.map((t) => t.title)).toEqual(["today"]);
      expect(tw.buckets.thisWeekRest).toEqual([]);
    } finally {
      sunday.close();
    }
  });

  it("瓦片数与 active_people / in_progress / blocked 对齐", () => {
    const ctx = setupWorld();
    try {
      // 在 V007/V008 已有的种子数据上额外加几条——counts 全局，所以我们只验
      // 相对增量（counts 包含种子数据）。
      const baseInProgress = ctx.state.db
        .prepare<[string], { c: number }>(
          "SELECT COUNT(*) AS c FROM task WHERE status = ?",
        )
        .get("In-progress")?.c ?? 0;
      const baseBlocked = ctx.state.db
        .prepare<unknown[], { c: number }>(
          "SELECT COUNT(*) AS c FROM task WHERE status IN (?, ?)",
        )
        .get("Blocked", "Waiting-on")?.c ?? 0;

      rawInsert(ctx.state, {
        title: "ip1",
        status: "In-progress",
        ownerPersonId: ctx.personId,
      });
      rawInsert(ctx.state, {
        title: "bl1",
        status: "Blocked",
        ownerPersonId: ctx.personId,
        blockedReason: "r",
      });
      rawInsert(ctx.state, {
        title: "wo1",
        status: "Waiting-on",
        ownerPersonId: ctx.personId,
        blockedReason: "r",
      });
      const tw = Task.todayWeek(ctx.state);
      // activePeople 全局：不会变（没 create 新 person）。
      expect(tw.counts.activePeople).toBeGreaterThanOrEqual(1);
      // in-progress + 1（种子中已有 1 条 In-progress）。
      expect(tw.counts.inProgress).toBe(baseInProgress + 1);
      // blocked 全局：种子 + 我们加的 2 条，至少 +2。
      expect(tw.counts.blocked).toBe(baseBlocked + 2);
    } finally {
      ctx.close();
    }
  });

  it("Done / Cancelled 不进任何桶", () => {
    const ctx = setupWorld();
    try {
      rawInsert(ctx.state, {
        title: "done-mine",
        status: "Done",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-10",
      });
      rawInsert(ctx.state, {
        title: "cancelled-mine",
        status: "Cancelled",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-10",
      });
      const tw = Task.todayWeek(ctx.state);
      // 我们刚 create 的两条 Done / Cancelled 不能出现在任何桶里——按 title 过滤确认。
      const titlesInBuckets = [
        ...tw.buckets.overdue,
        ...tw.buckets.today,
        ...tw.buckets.tomorrow,
        ...tw.buckets.thisWeekRest,
      ].map((t) => t.title);
      expect(titlesInBuckets).not.toContain("done-mine");
      expect(titlesInBuckets).not.toContain("cancelled-mine");
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// listDueDateOptions
// ---------------------------------------------------------------------------

describe("task / listDueDateOptions（#19）", () => {
  it("返回 4 个 chip，按顺序：今天 / 明天 / 一周后 / 无", () => {
    const ctx = setupWorld();
    try {
      const opts = Task.listDueDateOptions(ctx.state);
      expect(opts.map((o) => o.chip)).toEqual([
        "today",
        "tomorrow",
        "next-week",
        "none",
      ]);
      expect(opts[0]?.dueDate).toBe("2026-09-10");
      expect(opts[1]?.dueDate).toBe("2026-09-11");
      expect(opts[2]?.dueDate).toBe("2026-09-17");
      expect(opts[3]?.dueDate).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("label 文案中文", () => {
    const ctx = setupWorld();
    try {
      const opts = Task.listDueDateOptions(ctx.state);
      expect(opts[0]?.label).toBe("今天");
      expect(opts[1]?.label).toBe("明天");
      expect(opts[2]?.label).toBe("一周后");
      expect(opts[3]?.label).toBe("无");
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// weekEnd 纯函数
// ---------------------------------------------------------------------------

describe("task / weekEnd", () => {
  it("周一到周日分别是 +6..+0 天后", () => {
    const dates = [
      ["2026-09-07", "2026-09-13"], // Mon
      ["2026-09-08", "2026-09-13"], // Tue
      ["2026-09-09", "2026-09-13"], // Wed
      ["2026-09-10", "2026-09-13"], // Thu
      ["2026-09-11", "2026-09-13"], // Fri
      ["2026-09-12", "2026-09-13"], // Sat
      ["2026-09-13", "2026-09-13"], // Sun
    ];
    for (const [d, expected] of dates) {
      // 2026-09-07 是周一；JS Date 用 UTC date 表示本地日历日。
      const today = new Date(`${d}T00:00:00Z`);
      const end = Task.weekEnd(today);
      const yyyy = end.getUTCFullYear();
      const mm = String(end.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(end.getUTCDate()).padStart(2, "0");
      expect(`${yyyy}-${mm}-${dd}`).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchInFlightTasksForPerson 排序
// ---------------------------------------------------------------------------

describe("task / fetchInFlightTasksForPerson 排序", () => {
  it("按 状态优先级 + effective_date 升序", () => {
    const ctx = setupWorld();
    try {
      rawInsert(ctx.state, {
        title: "open",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-10",
      });
      rawInsert(ctx.state, {
        title: "blocked",
        status: "Blocked",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-15",
        blockedReason: "r",
      });
      rawInsert(ctx.state, {
        title: "in_progress",
        status: "In-progress",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-08",
      });
      const ts = Task.fetchInFlightTasksForPerson(ctx.state.db, ctx.personId);
      // 顺序：Open(0), In-progress(1), Blocked(2)
      expect(ts.map((t) => t.status)).toEqual([
        "Open",
        "In-progress",
        "Blocked",
      ]);
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// TASK_COLUMNS / TASK_COLUMNS_WITH_T / SEARCH_TASKS_LIMIT
// ---------------------------------------------------------------------------

describe("task / 共享片段", () => {
  it("TASK_COLUMNS 含 effective_date COALESCE 表达式", () => {
    expect(Task.TASK_COLUMNS).toContain("COALESCE(due_date, date(scheduled_at, '+8 hours')) AS effective_date");
  });
  it("TASK_COLUMNS_WITH_T 带 t. 前缀", () => {
    expect(Task.TASK_COLUMNS_WITH_T).toContain("t.id");
    expect(Task.TASK_COLUMNS_WITH_T).toContain("COALESCE(t.due_date");
  });
  it("SEARCH_TASKS_LIMIT = 50", () => {
    expect(Task.SEARCH_TASKS_LIMIT).toBe(50);
  });
  it("inFlightTaskOrderBy 含 6 状态前缀 + 在飞置前", () => {
    const sql = Task.inFlightTaskOrderBy("t.");
    expect(sql).toContain("CASE WHEN t.status IN");
    expect(sql).toContain("'Open','In-progress','Blocked','Waiting-on'");
    expect(sql).toContain("t.due_date ASC");
  });
  it("TASK_STATUSES 6 值", () => {
    expect(Task.TASK_STATUSES.length).toBe(6);
    expect(Task.TASK_STATUSES).toContain("Open");
    expect(Task.TASK_STATUSES).toContain("In-progress");
    expect(Task.TASK_STATUSES).toContain("Blocked");
    expect(Task.TASK_STATUSES).toContain("Waiting-on");
    expect(Task.TASK_STATUSES).toContain("Done");
    expect(Task.TASK_STATUSES).toContain("Cancelled");
  });
});

// ---------------------------------------------------------------------------
// sanitizeFts5Query 纯函数（#45）
// ---------------------------------------------------------------------------

describe("task / sanitizeFts5Query（#45）", () => {
  it("空输入 → 空字符串", () => {
    expect(Task.sanitizeFts5Query("")).toBe("");
  });
  it("全是 FTS5 特殊字符 → 空字符串", () => {
    expect(Task.sanitizeFts5Query("***")).toBe("");
    expect(Task.sanitizeFts5Query("\"\"")).toBe("");
    expect(Task.sanitizeFts5Query("()")).toBe("");
    expect(Task.sanitizeFts5Query(":-^+-")).toBe("");
  });
  it("LIKE 元字符也被替换", () => {
    expect(Task.sanitizeFts5Query("%")).toBe("");
    expect(Task.sanitizeFts5Query("_")).toBe("");
    expect(Task.sanitizeFts5Query("\\")).toBe("");
  });
  it("特殊字符替换为空白 + 折叠多空白", () => {
    expect(Task.sanitizeFts5Query("a*b")).toBe("a b");
    expect(Task.sanitizeFts5Query('"合同"')).toBe("合同");
    expect(Task.sanitizeFts5Query("  合同  ")).toBe("合同");
    expect(Task.sanitizeFts5Query("a  *  b")).toBe("a b");
  });
  it("汉字 / 字母 / 数字 / 普通标点保留", () => {
    expect(Task.sanitizeFts5Query("外委合同 2024")).toBe("外委合同 2024");
    expect(Task.sanitizeFts5Query("合同，评审")).toBe("合同，评审");
    expect(Task.sanitizeFts5Query("task/评审")).toBe("task/评审");
  });
});

// ---------------------------------------------------------------------------
// searchTasks FTS5 全文搜索（#45）
// ---------------------------------------------------------------------------

describe("task / searchTasks（#45）", () => {
  it("空关键词被拒", () => {
    const ctx = setupWorld();
    try {
      expect(() =>
        Task.searchTasks(ctx.state, {
          query: "   ",
          includeCancelled: false,
          includeDeactivatedOwners: false,
        }),
      ).toThrow(/搜索关键词不能为空/);
    } finally {
      ctx.close();
    }
  });

  it("关键词全是 FTS5 特殊字符：返回空列表而不是抛错", () => {
    const ctx = setupWorld();
    try {
      rawInsert(ctx.state, {
        title: "某任务",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const hits = Task.searchTasks(ctx.state, {
        query: "***",
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      expect(hits).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it("≥3 字中文走 FTS5 trigram：'委合同' 命中 '外委合同评审'", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "外委合同评审",
        description: "本年度外委合同集中评审",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const hits = Task.searchTasks(ctx.state, {
        query: "委合同",
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      expect(hits.map((t) => t.id)).toEqual([id]);
    } finally {
      ctx.close();
    }
  });

  it("描述里的关键词也进 FTS5 索引", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "整理卷宗",
        description: "把去年的项目档案归档入库",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      // 「档案归档」3 字 -> 走 FTS5 trigram
      const hits = Task.searchTasks(ctx.state, {
        query: "档案归档",
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      expect(hits.map((t) => t.id)).toEqual([id]);
    } finally {
      ctx.close();
    }
  });

  it("<3 字短查询走 LIKE 兜底：'合同' 命中 '外委合同评审'", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "外委合同评审",
        description: null,
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const hits = Task.searchTasks(ctx.state, {
        query: "合同",
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      expect(hits.map((t) => t.id)).toEqual([id]);
    } finally {
      ctx.close();
    }
  });

  it("1 字查询走 LIKE 兜底", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "外委合同评审",
        description: null,
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const hits = Task.searchTasks(ctx.state, {
        query: "合",
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      expect(hits.map((t) => t.id)).toEqual([id]);
    } finally {
      ctx.close();
    }
  });

  it("limit 截断返回前 N 条", () => {
    const ctx = setupWorld();
    try {
      for (let i = 0; i < 10; i++) {
        rawInsert(ctx.state, {
          title: `合同任务 ${String(i).padStart(2, "0")}`,
          description: null,
          status: "Open",
          ownerPersonId: ctx.personId,
        });
      }
      const hits = Task.searchTasks(ctx.state, {
        query: "合同",
        includeCancelled: false,
        includeDeactivatedOwners: false,
        limit: 3,
      });
      expect(hits.length).toBe(3);
    } finally {
      ctx.close();
    }
  });

  it("默认过滤 Cancelled 与离岗人员负责的任务", () => {
    const ctx = setupWorld();
    try {
      const a = Personnel.createPerson(ctx.state, {
        name: "李四",
        subTeamId: ctx.teamId,
        contact: "999",
      });
      const idActive = rawInsert(ctx.state, {
        title: "外委合同 A",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const idCancelled = rawInsert(ctx.state, {
        title: "外委合同 B",
        status: "Cancelled",
        ownerPersonId: ctx.personId,
      });
      const idDeactivated = rawInsert(ctx.state, {
        title: "外委合同 C",
        status: "Open",
        ownerPersonId: a.id,
      });
      Personnel.deactivatePerson(ctx.state, { id: a.id });

      // 默认 includeCancelled=false / includeDeactivatedOwners=false
      const hits = Task.searchTasks(ctx.state, {
        query: "外委合同",
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      expect(hits.map((t) => t.id)).toEqual([idActive]);

      // 打开 includeCancelled：cancelled 仍出现，deactivated 不出现
      const withCancelled = Task.searchTasks(ctx.state, {
        query: "外委合同",
        includeCancelled: true,
        includeDeactivatedOwners: false,
      });
      const withCancelledIds = withCancelled.map((t) => t.id).sort();
      expect(withCancelledIds).toEqual([idActive, idCancelled].sort());

      // 全部打开：3 条都出现
      const allOpen = Task.searchTasks(ctx.state, {
        query: "外委合同",
        includeCancelled: true,
        includeDeactivatedOwners: true,
      });
      expect(allOpen.map((t) => t.id).sort()).toEqual(
        [idActive, idCancelled, idDeactivated].sort(),
      );
    } finally {
      ctx.close();
    }
  });

  it("update 后 FTS 行同步：旧词消失，新词命中", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "原任务",
        description: "原描述",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      // update 改标题与描述
      Task.updateTask(ctx.state, {
        id,
        title: "新任务",
        description: "新描述",
        ownerPersonId: ctx.personId,
      });

      // 新词命中
      const newHits = Task.searchTasks(ctx.state, {
        query: "新任务",
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      expect(newHits.map((t) => t.id)).toEqual([id]);

      // 旧词消失
      const oldHits = Task.searchTasks(ctx.state, {
        query: "原任务",
        includeCancelled: false,
        includeDeactivatedOwners: false,
      });
      expect(oldHits).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it("insert 后 task_fts 影子表立即可见（触发器 task_ai 有效）", () => {
    const ctx = setupWorld();
    try {
      const id = rawInsert(ctx.state, {
        title: "外委合同评审",
        description: null,
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      // 直接断言影子表行数
      const count = ctx.state.db
        .prepare<[number], { c: number }>(
          "SELECT COUNT(*) AS c FROM task_fts WHERE rowid = ?",
        )
        .get(id)?.c ?? 0;
      expect(count).toBe(1);
    } finally {
      ctx.close();
    }
  });
});
