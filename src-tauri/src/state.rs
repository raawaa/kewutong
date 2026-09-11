//! 注入给 `tauri::State` 的应用状态：一个 SQLite 连接 + 一个时钟。

use crate::clock::{Clock, SystemClock};
use crate::error::{AppError, Result};
use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::Connection;
use std::sync::{Arc, Mutex, MutexGuard};

/// 单写者本地 app：一个连接串起所有命令，用 `Mutex` 串行化即可。
pub struct AppState {
    db: Mutex<Connection>,
    clock: Arc<dyn Clock>,
}

impl AppState {
    pub fn new(db: Connection, clock: Arc<dyn Clock>) -> Self {
        Self {
            db: Mutex::new(db),
            clock,
        }
    }

    /// 生产环境入口：真实时钟。
    pub fn with_system_clock(db: Connection) -> Self {
        Self::new(db, Arc::new(SystemClock))
    }

    /// 借出连接。锁被污染说明上一个持有者 panic 在事务中间，此时宁可报错也不要接着写。
    pub fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| AppError::Internal("数据库连接锁已被污染".into()))
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
