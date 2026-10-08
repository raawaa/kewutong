/**
 * 示例数据命令层（ticket #31）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/commands/sample.rs` 的语义：
 * - `is_sample_data_present`：横幅查询——是否还有示例数据未清除。
 * - `clear_sample_data`：一键清除所有 `is_sample = 1` 的行，**不留悬空 FK**。
 * - `seed_real_teams`：首启灌入真实 4 子组 + 20 人骨架。
 *
 * 约束（承接 V007 seed）：
 * - `is_sample` 列在 `sub_team` / `person` / `project` / `task` /
 *   `recurring_template` 五张表上，partial index `WHERE is_sample = 1` 让
 *   「横幅查询」与「清除」走 index seek。
 * - 清除按 FK 安全顺序：`task` → `recurring_template` → `project` →
 *   `person` → `sub_team`。`task.recurring_template_id` 与
 *   `task.project_id` 是 NO ACTION 缺省 FK，反过来删父表会被 DB 拒；
 *   顺序不能错。
 * - 真实数据 `is_sample = 0`，清除命令一行都不动——AC「清除后真实
 *   数据保留」。
 *
 * `data_file_location` 不在本模块：M1 已在 `ipc/register.ts` 里用
 * `s.dbPath` 直接注册 `dataFileLocation` 通道，preload 与 api-types 也已
 * 暴露——这里再实现一份只会造成两套真值。
 */

import type { AppState } from "../state.js";
import type { ClearSampleSummary, RealTeamsSeedSummary, SamplePresence } from "../types.js";

// ---------------------------------------------------------------------------
// 横幅查询
// ---------------------------------------------------------------------------

/**
 * 横幅查询：任意一张表里仍有 `is_sample = 1` 的行就返回 `present = true`。
 *
 * partial index `idx_*_is_sample` 走 index seek；不走全表扫。
 */
export function isSampleDataPresent(state: AppState): SamplePresence {
  const row = state.db
    .prepare<[], { present: number }>(
      `SELECT EXISTS(SELECT 1 FROM sub_team WHERE is_sample = 1)
            OR EXISTS(SELECT 1 FROM person WHERE is_sample = 1)
            OR EXISTS(SELECT 1 FROM project WHERE is_sample = 1)
            OR EXISTS(SELECT 1 FROM task WHERE is_sample = 1)
            OR EXISTS(SELECT 1 FROM recurring_template WHERE is_sample = 1) AS present`,
    )
    .get();

  return { present: (row?.present ?? 0) !== 0 };
}

// ---------------------------------------------------------------------------
// 一键清除
// ---------------------------------------------------------------------------

/**
 * 一键清除所有示例数据。
 *
 * FK 安全删除顺序（子 → 父，符合各 FK 引用关系）：
 * 1. `task` —— `task` FK 引用 `recurring_template` / `project` / `person`，
 *    必须先删，否则父表会被 NO ACTION FK 拒。
 * 2. `recurring_template` —— FK 引用 `project` / `sub_team`，在 task 之后
 *    删（否则 `task.recurring_template_id` 悬空）。
 * 3. `project` —— FK 引用 `person` / `sub_team`，在 task 之后删。
 * 4. `person` —— FK 引用 `sub_team`；task 已删，`waiting_on_person_id` 不再
 *    悬空。
 * 5. `sub_team` —— 最顶层，最后删。
 *
 * 整段在单个事务里执行——跨机同步漂移时不能出现「部分清除」的中间状态。
 * AC「清除后库仍自洽，无悬空 FK」由事务保证。
 */
