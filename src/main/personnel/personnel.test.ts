import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Personnel from "./index.js";
import * as Project from "../project/index.js";
import * as RecurringTemplate from "../recurring_template/index.js";
import { AppError } from "../error.js";
import { withTx } from "../sqlite.js";
import type { AppState } from "../state.js";

describe("personnel / 子组 CRUD（#17）", () => {
  it("空库时 listSubTeams 返回空", () => {
    const { state, close } = freshDb();
    try {
      expect(Personnel.listSubTeams(state)).toEqual([]);
    } finally {
      close();
    }
  });

  it("createSubTeam 自动追加 sortOrder", () => {
    const { state, close } = freshDb();
    try {
      const a = Personnel.createSubTeam(state, { name: "一组" });
      const b = Personnel.createSubTeam(state, { name: "二组" });
      expect(a.sortOrder).toBe(0);
      expect(b.sortOrder).toBe(1);
    } finally {
      close();
    }
  });

  it("createSubTeam 拒绝空名 / 重复名", () => {
    const { state, close } = freshDb();
    try {
      Personnel.createSubTeam(state, { name: "一组" });
      expect(() => Personnel.createSubTeam(state, { name: "  " })).toThrow(AppError);
      expect(() => Personnel.createSubTeam(state, { name: "一组" })).toThrow(AppError);
    } finally {
      close();
    }
  });

  it("deleteSubTeam 拒绝非空子组", () => {
    const { state, close } = freshDb();
    try {
      const team = Personnel.createSubTeam(state, { name: "一组" });
      Personnel.createPerson(state, {
        name: "张三",
        subTeamId: team.id,
        contact: "123",
      });
      expect(() => Personnel.deleteSubTeam(state, { id: team.id })).toThrow(/还有 1 名人员/);
    } finally {
      close();
    }
  });

  it("reorderSubTeams 拒绝长度不一致", () => {
    const { state, close } = freshDb();
    try {
      Personnel.createSubTeam(state, { name: "A" });
      Personnel.createSubTeam(state, { name: "B" });
      expect(() => Personnel.reorderSubTeams(state, { orderedIds: [1] })).toThrow(
        /子组列表与数据库不一致/,
      );
    } finally {
      close();
    }
  });
});

describe("personnel / 人员 CRUD（#17）", () => {
  it("listPeople 默认 include_deactivated 把离岗的人放段尾", () => {
    const { state, close } = freshDb();
    try {
      const team = Personnel.createSubTeam(state, { name: "一组" });
      const a = Personnel.createPerson(state, { name: "甲", subTeamId: team.id, contact: "1" });
      const b = Personnel.createPerson(state, { name: "乙", subTeamId: team.id, contact: "2" });
      Personnel.deactivatePerson(state, { id: a.id });

      const all = Personnel.listPeople(state, {
        includeDeactivated: true,
        subTeamId: team.id,
      });
      expect(all.map((p) => p.id)).toEqual([b.id, a.id]); // 在岗在前，离岗在后

      const active = Personnel.listPeople(state, {
        includeDeactivated: false,
        subTeamId: team.id,
      });
      expect(active.map((p) => p.id)).toEqual([b.id]);
    } finally {
      close();
    }
  });

  it("同子组内重名拒绝", () => {
    const { state, close } = freshDb();
    try {
      const team = Personnel.createSubTeam(state, { name: "一组" });
      Personnel.createPerson(state, { name: "张三", subTeamId: team.id, contact: "1" });
      expect(() =>
        Personnel.createPerson(state, { name: "张三", subTeamId: team.id, contact: "2" }),
      ).toThrow(/同子组内已存在同名人员/);
    } finally {
      close();
    }
  });

  it("createPerson 拒绝不存在的子组", () => {
    const { state, close } = freshDb();
    try {
      expect(() =>
        Personnel.createPerson(state, { name: "张三", subTeamId: 999, contact: "1" }),
      ).toThrow(/所属子组不存在/);
    } finally {
      close();
    }
  });

  it("deactivatePerson / reactivatePerson 双向切换", () => {
    const { state, clock, close } = freshDb({ now: "2026-09-10 08:00:00" });
    try {
      const team = Personnel.createSubTeam(state, { name: "一组" });
      const person = Personnel.createPerson(state, {
        name: "张三",
        subTeamId: team.id,
        contact: "1",
      });
      expect(person.deactivatedAt).toBeNull();

      const off = Personnel.deactivatePerson(state, { id: person.id });
      expect(off.deactivatedAt).toBe("2026-09-10 08:00:00");

      expect(() => Personnel.deactivatePerson(state, { id: person.id })).toThrow(
        /已是离岗状态/,
      );

      clock.setAt("2026-09-11 09:00:00");
      const on = Personnel.reactivatePerson(state, { id: person.id });
      expect(on.deactivatedAt).toBeNull();
    } finally {
      close();
    }
  });
});

