//! 通知引擎（ticket #30）。
//!
//! 承担三件事：
//!
//! 1. **payload 形状单源**：[`NotificationPayload`] 是 `#[serde(tag =
//    "kind", rename_all = "snake_case")]` enum，与 `notification_log.kind`
//    列字面量同源；序列化 → 落库 → 读回 三处共享同一份 JSON 形状。
//!
//! 2. **三条规则的纯查询**：每个规则跑"取行 → 去重 → 写日志"三步；
//    不碰 OS 通知 UI、不碰前端 IPC——OS 通知由调用方在拿到返回值后
//!    走 [`tauri_plugin_notification`] 的 emit 路径。
//!
//! 3. **dedup 单源**：去重完全走 `notification_log` 表 ——
//    `WHERE kind = ? AND related_task_id = ?`（due_24h / blocked_3d）
//    或 `WHERE kind = ? AND triggered_at LIKE ?`（weekly_digest）。
//!    同一规则对同一对象不反复轰炸。
//!
//! `Clock` 通过 [`crate::state::AppState::now`] 注入，测试可以把"现在"
//! 钉到任意时刻；周报"周一 08:00"窗口与节假日联动都走这条路径。
//!
//! 调度由 [`crate::lib::spawn_periodic_tick`] 共用现有物化 tick：
//! 每小时跑一次物化后顺带跑一遍三个规则（条件不满足 noop），
//! 不再单独起一个 interval。

use crate::error::{AppError, Result};
use crate::state::AppState;
use chrono::{Datelike, Days, NaiveDate, Timelike, Weekday};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// payload 形状单源（DB `notification_log.kind` 列字面量 ↔ Rust enum）
// ---------------------------------------------------------------------------

/// `notification_log.kind` 列字面量——DB `CHECK (kind IN (...))` 一一对齐。
///
/// serde 用 `snake_case`（与列字面量一致），前端按 `kind` 字符串分支渲
/// 染。不放 #[serde(rename_all)] 转换是为了让 DB 列 ↔ Rust 变体 ↔ 序列化
/// 字符串三者字面量一致，调试时少一层转换。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NotificationKind {
    #[serde(rename = "due_24h")]
    Due24h,
    #[serde(rename = "blocked_3d")]
    Blocked3d,
    #[serde(rename = "weekly_digest")]
    WeeklyDigest,
}

impl NotificationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Due24h => "due_24h",
            Self::Blocked3d => "blocked_3d",
            Self::WeeklyDigest => "weekly_digest",
        }
    }
}

/// 通知 payload 形状单源——`#[serde(tag = "kind")]` 与
/// `notification_log.kind` 列字面量同源。
///
/// 序列化形状（JSON）：
/// - `due_24h`: `{ "kind": "due_24h", "task_id": ..., "title": ..., "due_date": ..., "owner_person_id": ..., "owner_name": ... }`
/// - `blocked_3d`: `{ "kind": "blocked_3d", "task_id": ..., "title": ..., "blocked_at": ..., "days_blocked": ..., "blocked_reason": ..., "owner_person_id": ..., "owner_name": ... }`
/// - `weekly_digest`: `{ "kind": "weekly_digest", "week_start": ..., "week_end": ..., "overdue_count": ..., "due_today_count": ..., "due_tomorrow_count": ..., "blocked_count": ... }`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum NotificationPayload {
    /// 到期前 24h 提醒。`due_date` 是 YYYY-MM-DD 本地日历日。
    #[serde(rename = "due_24h")]
    Due24h {
        task_id: i64,
        title: String,
        due_date: String,
        owner_person_id: i64,
        owner_name: String,
    },
    /// Blocked / Waiting-on 超过 3 天。`blocked_at` 是 UTC 时间戳
    /// (SQL `datetime('now')` 格式)；`days_blocked` 为整数天（向下取整）。
    #[serde(rename = "blocked_3d")]
    Blocked3d {
        task_id: i64,
        title: String,
        blocked_at: String,
        days_blocked: i64,
        blocked_reason: String,
        owner_person_id: i64,
        owner_name: String,
    },
    /// 周一 08:00 周报摘要。计数即可,明细走今日/本周视图自己拉——
    /// payload 不膨胀。
    #[serde(rename = "weekly_digest")]
    WeeklyDigest {
        /// 本周一(YYYY-MM-DD,本地日历)。
        week_start: String,
        /// 本周日(YYYY-MM-DD,本地日历)。
        week_end: String,
        /// 已逾期任务数(不限负责人)。
        overdue_count: i64,
        /// 今天到期任务数。
        due_today_count: i64,
        /// 明天到期任务数。
        due_tomorrow_count: i64,
        /// 当前阻塞任务数(`status IN ('Blocked','Waiting-on')`)。
        blocked_count: i64,
    },
}

