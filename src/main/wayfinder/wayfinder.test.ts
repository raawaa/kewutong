/**
 * ⌘K 命令面板（ticket #50 · 平迁自 ticket #28）的集成测试。
 *
 * 覆盖三类候选的全部过滤 / 排序 / 封顶语义与 match_kind 分类——
 * 命令层是「候选列表是什么」的权威,前端不再二次加工,这些断言就是契约。
 */

import { describe, expect, it } from "vitest";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Personnel from "../personnel/index.js";
import * as Project from "../project/index.js";
import * as Wayfinder from "./index.js";

// ---------------------------------------------------------------------------
// Test fixture: 一名人员 + 多个项目 + 多个任务,简化后续测试的样板。
// ---------------------------------------------------------------------------

interface World {
  state: ReturnType<typeof freshDb>["state"];
  clock: ReturnType<typeof freshDb>["clock"];
  close: ReturnType<typeof freshDb>["close"];
  teamId: number;
  personId: number;
  teamAlphaId: number;
  teamBetaId: number;
  personAlphaId: number;
  personBetaId: number;
  projectInFlightId: number;
  projectDoneId: number;
}

function setupWorld(): World {
  const ctx = freshDb({ now: "2026-09-10 08:00:00" });
  // 一组 + 暖通组
  const team = Personnel.createSubTeam(ctx.state, { name: "一组" });
  const teamAlpha = Personnel.createSubTeam(ctx.state, { name: "暖通甲" });
  const teamBeta = Personnel.createSubTeam(ctx.state, { name: "电气乙" });
  const person = Personnel.createPerson(ctx.state, {
    name: "张三",
    subTeamId: team.id,
    contact: "123",
  });
  const personAlpha = Personnel.createPerson(ctx.state, {
    name: "王小暖",
    subTeamId: teamAlpha.id,
    contact: "456",
  });
  const personBeta = Personnel.createPerson(ctx.state, {
    name: "李电",
    subTeamId: teamBeta.id,
    contact: "789",
  });

  // 一个在飞项目 + 一个 Done 项目(用于断言过滤掉 Done/Cancelled)
  const projectInFlight = Project.createProject(ctx.state, {
    name: "综合改造项目",
    ownerPersonId: person.id,
    subTeamId: team.id,
    dueDate: "2026-09-30",
  });
  const projectDone = Project.createProject(ctx.state, {
    name: "废弃项目",
    ownerPersonId: person.id,
    subTeamId: team.id,
    dueDate: "2025-01-01",
  });
  // 给废弃项目加一个 Done 任务,触发 status = Done
  ctx.state.db
    .prepare(
      `INSERT INTO task (title, status, owner_person_id, project_id, due_date)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("收尾", "Done", person.id, projectDone.id, "2025-01-01");

  return {
    state: ctx.state,
    clock: ctx.clock,
    close: ctx.close,
    teamId: team.id,
    personId: person.id,
    teamAlphaId: teamAlpha.id,
    teamBetaId: teamBeta.id,
    personAlphaId: personAlpha.id,
    personBetaId: personBeta.id,
    projectInFlightId: projectInFlight.id,
    projectDoneId: projectDone.id,
  };
}

function rawInsertTask(
  state: ReturnType<typeof freshDb>["state"],
  fields: {
    title: string;
    status: import("../types.js").TaskStatus;
    ownerPersonId: number;
    projectId?: number | null;
    dueDate?: string | null;
    description?: string | null;
    blockedAt?: string | null;
    blockedReason?: string | null;
    waitingOnPersonId?: number | null;
    recurringTemplateId?: number | null;
    scheduledAt?: string | null;
  },
): number {
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
      "2026-09-10 08:00:00",
      "2026-09-10 08:00:00",
      fields.blockedAt ?? null,
      fields.blockedReason ?? null,
      fields.waitingOnPersonId ?? null,
      fields.recurringTemplateId ?? null,
      fields.scheduledAt ?? null,
      fields.scheduledAt ?? null,
    );
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// 助手函数
// ---------------------------------------------------------------------------

describe("wayfinder / buildLikeClause", () => {
  it("空字符串 → null(走默认排序)", () => {
    expect(Wayfinder.buildLikeClause("")).toBeNull();
  });

  it("纯空白 → null(走默认排序)", () => {
    expect(Wayfinder.buildLikeClause("   ")).toBeNull();
  });

  it("中文 → %xx% 子串模板", () => {
    expect(Wayfinder.buildLikeClause("合同")).toBe("%合同%");
    expect(Wayfinder.buildLikeClause("小")).toBe("%小%");
  });

  it("首尾空白先 trim", () => {
    expect(Wayfinder.buildLikeClause("  张  ")).toBe("%张%");
  });

  it("LIKE 元字符被 \\ 转义", () => {
    // 用户打一个 %,不能把全员刷出来
    expect(Wayfinder.buildLikeClause("%")).toBe("%\\%%");
    expect(Wayfinder.buildLikeClause("a_b")).toBe("%a\\_b%");
    expect(Wayfinder.buildLikeClause("a\\b")).toBe("%a\\\\b%");
  });
});

describe("wayfinder / classifyMatch", () => {
  it("空 query → name", () => {
    expect(Wayfinder.classifyMatch("", "张小五", "暖通")).toBe("name");
  });

  it("纯空白 query → name", () => {
    expect(Wayfinder.classifyMatch("   ", "张小五", "暖通")).toBe("name");
  });

  it("query 落在名字 → name", () => {
    expect(Wayfinder.classifyMatch("小五", "张小五", "暖通")).toBe("name");
  });

  it("query 落在子组名 → sub-team", () => {
    expect(Wayfinder.classifyMatch("暖通", "张小五", "暖通组")).toBe("sub-team");
  });

  it("query 同时落在名字 + 子组名 → both", () => {
    expect(Wayfinder.classifyMatch("暖", "暖通甲", "暖通组")).toBe("both");
  });

  it("大小写不敏感(英文)", () => {
    expect(Wayfinder.classifyMatch("ZHANG", "Zhang San", "暖通")).toBe("name");
    expect(Wayfinder.classifyMatch("zhang", "Zhang San", "暖通")).toBe("name");
  });

  it("大小写不敏感(子组英文)", () => {
    expect(Wayfinder.classifyMatch("hvac", "张小暖", "HVAC Team")).toBe("sub-team");
  });

  it("未命中(不该走到):兜底 name", () => {
    expect(Wayfinder.classifyMatch("zzz", "张小五", "暖通")).toBe("name");
  });
});

// ---------------------------------------------------------------------------
// 人员候选
// ---------------------------------------------------------------------------

describe("wayfinder / searchPeople", () => {
  it("空 query → 默认排序前 N 条(子组 sort_order → 在岗优先 → id)", () => {
    const ctx = setupWorld();
    try {
      // 暖通甲 sort_order=1,电气乙 sort_order=2;按 sort_order 应先出暖通甲的人
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "",
        peopleLimit: 6,
        includeDeactivatedPeople: false,
      });
      expect(hits.people.length).toBeGreaterThanOrEqual(2);
      // 暖通甲的人(王小暖)在电气乙的人(李电)前面
      const ids = hits.people.map((p) => p.personId);
      expect(ids.indexOf(ctx.personAlphaId)).toBeLessThan(ids.indexOf(ctx.personBetaId));
    } finally {
      ctx.close();
    }
  });

  it("query 命中名字 → matchKind = name", () => {
    const ctx = setupWorld();
    try {
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "小暖",
        peopleLimit: 6,
        includeDeactivatedPeople: false,
      });
      expect(hits.people.length).toBe(1);
      expect(hits.people[0]?.name).toBe("王小暖");
      expect(hits.people[0]?.matchKind).toBe("name");
    } finally {
      ctx.close();
    }
  });

  it("query 命中子组名 → matchKind = sub-team", () => {
    const ctx = setupWorld();
    try {
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "暖通",
        peopleLimit: 6,
        includeDeactivatedPeople: false,
      });
      // 暖通甲里的人都进 hit(暖通)
      expect(hits.people.length).toBeGreaterThanOrEqual(1);
      expect(hits.people.some((p) => p.name === "王小暖" && p.matchKind === "sub-team")).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("query 同时命中名字 + 子组名 → matchKind = both", () => {
    const ctx = setupWorld();
    try {
      // "暖" 既命中"王小暖"的名字又命中子组"暖通甲"的名字
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "暖",
        peopleLimit: 6,
        includeDeactivatedPeople: false,
      });
      expect(hits.people.some((p) => p.name === "王小暖" && p.matchKind === "both")).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("英文大小写不敏感", () => {
    const ctx = setupWorld();
    try {
      // 加一名英文名的人便于断言大小写
      const englishTeam = Personnel.createSubTeam(ctx.state, { name: "Mechanical" });
      const englishPerson = Personnel.createPerson(ctx.state, {
        name: "Alice Wonder",
        subTeamId: englishTeam.id,
        contact: "111",
      });
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "ALICE",
        peopleLimit: 6,
        includeDeactivatedPeople: false,
      });
      expect(hits.people.some((p) => p.personId === englishPerson.id)).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("默认过滤离岗人员;includeDeactivatedPeople=true 保留", () => {
    const ctx = setupWorld();
    try {
      const inactiveTeam = Personnel.createSubTeam(ctx.state, { name: "临时组" });
      const inactivePerson = Personnel.createPerson(ctx.state, {
        name: "赵休",
        subTeamId: inactiveTeam.id,
        contact: "999",
      });
      Personnel.deactivatePerson(ctx.state, { id: inactivePerson.id });

      const filtered = Wayfinder.wayfinderSearch(ctx.state, {
        query: "赵",
        peopleLimit: 6,
        includeDeactivatedPeople: false,
      });
      expect(filtered.people).toEqual([]);

      const withDeactivated = Wayfinder.wayfinderSearch(ctx.state, {
        query: "赵",
        peopleLimit: 6,
        includeDeactivatedPeople: true,
      });
      expect(withDeactivated.people.length).toBe(1);
      expect(withDeactivated.people[0]?.name).toBe("赵休");
    } finally {
      ctx.close();
    }
  });

  it("peopleLimit 封顶", () => {
    const ctx = setupWorld();
    try {
      // 加 5 个同名的人在同一个子组 → 至少返回 1;封顶 1 时就 1 条
      for (let i = 0; i < 4; i++) {
        Personnel.createPerson(ctx.state, {
          name: `工号${i}`,
          subTeamId: ctx.teamId,
          contact: String(i),
        });
      }
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "工号",
        peopleLimit: 1,
        includeDeactivatedPeople: false,
      });
      expect(hits.people.length).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it("LIKE 元字符被转义:query=% 不会刷出全员", () => {
    const ctx = setupWorld();
    try {
      // query = "%" 应只匹配名字/子组名包含字面 % 的(没有,所以空列表)
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "%",
        peopleLimit: 6,
        includeDeactivatedPeople: false,
      });
      // buildLikeClause("%") → "%\%%" → 转义后真正的 LIKE 通配符被转义,
      // 没有任何名字含字面 %,所以 0 条
      expect(hits.people).toEqual([]);
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 项目候选
// ---------------------------------------------------------------------------

describe("wayfinder / searchProjects", () => {
  it("空 query → 默认排序前 N 条,排除 Done/Cancelled", () => {
    const ctx = setupWorld();
    try {
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "",
        projectsLimit: 6,
      });
      // 2 个项目建了 1 个 done 1 个 in-flight;在飞的那个进 hit
      expect(hits.projects.length).toBe(1);
      expect(hits.projects[0]?.projectId).toBe(ctx.projectInFlightId);
    } finally {
      ctx.close();
    }
  });

  it("query 命中项目名 → matchKind = name", () => {
    const ctx = setupWorld();
    try {
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "综合改造",
        projectsLimit: 6,
      });
      expect(hits.projects.length).toBe(1);
      expect(hits.projects[0]?.name).toBe("综合改造项目");
      expect(hits.projects[0]?.matchKind).toBe("name");
      expect(hits.projects[0]?.status).toBe("Active");
    } finally {
      ctx.close();
    }
  });

  it("query 命中子组名 → matchKind = sub-team", () => {
    const ctx = setupWorld();
    try {
      // 给暖通甲建一个项目;query "暖通" 命中子组名
      const proj = Project.createProject(ctx.state, {
        name: "管道升级",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamAlphaId,
      });
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "暖通",
        projectsLimit: 6,
      });
      const found = hits.projects.find((p) => p.projectId === proj.id);
      expect(found).toBeDefined();
      expect(found?.matchKind).toBe("sub-team");
    } finally {
      ctx.close();
    }
  });

  it("Done / Cancelled 项目过滤掉", () => {
    const ctx = setupWorld();
    try {
      // projectDoneId 是 fixture 里建好的 Done 项目
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "废弃",
        projectsLimit: 6,
      });
      expect(hits.projects).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it("projectsLimit 封顶", () => {
    const ctx = setupWorld();
    try {
      // 加 5 个在飞项目 → 封顶 1 时就 1 条
      for (let i = 0; i < 4; i++) {
        Project.createProject(ctx.state, {
          name: `新项目${i}`,
          ownerPersonId: ctx.personId,
          subTeamId: ctx.teamId,
        });
      }
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "新项目",
        projectsLimit: 1,
      });
      expect(hits.projects.length).toBe(1);
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 任务候选
// ---------------------------------------------------------------------------

describe("wayfinder / searchTasks", () => {
  it("空 query → 在飞任务前 N 条(fetchTopTasks)", () => {
    const ctx = setupWorld();
    try {
      const idOpen = rawInsertTask(ctx.state, {
        title: "审合同 A",
        status: "Open",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-15",
      });
      const idInProg = rawInsertTask(ctx.state, {
        title: "审合同 B",
        status: "In-progress",
        ownerPersonId: ctx.personId,
        dueDate: "2026-09-20",
      });
      const idDone = rawInsertTask(ctx.state, {
        title: "审合同 C",
        status: "Done",
        ownerPersonId: ctx.personId,
        dueDate: "2026-08-01",
      });
      const idCancelled = rawInsertTask(ctx.state, {
        title: "审合同 D",
        status: "Cancelled",
        ownerPersonId: ctx.personId,
        dueDate: "2026-08-01",
      });
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "",
        tasksLimit: 12,
        includeCancelledTasks: false,
      });
      const ids = hits.tasks.map((t) => t.id);
      // 默认 includeCancelled=false → Cancelled 任务过滤掉;
      // Done 走"在飞排序"的尾巴但仍出现(空 query 是「最近候选」视图,
      // Done 已收尾留底以便点回看)。
      expect(ids).toContain(idOpen);
      expect(ids).toContain(idInProg);
      expect(ids).toContain(idDone);
      expect(ids).not.toContain(idCancelled);
      // 排序上在飞优先:Open / In-progress 在 Done 前面
      expect(ids.indexOf(idOpen)).toBeLessThan(ids.indexOf(idDone));
      expect(ids.indexOf(idInProg)).toBeLessThan(ids.indexOf(idDone));
    } finally {
      ctx.close();
    }
  });

  it("空 query + includeCancelledTasks=true:Cancelled 任务也出现", () => {
    const ctx = setupWorld();
    try {
      const idCancelled = rawInsertTask(ctx.state, {
        title: "废任务",
        status: "Cancelled",
        ownerPersonId: ctx.personId,
        dueDate: "2026-08-01",
      });
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "",
        tasksLimit: 12,
        includeCancelledTasks: true,
      });
      expect(hits.tasks.some((t) => t.id === idCancelled)).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("非空 query → 走 searchTasksBlocking(FTS5 / LIKE 短查询兜底)", () => {
    const ctx = setupWorld();
    try {
      const idLong = rawInsertTask(ctx.state, {
        title: "外委合同评审",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const idShort = rawInsertTask(ctx.state, {
        title: "合同归档",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "合同",
        tasksLimit: 12,
        includeCancelledTasks: false,
      });
      const ids = hits.tasks.map((t) => t.id);
      expect(ids).toContain(idLong);
      expect(ids).toContain(idShort);
    } finally {
      ctx.close();
    }
  });

  it("tasksLimit 封顶", () => {
    const ctx = setupWorld();
    try {
      for (let i = 0; i < 5; i++) {
        rawInsertTask(ctx.state, {
          title: `合同评审 ${i}`,
          status: "Open",
          ownerPersonId: ctx.personId,
        });
      }
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "合同",
        tasksLimit: 2,
        includeCancelledTasks: false,
      });
      expect(hits.tasks.length).toBe(2);
    } finally {
      ctx.close();
    }
  });

  it("空 query 过滤离岗人员负责的任务(默认)", () => {
    const ctx = setupWorld();
    try {
      const otherTeam = Personnel.createSubTeam(ctx.state, { name: "其他" });
      const other = Personnel.createPerson(ctx.state, {
        name: "孙离",
        subTeamId: otherTeam.id,
        contact: "000",
      });
      const idActive = rawInsertTask(ctx.state, {
        title: "在岗人的任务",
        status: "Open",
        ownerPersonId: ctx.personId,
      });
      const idDeactivated = rawInsertTask(ctx.state, {
        title: "离岗人的任务",
        status: "Open",
        ownerPersonId: other.id,
      });
      Personnel.deactivatePerson(ctx.state, { id: other.id });

      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "",
        tasksLimit: 12,
        includeCancelledTasks: false,
      });
      const ids = hits.tasks.map((t) => t.id);
      expect(ids).toContain(idActive);
      expect(ids).not.toContain(idDeactivated);
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 三类合一的 wayfinderSearch
// ---------------------------------------------------------------------------

describe("wayfinder / wayfinderSearch 一次拉回三类", () => {
  it("默认入参 + 默认 limit,空 query 返回 DTO 结构", () => {
    const ctx = setupWorld();
    try {
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "",
      });
      expect(hits).toMatchObject({
        people: expect.any(Array),
        projects: expect.any(Array),
        tasks: expect.any(Array),
      });
    } finally {
      ctx.close();
    }
  });

  it("query 同时命中三类,三类候选互不干扰(各走各的 SQL)", () => {
    const ctx = setupWorld();
    try {
      const t = rawInsertTask(ctx.state, {
        title: "暖通系统年度维护",
        status: "Open",
        ownerPersonId: ctx.personAlphaId,
        dueDate: "2026-09-30",
      });
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "暖通",
      });
      // people: 子组名命中
      expect(hits.people.some((p) => p.personId === ctx.personAlphaId)).toBe(true);
      // projects: fixture 没在暖通组下建项目,所以可能 0
      // tasks: title 含 "暖通"
      expect(hits.tasks.some((task) => task.id === t)).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("自定义 limit 生效", () => {
    const ctx = setupWorld();
    try {
      // 加 5 个同名人在同一子组
      for (let i = 0; i < 5; i++) {
        Personnel.createPerson(ctx.state, {
          name: `测试人${i}`,
          subTeamId: ctx.teamId,
          contact: String(i),
        });
      }
      const hits = Wayfinder.wayfinderSearch(ctx.state, {
        query: "测试人",
        peopleLimit: 3,
        projectsLimit: 1,
        tasksLimit: 1,
      });
      expect(hits.people.length).toBe(3);
      expect(hits.projects.length).toBeLessThanOrEqual(1);
      expect(hits.tasks.length).toBeLessThanOrEqual(1);
    } finally {
      ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

describe("wayfinder / 默认 limit 常量", () => {
  it("PEOPLE_LIMIT_DEFAULT = 6", () => {
    expect(Wayfinder.PEOPLE_LIMIT_DEFAULT).toBe(6);
  });
  it("PROJECTS_LIMIT_DEFAULT = 6", () => {
    expect(Wayfinder.PROJECTS_LIMIT_DEFAULT).toBe(6);
  });
  it("TASKS_LIMIT_DEFAULT = 12", () => {
    expect(Wayfinder.TASKS_LIMIT_DEFAULT).toBe(12);
  });
});