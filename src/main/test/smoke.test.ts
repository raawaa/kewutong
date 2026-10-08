/**
 * 行为对齐 smoke（ticket #57 · M3 阶段）。
 *
 * 5 个核心场景：人员 / 任务状态机 / 项目 / 模板 / 物化。每个场景走一
 * 段「命令调用序列」并断言 DTO 形状 + DB 行内容。
 *
 * ## Electron ↔ Tauri 对齐的语义
 *
 * 本仓库正处在「Tauri → Electron 迁移」(spec #37)。迁移可观察的边界是
 * 「同一组命令调用、同一份 DTO 形状、同一份 DB 行内容」。Rust 端的原始
 * 实现位于 `src-tauri/src/commands/*.rs`，由下列 module 顶部的注释明确
 * 引用 —— 平迁的精神就是「字段名 / 校验消息 / SQL 落库内容」三处一致：
 *
 * - `personnel` 对应 `personnel.rs`（#17 / #19 / #22）
 * - `task` 对应 `task.rs`（#18 / #19 / #21 / #27 / #44）
 * - `project` 对应 `project.rs`（#20）
 * - `recurring_template` 对应 `recurring_template.rs`（#24 / #46）
 * - `materialization` 对应 `materialization.rs`（#25 / #48）
 *
 * 本测试不另起 Tauri 进程做对照（dev / CI 链路里 Tauri 不再是默认 runner）
 * ——「一致性」的检查降级为：
 *
 *   1. DTO 字段与 `src/main/types.ts` 严格对齐（camelCase 键名 + 类型）；
 *   2. DB 行内容与 `src/main/migrations/V001..V008.sql` schema 期望对齐；
 *   3. 边界场景（FK 缺失 / UNIQUE 冲突 / 6 状态机 / 跨窗口累计）按命令层
 *      文档约定的中文消息报错。
 *
 * 上述三点是「命令层是测试缝」的硬约束（ADR 0006）。当 Tauri 仍存在于双
 * 壳共存阶段时，可手工复制本测试用例到 `src-tauri/tests/` 跑一遍 → 双方
 * 行为对齐即可签收 M3。本测试既是 Electron 端的契约，也是 Tauri 端对齐
 * 的「期望输出」模板。
 */

import { describe, expect, it } from "vitest";

import { freshDb } from "./commands/fresh_db.js";
import * as Personnel from "../personnel/index.js";
import * as Task from "../task/index.js";
import * as Project from "../project/index.js";
import * as Template from "../recurring_template/index.js";
import * as Materialization from "../materialization/index.js";

// ---------------------------------------------------------------------------
// 公共 helper：建一个最小世界（一组 + 一人 + 一项目），供多场景复用。
// ---------------------------------------------------------------------------

interface World {
  state: ReturnType<typeof freshDb>["state"];
  clock: ReturnType<typeof freshDb>["clock"];
  db: ReturnType<typeof freshDb>["db"];
  close: () => void;
  teamId: number;
  teamSortOrder: number;
  personId: number;
  projectId: number;
}

function setupWorld(now: string): World {
  const ctx = freshDb({ now });
  const team = Personnel.createSubTeam(ctx.state, { name: "一组" });
  const person = Personnel.createPerson(ctx.state, {
    name: "张三",
    subTeamId: team.id,
    contact: "13800138000",
  });
  const project = Project.createProject(ctx.state, {
    name: "外委合同评审",
    ownerPersonId: person.id,
    subTeamId: team.id,
    startDate: "2026-09-01",
    dueDate: "2026-12-31",
  });
  return {
    state: ctx.state,
    clock: ctx.clock,
    db: ctx.db,
    close: ctx.close,
    teamId: team.id,
    teamSortOrder: team.sortOrder,
    personId: person.id,
    projectId: project.id,
  };
}

// ===========================================================================
// 场景 1：人员 — 子组 + 人员 CRUD + 花名册 / 矩阵
// ===========================================================================