impl NotificationPayload {
    fn kind(&self) -> NotificationKind {
        match self {
            Self::Due24h { .. } => NotificationKind::Due24h,
            Self::Blocked3d { .. } => NotificationKind::Blocked3d,
            Self::WeeklyDigest { .. } => NotificationKind::WeeklyDigest,
        }
    }

    fn related_task_id(&self) -> Option<i64> {
        match self {
            Self::Due24h { task_id, .. } => Some(*task_id),
            Self::Blocked3d { task_id, .. } => Some(*task_id),
            Self::WeeklyDigest { .. } => None,
        }
    }

    /// 渲染 OS 通知的标题 + 正文（中文硬编码,无 i18n,spec #15）。
    pub(crate) fn render_message(&self) -> (String, String) {
        match self {
            Self::Due24h { title, due_date, owner_name, .. } => (
                "任务即将到期".to_string(),
                format!("{owner_name} 的「{title}」将于 {due_date} 到期"),
            ),
            Self::Blocked3d { title, days_blocked, owner_name, blocked_reason, .. } => (
                format!("任务阻塞 {days_blocked} 天"),
                format!("{owner_name} 的「{title}」：{blocked_reason}"),
            ),
            Self::WeeklyDigest { week_start, week_end, overdue_count, due_today_count, due_tomorrow_count, blocked_count } => (
                format!("周报摘要（{week_start} ~ {week_end}）"),
                format!(
                    "已逾期 {overdue_count} 条,今日到期 {due_today_count} 条,明日到期 {due_tomorrow_count} 条,阻塞中 {blocked_count} 条",
                ),
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// 通知行 DTO（前端 IPC 出参）
// ---------------------------------------------------------------------------

/// 一条通知行（DB → 前端）。
///
/// `payload` 用 `serde_json::Value` 透传——前端按 `payload.kind` 分支
/// 渲染（避免 Rust 端在 IPC 层再造一层一比一 DTO）。`viewed_at` NULL
/// 即未读。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRow {
    pub id: i64,
    pub triggered_at: String,
    pub kind: String,
    pub related_task_id: Option<i64>,
    pub related_template_id: Option<i64>,
    pub payload: serde_json::Value,
    pub viewed_at: Option<String>,
}

// ---------------------------------------------------------------------------
// 三条规则
// ---------------------------------------------------------------------------

/// due_24h：扫描「今天 + 明天」截止的一次性任务，按 task 去重。
///
/// 只扫**一次性 task**（`recurring_template_id IS NULL` + `due_date` 非
/// 空 + 状态在飞）——instance 由物化层管 due 语义，不进通知。
/// 去重键：`(kind='due_24h', related_task_id)`。
///
/// 返回本次新插入的 rows；调用方对每行 emit OS 通知。
pub fn run_due_24h(state: &AppState) -> Result<Vec<NotificationRow>> {
    let today = state.today();
    let tomorrow = today
        .checked_add_days(Days::new(1))
        .ok_or_else(|| AppError::Internal("today+1 越界,日期不合理".into()))?;

    let conn = state.db()?;
    // 命中 `idx_task_due_date` partial（`WHERE due_date IS NOT NULL`）+
    // `idx_task_in_flight_status` partial（在飞四态）。SQLite 会挑基数小
    // 的那个走。
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.due_date, t.owner_person_id, p.name \
           FROM task t \
           JOIN person p ON p.id = t.owner_person_id \
          WHERE t.recurring_template_id IS NULL \
            AND t.due_date IS NOT NULL \
            AND t.due_date IN (?1, ?2) \
            AND t.status IN ('Open','In-progress','Blocked','Waiting-on') \
          ORDER BY t.due_date ASC, t.id ASC",
    )?;
    let rows = stmt.query_map(
        params![today.format("%Y-%m-%d").to_string(), tomorrow.format("%Y-%m-%d").to_string()],
        |row| {
            let task_id: i64 = row.get(0)?;
            Ok(Due24hCandidate {
                task_id,
                title: row.get(1)?,
                due_date: row.get(2)?,
                owner_person_id: row.get(3)?,
                owner_name: row.get(4)?,
            })
        },
    )?;

    let mut inserted = Vec::new();
    let now = state.now_sql();
    for row in rows {
        let cand = row?;
        let payload = NotificationPayload::Due24h {
            task_id: cand.task_id,
            title: cand.title,
            due_date: cand.due_date,
            owner_person_id: cand.owner_person_id,
            owner_name: cand.owner_name,
        };
        if let Some(notif) = dedup_insert(&conn, payload, &now)? {
            inserted.push(notif);
        }
    }
    Ok(inserted)
}

struct Due24hCandidate {
    task_id: i64,
    title: String,
    due_date: String,
    owner_person_id: i64,
    owner_name: String,
}

/// blocked_3d：扫描 Blocked / Waiting-on 超 3 天的任务，按 task 去重。
///
/// 命中 `idx_task_status_blocked_at` partial（`WHERE status IN
/// ('Blocked','Waiting-on')`）——谓词已压基数，复合索引
/// `(status, blocked_at)` 走 range scan。
///
/// 去重键：`(kind='blocked_3d', related_task_id)`。
pub fn run_blocked_3d(state: &AppState) -> Result<Vec<NotificationRow>> {
    let now = state.now_sql(); // UTC, '%Y-%m-%d %H:%M:%S'
    let conn = state.db()?;

    // 阈值用 SQL 算：`blocked_at < datetime('now', '-3 days')`。
    // 与 [AppState::now_sql] 是同一个 UTC 时刻,但 SQL 端用 `datetime('now')`
    // 走 SQLite 内置时钟——本票测试注入 clock 时,AppState 给的是 UTC 文本,
    // 直接用 `now` 文本绑参更稳(测试时钟可控)。
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.blocked_at, t.blocked_reason, t.owner_person_id, p.name, \
                CAST(julianday(?1) - julianday(t.blocked_at) AS INTEGER) AS days_blocked \
           FROM task t \
           JOIN person p ON p.id = t.owner_person_id \
          WHERE t.status IN ('Blocked','Waiting-on') \
            AND t.blocked_at IS NOT NULL \
            AND t.blocked_at < datetime(?1, '-3 days') \
          ORDER BY t.blocked_at ASC, t.id ASC",
    )?;
    let rows = stmt.query_map(params![&now], |row| {
        let task_id: i64 = row.get(0)?;
        Ok(Blocked3dCandidate {
            task_id,
            title: row.get(1)?,
            blocked_at: row.get(2)?,
            blocked_reason: row.get(3)?,
            owner_person_id: row.get(4)?,
            owner_name: row.get(5)?,
            days_blocked: row.get(6)?,
        })
    })?;

    let mut inserted = Vec::new();
    for row in rows {
        let cand = row?;
        let payload = NotificationPayload::Blocked3d {
            task_id: cand.task_id,
            title: cand.title,
            blocked_at: cand.blocked_at,
            days_blocked: cand.days_blocked,
            blocked_reason: cand.blocked_reason,
            owner_person_id: cand.owner_person_id,
            owner_name: cand.owner_name,
        };
        if let Some(notif) = dedup_insert(&conn, payload, &now)? {
            inserted.push(notif);
        }
    }
    Ok(inserted)
}

struct Blocked3dCandidate {
    task_id: i64,
    title: String,
    blocked_at: String,
    blocked_reason: String,
    owner_person_id: i64,
    owner_name: String,
    days_blocked: i64,
}

/// weekly_digest：周一 08:00（科长本地时区）发一次。
///
/// 触发条件（**全部**满足才发）：
/// 1. 今天是周一(本地日历)
/// 2. 当前墙钟小时 == 8(本地)
/// 3. 今天不是 holiday(种子 / override 都算)且不是默认周末
///
/// 去重键：`(kind='weekly_digest', triggered_at LIKE 'YYYY-MM-W%')`
/// ——同一周一条,周一任意 8:xx 触发都归到同一条。
///
/// `week_start` / `week_end` 是本周一/本周日(YYYY-MM-DD,本地日历)。
/// `overdue_count` 等计数是当前快照——前端可读 payload 直接展示,也
/// 可以无视计数自己重新拉今日/本周视图。
pub fn run_weekly_digest(state: &AppState) -> Result<Vec<NotificationRow>> {
    let today = state.today();
    let now_utc = state.now(); // UTC DateTime
    // UTC+8 固定偏移(中国自 1991 起不实行夏令时,与 IANA 等价)。
    // 用 `Timelike::hour()` 而不是 `format("%H").parse()`,省一次字符串
    // round-trip,也避免静默兜底到 0(unwrap_or(0) 会让"非 8 点"判定失误)。
    let local_hour = (now_utc + chrono::Duration::hours(8)).hour();

    // 条件 1：周一
    if today.weekday() != Weekday::Mon {
        return Ok(Vec::new());
    }
    // 条件 2：本地 8 点窗口
    if local_hour != 8 {
        return Ok(Vec::new());
    }
    // 条件 3：今天不是 holiday（默认 weekend 已被 weekday == Mon 排除）
    let calendar = state.calendar()?;
    if calendar.is_holiday(today) {
        return Ok(Vec::new());
    }

    let conn = state.db()?;
    let week_start = today; // 周一
    let week_end = today // 周一 + 6 = 周日
        .checked_add_days(Days::new(6))
        .ok_or_else(|| AppError::Internal("today+6 越界,日期不合理".into()))?;

    // 周报范围内已有 weekly_digest 记录?返回最早一条(读回给调用方),不
    // 再写新行——去重落库 + 不重复 emit。
    if let Some(existing) = find_weekly_digest_this_week(&conn, week_start)? {
        return Ok(vec![existing]);
    }

    // 4 个计数——独立 SQL,各自走对应 partial index。
    let overdue_count = count_overdue(&conn, today)?;
    let due_today_count = count_due_on(&conn, today)?;
    let due_tomorrow_count = count_due_on(
        &conn,
        week_start
            .checked_add_days(Days::new(1))
            .ok_or_else(|| AppError::Internal("today+1 越界".into()))?,
    )?;
    let blocked_count = count_blocked(&conn)?;

    let payload = NotificationPayload::WeeklyDigest {
        week_start: week_start.format("%Y-%m-%d").to_string(),
        week_end: week_end.format("%Y-%m-%d").to_string(),
        overdue_count,
        due_today_count,
        due_tomorrow_count,
        blocked_count,
    };

    let now = state.now_sql();
    let inserted = insert_weekly_digest(&conn, payload, &now)?;
    Ok(inserted.into_iter().collect())
}

fn count_overdue(conn: &Connection, today: NaiveDate) -> Result<i64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task \
          WHERE status IN ('Open','In-progress','Blocked','Waiting-on') \
            AND due_date IS NOT NULL AND due_date < ?1",
        params![today.format("%Y-%m-%d").to_string()],
        |row| row.get(0),
    )?;
    Ok(n)
}

