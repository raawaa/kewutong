//! 示例数据命令层（ticket #31）。
//!
//! 提供三个动作:
//! - `is_sample_data_present`:横幅查询——是否还有示例数据未清除。
//! - `clear_sample_data`:一键清除所有 `is_sample = 1` 的行,**不留悬空 FK**。
//! - `data_file_location`:返回 SQLite 文件绝对路径——便于科长把它加进
//!   Syncthing 同步目录。
//!
//! 约束(承接 V007 seed):
//! - `is_sample` 列在 `sub_team` / `person` / `project` / `task` /
//!   `recurring_template` 五张表上,partial index `WHERE is_sample = 1` 让
//!   「横幅查询」与「清除」走 index seek。
//! - 清除按 FK 安全顺序:`recurring_template` → `task` → `project` →
//!   `person` → `sub_team`。`task.recurring_template_id` 与
//!   `task.project_id` 是 NO ACTION 缺省 FK,反过来删父表会被 DB 拒;
//!   顺序不能错。
//! - 真实数据 `is_sample = 0`,清除命令一行都不动——AC「清除后真实
//!   数据保留」。

use crate::error::{AppError, Result};
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

/// `is_sample_data_present` 的返回 DTO。前端拿到这个布尔决定是否展示
/// 「这是示例数据」横幅。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplePresence {
    pub present: bool,
}

/// `clear_sample_data` 的返回 DTO。前端 banner 清除后调用,然后可以刷
/// 新一次视图确认。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearSampleSummary {
    pub sub_teams: i64,
    pub people: i64,
    pub projects: i64,
    pub tasks: i64,
    pub recurring_templates: i64,
}

/// 横幅查询:任意一张表里仍有 `is_sample = 1` 的行就返回 `present = true`。
///
/// partial index `idx_*_is_sample` 走 index seek;不走全表扫。
#[tauri::command]
pub fn is_sample_data_present(state: State<'_, AppState>) -> Result<SamplePresence> {
    let conn = state.db()?;
    let mut stmt = conn.prepare(
        "SELECT EXISTS(SELECT 1 FROM sub_team WHERE is_sample = 1) \
                OR EXISTS(SELECT 1 FROM person WHERE is_sample = 1) \
                OR EXISTS(SELECT 1 FROM project WHERE is_sample = 1) \
                OR EXISTS(SELECT 1 FROM task WHERE is_sample = 1) \
                OR EXISTS(SELECT 1 FROM recurring_template WHERE is_sample = 1)",
    )?;
    let present: i64 = stmt.query_row([], |row| row.get(0))?;
    Ok(SamplePresence {
        present: present != 0,
    })
}

/// 一键清除所有示例数据。
///
/// FK 安全删除顺序(子 → 父,符合各 FK 引用关系):
/// 1. `task` —— `task` FK 引用 `recurring_template` / `project` / `person`,
///    必须先删,否则父表会被 NO ACTION FK 拒。
/// 2. `recurring_template` —— FK 引用 `project` / `sub_team`,在 task 之
///    后删(否则 task.recurring_template_id 悬空)。
/// 3. `project` —— FK 引用 `person` / `sub_team`,在 task 之后删。
/// 4. `person` —— FK 引用 `sub_team`;task 已删,waiting_on_person_id 不
///    再悬空。
/// 5. `sub_team` —— 最顶层,最后删。
///
/// 整段在单个事务里执行——跨机同步漂移时不能出现"部分清除"的中间
/// 状态。AC「清除后库仍自洽,无悬空 FK」由事务保证。
#[tauri::command]
pub fn clear_sample_data(state: State<'_, AppState>) -> Result<ClearSampleSummary> {
    let conn = state.db()?;
    let tx = conn.unchecked_transaction()?;

    // FK 子 → 父顺序。每步拿到 affected 计数——前端不用,但保留便于测试
    // 与日志排错。
    let tasks = tx.execute("DELETE FROM task WHERE is_sample = 1", [])?;
    let templates = tx.execute(
        "DELETE FROM recurring_template WHERE is_sample = 1",
        [],
    )?;
    let projects = tx.execute("DELETE FROM project WHERE is_sample = 1", [])?;
    let people = tx.execute("DELETE FROM person WHERE is_sample = 1", [])?;
    let sub_teams = tx.execute("DELETE FROM sub_team WHERE is_sample = 1", [])?;

    tx.commit().map_err(AppError::from)?;

    Ok(ClearSampleSummary {
        sub_teams: sub_teams as i64,
        people: people as i64,
        projects: projects as i64,
        tasks: tasks as i64,
        recurring_templates: templates as i64,
    })
}

/// 返回 SQLite 数据库文件的绝对路径——前端 banner 里展示,便于科长
/// 把它加进 Syncthing 同步目录。
///
/// 路径在应用启动时由 [`crate::state::AppState`] 持有,本命令直接读
/// state 字段,不再走 OS 查询(后者在 macOS sandbox 下要绕一道)。
#[tauri::command]
pub fn data_file_location(state: State<'_, AppState>) -> Result<String> {
    let path = state.db_path().ok_or_else(|| {
        AppError::internal("数据库路径未初始化,请重启应用后再试。")
    })?;
    Ok(path.to_string_lossy().to_string())
}

