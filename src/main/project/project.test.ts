import { describe, expect, it } from "vitest";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Project from "./index.js";
import * as Personnel from "../personnel/index.js";
import { AppError } from "../error.js";

function setupWorld(): ReturnType<typeof freshDb> & { teamId: number; personId: number } {
  const ctx = freshDb();
  const team = Personnel.createSubTeam(ctx.state, { name: "一组" });
  const person = Personnel.createPerson(ctx.state, {
    name: "张三",
    subTeamId: team.id,
    contact: "123",
  });
  return { ...ctx, teamId: team.id, personId: person.id };
}

describe("project / CRUD（#20）", () => {
  it("createProject 拒绝空名", () => {
    const ctx = setupWorld();
    try {
      expect(() =>
        Project.createProject(ctx.state, {
          name: "  ",
          ownerPersonId: ctx.personId,
          subTeamId: ctx.teamId,
        }),
      ).toThrow(AppError);
    } finally {
      ctx.close();
    }
  });

  it("createProject 拒绝非法日期", () => {
    const ctx = setupWorld();
    try {
      expect(() =>
        Project.createProject(ctx.state, {
          name: "x",
          ownerPersonId: ctx.personId,
          subTeamId: ctx.teamId,
          startDate: "2026/09/10",
        }),
      ).toThrow(/开始日格式不对/);
    } finally {
      ctx.close();
    }
  });

  it("createProject 拒绝不存在的负责人", () => {
    const ctx = setupWorld();
    try {
      expect(() =>
        Project.createProject(ctx.state, {
          name: "x",
          ownerPersonId: 999,
          subTeamId: ctx.teamId,
        }),
      ).toThrow(/项目负责人不存在/);
    } finally {
      ctx.close();
    }
  });

  it("status 由视图层从 task 聚合：空项目为 Active", () => {
    const ctx = setupWorld();
    try {
      const p = Project.createProject(ctx.state, {
        name: "p",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamId,
      });
      expect(p.status).toBe("Active");
    } finally {
      ctx.close();
    }
  });

  it("status 由视图层从 task 聚合：全部 task Cancelled 则 Cancelled", () => {
    const ctx = setupWorld();
    try {
      const p = Project.createProject(ctx.state, {
        name: "p",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamId,
      });
      ctx.state.db.transaction(() => {
        ctx.state.db
          .prepare(
            `INSERT INTO task (title, status, owner_person_id, project_id)
             VALUES (?, ?, ?, ?)`,
          )
          .run("t1", "Cancelled", ctx.personId, p.id);
      })();
      const fetched = Project.listProjects(ctx.state, { includeDone: true });
      expect(fetched[0]?.status).toBe("Cancelled");
    } finally {
      ctx.close();
    }
  });

  it("status 由视图层从 task 聚合：混存 in-flight 时仍为 Active", () => {
    const ctx = setupWorld();
    try {
      const p = Project.createProject(ctx.state, {
        name: "p",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamId,
      });
      ctx.state.db.transaction(() => {
        ctx.state.db
          .prepare(
            `INSERT INTO task (title, status, owner_person_id, project_id)
             VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
          )
          .run(
            "t1", "Done", ctx.personId, p.id,
            "t2", "Open", ctx.personId, p.id,
          );
      })();
      const fetched = Project.listProjects(ctx.state, { includeDone: true });
      expect(fetched[0]?.status).toBe("Active");
    } finally {
      ctx.close();
    }
  });

  it("listProjects includeDone=false 过滤掉 Done / Cancelled", () => {
    const ctx = setupWorld();
    try {
      const p1 = Project.createProject(ctx.state, {
        name: "active",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamId,
      });
      const p2 = Project.createProject(ctx.state, {
        name: "done",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamId,
      });
      // p2 全 Done
      ctx.state.db.transaction(() => {
        ctx.state.db
          .prepare(
            `INSERT INTO task (title, status, owner_person_id, project_id)
             VALUES (?, ?, ?, ?)`,
          )
          .run("t1", "Done", ctx.personId, p2.id);
      })();

      const inFlightOnly = Project.listProjects(ctx.state, { includeDone: false });
      expect(inFlightOnly.map((p) => p.id)).toEqual([p1.id]);

      const all = Project.listProjects(ctx.state, { includeDone: true });
      expect(all.length).toBe(2);
    } finally {
      ctx.close();
    }
  });

  it("deleteProject 把名下任务的 project_id 置 NULL", () => {
    const ctx = setupWorld();
    try {
      const p = Project.createProject(ctx.state, {
        name: "p",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamId,
      });
      const insertTask = ctx.state.db.prepare(
        `INSERT INTO task (title, status, owner_person_id, project_id)
         VALUES (?, ?, ?, ?)`,
      );
      ctx.state.db.transaction(() => {
        insertTask.run("t1", "Open", ctx.personId, p.id);
      })();

      Project.deleteProject(ctx.state, { id: p.id });

      const task = ctx.state.db
        .prepare<[number], { project_id: number | null }>("SELECT project_id FROM task WHERE title = ?")
        .get("t1");
      expect(task?.project_id).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("listProjectCandidates 排除 Done / Cancelled", () => {
    const ctx = setupWorld();
    try {
      const p1 = Project.createProject(ctx.state, {
        name: "项目甲",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamId,
      });
      const p2 = Project.createProject(ctx.state, {
        name: "项目乙",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamId,
      });
      ctx.state.db.transaction(() => {
        ctx.state.db
          .prepare(
            `INSERT INTO task (title, status, owner_person_id, project_id)
             VALUES (?, ?, ?, ?)`,
          )
          .run("t", "Done", ctx.personId, p2.id);
      })();

      const cands = Project.listProjectCandidates(ctx.state, { query: null });
      expect(cands.map((c) => c.projectId)).toEqual([p1.id]);
    } finally {
      ctx.close();
    }
  });

  it("listProjectCandidates query 子串匹配（中文场景）", () => {
    const ctx = setupWorld();
    try {
      Project.createProject(ctx.state, {
        name: "综合楼改造",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamId,
      });
      Project.createProject(ctx.state, {
        name: "电梯年检",
        ownerPersonId: ctx.personId,
        subTeamId: ctx.teamId,
      });

      const cands = Project.listProjectCandidates(ctx.state, { query: "综合" });
      expect(cands.map((c) => c.name)).toEqual(["综合楼改造"]);
    } finally {
      ctx.close();
    }
  });
});

describe("project / status 派生 SQL 片段", () => {
  it("四条边界都出现（防回归）", () => {
    const fragment = Project.deriveStatusSqlFragment("p");
    expect(fragment).toContain("NOT EXISTS");
    expect(fragment).toContain("'Cancelled'");
    expect(fragment).toContain("'Done','Cancelled'");
    expect(fragment).toContain("'Active'");
  });
});