fn count_due_on(conn: &Connection, day: NaiveDate) -> Result<i64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task \
          WHERE status IN ('Open','In-progress','Blocked','Waiting-on') \
            AND due_date IS NOT NULL AND due_date = ?1",
        params![day.format("%Y-%m-%d").to_string()],
        |row| row.get(0),
    )?;
    Ok(n)
}

fn count_blocked(conn: &Connection) -> Result<i64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task WHERE status IN ('Blocked','Waiting-on')",
        [],
        |row| row.get(0),
    )?;
    Ok(n)
}

/// 同周已有 weekly_digest 记录?——按 `triggered_at LIKE 'YYYY-MM-W%'`
/// 兜底；当前 ISO 周起点 = 本周一,字符串前缀 `YYYY-MM-DD`,能唯一定位。
fn find_weekly_digest_this_week(
    conn: &Connection,
    week_start: NaiveDate,
) -> Result<Option<NotificationRow>> {
    let prefix = format!("{}%", week_start.format("%Y-%m-%d"));
    let mut stmt = conn.prepare(
        "SELECT id, triggered_at, kind, related_task_id, related_template_id, payload, viewed_at \
           FROM notification_log \
          WHERE kind = 'weekly_digest' AND triggered_at LIKE ?1 \
          ORDER BY id ASC LIMIT 1",
    )?;
    let mut rows = stmt.query(params![prefix])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(row_to_notification(&row)?));
    }
    Ok(None)
}

