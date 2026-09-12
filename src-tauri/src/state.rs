//! 注入给 `tauri::State` 的应用状态：一个 SQLite 连接 + 一个时钟 +
//! 一张合并后的节假日日历视图。

use crate::clock::Clock;
use crate::error::{AppError, Result};
use crate::holiday::HolidayCalendar;
use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::Connection;
use std::sync::{Arc, Mutex, MutexGuard};

/// 单写者本地 app：一个连接串起所有命令，用 `Mutex` 串行化即可。
///
/// `calendar` 启动时从打包 `holidays/cn-<year>.json` + SQLite 的
/// `holiday_override` 合并加载,运行时随 override 写更新——物化层和日历
/// 视图通过 [`AppState::holiday_calendar`] 取只读视图。
///
/// 整体包在 `Arc` 里是为了把 clone 出去给后台 tick 用
/// （[`crate::spawn_materialize_tick`]）—每个字段单独 `Arc` 也可以,
/// 但 `Arc<AppState>` 的写法更直接,测试侧也更容易共享同一份状态。
pub struct AppStateInner {
    pub db: Mutex<Connection>,
    pub clock: Arc<dyn Clock>,
    pub calendar: Mutex<HolidayCalendar>,
    /// 托盘可达性（ticket #29）。`Mutex` 是为了让安装失败时能从另一条线
    /// 程立刻翻成 `Unavailable { reason }`,前端 banner 跟着更新——单写者
    /// 场景下用 Mutex 而不是 `RwLock`,没必要承担读锁开销。
    pub tray_status: Mutex<TrayStatus>,
}

/// 托盘可达性。
///
/// 启动时走 `Available`（托盘图标建起来了）或 `Unavailable { reason }`
/// （建失败,前端据此展示 banner）。`reason` 是面向科长的中文,与
/// `AppError::message()` 同口径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayStatus {
    /// 托盘图标已建好,菜单可用。
    Available,
    /// 托盘不可用——`reason` 是给科长看的中文短句。
    Unavailable { reason: String },
}

impl Default for TrayStatus {
    fn default() -> Self {
        // 默认不可用:启动 hook 还没跑过。如果应用跑着跑着托盘挂了,后续
        // 也可以再 set 一次,前端再开 banner。
        Self::Unavailable {
            reason: "托盘尚未初始化".into(),
        }
    }
}

/// `AppState = Arc<AppStateInner>`：所有借出走 `state.inner()` 解 Arc;
/// 后台 tick 直接 clone 整个 `Arc`,与主进程共享同一份 db / calendar。
pub type AppState = Arc<AppStateInner>;

/// 构造一个新的 `AppState` (内部 = `Arc<AppStateInner>`)。
pub fn new_app_state(conn: Connection, clock: Arc<dyn Clock>) -> AppState {
    Arc::new(AppStateInner {
        db: Mutex::new(conn),
        clock,
        calendar: Mutex::new(HolidayCalendar::default()),
        tray_status: Mutex::new(TrayStatus::default()),
    })
}

impl AppStateInner {
    /// 装入合并后的节假日日历。`setup` 钩子里调一次；之后 override 写命
    /// 令走 [`crate::holiday::reload_overrides_from_db`] 在原对象上原地
    /// 刷新,不必再走这条。
    pub fn install_calendar(&self, calendar: HolidayCalendar) {
        *self
            .calendar
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = calendar;
    }

    /// 借出连接。锁被污染说明上一个持有者 panic 在事务中间，此时宁可报错也不要接着写。
    pub fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| AppError::Internal("数据库连接锁已被污染".into()))
    }

    /// 借出节假日日历的独占锁（`MutexGuard`）。覆盖写命令原地更新,
    /// 读命令拿到 guard 后即持锁——单写者本机场景下不存在并发读,
    /// 不需要 clone Arc。
    pub fn calendar(&self) -> Result<MutexGuard<'_, HolidayCalendar>> {
        self.calendar
            .lock()
            .map_err(|_| AppError::Internal("节假日日历锁已被污染".into()))
    }

    pub fn now(&self) -> DateTime<Utc> {
        self.clock.now()
    }

    /// 可直接入库的「现在」。
    pub fn now_sql(&self) -> String {
        self.clock.now_sql()
    }

    /// 科长本地的「今天」。截止日这类**日历日**语义一律从这里取，
    /// 不要自己拿 [`AppState::now`] 做时区换算。
    pub fn today(&self) -> NaiveDate {
        self.clock.today()
    }

    /// 当前托盘可达性快照。前端 banner 与测试都从这里取。
    pub fn tray_status(&self) -> TrayStatus {
        self.tray_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// 设置托盘可达性。安装成功时传 `Available`,失败时传
    /// `Unavailable { reason }`——`reason` 是面向科长的中文短句。
    pub fn set_tray_status(&self, status: TrayStatus) {
        *self
            .tray_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = status;
    }
}

/// 旧 `AppState::with_system_clock` 的兼容入口——保留是因为 [`crate::testing`]
/// 的文件库 fixture 直接拿它构造而不绕道 `new_app_state`,删除会
/// 让那条调用变成更长。**新增代码请用 [`new_app_state`]。**
pub mod compat {
    use super::*;
    use crate::clock::SystemClock;

    /// 与旧 `AppState::with_system_clock(conn)` 等价。
    pub fn with_system_clock(conn: Connection) -> AppState {
        new_app_state(conn, Arc::new(SystemClock))
    }
}