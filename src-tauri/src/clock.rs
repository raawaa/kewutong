//! 可注入的时钟。
//!
//! 「到期前 24h」「阻塞 > 3 天」「跨周物化」这三类逻辑要能确定性测试，业务代码就
//! 不能直接读宿主时间。全 app 只通过 [`Clock`] 取「现在」，测试注入 [`FixedClock`]
//! 把它钉在任意时刻。

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, TimeDelta, Utc};
use std::sync::Mutex;

/// ADR 0001：时间戳一律以 UTC 文本入库。
pub const SQL_TIMESTAMP_FORMAT: &str = "%Y-%m-%d %H:%M:%S";

/// 纯日期列（`task.due_date` 等）的入库格式。
pub const SQL_DATE_FORMAT: &str = "%Y-%m-%d";

/// 科长所在时区相对 UTC 的偏移秒数。
///
/// v1 是国内单座位应用（spec #15 §Out of Scope「多座位」），ADR 0001 §3.4 的
/// `iana_zone` 也默认 `'Asia/Shanghai'`。中国自 1991 年起不再实行夏令时，固定
/// 偏移与 IANA 规则等价，因此不引 `chrono-tz`。
///
/// 这个常量只服务「本地日历日」——「今天 / 明天 / 一周后」这类**日期**语义。
/// 时间戳仍一律 UTC 入库，不受影响。
const LOCAL_UTC_OFFSET_SECONDS: i32 = 8 * 3600;

/// 科长本地时区。
fn local_offset() -> FixedOffset {
    FixedOffset::east_opt(LOCAL_UTC_OFFSET_SECONDS)
        .expect("UTC+8 是合法偏移")
}

/// 按入库格式渲染一个 UTC 时刻。
pub fn to_sql_timestamp(at: DateTime<Utc>) -> String {
    at.format(SQL_TIMESTAMP_FORMAT).to_string()
}

/// 解析入库格式的 UTC 时间戳。
pub fn parse_sql_timestamp(text: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(text, SQL_TIMESTAMP_FORMAT)
        .ok()
        .map(|naive| naive.and_utc())
}

/// 按入库格式渲染一个日历日。
pub fn to_sql_date(date: NaiveDate) -> String {
    date.format(SQL_DATE_FORMAT).to_string()
}

/// 解析入库格式的日历日。非 `YYYY-MM-DD` 一律返回 `None`，不做宽松兜底——
/// 静默接受 `2026/10/01` 只会让脏数据进库。
pub fn parse_sql_date(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text, SQL_DATE_FORMAT).ok()
}

/// 「现在」的唯一来源。
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> DateTime<Utc>;

    /// 直接给出可入库的时间戳文本。
    fn now_sql(&self) -> String {
        to_sql_timestamp(self.now())
    }

    /// 科长本地的「今天」。
    ///
    /// 截止日是**日历日**而不是时刻：本地晚上 8 点录的任务，「今天」得是
    /// 本地的今天，不能因为 UTC 已经翻篇就跳到明天。日期语义一律从这里取，
    /// 不要在业务代码里自己对 [`Clock::now`] 做时区换算。
    fn today(&self) -> NaiveDate {
        self.now().with_timezone(&local_offset()).date_naive()
    }
}

/// 生产环境用的真实时钟。
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// 测试用时钟：把「现在」钉死，也可以随时拨动。
#[derive(Debug)]
pub struct FixedClock {
    at: Mutex<DateTime<Utc>>,
}

impl FixedClock {
    pub fn new(at: DateTime<Utc>) -> Self {
        Self { at: Mutex::new(at) }
    }

    /// 从入库格式的 UTC 文本建钟，如 `"2026-09-10 08:00:00"`。
    ///
    /// # Panics
    /// 文本格式不合法时 panic——这是测试助手，写错就该当场炸。
    pub fn at(text: &str) -> Self {
        Self::new(
            parse_sql_timestamp(text).unwrap_or_else(|| {
                panic!("时间戳格式应为 `{SQL_TIMESTAMP_FORMAT}`，收到 {text:?}")
            }),
        )
    }

    pub fn set(&self, at: DateTime<Utc>) {
        *self.lock() = at;
    }

    /// 见 [`FixedClock::at`]。
    ///
    /// # Panics
    /// 文本格式不合法时 panic。
    pub fn set_at(&self, text: &str) {
        let at = parse_sql_timestamp(text)
            .unwrap_or_else(|| panic!("时间戳格式应为 `{SQL_TIMESTAMP_FORMAT}`，收到 {text:?}"));
        self.set(at);
    }

    /// 往前（或往后，传负数）拨动时钟。
    pub fn advance(&self, delta: TimeDelta) {
        let mut at = self.lock();
        *at += delta;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, DateTime<Utc>> {
        // 测试助手：即便某个断言 panic 污染了锁，也让后续测试读得到值
        self.at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        *self.lock()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 固定时钟把现在钉在给定时刻() {
        let clock = FixedClock::at("2026-09-10 08:00:00");

        assert_eq!(clock.now_sql(), "2026-09-10 08:00:00");
    }

    #[test]
    fn 时钟可以被拨到任意时刻() {
        let clock = FixedClock::at("2026-09-10 08:00:00");

        clock.advance(TimeDelta::days(3) + TimeDelta::hours(1));
        assert_eq!(clock.now_sql(), "2026-09-13 09:00:00");

        clock.set_at("2027-01-01 00:00:00");
        assert_eq!(clock.now_sql(), "2027-01-01 00:00:00");
    }

    #[test]
    fn 入库格式可以往返() {
        let text = "2026-10-01 15:04:05";

        let parsed = parse_sql_timestamp(text).expect("应当能解析");

        assert_eq!(to_sql_timestamp(parsed), text);
    }

    #[test]
    fn 格式不对的时间戳解析失败而不是静默兜底() {
        assert!(parse_sql_timestamp("2026-10-01T15:04:05Z").is_none());
        assert!(parse_sql_timestamp("").is_none());
    }

    #[test]
    fn 今天按科长本地时区算而不是按_utc() {
        // UTC 20:00 在科长本地（UTC+8）已经是次日 04:00——「今天」该跟着本地走。
        let clock = FixedClock::at("2026-09-10 20:00:00");

        assert_eq!(to_sql_date(clock.today()), "2026-09-11");
    }

    #[test]
    fn 今天在本地日内不随_utc_时刻漂移() {
        // 本地 08:00（UTC 前一日 00:00）与本地 23:59 都还是同一个本地日。
        for (utc, expected) in [
            ("2026-09-10 00:00:00", "2026-09-10"), // 本地 08:00
            ("2026-09-10 15:59:59", "2026-09-10"), // 本地 23:59:59
            ("2026-09-10 16:00:00", "2026-09-11"), // 本地次日 00:00
        ] {
            let clock = FixedClock::at(utc);
            assert_eq!(to_sql_date(clock.today()), expected, "utc={utc}");
        }
    }

    #[test]
    fn 入库日期格式可以往返() {
        let date = parse_sql_date("2026-10-01").expect("应当能解析");

        assert_eq!(to_sql_date(date), "2026-10-01");
    }

    #[test]
    fn 格式不对的日期解析失败而不是静默兜底() {
        assert!(parse_sql_date("2026/10/01").is_none());
        assert!(parse_sql_date("2026-10-01 00:00:00").is_none());
        assert!(parse_sql_date("2026-13-01").is_none());
        assert!(parse_sql_date("").is_none());
    }
}