export function clearSampleData(state: AppState): ClearSampleSummary {
  // 每步拿到 affected 计数——前端 banner 清除后据此提示，实际条数同时便于
  // 测试与日志排错。
  return state.db.transaction((): ClearSampleSummary => {
    const tasks = state.db.prepare("DELETE FROM task WHERE is_sample = 1").run().changes;
    const templates = state.db
      .prepare("DELETE FROM recurring_template WHERE is_sample = 1")
      .run().changes;
    const projects = state.db.prepare("DELETE FROM project WHERE is_sample = 1").run().changes;
    const people = state.db.prepare("DELETE FROM person WHERE is_sample = 1").run().changes;
    const subTeams = state.db.prepare("DELETE FROM sub_team WHERE is_sample = 1").run().changes;

    return {
      subTeams,
      people,
      projects,
      tasks,
      recurringTemplates: templates,
    };
  })();
}

// ---------------------------------------------------------------------------
// 首启种子
// ---------------------------------------------------------------------------

/**
 * 首启灌入真实 4 子组 + 20 人骨架（承接 `docs/data/initial-sub-teams.md`）。
 *
 * 触发条件：**库里没有任何 `is_sample = 0` 的子组**。已经存在真实子组时
 * 整段跳过——保证后续启动 / 跨机同步漂移时**不重复**灌入。返回
 * `seeded = false` 让调用方知道「没动库」。
 *
 * 不放进 V008 migration 的原因：迁移在 fixture / 跨机同步等场景下会与已
 * 有数据冲突（UNIQUE 约束）；做成命令后，「有数据就不灌」是一条业务规
 * 则，而不是 SQL 报错。
 */
export function seedRealTeams(state: AppState): RealTeamsSeedSummary {
  return seedRealTeamsInner(state);
}

/**
 * 首启场景同步执行 [`seedRealTeams`]——非 IPC 变体，直接吃 `AppState`，
 * 便于 setup 钩子同步调用。
 *
 * 与命令版语义一致：有真实子组就跳过。两条导出共用一份实现，避免日后
 * 「改了一处忘了另一处」。
 */
export function seedRealTeamsViaState(state: AppState): RealTeamsSeedSummary {
  return seedRealTeamsInner(state);
}

function seedRealTeamsInner(state: AppState): RealTeamsSeedSummary {
  const existing =
    state.db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sub_team WHERE is_sample = 0")
      .get()?.c ?? 0;
  if (existing > 0) {
    return { subTeamsInserted: 0, peopleInserted: 0, seeded: false };
  }

  // 显式 ID 与 V007 示例子组（1-2）错开，避免 rowid 重叠混淆。
  state.db.transaction(() => {
    state.db
      .prepare(
        `INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample) VALUES
           (100, '暖通', '暖通空调系统维护与改造(楼宇温控 / 通风 / 冷热源)', 1, datetime('now'), 0),
           (101, '电气', '强电 / 弱电 / 配电系统维护',                          2, datetime('now'), 0),
           (102, '行政', '综合行政 / 文件流转 / 后勤保障',                      3, datetime('now'), 0),
           (103, '运行', '设备日常运行 / 巡检 / 值守',                          4, datetime('now'), 0)`,
      )
      .run();

    // contact 写占位文案——真实联系方式由科长在人员管理里补录，不在种子阶段
    // 编造。deactivated_at 留 NULL：新灌的人都在岗。
    state.db
      .prepare(
        `INSERT INTO person (id, name, sub_team_id, contact, deactivated_at, created_at, is_sample) VALUES
           (100, '张建国', 100, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (101, '李志远', 100, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (102, '王海涛', 100, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (103, '陈伟',   100, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (104, '刘建新', 100, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (110, '赵建华', 101, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (111, '钱永刚', 101, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (112, '周大鹏', 101, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (113, '吴军',   101, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (114, '林志强', 101, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (120, '孙美华', 102, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (121, '郑雅静', 102, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (122, '何秀梅', 102, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (123, '杨丽萍', 102, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (130, '黄海波', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (131, '徐建斌', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (132, '马天宇', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (133, '朱云峰', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (134, '胡晓东', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0),
           (135, '郭文涛', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0)`,
      )
      .run();
  })();

  return { subTeamsInserted: 4, peopleInserted: 20, seeded: true };
}