/// 三规则统一入口——由调度器（materialize tick 共用触发器）调用。
///
/// 各自独立：任何一个抛错不影响其它的写入（partial success）。错误累
/// 积后调用方决定怎么走（建议 eprintln 不 panic,通知是后台能力）。
pub fn run_all(state: &AppState) -> Result<NotificationRunSummary> {
    let due_24h = run_due_24h(state)?;
    let blocked_3d = run_blocked_3d(state)?;
    let weekly_digest = run_weekly_digest(state)?;
    Ok(NotificationRunSummary {
        due_24h,
        blocked_3d,
        weekly_digest,
    })
}

/// 三规则各自的产出——调度器拿到后各自 emit OS 通知。
#[derive(Debug, Clone, Default)]
pub struct NotificationRunSummary {
    pub due_24h: Vec<NotificationRow>,
    pub blocked_3d: Vec<NotificationRow>,
    pub weekly_digest: Vec<NotificationRow>,
}

impl NotificationRunSummary {
    /// 本次所有新插入/读回的行——用于"本次有 N 条新通知"统计与 UI toast。
    pub fn total_inserted(&self) -> usize {
        self.due_24h.len() + self.blocked_3d.len() + self.weekly_digest.len()
    }

    /// 把所有行摊平成一个 Vec,给 emit OS 通知循环用。
    pub fn into_flat(self) -> Vec<NotificationRow> {
        let mut out = Vec::with_capacity(self.total_inserted());
        out.extend(self.due_24h);
        out.extend(self.blocked_3d);
        out.extend(self.weekly_digest);
        out
    }
}