/// `seed_real_teams` 的返回 DTO——首启调用后告诉前端「灌了 X 个子组、
/// Y 名人员」,前端 banner 据此提示「真实分桶已就位」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealTeamsSeedSummary {
    pub sub_teams_inserted: i64,
    pub people_inserted: i64,
    /// `false` = 库里已有 `is_sample = 0` 的子组,本次跳过。
    pub seeded: bool,
}

/// 首启灌入真实 4 子组 + 20 人骨架(承接 `docs/data/initial-sub-teams.md`)。
///
/// 触发条件:**库里没有任何 `is_sample = 0` 的子组**。已经存在真
/// 实子组时整段跳过——保证后续启动 / 跨机同步漂移时**不重复**灌入。
/// 返回 `seeded = false` 让调用方知道「没动库」。
///
/// 不放进 V008 migration 的原因:迁移在 fixture / 跨机同步等场景下会
/// 与已有数据冲突(UNIQUE 约束);改成 Rust 命令后,「有数据就不灌」
/// 是一条业务规则,而不是 SQL 报错。
#[tauri::command]
pub fn seed_real_teams(state: State<'_, AppState>) -> Result<RealTeamsSeedSummary> {
    seed_real_teams_inner(state.inner())
}

/// 首启场景同步执行 [`seed_real_teams`]——非 Tauri 命令,直接吃
/// `&AppState`,便于 [`crate::lib::run`] 在 setup 钩子同步调用。
///
/// 与命令版语义一致:有真实子组就跳过。
pub fn seed_real_teams_via_state(state: &AppState) -> Result<RealTeamsSeedSummary> {
    seed_real_teams_inner(state)
}

fn seed_real_teams_inner(state: &AppState) -> Result<RealTeamsSeedSummary> {
    let conn = state.db()?;
    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sub_team WHERE is_sample = 0",
        [],
        |row| row.get(0),
    )?;
    if existing > 0 {
        return Ok(RealTeamsSeedSummary {
            sub_teams_inserted: 0,
            people_inserted: 0,
            seeded: false,
        });
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample) VALUES \
            (100, '暖通', '暖通空调系统维护与改造(楼宇温控 / 通风 / 冷热源)', 1, datetime('now'), 0), \
            (101, '电气', '强电 / 弱电 / 配电系统维护',                          2, datetime('now'), 0), \
            (102, '行政', '综合行政 / 文件流转 / 后勤保障',                      3, datetime('now'), 0), \
            (103, '运行', '设备日常运行 / 巡检 / 值守',                          4, datetime('now'), 0)",
        [],
    )?;
    tx.execute(
        "INSERT INTO person (id, name, sub_team_id, contact, deactivated_at, created_at, is_sample) VALUES \
            (100, '张建国', 100, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (101, '李志远', 100, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (102, '王海涛', 100, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (103, '陈伟',   100, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (104, '刘建新', 100, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (110, '赵建华', 101, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (111, '钱永刚', 101, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (112, '周大鹏', 101, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (113, '吴军',   101, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (114, '林志强', 101, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (120, '孙美华', 102, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (121, '郑雅静', 102, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (122, '何秀梅', 102, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (123, '杨丽萍', 102, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (130, '黄海波', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (131, '徐建斌', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (132, '马天宇', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (133, '朱云峰', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (134, '胡晓东', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0), \
            (135, '郭文涛', 103, '请在人员管理补录联系方式', NULL, datetime('now'), 0)",
        [],
    )?;
    tx.commit().map_err(AppError::from)?;
    Ok(RealTeamsSeedSummary {
        sub_teams_inserted: 4,
        people_inserted: 20,
        seeded: true,
    })
}

#[cfg(test)]
mod tests {
    //! 单元侧测试由集成测试 `tests/sample.rs` 覆盖(端到端走 mock_app +
    //! fresh_db);本模块只放纯函数级别的桩测试。

    #[test]
    fn sample_presence_序列化字段名_对齐_camel_case() {
        let payload = super::SamplePresence { present: true };
        let json = serde_json::to_value(payload).expect("序列化");
        assert_eq!(json["present"], true);
    }

    #[test]
    fn clear_summary_字段名_对齐_camel_case() {
        let summary = super::ClearSampleSummary {
            sub_teams: 1,
            people: 2,
            projects: 3,
            tasks: 4,
            recurring_templates: 5,
        };
        let json = serde_json::to_value(summary).expect("序列化");
        assert_eq!(json["subTeams"], 1);
        assert_eq!(json["people"], 2);
        assert_eq!(json["projects"], 3);
        assert_eq!(json["tasks"], 4);
        assert_eq!(json["recurringTemplates"], 5);
    }
}
