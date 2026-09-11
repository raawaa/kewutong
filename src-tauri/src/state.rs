//! 注入给 `tauri::State` 的应用状态：一个 SQLite 连接 + 一个时钟 +
//! 一张合并后的节假日日历视图。

use crate::clock::{Clock, SystemClock};
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
pub struct AppState {
    db: Mutex<Connection>,
    clock: Arc<dyn Clock>,
    calendar: Mutex<HolidayCalendar>,
}

impl AppState {
    pub fn new(db: Connection, clock: Arc<dyn Clock>) -> Self {
        Self {
            db: Mutex::new(db),
            clock,
            calendar: Mutex::new(HolidayCalendar::default()),
        }
    }

    /// 装入合并后的节假日日历。`setup` 钩子里调一次；之后 override 写命
    /// 令走 [`crate::holiday::reload_overrides_from_db`] 在原对象上原地
    /// 刷新,不必再走这条。
    pub fn install_calendar(&self, calendar: HolidayCalendar) {
        *self
            .calendar
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = calendar;
    }

    /// 生产环境入口：真实时钟 + 空日历（`setup` 钩子里再装）。
    pub fn with_system_clock(db: Connection) -> Self {
        Self::new(db, Arc::new(SystemClock))
    }

    /// 借出连接。锁被污染说明上一个持有者 panic 在事务中间，此时宁可报错也不要接着写。
    pub fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| AppError::Internal("数据库连接锁已被污染".into()))
    }

    /// 借出节假日日历的可变引用。覆盖写后命令原地更新,读命令 clone 出 Arc。
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
}