// ---------------------------------------------------------------------------
// dedup_insert：单源去重入口
// ---------------------------------------------------------------------------

/// 写 `notification_log`,同 `(kind, related_task_id)` 已存在则跳过。
///
/// `related_task_id IS NULL` 的 kind（当前仅 `weekly_digest`）走另一条
/// 路径 [`dedup_insert_weekly_digest`],不去重 lookup。
///
/// `triggered_at` 由调用方通过 [`crate::clock::Clock`] 注入的 `now_sql()`
/// 显式写入,不走 SQLite 的 `datetime('now')`——后者是宿主 wall-clock,
/// 测试注入 [`FixedClock`] 时会与 `state.today()` 不一致,导致 weekly_digest
/// 的"同周"判定走偏。
fn dedup_insert(
    conn: &Connection,
    payload: NotificationPayload,
    triggered_at: &str,
) -> Result<Option<NotificationRow>> {
    let task_id = payload
        .related_task_id()
        .ok_or_else(|| AppError::Internal("dedup_insert 收到 weekly_digest payload".into()))?;
    let kind = payload.kind();

    let exists: Option<i64> = conn
        .query_row(
            "SELECT id FROM notification_log WHERE kind = ?1 AND related_task_id = ?2 LIMIT 1",
            params![kind.as_str(), task_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_some() {
        return Ok(None);
    }

    let payload_text = serde_json::to_string(&payload)
        .map_err(|err| AppError::internal(format!("序列化 payload 失败：{err}")))?;
    conn.execute(
        "INSERT INTO notification_log (triggered_at, kind, related_task_id, payload) VALUES (?1, ?2, ?3, ?4)",
        params![triggered_at, kind.as_str(), task_id, payload_text],
    )?;
    let id = conn.last_insert_rowid();
    fetch_notification(conn, id)?.map(Some).ok_or_else(|| {
        AppError::Internal(format!("刚插入的 notification_log id={id} 立即查不到"))
    })
}

/// weekly_digest 专用：单纯 INSERT,不查 dedup——周报的 dedup 由调用方
/// [`run_weekly_digest`] 通过 [`find_weekly_digest_this_week`] 完成,
/// 函数名此前是 `dedup_insert_weekly_digest` 但实际不 dedup,改名以诚。
///
/// 周报的去重键是 `triggered_at LIKE 'YYYY-MM-DD%'`,不挂 task;另开
/// 一条路径免得 [`dedup_insert`] 的"必填 related_task_id"语义膨胀。
/// `triggered_at` 从 app clock 取,不走 SQLite 默认——见 [`dedup_insert`]
/// 注释。
fn insert_weekly_digest(
    conn: &Connection,
    payload: NotificationPayload,
    triggered_at: &str,
) -> Result<Option<NotificationRow>> {
    debug_assert!(matches!(payload, NotificationPayload::WeeklyDigest { .. }));
    let kind = payload.kind();
    let payload_text = serde_json::to_string(&payload)
        .map_err(|err| AppError::internal(format!("序列化 payload 失败：{err}")))?;

    conn.execute(
        "INSERT INTO notification_log (triggered_at, kind, payload) VALUES (?1, ?2, ?3)",
        params![triggered_at, kind.as_str(), payload_text],
    )?;
    let id = conn.last_insert_rowid();
    fetch_notification(conn, id)?.map(Some).ok_or_else(|| {
        AppError::Internal(format!("刚插入的 notification_log id={id} 立即查不到"))
    })
}

// ---------------------------------------------------------------------------
// 读路径：未读面板 / 已读标记 / 单条查询
// ---------------------------------------------------------------------------

/// 未读通知列表——按触发时间倒序,前端 unread panel 一次拉全。
///
/// 命中 `idx_notification_log_viewed_at_unread` partial（`WHERE viewed_at
/// IS NULL`）。
pub fn list_unread(state: &AppState) -> Result<Vec<NotificationRow>> {
    let conn = state.db()?;
    let mut stmt = conn.prepare(
        "SELECT id, triggered_at, kind, related_task_id, related_template_id, payload, viewed_at \
           FROM notification_log \
          WHERE viewed_at IS NULL \
          ORDER BY triggered_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], row_to_notification)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

/// 历史通知列表（含已读）——UI「通知中心」历史视图。
///
/// 默认按触发时间倒序,limit 由命令层封顶。
pub fn list_all(state: &AppState, limit: usize) -> Result<Vec<NotificationRow>> {
    let conn = state.db()?;
    let mut stmt = conn.prepare(
        "SELECT id, triggered_at, kind, related_task_id, related_template_id, payload, viewed_at \
           FROM notification_log \
          ORDER BY triggered_at DESC, id DESC \
          LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], row_to_notification)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

/// 取一条通知——点 OS 通知跳任务时调用,前端用 `payload.task_id` 定位。
pub fn get(state: &AppState, id: i64) -> Result<Option<NotificationRow>> {
    let conn = state.db()?;
    fetch_notification(&conn, id)
}

/// 标记单条已读。
///
/// 已读时返回 `false`（幂等：避免重复更新 `updated_at` 这类副作用），
/// 这次写了返回 `true`。
pub fn mark_read(state: &AppState, id: i64) -> Result<bool> {
    let conn = state.db()?;
    let now = state.now_sql();
    let affected = conn.execute(
        "UPDATE notification_log SET viewed_at = ?1 WHERE id = ?2 AND viewed_at IS NULL",
        params![now, id],
    )?;
    Ok(affected > 0)
}

/// 标记全部未读已读。返回本次实际标记的条数。
pub fn mark_all_read(state: &AppState) -> Result<usize> {
    let conn = state.db()?;
    let now = state.now_sql();
    let affected = conn.execute(
        "UPDATE notification_log SET viewed_at = ?1 WHERE viewed_at IS NULL",
        params![now],
    )?;
    Ok(affected as usize)
}

fn fetch_notification(conn: &Connection, id: i64) -> Result<Option<NotificationRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, triggered_at, kind, related_task_id, related_template_id, payload, viewed_at \
           FROM notification_log WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(row_to_notification(&row)?));
    }
    Ok(None)
}

fn row_to_notification(row: &Row<'_>) -> rusqlite::Result<NotificationRow> {
    let payload_text: String = row.get(5)?;
    let payload: serde_json::Value = serde_json::from_str(&payload_text).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            Box::new(err),
        )
    })?;
    Ok(NotificationRow {
        id: row.get(0)?,
        triggered_at: row.get(1)?,
        kind: row.get(2)?,
        related_task_id: row.get(3)?,
        related_template_id: row.get(4)?,
        payload,
        viewed_at: row.get(6)?,
    })
}