describe("personnel / listAssigneeCandidates（#19）", () => {
  it("只返回在岗人员", () => {
    const { state, close } = freshDb();
    try {
      const team = Personnel.createSubTeam(state, { name: "一组" });
      const a = Personnel.createPerson(state, { name: "甲", subTeamId: team.id, contact: "1" });
      Personnel.createPerson(state, { name: "乙", subTeamId: team.id, contact: "2" });
      Personnel.deactivatePerson(state, { id: a.id });

      const cands = Personnel.listAssigneeCandidates(state, { query: null });
      expect(cands.map((c) => c.personId)).toEqual([a.id + 1]);
    } finally {
      close();
    }
  });

  it("query 子串匹配（中文场景）", () => {
    const { state, close } = freshDb();
    try {
      const team = Personnel.createSubTeam(state, { name: "一组" });
      Personnel.createPerson(state, { name: "张小五", subTeamId: team.id, contact: "1" });
      Personnel.createPerson(state, { name: "李四", subTeamId: team.id, contact: "2" });

      const cands = Personnel.listAssigneeCandidates(state, { query: "小" });
      expect(cands.map((c) => c.name)).toEqual(["张小五"]);
    } finally {
      close();
    }
  });

  it("query 中的 % 不会扩展为通配符", () => {
    const { state, close } = freshDb();
    try {
      const team = Personnel.createSubTeam(state, { name: "一组" });
      Personnel.createPerson(state, { name: "甲", subTeamId: team.id, contact: "1" });

      const cands = Personnel.listAssigneeCandidates(state, { query: "%" });
      expect(cands).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("personnel / personnelMatrix（#22）", () => {
  it("includeDeactivated=false 时空段略去", () => {
    const { state, close } = freshDb();
    try {
      Personnel.createSubTeam(state, { name: "空段" });
      const team = Personnel.createSubTeam(state, { name: "实段" });
      Personnel.createPerson(state, { name: "甲", subTeamId: team.id, contact: "1" });

      const matrix = Personnel.personnelMatrix(state, { includeDeactivated: false });
      expect(matrix.segments.length).toBe(1);
      expect(matrix.segments[0]?.subTeam.name).toBe("实段");
    } finally {
      close();
    }
  });

  it("在岗人员的 inFlightCount / blockedCount 与其任务列表对齐", () => {
    const { state, close } = freshDb();
    try {
      const team = Personnel.createSubTeam(state, { name: "一组" });
      const person = Personnel.createPerson(state, {
        name: "甲",
        subTeamId: team.id,
        contact: "1",
      });

      // 插入 3 条任务：Open / Done / Blocked
      withTx(state.db, () => {
        state.db
          .prepare(
            `INSERT INTO task (title, status, owner_person_id, due_date)
             VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
          )
          .run(
            "t1", "Open", person.id, "2026-09-10",
            "t2", "Done", person.id, "2026-09-11",
            "t3", "Blocked", person.id, "2026-09-12",
          );
      });

      const matrix = Personnel.personnelMatrix(state, { includeDeactivated: false });
      const card = matrix.segments[0]?.people[0];
      expect(card?.inFlightCount).toBe(2); // Open + Blocked
      expect(card?.blockedCount).toBe(1);
      expect(card?.tasks.length).toBe(2);
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// getPersonDetail（#81 T1 · 端到端命令 seam）
// ---------------------------------------------------------------------------

describe("personnel / getPersonDetail（#81）", () => {
  it("空库时人员不存在抛 AppError.invalid", () => {
    const { state, close } = freshDb();
    try {
      expect(() => Personnel.getPersonDetail(state, { id: 1 })).toThrow(/人员不存在/);
    } finally {
      close();
    }
  });

  it("正常返回：所有 5 段均聚合正确", () => {
    const { state, close } = freshDb({ now: "2026-09-10 08:00:00" });
    try {
      const team = Personnel.createSubTeam(state, { name: "一组" });
      const otherTeam = Personnel.createSubTeam(state, { name: "二组" });
      const person = Personnel.createPerson(state, {
        name: "张三",
        subTeamId: team.id,
        contact: "123",
      });
      // 先录入「本人等的别人」,Waiting-on 任务的 waiting_on_person_id 才
      // 能指向他人(不是本人)——waitingOn 桶的语义是「等别人,不等自己」。
      const someoneElse = Personnel.createPerson(state, {
        name: "李四",
        subTeamId: team.id,
        contact: "456",
      });

      // 段 2：在飞任务六状态各一条 + 一条 cancelled
      withTx(state.db, () => {
        state.db
          .prepare(
            `INSERT INTO task (title, status, owner_person_id, due_date, blocked_at, blocked_reason, waiting_on_person_id, updated_at)
             VALUES
               ('open 任务',     'Open',        ?, '2026-09-10', NULL, NULL, NULL, '2026-09-10 08:00:00'),
               ('in-prog 任务',  'In-progress', ?, '2026-09-11', NULL, NULL, NULL, '2026-09-10 08:00:00'),
               ('blocked 任务',  'Blocked',     ?, '2026-09-12', '2026-09-09 09:00:00', '卡审批', NULL, '2026-09-10 08:00:00'),
               ('waiting 任务',  'Waiting-on',  ?, '2026-09-13', '2026-09-09 10:00:00', '等对方', ?, '2026-09-10 08:00:00'),
               ('done 任务',     'Done',        ?, NULL, NULL, NULL, NULL, '2026-09-10 08:00:00'),
               ('cancel 任务',   'Cancelled',   ?, NULL, NULL, NULL, NULL, '2026-09-10 08:00:00')`,
          )
          .run(
            person.id, person.id, person.id,
            person.id, someoneElse.id,
            person.id, person.id,
          );
      });

      // 段 3：负责的项目（本组一个 + 跨组一个）
      const projectA = Project.createProject(state, {
        name: "项目 A",
        ownerPersonId: person.id,
        subTeamId: team.id,
      });
      const projectB = Project.createProject(state, {
        name: "项目 B",
        ownerPersonId: person.id,
        subTeamId: otherTeam.id,
      });

      // 段 4：他人任务但 waiting_on_person_id = 本人(someoneElse 已在前面录好)
      const waitingOnTaskId = withTx(state.db, () => {
        const info = state.db
          .prepare(
            `INSERT INTO task (title, status, owner_person_id, due_date, blocked_at, blocked_reason, waiting_on_person_id, updated_at)
             VALUES ('他人等我', 'Waiting-on', ?, '2026-09-14', '2026-09-09 11:00:00', '等审批', ?, '2026-09-10 08:00:00')`,
          )
          .run(someoneElse.id, person.id);
        return Number(info.lastInsertRowid);
      });

      // 段 5：所属子组的周期模板（本组一个 + 跨组一个 + 别人的挂项目模板）
      const tmplInTeam = RecurringTemplate.upsertRecurringTemplate(state, {
        id: null,
        name: "周一例会",
        rule: {
          freq: "weekly",
          bydayMask: 1 << 0,
          bymonthday: null,
          bymonth: null,
          byhour: 9,
          byminute: 0,
          ianaZone: "Asia/Shanghai",
          ends: { kind: "after", n: 12 },
          holidayBehavior: "skip",
        },
        projectId: null,
        subTeamId: team.id,
        notes: null,
      });
      const tmplInOtherTeam = RecurringTemplate.upsertRecurringTemplate(state, {
        id: null,
        name: "二组周会",
        rule: {
          freq: "weekly",
          bydayMask: 1 << 1,
          bymonthday: null,
          bymonth: null,
          byhour: 9,
          byminute: 0,
          ianaZone: "Asia/Shanghai",
          ends: { kind: "after", n: 8 },
          holidayBehavior: "skip",
        },
        projectId: null,
        subTeamId: otherTeam.id,
        notes: null,
      });

      const detail = Personnel.getPersonDetail(state, { id: person.id });

      // 段 1：person
      expect(detail.person.id).toBe(person.id);
      expect(detail.person.name).toBe("张三");
      expect(detail.person.subTeamId).toBe(team.id);
      expect(detail.person.contact).toBe("123");
      expect(detail.person.deactivatedAt).toBeNull();

      // 段 2：6 状态分组（每条 inFlight bucket 各含 1 条）
      expect(detail.inFlight.open.length).toBe(1);
      expect(detail.inFlight.inProgress.length).toBe(1);
      expect(detail.inFlight.blocked.length).toBe(1);
      expect(detail.inFlight.waitingOn.length).toBe(1);
      expect(detail.inFlight.done.length).toBe(1);
      expect(detail.inFlight.cancelled.length).toBe(1);

      // 段 3：owned projects（2 个,跨组也算）
      expect(detail.ownedProjects.length).toBe(2);
      const ownedIds = detail.ownedProjects.map((p) => p.id).sort();
      expect(ownedIds).toEqual([projectA.id, projectB.id].sort());

      // 段 4：他人 wait 在本人身上的任务
      expect(detail.waitingOnTasks.length).toBe(1);
      expect(detail.waitingOnTasks[0]?.id).toBe(waitingOnTaskId);

      // 段 5：所属子组的模板（仅本组 = team.id,跨组的 tmplInOtherTeam 不在内）
      expect(detail.subTeamTemplates.length).toBe(1);
      expect(detail.subTeamTemplates[0]?.id).toBe(tmplInTeam.id);
      expect(detail.subTeamTemplates[0]?.subTeamId).toBe(team.id);
      // 显式兜底：跨子组的模板不进段 5,避免「长度对了但混了别组的模板」
      expect(
        detail.subTeamTemplates.some((t) => t.id === tmplInOtherTeam.id),
      ).toBe(false);
    } finally {
      close();
    }
  });

  it("离岗人员可正常返回 DTO（不抛错）", () => {
    const { state, close } = freshDb({ now: "2026-09-10 08:00:00" });
    try {
      const team = Personnel.createSubTeam(state, { name: "一组" });
      const person = Personnel.createPerson(state, {
        name: "张三",
        subTeamId: team.id,
        contact: "123",
      });
      Personnel.deactivatePerson(state, { id: person.id });

      const detail = Personnel.getPersonDetail(state, { id: person.id });
      expect(detail.person.id).toBe(person.id);
      expect(detail.person.deactivatedAt).toBe("2026-09-10 08:00:00");
      // 离岗人员的 5 段都应是空数组（库内无其它数据）
      expect(detail.inFlight.open).toEqual([]);
      expect(detail.inFlight.inProgress).toEqual([]);
      expect(detail.inFlight.blocked).toEqual([]);
      expect(detail.inFlight.waitingOn).toEqual([]);
      expect(detail.inFlight.done).toEqual([]);
      expect(detail.inFlight.cancelled).toEqual([]);
      expect(detail.ownedProjects).toEqual([]);
      expect(detail.waitingOnTasks).toEqual([]);
      expect(detail.subTeamTemplates).toEqual([]);
    } finally {
      close();
    }
  });

  it("人员不存在抛 AppError.invalid,与既有 fetchPerson 行为一致", () => {
    const { state, close } = freshDb();
    try {
      // 先建一个其它人员,id 自增到 2,故意查 999 不应命中
      const team = Personnel.createSubTeam(state, { name: "一组" });
      const a = Personnel.createPerson(state, {
        name: "甲",
        subTeamId: team.id,
        contact: "1",
      });
      expect(() => Personnel.getPersonDetail(state, { id: 999 })).toThrow(AppError);
      // 已存在人员应可正常返回
      const detail = Personnel.getPersonDetail(state, { id: a.id });
      expect(detail.person.id).toBe(a.id);
    } finally {
      close();
    }
  });

  // -----------------------------------------------------------------------
  // 段内排序（#82 T2）——「Longest-Stuck」语义在命令层一次给齐,前端不
  // 重排。3 类排序各 3 条互不相同的值 + 显式覆盖 NULL/并列兜底。
  // -----------------------------------------------------------------------

  /**
   * 给单人灌 6 段测试任务的便捷工厂——本块 6 个 case 都跑这套结构。
   * 函数内返回 `personId` 由调用方持有,做后续断言。
   */
  function seedPersonWithSixSegments(): { state: AppState; personId: number; close: () => void } {
    const { state, close } = freshDb({ now: "2026-09-10 12:00:00" });
    const team = Personnel.createSubTeam(state, { name: "一组" });
    const person = Personnel.createPerson(state, {
      name: "张三",
      subTeamId: team.id,
      contact: "1",
    });
    return { state, personId: person.id, close };
  }

  /**
   * 直接 SQL 灌一条任务——绕开 `setTaskStatus`（那个会按 now 重写
   * `blocked_at` / `updated_at`,会污染本块的「按字段排序」断言）。
   */
  function insertTaskRow(
    db: DatabaseSync,
    row: {
      title: string;
      status: "Open" | "In-progress" | "Blocked" | "Waiting-on" | "Done" | "Cancelled";
      ownerPersonId: number;
      dueDate: string | null;
      blockedAt: string | null;
      blockedReason: string | null;
      waitingOnPersonId: number | null;
      updatedAt: string;
    },
  ): number {
    let id = 0;
    withTx(db, () => {
      const info = db
        .prepare(
          `INSERT INTO task (title, status, owner_person_id, due_date,
                             blocked_at, blocked_reason, waiting_on_person_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.title,
          row.status,
          row.ownerPersonId,
          row.dueDate,
          row.blockedAt,
          row.blockedReason,
          row.waitingOnPersonId,
          row.updatedAt,
        );
      id = Number(info.lastInsertRowid);
    });
    return id;
  }

  it("Open 段按 due_date ASC 排,NULL 排到末尾", () => {
    const { state, personId, close } = seedPersonWithSixSegments();
    try {
      // 三条 Open：1 天后 / 5 天后 / NULL。NULL 必须排到末。
      const nearId = insertTaskRow(state.db, {
        title: "1 天后到期",
        status: "Open",
        ownerPersonId: personId,
        dueDate: "2026-09-11",
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-09-10 12:00:00",
      });
      const farId = insertTaskRow(state.db, {
        title: "5 天后到期",
        status: "Open",
        ownerPersonId: personId,
        dueDate: "2026-09-15",
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-09-10 12:00:00",
      });
      const noDueId = insertTaskRow(state.db, {
        title: "无截止",
        status: "Open",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-09-10 12:00:00",
      });

      const detail = Personnel.getPersonDetail(state, { id: personId });
      expect(detail.inFlight.open.map((t) => t.id)).toEqual([
        nearId,
        farId,
        noDueId,
      ]);
    } finally {
      close();
    }
  });

  it("In-progress 段按 due_date ASC 排,NULL 排到末尾", () => {
    const { state, personId, close } = seedPersonWithSixSegments();
    try {
      const nearId = insertTaskRow(state.db, {
        title: "进行中 · 1 天后",
        status: "In-progress",
        ownerPersonId: personId,
        dueDate: "2026-09-11",
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-09-10 12:00:00",
      });
      const noDueId = insertTaskRow(state.db, {
        title: "进行中 · 无截止",
        status: "In-progress",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-09-10 12:00:00",
      });
      const farId = insertTaskRow(state.db, {
        title: "进行中 · 5 天后",
        status: "In-progress",
        ownerPersonId: personId,
        dueDate: "2026-09-15",
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-09-10 12:00:00",
      });

      const detail = Personnel.getPersonDetail(state, { id: personId });
      expect(detail.inFlight.inProgress.map((t) => t.id)).toEqual([
        nearId,
        farId,
        noDueId,
      ]);
    } finally {
      close();
    }
  });

  it("Blocked 段按 blocked_at ASC 排,longest-stuck 最靠前", () => {
    const { state, personId, close } = seedPersonWithSixSegments();
    try {
      // 三条 Blocked：阻塞起点分别是 1 天前 / 5 天前 / 10 天前。
      // longest-stuck first → 10 天前那一条排第一。
      const oneDayId = insertTaskRow(state.db, {
        title: "阻塞 1 天",
        status: "Blocked",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: "2026-09-09 12:00:00",
        blockedReason: "卡审批",
        waitingOnPersonId: null,
        updatedAt: "2026-09-10 12:00:00",
      });
      const fiveDayId = insertTaskRow(state.db, {
        title: "阻塞 5 天",
        status: "Blocked",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: "2026-09-05 12:00:00",
        blockedReason: "卡审批",
        waitingOnPersonId: null,
        updatedAt: "2026-09-10 12:00:00",
      });
      const tenDayId = insertTaskRow(state.db, {
        title: "阻塞 10 天",
        status: "Blocked",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: "2026-08-31 12:00:00",
        blockedReason: "卡审批",
        waitingOnPersonId: null,
        updatedAt: "2026-09-10 12:00:00",
      });

      const detail = Personnel.getPersonDetail(state, { id: personId });
      expect(detail.inFlight.blocked.map((t) => t.id)).toEqual([
        tenDayId,
        fiveDayId,
        oneDayId,
      ]);
    } finally {
      close();
    }
  });

  it("Waiting-on 段按 blocked_at ASC 排,longest-stuck 最靠前", () => {
    const { state, personId, close } = seedPersonWithSixSegments();
    try {
      const someoneElseId = Personnel.createPerson(state, {
        name: "李四",
        subTeamId: 1,
        contact: "2",
      }).id;

      const oneDayId = insertTaskRow(state.db, {
        title: "等 1 天",
        status: "Waiting-on",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: "2026-09-09 12:00:00",
        blockedReason: "等审批",
        waitingOnPersonId: someoneElseId,
        updatedAt: "2026-09-10 12:00:00",
      });
      const fiveDayId = insertTaskRow(state.db, {
        title: "等 5 天",
        status: "Waiting-on",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: "2026-09-05 12:00:00",
        blockedReason: "等审批",
        waitingOnPersonId: someoneElseId,
        updatedAt: "2026-09-10 12:00:00",
      });
      const tenDayId = insertTaskRow(state.db, {
        title: "等 10 天",
        status: "Waiting-on",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: "2026-08-31 12:00:00",
        blockedReason: "等审批",
        waitingOnPersonId: someoneElseId,
        updatedAt: "2026-09-10 12:00:00",
      });

      const detail = Personnel.getPersonDetail(state, { id: personId });
      expect(detail.inFlight.waitingOn.map((t) => t.id)).toEqual([
        tenDayId,
        fiveDayId,
        oneDayId,
      ]);
    } finally {
      close();
    }
  });

  it("Done 段按 updated_at DESC 排", () => {
    const { state, personId, close } = seedPersonWithSixSegments();
    try {
      // updated_at 分别是 1 天前 / 5 天前 / 10 天前。DESC → 1 天前那
      // 条排第一（最新完成的先看）。
      const oneDayId = insertTaskRow(state.db, {
        title: "完成 · 1 天前",
        status: "Done",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-09-09 12:00:00",
      });
      const fiveDayId = insertTaskRow(state.db, {
        title: "完成 · 5 天前",
        status: "Done",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-09-05 12:00:00",
      });
      const tenDayId = insertTaskRow(state.db, {
        title: "完成 · 10 天前",
        status: "Done",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-08-31 12:00:00",
      });

      const detail = Personnel.getPersonDetail(state, { id: personId });
      expect(detail.inFlight.done.map((t) => t.id)).toEqual([
        oneDayId,
        fiveDayId,
        tenDayId,
      ]);
    } finally {
      close();
    }
  });

  it("Cancelled 段按 updated_at DESC 排", () => {
    const { state, personId, close } = seedPersonWithSixSegments();
    try {
      const oneDayId = insertTaskRow(state.db, {
        title: "取消 · 1 天前",
        status: "Cancelled",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-09-09 12:00:00",
      });
      const fiveDayId = insertTaskRow(state.db, {
        title: "取消 · 5 天前",
        status: "Cancelled",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-09-05 12:00:00",
      });
      const tenDayId = insertTaskRow(state.db, {
        title: "取消 · 10 天前",
        status: "Cancelled",
        ownerPersonId: personId,
        dueDate: null,
        blockedAt: null,
        blockedReason: null,
        waitingOnPersonId: null,
        updatedAt: "2026-08-31 12:00:00",
      });

      const detail = Personnel.getPersonDetail(state, { id: personId });
      expect(detail.inFlight.cancelled.map((t) => t.id)).toEqual([
        oneDayId,
        fiveDayId,
        tenDayId,
      ]);
    } finally {
      close();
    }
  });

  it("空段聚合：六段全空时各桶都为空数组", () => {
    const { state, personId, close } = seedPersonWithSixSegments();
    try {
      const detail = Personnel.getPersonDetail(state, { id: personId });
      expect(detail.inFlight.open).toEqual([]);
      expect(detail.inFlight.inProgress).toEqual([]);
      expect(detail.inFlight.blocked).toEqual([]);
      expect(detail.inFlight.waitingOn).toEqual([]);
      expect(detail.inFlight.done).toEqual([]);
      expect(detail.inFlight.cancelled).toEqual([]);
    } finally {
      close();
    }
  });
});