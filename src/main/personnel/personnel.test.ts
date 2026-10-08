import { describe, expect, it } from "vitest";

import { freshDb } from "../test/commands/fresh_db.js";
import * as Personnel from "./index.js";
import { AppError } from "../error.js";

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
      state.db.transaction(() => {
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
      })();

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