// ---------------------------------------------------------------------------
// 单测：payload 序列化 / 周一 8 点判定 / 周一+holiday 跳过
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FixedClock;
    use crate::db;
    use crate::state;
    use std::sync::Arc;

    fn fresh_state(at: &str) -> AppState {
        let conn = db::open_in_memory().expect("内存库");
        let clock = Arc::new(FixedClock::at(at));
        state::new_app_state(conn, clock)
    }

    #[test]
    fn payload_kind_字面量与_db_列对齐() {
        // 三种 kind 的序列化字符串与 DB CHECK 一致。
        for (payload, expected) in [
            (
                NotificationPayload::Due24h {
                    task_id: 1,
                    title: "t".into(),
                    due_date: "2026-09-10".into(),
                    owner_person_id: 2,
                    owner_name: "张三".into(),
                },
                r#""due_24h""#,
            ),
            (
                NotificationPayload::Blocked3d {
                    task_id: 1,
                    title: "t".into(),
                    blocked_at: "2026-09-10 08:00:00".into(),
                    days_blocked: 3,
                    blocked_reason: "等外委".into(),
                    owner_person_id: 2,
                    owner_name: "张三".into(),
                },
                r#""blocked_3d""#,
            ),
            (
                NotificationPayload::WeeklyDigest {
                    week_start: "2026-09-07".into(),
                    week_end: "2026-09-13".into(),
                    overdue_count: 1,
                    due_today_count: 2,
                    due_tomorrow_count: 3,
                    blocked_count: 4,
                },
                r#""weekly_digest""#,
            ),
        ] {
            let kind = payload.kind();
            assert_eq!(kind.as_str(), expected.trim_matches('"'));
            // 序列化走 serde::Serialize,字面量由 #[serde(rename)] 钉死——
            // 测试入口只验 kind.as_str() 与 DB CHECK 字面量对齐就够。
        }
    }

    #[test]
    fn payload_due_24h_序列化_含必填字段() {
        let payload = NotificationPayload::Due24h {
            task_id: 42,
            title: "外委合同评审".into(),
            due_date: "2026-09-15".into(),
            owner_person_id: 7,
            owner_name: "张三".into(),
        };
        let json = serde_json::to_value(&payload).expect("序列化");
        assert_eq!(json["kind"], "due_24h");
        assert_eq!(json["task_id"], 42);
        assert_eq!(json["title"], "外委合同评审");
        assert_eq!(json["due_date"], "2026-09-15");
        assert_eq!(json["owner_person_id"], 7);
        assert_eq!(json["owner_name"], "张三");
    }

    #[test]
    fn payload_blocked_3d_序列化_含_blocked_at_days_blocked_blocked_reason() {
        let payload = NotificationPayload::Blocked3d {
            task_id: 42,
            title: "外委合同评审".into(),
            blocked_at: "2026-09-10 08:00:00".into(),
            days_blocked: 3,
            blocked_reason: "等外委回函".into(),
            owner_person_id: 7,
            owner_name: "张三".into(),
        };
        let json = serde_json::to_value(&payload).expect("序列化");
        assert_eq!(json["kind"], "blocked_3d");
        // ADR 0001 §3.6 约束:必须含 blocked_at / days_blocked / blocked_reason
        assert_eq!(json["blocked_at"], "2026-09-10 08:00:00");
        assert_eq!(json["days_blocked"], 3);
        assert_eq!(json["blocked_reason"], "等外委回函");
        assert_eq!(json["task_id"], 42);
        assert_eq!(json["title"], "外委合同评审");
    }

    #[test]
    fn payload_weekly_digest_序列化_含_4_个_计数_和_周界() {
        let payload = NotificationPayload::WeeklyDigest {
            week_start: "2026-09-07".into(),
            week_end: "2026-09-13".into(),
            overdue_count: 1,
            due_today_count: 2,
            due_tomorrow_count: 3,
            blocked_count: 4,
        };
        let json = serde_json::to_value(&payload).expect("序列化");
        assert_eq!(json["kind"], "weekly_digest");
        assert_eq!(json["week_start"], "2026-09-07");
        assert_eq!(json["week_end"], "2026-09-13");
        assert_eq!(json["overdue_count"], 1);
        assert_eq!(json["due_today_count"], 2);
        assert_eq!(json["due_tomorrow_count"], 3);
        assert_eq!(json["blocked_count"], 4);
    }

    #[test]
    fn payload_kind_tag_反序列化_必须带_kind_字段() {
        // #[serde(tag = "kind")] 的语义:JSON 顶层必须有 "kind",否则反序列化失败。
        let bad = r#"{"task_id": 1, "title": "t"}"#;
        let err = serde_json::from_str::<NotificationPayload>(bad)
            .expect_err("缺 kind 字段应被拒");
        assert!(err.to_string().contains("kind"));
    }

    #[test]
    fn render_message_三种_payload_返回中文_标题_与_正文() {
        let (title, body) = NotificationPayload::Due24h {
            task_id: 1,
            title: "外委合同评审".into(),
            due_date: "2026-09-15".into(),
            owner_person_id: 2,
            owner_name: "张三".into(),
        }
        .render_message();
        assert_eq!(title, "任务即将到期");
        assert!(body.contains("张三"));
        assert!(body.contains("外委合同评审"));
        assert!(body.contains("2026-09-15"));

        let (title, body) = NotificationPayload::Blocked3d {
            task_id: 1,
            title: "外委合同评审".into(),
            blocked_at: "2026-09-10 08:00:00".into(),
            days_blocked: 3,
            blocked_reason: "等外委回函".into(),
            owner_person_id: 2,
            owner_name: "张三".into(),
        }
        .render_message();
        assert!(title.contains("3 天"));
        assert!(body.contains("等外委回函"));

        let (title, body) = NotificationPayload::WeeklyDigest {
            week_start: "2026-09-07".into(),
            week_end: "2026-09-13".into(),
            overdue_count: 1,
            due_today_count: 2,
            due_tomorrow_count: 3,
            blocked_count: 4,
        }
        .render_message();
        assert!(title.contains("2026-09-07"));
        assert!(title.contains("2026-09-13"));
        assert!(body.contains("已逾期 1"));
        assert!(body.contains("今日到期 2"));
    }

    // ---- 周报触发窗口 ----

    #[test]
    fn weekly_digest_非周一不触发() {
        let state = fresh_state("2026-09-08 08:00:00"); // Tue 08:00
        // 周二 / 周三 ... 任意小时都返空
        let result = run_weekly_digest(&state).expect("运行");
        assert!(result.is_empty());
    }

    #[test]
    fn weekly_digest_周一但_非_8_点_不触发() {
        let state = fresh_state("2026-09-07 07:59:00"); // Mon 07:59 UTC = 15:59 local
        assert!(run_weekly_digest(&state).expect("运行").is_empty());

        let state = fresh_state("2026-09-07 09:00:00"); // Mon 09:00 UTC = 17:00 local
        assert!(run_weekly_digest(&state).expect("运行").is_empty());
    }

    #[test]
    fn weekly_digest_周一_8_点_且非_holiday_触发一次() {
        // 2026-09-07 是周一。
        let state = fresh_state("2026-09-07 00:00:00"); // Mon 00:00 UTC = 08:00 local
        let result = run_weekly_digest(&state).expect("运行");
        assert_eq!(result.len(), 1);
        let notif = &result[0];
        assert_eq!(notif.kind, "weekly_digest");
        // payload 是 JSON Value,从中取字段验证。
        assert_eq!(notif.payload["week_start"], "2026-09-07");
        assert_eq!(notif.payload["week_end"], "2026-09-13");
    }

    #[test]
    fn weekly_digest_周一_8_点_且今天_是_override_holiday_不触发() {
        let state = fresh_state("2026-09-07 00:00:00");
        // 把 2026-09-07 标记为 holiday override,然后释放所有锁——
        // inner scope 让 `conn` 和 `cal` 在调用 run_weekly_digest 之前
        // 就 drop,否则 mutex 在同一线程上 self-deadlock(MutexGuard 的
        // 生命期是 let 所在的 block,直到 `}` 才释放)。
        {
            let conn = state.db().expect("锁");
            conn.execute(
                "INSERT INTO holiday_override (date, kind) VALUES ('2026-09-07','holiday')",
                [],
            )
            .expect("override");
            let mut cal = state.calendar().expect("日历锁");
            crate::holiday::reload_overrides_from_db(&conn, &mut cal).expect("reload");
        }

        let result = run_weekly_digest(&state).expect("运行");
        assert!(result.is_empty(), "周一若是 holiday 应跳过");
    }
}