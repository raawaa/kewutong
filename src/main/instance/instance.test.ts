/**
 * Instance 命令层测试（ticket #26 / #49 平迁）。
 *
 * 覆盖：
 * - rescheduleInstance：happy / 已取消 / 已完成 / 同时间拒绝 / 同模板占用拒绝 / 链深度
 * - overrideInstanceScheduledAt：happy + 拒绝 / 不挂 rescheduled_from_id
 * - updateRecurringTemplateZone：happy + 非法时区拒绝
 * - instanceRescheduleChain：单节点 / 链 / 深度 32 上限 / 环路检测
 *
 * 复用 [`freshDb`] + `Personnel` / `Project` / `RecurringTemplate` /
 * `Materialization` 拼出一个可改期的 instance fixture。
 */

import { describe, expect, it } from "vitest";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Personnel from "../personnel/index.js";
import * as Project from "../project/index.js";
import * as RecurringTemplate from "../recurring_template/index.js";
import * as Task from "../task/index.js";
import { AppError } from "../error.js";

import * as Instance from "./index.js";
import type {
  InstanceIdArgs,
  OverrideInstanceScheduledAtArgs,
  RescheduleInstanceArgs,
  StructuredRule,
  UpdateTemplateZoneArgs,
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

function setupWorld(now = "2026-09-10 08:00:00"): World {
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

/** 每周一 09:00 持续 12 周——简单 weekly 模板，方便物化出 instance。 */
function weeklyMon9am(): StructuredRule {
  return {
    freq: "weekly",
    bydayMask: RecurringTemplate.BYDAY_MO,
    bymonthday: null,
    bymonth: null,
    byhour: 9,
    byminute: 0,
    ianaZone: "Asia/Shanghai",
    ends: { kind: "on", date: "2026-12-31" },
    holidayBehavior: "skip",
  };
}

/** 直接 INSERT 一条 instance（绕开物化层，测试更聚焦）。 */
function rawInsertInstance(
  state: ReturnType<typeof freshDb>["state"],
  fields: {
    title: string;
    status: "Open" | "In-progress" | "Blocked" | "Waiting-on" | "Done" | "Cancelled";
    ownerPersonId: number;
    recurringTemplateId: number;
    scheduledAt: string;
    originalScheduledAt?: string | null;
    rescheduledFromId?: number | null;
  },
): number {
  const info = state.db
    .prepare(
      `INSERT INTO task
         (title, status, owner_person_id, project_id, recurring_template_id,
          scheduled_at, original_scheduled_at, rescheduled_from_id,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(
      fields.title,
      fields.status,
      fields.ownerPersonId,
      null,
      fields.recurringTemplateId,
      fields.scheduledAt,
      fields.originalScheduledAt ?? fields.scheduledAt,
      fields.rescheduledFromId ?? null,
    );
  return Number(info.lastInsertRowid);
}

// ===========================================================================
// rescheduleInstance
// ===========================================================================

describe("instance / rescheduleInstance（#26）", () => {
  it("happy path：原 Open 改期，原 → Cancelled + 新 → Open，rescheduledFromId 串起来", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const original = rawInsertInstance(world.state, {
        title: "周一例会 @ 2026-09-14",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00", // Mon 09:00 Asia/Shanghai = 01:00 UTC
      });

      const args: RescheduleInstanceArgs = {
        taskId: original,
        newScheduledAt: "2026-09-21 01:00:00", // 下一周 Mon 09:00
      };
      const newTask = Instance.rescheduleInstance(world.state, args);

      // 1) 返回的是新 instance
      expect(newTask.id).not.toBe(original);
      expect(newTask.status).toBe("Open");
      expect(newTask.scheduledAt).toBe("2026-09-21 01:00:00");
      expect(newTask.originalScheduledAt).toBe("2026-09-14 01:00:00");
      // 新 instance 的 rescheduled_from_id 指向原 instance（与 SHIFT 路径一致）。
      expect(newTask.rescheduledFromId).toBe(original);
      expect(newTask.recurringTemplateId).toBe(template.id);
      // 标题用「原定日期」（与 SHIFT 路径同语义）
      expect(newTask.title).toBe("周一例会 @ 2026-09-14");

      // 2) 原 instance 已是 Cancelled（rescheduled_from_id 仍为 NULL——根节点）
      const originalAfter = Task.fetchTask(world.state.db, original);
      expect(originalAfter).not.toBeNull();
      expect(originalAfter!.status).toBe("Cancelled");
      expect(originalAfter!.rescheduledFromId).toBeNull();
    } finally {
      world.close();
    }
  });

  it("原时间 = 新时间 → 拒绝", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const original = rawInsertInstance(world.state, {
        title: "周一例会",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      expect(() =>
        Instance.rescheduleInstance(world.state, {
          taskId: original,
          newScheduledAt: "2026-09-14 01:00:00",
        }),
      ).toThrowError(/改期目标时间与原时间相同/);
    } finally {
      world.close();
    }
  });

  it("目标时间已被同模板的另一个 instance 占用 → 拒绝", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const original = rawInsertInstance(world.state, {
        title: "周一例会 A",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      // 占用目标时间
      rawInsertInstance(world.state, {
        title: "周一例会 B",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-21 01:00:00",
      });
      expect(() =>
        Instance.rescheduleInstance(world.state, {
          taskId: original,
          newScheduledAt: "2026-09-21 01:00:00",
        }),
      ).toThrowError(/目标时间已被同模板的另一个 instance 占用/);
    } finally {
      world.close();
    }
  });

  it("已 Cancelled 拒绝", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const original = rawInsertInstance(world.state, {
        title: "周一例会",
        status: "Cancelled",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      expect(() =>
        Instance.rescheduleInstance(world.state, {
          taskId: original,
          newScheduledAt: "2026-09-21 01:00:00",
        }),
      ).toThrowError(/已取消的 instance 无法再改期/);
    } finally {
      world.close();
    }
  });

  it("已 Done 拒绝", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const original = rawInsertInstance(world.state, {
        title: "周一例会",
        status: "Done",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      expect(() =>
        Instance.rescheduleInstance(world.state, {
          taskId: original,
          newScheduledAt: "2026-09-21 01:00:00",
        }),
      ).toThrowError(/已完成的 instance 不能再改期/);
    } finally {
      world.close();
    }
  });

  it("非法时间格式 → 拒绝", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const original = rawInsertInstance(world.state, {
        title: "周一例会",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      expect(() =>
        Instance.rescheduleInstance(world.state, {
          taskId: original,
          newScheduledAt: "2026-09-14", // 缺时间
        }),
      ).toThrowError(/时间格式不对/);
    } finally {
      world.close();
    }
  });

  it("一次性 task（无 recurring_template_id）拒绝", () => {
    const world = setupWorld();
    try {
      // 一次性：recurring_template_id = NULL
      const info = world.state.db
        .prepare(
          `INSERT INTO task
             (title, status, owner_person_id, scheduled_at, original_scheduled_at,
              created_at, updated_at)
             VALUES ('一次性', 'Open', ?, NULL, NULL, datetime('now'), datetime('now'))`,
        )
        .run(world.personId);
      const oneOffId = Number(info.lastInsertRowid);
      expect(() =>
        Instance.rescheduleInstance(world.state, {
          taskId: oneOffId,
          newScheduledAt: "2026-09-21 01:00:00",
        }),
      ).toThrowError(/只有周期性 instance 可以改期/);
    } finally {
      world.close();
    }
  });

  it("rescheduleInstance 二次改期能形成 chain", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const original = rawInsertInstance(world.state, {
        title: "周一例会 @ 2026-09-14",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      const second = Instance.rescheduleInstance(world.state, {
        taskId: original,
        newScheduledAt: "2026-09-21 01:00:00",
      });
      const third = Instance.rescheduleInstance(world.state, {
        taskId: second.id,
        newScheduledAt: "2026-09-28 01:00:00",
      });
      // Rust 端 `load_instance_row` 返回的是「当前 row 的 `scheduled_at`」——
      // 链上每改一次，新 instance 的 `original_scheduled_at` 取自上一节
      // 点的 `scheduled_at`（即上一次的目标时间），不是「最最原始」的
      // 时间。`originalScheduledAt` 体现"最近一次改期来自哪"语义。
      expect(third.originalScheduledAt).toBe("2026-09-21 01:00:00");
      const chain = Instance.instanceRescheduleChain(world.state, { taskId: third.id });
      expect(chain.map((t) => t.id)).toEqual([third.id, second.id, original]);
    } finally {
      world.close();
    }
  });
});

// ===========================================================================
// overrideInstanceScheduledAt
// ===========================================================================

describe("instance / overrideInstanceScheduledAt（#26）", () => {
  it("happy path：仅 UPDATE scheduled_at，不挂 rescheduled_from_id", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const original = rawInsertInstance(world.state, {
        title: "周一例会",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      const args: OverrideInstanceScheduledAtArgs = {
        taskId: original,
        newScheduledAt: "2026-09-14 03:00:00", // 同日，2 小时后
      };
      const updated = Instance.overrideInstanceScheduledAt(world.state, args);
      expect(updated.id).toBe(original);
      expect(updated.scheduledAt).toBe("2026-09-14 03:00:00");
      expect(updated.rescheduledFromId).toBeNull();
      // 不创建新 instance
      const count = world.state.db
        .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM task WHERE recurring_template_id = ?")
        .get(template.id)?.c;
      expect(count).toBe(1);
    } finally {
      world.close();
    }
  });

  it("已 Cancelled 拒绝", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const original = rawInsertInstance(world.state, {
        title: "周一例会",
        status: "Cancelled",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      expect(() =>
        Instance.overrideInstanceScheduledAt(world.state, {
          taskId: original,
          newScheduledAt: "2026-09-14 03:00:00",
        }),
      ).toThrowError(/已取消的 instance 无法再覆盖/);
    } finally {
      world.close();
    }
  });

  it("目标时间 = 原时间 → 拒绝", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const original = rawInsertInstance(world.state, {
        title: "周一例会",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      expect(() =>
        Instance.overrideInstanceScheduledAt(world.state, {
          taskId: original,
          newScheduledAt: "2026-09-14 01:00:00",
        }),
      ).toThrowError(/覆盖目标时间与原时间相同/);
    } finally {
      world.close();
    }
  });

  it("目标时间已被同模板占用 → 拒绝", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const a = rawInsertInstance(world.state, {
        title: "A",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      rawInsertInstance(world.state, {
        title: "B",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-21 01:00:00",
      });
      expect(() =>
        Instance.overrideInstanceScheduledAt(world.state, {
          taskId: a,
          newScheduledAt: "2026-09-21 01:00:00",
        }),
      ).toThrowError(/目标时间已被同模板的另一个 instance 占用/);
    } finally {
      world.close();
    }
  });
});

// ===========================================================================
// updateRecurringTemplateZone
// ===========================================================================

describe("instance / updateRecurringTemplateZone（#26）", () => {
  it("happy path：改 iana_zone 后读回", () => {
    const world = setupWorld();
    try {
      const t = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const args: UpdateTemplateZoneArgs = { templateId: t.id, ianaZone: "Asia/Shanghai" };
      const updated = Instance.updateRecurringTemplateZone(world.state, args);
      expect(updated.id).toBe(t.id);
      expect(updated.ianaZone).toBe("Asia/Shanghai");
    } finally {
      world.close();
    }
  });

  it("非法时区拒绝", () => {
    const world = setupWorld();
    try {
      const t = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      expect(() =>
        Instance.updateRecurringTemplateZone(world.state, {
          templateId: t.id,
          ianaZone: "America/New_York",
        }),
      ).toThrowError(/仅支持 Asia\/Shanghai/);
    } finally {
      world.close();
    }
  });

  it("模板不存在 → 拒绝", () => {
    const world = setupWorld();
    try {
      expect(() =>
        Instance.updateRecurringTemplateZone(world.state, {
          templateId: 99999,
          ianaZone: "Asia/Shanghai",
        }),
      ).toThrowError(/模板不存在或已被删除/);
    } finally {
      world.close();
    }
  });
});

// ===========================================================================
// instanceRescheduleChain
// ===========================================================================

describe("instance / instanceRescheduleChain（#26）", () => {
  it("单节点（自身 rescheduledFromId = null）", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const only = rawInsertInstance(world.state, {
        title: "周一例会",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      const chain = Instance.instanceRescheduleChain(world.state, { taskId: only });
      expect(chain.map((t) => t.id)).toEqual([only]);
    } finally {
      world.close();
    }
  });

  it("三节点链：返回 [current, parent, root]", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const root = rawInsertInstance(world.state, {
        title: "根",
        status: "Cancelled",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      const middle = rawInsertInstance(world.state, {
        title: "中",
        status: "Cancelled",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-21 01:00:00",
        rescheduledFromId: root,
      });
      const leaf = rawInsertInstance(world.state, {
        title: "叶",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-28 01:00:00",
        rescheduledFromId: middle,
      });
      const chain = Instance.instanceRescheduleChain(world.state, { taskId: leaf });
      expect(chain.map((t) => t.id)).toEqual([leaf, middle, root]);
    } finally {
      world.close();
    }
  });

  it("深度上限 32：构造 33 节点链，只返回 32 个", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      // 链：root -> n1 -> n2 -> ... -> n32 -> leaf（共 33 个 id）。但
      // max depth = 32，函数从 leaf 回溯最多 32 步（含 leaf）= leaf + 31
      // 个祖先；最深一个祖先（最根）不会进链。
      //
      // 同一 (template, scheduledAt) 唯一约束，用每天 1h 间隔错开避免
      // 触发冲突——`2026-09-01 00:00:00` 起到 `2026-09-01 09:00:00`。
      const baseDate = new Date(Date.UTC(2026, 8, 1, 0, 0, 0)); // 09-01 00:00 UTC
      const ids: number[] = [];
      let prev: number | null = null;
      for (let i = 0; i < 33; i += 1) {
        const d = new Date(baseDate.getTime() + i * 60 * 60 * 1000);
        const pad = (n: number): string => String(n).padStart(2, "0");
        const scheduledAt =
          `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
          `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
        const id = rawInsertInstance(world.state, {
          title: `链节点 ${i}`,
          status: "Open",
          ownerPersonId: world.personId,
          recurringTemplateId: template.id,
          scheduledAt,
          rescheduledFromId: prev,
        });
        ids.push(id);
        prev = id;
      }
      // ids[0] 是根，ids[32] 是叶（最新）。
      const leaf = ids[ids.length - 1]!;
      const args: InstanceIdArgs = { taskId: leaf };
      const chain = Instance.instanceRescheduleChain(world.state, args);
      // chain 长度 = 32（leaf + 31 个祖先）
      expect(chain.length).toBe(Instance.RESCHEDULE_CHAIN_MAX_DEPTH);
      // 头是 leaf，尾是 ids[32 - 31] = ids[1]
      expect(chain[0]!.id).toBe(leaf);
      expect(chain[chain.length - 1]!.id).toBe(ids[1]);
    } finally {
      world.close();
    }
  });

  it("环路检测：A -> B -> A 不死循环", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const a = rawInsertInstance(world.state, {
        title: "A",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      const b = rawInsertInstance(world.state, {
        title: "B",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-21 01:00:00",
        rescheduledFromId: a,
      });
      // 手工造成 A.rescheduled_from_id = b 制造环。
      world.state.db
        .prepare("UPDATE task SET rescheduled_from_id = ? WHERE id = ?")
        .run(b, a);
      const chain = Instance.instanceRescheduleChain(world.state, { taskId: a });
      // 期望：[a, b]——到 b 时 next = a 已在 seen 里，break。
      expect(chain.map((t) => t.id)).toEqual([a, b]);
    } finally {
      world.close();
    }
  });

  it("未知 taskId → 返回空链", () => {
    const world = setupWorld();
    try {
      const chain = Instance.instanceRescheduleChain(world.state, { taskId: 99999 });
      expect(chain).toEqual([]);
    } finally {
      world.close();
    }
  });
});

// ===========================================================================
// parseSqlTimestamp / originalScheduledAtLocal（unit，纯函数）
// ===========================================================================

describe("instance / 内部 helper", () => {
  it("parseSqlTimestamp 合法格式通过", () => {
    // 通过 rescheduleInstance 的入参校验路径间接验证
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const t = rawInsertInstance(world.state, {
        title: "周一例会",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      expect(() =>
        Instance.rescheduleInstance(world.state, {
          taskId: t,
          newScheduledAt: "2026-09-14 23:59:59",
        }),
      ).not.toThrow();
    } finally {
      world.close();
    }
  });

  it("parseSqlTimestamp 非法格式抛 AppError.invalid 带中文消息", () => {
    const world = setupWorld();
    try {
      const template = RecurringTemplate.upsertRecurringTemplate(world.state, {
        id: null,
        name: "周一例会",
        rule: weeklyMon9am(),
        projectId: world.projectId,
        subTeamId: world.teamId,
        notes: null,
      });
      const t = rawInsertInstance(world.state, {
        title: "周一例会",
        status: "Open",
        ownerPersonId: world.personId,
        recurringTemplateId: template.id,
        scheduledAt: "2026-09-14 01:00:00",
      });
      try {
        Instance.rescheduleInstance(world.state, {
          taskId: t,
          newScheduledAt: "garbage",
        });
        throw new Error("应当抛 AppError");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("INVALID_ARGUMENT");
        expect((err as AppError).message).toContain("时间");
      }
    } finally {
      world.close();
    }
  });
});