describe("smoke / 场景 1：人员 — 子组 + 人员 CRUD（#17 / #19 / #22）", () => {
  it("建组 → 建人 → 列人 → 矩阵；DTO + DB 行内容与原 Rust 端一致", () => {
    const w = setupWorld("2026-09-10 08:00:00");
    try {
      // 1) createSubTeam：sortOrder 默认按当前最大值递增；空库追加为 0。
      const team = Personnel.createSubTeam(w.state, {
        name: "二组",
        description: "外委对接",
      });
      expect(team.name).toBe("二组");
      expect(team.description).toBe("外委对接");
      // 一组先建（setupWorld 内 sortOrder=0），所以二组是 1。
      expect(team.sortOrder).toBe(1);
      expect(typeof team.id).toBe("number");
      expect(team.id).toBeGreaterThan(w.teamId);

      // DB 行内容：`sub_team` 表列必须落齐（V001 schema）。
      const teamRow = w.db
        .prepare<[number], {
          id: number;
          name: string;
          description: string | null;
          sort_order: number;
        }>(
          "SELECT id, name, description, sort_order FROM sub_team WHERE id = ?",
        )
        .get(team.id);
      expect(teamRow).toEqual({
        id: team.id,
        name: "二组",
        description: "外委对接",
        sort_order: 1,
      });

      // 2) createPerson：FK 落到子组；contact 必填且 trim 后非空。
      const person = Personnel.createPerson(w.state, {
        name: "李四",
        subTeamId: team.id,
        contact: "13900139000",
      });
      expect(person.name).toBe("李四");
      expect(person.subTeamId).toBe(team.id);
      expect(person.contact).toBe("13900139000");
      expect(person.deactivatedAt).toBeNull();
      // createdAt 走 SQLite `datetime('now')` 默认（V001 schema），不是
      // 注入时钟——这是 Electron ↔ Tauri 一致的硬约束：DB 列不接受
      // 时钟注入；只断言格式合法。
      expect(person.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

      // DB 行：`person(sub_team_id, name)` UNIQUE，contact 非空。
      const personRow = w.db
        .prepare<[number], {
          id: number;
          name: string;
          sub_team_id: number;
          contact: string;
          deactivated_at: string | null;
        }>(
          "SELECT id, name, sub_team_id, contact, deactivated_at FROM person WHERE id = ?",
        )
        .get(person.id);
      expect(personRow).toEqual({
        id: person.id,
        name: "李四",
        sub_team_id: team.id,
        contact: "13900139000",
        deactivated_at: null,
      });

      // 3) listPeople：默认 includeDeactivated=false，按 (sub_team_id, id) 排序。
      const onDuty = Personnel.listPeople(w.state, { includeDeactivated: false });
      // setupWorld 里一组有「张三」，这里二组新增「李四」，全表应有两人。
      expect(onDuty.map((p) => p.name).sort()).toEqual(["张三", "李四"]);

      // 子组过滤：李四在二组，张三在一组。
      const onlyErZu = Personnel.listPeople(w.state, {
        includeDeactivated: false,
        subTeamId: team.id,
      });
      expect(onlyErZu.map((p) => p.name)).toEqual(["李四"]);

      // 4) personnelMatrix：段头按 sort_order，二组在末位；在岗人员不
      // 出现 includeDeactivated=false 的段。
      const matrix = Personnel.personnelMatrix(w.state, { includeDeactivated: false });
      expect(matrix.segments.length).toBe(2);
      expect(matrix.segments[0]?.subTeam.name).toBe("一组");
      expect(matrix.segments[1]?.subTeam.name).toBe("二组");
      expect(matrix.segments[0]?.people.length).toBe(1);
      expect(matrix.segments[1]?.people[0]?.person.name).toBe("李四");
      // 没有任何任务，inFlightCount / blockedCount 都是 0。
      expect(matrix.segments[1]?.people[0]?.inFlightCount).toBe(0);
      expect(matrix.segments[1]?.people[0]?.blockedCount).toBe(0);
      expect(matrix.segments[1]?.people[0]?.tasks).toEqual([]);
    } finally {
      w.close();
    }
  });

  it("边界：同名子组拒绝 / 同子组内重名拒绝 / 空子组允许删", () => {
    const w = setupWorld("2026-09-10 08:00:00");
    try {
      // 一组已存在（同 setupWorld），再创同名 → 中文错误。
      expect(() =>
        Personnel.createSubTeam(w.state, { name: "一组" }),
      ).toThrow(/已存在同名子组/);

      // 同子组内重名：setupWorld 已建「张三」，再建会得中文错误。
      expect(() =>
        Personnel.createPerson(w.state, {
          name: "张三",
          subTeamId: w.teamId,
          contact: "x",
        }),
      ).toThrow(/同子组内已存在同名人员/);

      // 空白姓名 / 联系方式被拒。
      expect(() =>
        Personnel.createPerson(w.state, {
          name: "   ",
          subTeamId: w.teamId,
          contact: "x",
        }),
      ).toThrow(/姓名不能为空/);
      expect(() =>
        Personnel.createPerson(w.state, {
          name: "王五",
          subTeamId: w.teamId,
          contact: "  ",
        }),
      ).toThrow(/联系方式不能为空/);

      // 不存在的子组 FK 被拒。
      expect(() =>
        Personnel.createPerson(w.state, {
          name: "王五",
          subTeamId: 9999,
          contact: "x",
        }),
      ).toThrow(/所属子组不存在/);

      // 空子组允许删：建一个无人员的子组后删除。
      const empty = Personnel.createSubTeam(w.state, { name: "空组" });
      Personnel.deleteSubTeam(w.state, { id: empty.id });
      const after = Personnel.listSubTeams(w.state).map((t) => t.id);
      expect(after).not.toContain(empty.id);
    } finally {
      w.close();
    }
  });
});

// ===========================================================================
// 场景 2：任务 — 6 状态机 + 阻塞三列联动
// ===========================================================================

describe("smoke / 场景 2：任务 6 状态机 + 阻塞三列联动（#18 / #44）", () => {
  it("Open → In-progress → Blocked(reason) → Open：blocked_at / blocked_reason 正确联动", () => {
    const w = setupWorld("2026-09-10 08:00:00");
    try {
      // 1) createTask：默认 Open，blocked_* 全空。
      w.clock.setAt("2026-09-10 08:00:00");
      const t0 = Task.createTask(w.state, {
        title: "合同评审",
        description: "外委合同评审",
        ownerPersonId: w.personId,
        projectId: w.projectId,
        dueDate: "2026-09-10",
      });
      expect(t0.status).toBe("Open");
      expect(t0.blockedAt).toBeNull();
      expect(t0.blockedReason).toBeNull();
      expect(t0.waitingOnPersonId).toBeNull();
      expect(t0.isRecurring).toBe(false);
      expect(t0.effectiveDate).toBe("2026-09-10"); // due_date 走 COALESCE

      // DB 行内容：新建时 blocked_* 三列必须为 NULL（不能是空串）。
      const rowAfterCreate = w.db
        .prepare<[number], {
          status: string;
          blocked_at: string | null;
          blocked_reason: string | null;
          waiting_on_person_id: number | null;
          due_date: string | null;
        }>(
          `SELECT status, blocked_at, blocked_reason, waiting_on_person_id, due_date
             FROM task WHERE id = ?`,
        )
        .get(t0.id);
      expect(rowAfterCreate).toEqual({
        status: "Open",
        blocked_at: null,
        blocked_reason: null,
        waiting_on_person_id: null,
        due_date: "2026-09-10",
      });

      // 2) Open → In-progress：不写阻塞三列。
      w.clock.setAt("2026-09-10 09:00:00");
      const t1 = Task.setTaskStatus(w.state, {
        taskId: t0.id,
        status: "In-progress",
      });
      expect(t1.status).toBe("In-progress");
      expect(t1.blockedAt).toBeNull();
      expect(t1.blockedReason).toBeNull();
      expect(t1.waitingOnPersonId).toBeNull();

      // 3) In-progress → Blocked（带 reason）：写 blocked_at = now, blocked_reason,
      //    清空 waiting_on_person_id。
      w.clock.setAt("2026-09-10 10:00:00");
      const t2 = Task.setTaskStatus(w.state, {
        taskId: t0.id,
        status: "Blocked",
        blockedReason: "等外委回函",
      });
      expect(t2.status).toBe("Blocked");
      expect(t2.blockedAt).toBe("2026-09-10 10:00:00");
      expect(t2.blockedReason).toBe("等外委回函");
      expect(t2.waitingOnPersonId).toBeNull(); // Blocked 不允许 waiting_on

      // DB 行内容：DB 层这里 set 阻塞三列（CHECK 保证 waiting_on 必空）。
      const blockedRow = w.db
        .prepare<[number], {
          status: string;
          blocked_at: string | null;
          blocked_reason: string | null;
          waiting_on_person_id: number | null;
        }>(
          `SELECT status, blocked_at, blocked_reason, waiting_on_person_id
             FROM task WHERE id = ?`,
        )
        .get(t0.id);
      expect(blockedRow).toEqual({
        status: "Blocked",
        blocked_at: "2026-09-10 10:00:00",
        blocked_reason: "等外委回函",
        waiting_on_person_id: null,
      });

      // 4) Blocked → Open：清空 blocked_at / blocked_reason / waiting_on_person_id。
      w.clock.setAt("2026-09-10 11:00:00");
      const t3 = Task.setTaskStatus(w.state, {
        taskId: t0.id,
        status: "Open",
      });
      expect(t3.status).toBe("Open");
      expect(t3.blockedAt).toBeNull();
      expect(t3.blockedReason).toBeNull();
      expect(t3.waitingOnPersonId).toBeNull();

      // DB 行：阻塞三列已全部清空。
      const reopened = w.db
        .prepare<[number], {
          blocked_at: string | null;
          blocked_reason: string | null;
          waiting_on_person_id: number | null;
        }>(
          `SELECT blocked_at, blocked_reason, waiting_on_person_id FROM task WHERE id = ?`,
        )
        .get(t0.id);
      expect(reopened).toEqual({
        blocked_at: null,
        blocked_reason: null,
        waiting_on_person_id: null,
      });
    } finally {
      w.close();
    }
  });

  it("边界：Blocked 缺 reason / 超长 reason / 不存在 taskId 都被拒", () => {
    const w = setupWorld("2026-09-10 08:00:00");
    try {
      const t = Task.createTask(w.state, {
        title: "t",
        ownerPersonId: w.personId,
      });
      // Blocked 必须带 reason。
      expect(() =>
        Task.setTaskStatus(w.state, {
          taskId: t.id,
          status: "Blocked",
          blockedReason: null,
        }),
      ).toThrow(/阻塞原因不能为空/);
      expect(() =>
        Task.setTaskStatus(w.state, {
          taskId: t.id,
          status: "Blocked",
          blockedReason: "   ",
        }),
      ).toThrow(/阻塞原因不能为空/);

      // 超过 500 字符被拒（DB CHECK length(blocked_reason) <= 500）。
      expect(() =>
        Task.setTaskStatus(w.state, {
          taskId: t.id,
          status: "Blocked",
          blockedReason: "啊".repeat(501),
        }),
      ).toThrow(/500/);

      // 不存在的 taskId。
      expect(() =>
        Task.setTaskStatus(w.state, {
          taskId: 99999,
          status: "Open",
        }),
      ).toThrow(/任务不存在或已被删除/);
    } finally {
      w.close();
    }
  });
});

// ===========================================================================
// 场景 3：项目 — 创建 + 关联任务 + status 视图层派生
// ===========================================================================

describe("smoke / 场景 3：项目 + 任务关联 + status 派生（#20）", () => {
  it("空项目 Active → 加入 in-flight → Active → 全部 Done → Done", () => {
    const w = setupWorld("2026-09-10 08:00:00");
    try {
      // 1) 新建项目（空任务 → Active）。
      const project = Project.createProject(w.state, {
        name: "P-电梯年检",
        ownerPersonId: w.personId,
        subTeamId: w.teamId,
        startDate: "2026-09-01",
        dueDate: "2026-12-31",
        notes: "三季度电梯年检",
      });
      expect(project.name).toBe("P-电梯年检");
      expect(project.status).toBe("Active");
      expect(project.startDate).toBe("2026-09-01");
      expect(project.dueDate).toBe("2026-12-31");
      expect(project.notes).toBe("三季度电梯年检");

      // DB 行：`project.status` 不存表里 —— schema 没有该列，是视图层
      // 聚合。这一点 Electron 端 ↔ Tauri 端都必须一致。
      const projectRow = w.db
        .prepare<[number], {
          id: number;
          name: string;
          owner_person_id: number;
          sub_team_id: number;
        }>(
          "SELECT id, name, owner_person_id, sub_team_id FROM project WHERE id = ?",
        )
        .get(project.id);
      expect(projectRow).toEqual({
        id: project.id,
        name: "P-电梯年检",
        owner_person_id: w.personId,
        sub_team_id: w.teamId,
      });

      // 2) 把一条任务挂到项目下 → 项目仍 Active。
      const task = Task.createTask(w.state, {
        title: "联系维保单位",
        ownerPersonId: w.personId,
        projectId: project.id,
        dueDate: "2026-09-15",
      });
      expect(task.projectId).toBe(project.id);

      // listProjects(includeDone=false) 仍能看到（status=Active）。
      const stillActive = Project.listProjects(w.state, { includeDone: false });
      expect(stillActive.map((p) => p.status)).toEqual(["Active", "Active"]); // setupWorld 那条 + 这条

      // 3) 任务 Done → 项目 status=Done（无在飞，全是 Done/Cancelled）。
      Task.setTaskStatus(w.state, { taskId: task.id, status: "Done" });
      const afterDone = Project.listProjects(w.state, { includeDone: true });
      const justDone = afterDone.find((p) => p.id === project.id);
      expect(justDone?.status).toBe("Done");

      // includeDone=false 时不再出现。
      const inFlightOnly = Project.listProjects(w.state, { includeDone: false });
      expect(inFlightOnly.map((p) => p.id)).not.toContain(project.id);

      // 4) 把仅有的那条 task 从 Done 改回 Cancelled → status=Cancelled
      //    （全部任务都 Cancelled，无在飞）。
      Task.setTaskStatus(w.state, { taskId: task.id, status: "Cancelled" });
      const afterAllCancelled = Project.listProjects(w.state, { includeDone: true });
      const allCancelled = afterAllCancelled.find((p) => p.id === project.id);
      expect(allCancelled?.status).toBe("Cancelled");
    } finally {
      w.close();
    }
  });

  it("边界：createProject 拒绝非法日期 / 不存在的负责人或子组", () => {
    const w = setupWorld("2026-09-10 08:00:00");
    try {
      expect(() =>
        Project.createProject(w.state, {
          name: "x",
          ownerPersonId: w.personId,
          subTeamId: w.teamId,
          startDate: "2026/09/01", // 非法格式
        }),
      ).toThrow(/开始日格式不对/);

      expect(() =>
        Project.createProject(w.state, {
          name: "x",
          ownerPersonId: 9999,
          subTeamId: w.teamId,
        }),
      ).toThrow(/负责人不存在/);

      expect(() =>
        Project.createProject(w.state, {
          name: "x",
          ownerPersonId: w.personId,
          subTeamId: 9999,
        }),
      ).toThrow(/所属子组不存在/);

      // 空名拒绝。
      expect(() =>
        Project.createProject(w.state, {
          name: "   ",
          ownerPersonId: w.personId,
          subTeamId: w.teamId,
        }),
      ).toThrow(/项目名不能为空/);
    } finally {
      w.close();
    }
  });
});

// ===========================================================================
// 场景 4：模板 — upsert + rrule_text + list
// ===========================================================================

describe("smoke / 场景 4：周一例会模板 — upsert + rrule_text + list（#24 / #46）", () => {
  it("周一例会 weekly MO 模板：rrule_text 生成 + 结构化字段 round-trip", () => {
    const w = setupWorld("2026-09-10 08:00:00");
    try {
      // 1) upsert 新建 weekly MO 08:30 模板。
      const rule = {
        freq: "weekly" as const,
        bydayMask: Template.BYDAY_MO,
        bymonthday: null,
        bymonth: null,
        byhour: 8,
        byminute: 30,
        ianaZone: "Asia/Shanghai",
        ends: { kind: "on" as const, date: "2026-12-31" },
        holidayBehavior: "skip" as const,
      };
      const created = Template.upsertRecurringTemplate(w.state, {
        id: null,
        name: "周一例会",
        rule,
        projectId: w.projectId,
        subTeamId: null,
        notes: null,
      });
      expect(created.name).toBe("周一例会");
      expect(created.freq).toBe("weekly");
      expect(created.bydayMask).toBe(Template.BYDAY_MO);
      expect(created.byhour).toBe(8);
      expect(created.byminute).toBe(30);
      expect(created.ianaZone).toBe("Asia/Shanghai");
      expect(created.ends).toEqual({ kind: "on", date: "2026-12-31" });
      expect(created.holidayBehavior).toBe("skip");
      expect(created.projectId).toBe(w.projectId);
      expect(created.subTeamId).toBeNull();
      expect(created.enabled).toBe(true);
      expect(created.createdAt).toBe("2026-09-10 08:00:00");

      // rrule_text 与结构化字段一致（ADR 0002：结构化字段是真理）。
      // FREQ + BYDAY=MO + BYHOUR=8 + BYMINUTE=30 + UNTIL=20261231T235959Z。
      expect(created.rruleText).toBe(
        "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=30;UNTIL=20261231T235959Z",
      );

      // DB 行：`rrule_text` 列由 upsert 一次性写入，不在 schema 层重算。
      const tmplRow = w.db
        .prepare<[number], {
          name: string;
          freq: string;
          byday_mask: number;
          byhour: number;
          byminute: number;
          iana_zone: string;
          ends_on: string | null;
          ends_after_n: number | null;
          holiday_behavior: string;
          rrule_text: string;
          enabled: number;
          project_id: number | null;
          sub_team_id: number | null;
        }>(
          `SELECT name, freq, byday_mask, byhour, byminute, iana_zone,
                  ends_on, ends_after_n, holiday_behavior, rrule_text,
                  enabled, project_id, sub_team_id
             FROM recurring_template WHERE id = ?`,
        )
        .get(created.id);
      expect(tmplRow).toEqual({
        name: "周一例会",
        freq: "WEEKLY",
        byday_mask: Template.BYDAY_MO,
        byhour: 8,
        byminute: 30,
        iana_zone: "Asia/Shanghai",
        ends_on: "2026-12-31",
        ends_after_n: null,
        holiday_behavior: "SKIP",
        rrule_text: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=30;UNTIL=20261231T235959Z",
        enabled: 1,
        project_id: w.projectId,
        sub_team_id: null,
      });

      // 2) listRecurringTemplates：默认只看启用（includeDisabled=false）。
      const list = Template.listRecurringTemplates(w.state, { includeDisabled: false });
      expect(list.map((t) => t.name)).toEqual(["周一例会"]);
      // 列表项的 rruleText 走 sanity check → 与结构化字段一致。
      expect(list[0]?.rruleText).toBe(
        "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=30;UNTIL=20261231T235959Z",
      );

      // 3) 编辑（id 非空）：rrule_text 跟着结构化字段重新派生。
      const edited = Template.upsertRecurringTemplate(w.state, {
        id: created.id,
        name: "周一例会 v2",
        rule: { ...rule, byhour: 9, byminute: 0 },
        projectId: w.projectId,
        subTeamId: null,
        notes: "9 点开档",
      });
      expect(edited.name).toBe("周一例会 v2");
      expect(edited.byhour).toBe(9);
      expect(edited.byminute).toBe(0);
      expect(edited.notes).toBe("9 点开档"); // trim 后落库
      expect(edited.rruleText).toBe(
        "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;UNTIL=20261231T235959Z",
      );
      // 编辑不复活：若先停用，编辑后 enabled 保持 false。
      Template.setRecurringTemplateEnabled(w.state, {
        id: created.id,
        enabled: false,
      });
      const reEdited = Template.upsertRecurringTemplate(w.state, {
        id: created.id,
        name: "周一例会 v3",
        rule: { ...rule, byhour: 7 },
        projectId: w.projectId,
        subTeamId: null,
        notes: null,
      });
      expect(reEdited.enabled).toBe(false);
    } finally {
      w.close();
    }
  });

  it("边界：weekly 缺星期 / 非 Asia/Shanghai 时区 / 非法终止日都被拒", () => {
    const w = setupWorld("2026-09-10 08:00:00");
    try {
      const weekly = {
        freq: "weekly" as const,
        bydayMask: Template.BYDAY_MO,
        bymonthday: null,
        bymonth: null,
        byhour: 8,
        byminute: 30,
        ianaZone: "Asia/Shanghai",
        ends: { kind: "on" as const, date: "2026-12-31" },
        holidayBehavior: "skip" as const,
      };

      // weekly 缺星期 = 0 → 拒绝。
      expect(() =>
        Template.upsertRecurringTemplate(w.state, {
          id: null,
          name: "x",
          rule: { ...weekly, bydayMask: 0 },
          projectId: w.projectId,
          subTeamId: null,
          notes: null,
        }),
      ).toThrow(/每周规则必须至少选一天/);

      // 非 Asia/Shanghai → 拒绝（v1 简化）。
      expect(() =>
        Template.upsertRecurringTemplate(w.state, {
          id: null,
          name: "x",
          rule: { ...weekly, ianaZone: "America/New_York" },
          projectId: w.projectId,
          subTeamId: null,
          notes: null,
        }),
      ).toThrow(/Asia\/Shanghai/);

      // 非法终止日 → 拒绝。
      expect(() =>
        Template.upsertRecurringTemplate(w.state, {
          id: null,
          name: "x",
          rule: { ...weekly, ends: { kind: "on" as const, date: "2026/12/31" } },
          projectId: w.projectId,
          subTeamId: null,
          notes: null,
        }),
      ).toThrow(/终止日/);
    } finally {
      w.close();
    }
  });
});

// ===========================================================================
// 场景 5：物化 — 模板 → materialize_now → task 实例行
// ===========================================================================

describe("smoke / 场景 5：物化 — materializeFromState（#25 / #48）", () => {
  it("周一例会 weekly MO 模板 → 12 周窗口 → 12 条 Open instance", () => {
    // 物化窗口需要 now.today() 落在周内——选周四 2026-09-10 这样不会
    // 横跨周一/周日的边界意外跳过。
    const w = setupWorld("2026-09-10 08:00:00");
    try {
      // 1) upsert weekly MO 08:00 模板（与场景 4 同形但 ends_on 收紧）。
      const template = Template.upsertRecurringTemplate(w.state, {
        id: null,
        name: "周一例会",
        rule: {
          freq: "weekly",
          bydayMask: Template.BYDAY_MO,
          bymonthday: null,
          bymonth: null,
          byhour: 8,
          byminute: 0,
          ianaZone: "Asia/Shanghai",
          ends: { kind: "on", date: "2026-12-31" },
          holidayBehavior: "skip",
        },
        projectId: w.projectId,
        subTeamId: null,
        notes: null,
      });

      // 2) 调 materializeFromState（= IPC `materialize_now` 的等价命令）。
      //    freshDb 默认装载的是空日历（workday 占位），SKIP 路径只走
      //    `calendar.kindOf()`（state.calendar 在 freshDb 里就是占位
//    HolidayCalendar）。
      const totals = Materialization.materializeFromState(w.state);

      // 3) 物化 totals：12 周 × 每周一 = 12 条（SKIP 路径下没有 skipped，
      //    9/14 / 9/21 / ... 都是普通 Mon → keep）。
      expect(totals.templates).toBe(1);
      expect(totals.kept).toBe(12);
      expect(totals.skipped).toBe(0);
      expect(totals.shifted).toBe(0);
      expect(totals.cancelled).toBe(0);

      // 4) DB 行内容：每条 instance 必须挂齐 project_id / sub_team_id
      //    （从模板继承）、recurring_template_id、scheduled_at、status=Open。
      //    12 周窗口起点 2026-09-10（含）→ 12 个 Mon。
      //    2026-09-14, 09-21, 09-28, 10-05, 10-12, 10-19, 10-26,
      //    11-02, 11-09, 11-16, 11-23, 11-30。
      const instances = w.db
        .prepare<[number], {
          id: number;
          title: string;
          status: string;
          owner_person_id: number;
          project_id: number | null;
          sub_team_id: number | null;
          recurring_template_id: number | null;
          scheduled_at: string;
          original_scheduled_at: string | null;
          rescheduled_from_id: number | null;
        }>(
          `SELECT id, title, status, owner_person_id, project_id, sub_team_id,
                  recurring_template_id, scheduled_at, original_scheduled_at,
                  rescheduled_from_id
             FROM task
            WHERE recurring_template_id = ?
            ORDER BY scheduled_at ASC`,
        )
        .all(template.id);

      expect(instances.length).toBe(12);
      expect(instances[0]?.scheduled_at).toBe("2026-09-14 00:00:00");
      expect(instances[11]?.scheduled_at).toBe("2026-11-30 00:00:00");
      expect(instances.every((r) => r.status === "Open")).toBe(true);
      expect(instances.every((r) => r.recurring_template_id === template.id)).toBe(true);
      expect(instances.every((r) => r.project_id === w.projectId)).toBe(true);
      expect(instances.every((r) => r.owner_person_id === w.personId)).toBe(true);
      // KEEP 路径 original_scheduled_at == scheduled_at。
      expect(
        instances.every((r) => r.original_scheduled_at === r.scheduled_at),
      ).toBe(true);
      expect(instances.every((r) => r.rescheduled_from_id === null)).toBe(true);
      // 标题「周一例会 @ YYYY-MM-DD」由物化层写入。
      expect(instances[0]?.title).toBe("周一例会 @ 2026-09-14");

      // 5) 幂等：再跑一次 totals 不再增加。
      const second = Materialization.materializeFromState(w.state);
      expect(second).toEqual({
        templates: 1,
        kept: 0,
        skipped: 0,
        shifted: 0,
        cancelled: 0,
      });

      // 6) meta 写入：materializeFromState 在物化后写 (year, week)。
      const meta = Materialization.readLastMaterializedWeek(w.db);
      expect(meta).not.toBeNull();
      // 2026-09-10 是周四 → 第 37 周。
      expect(meta?.week).toBe(37);
    } finally {
      w.close();
    }
  });
});