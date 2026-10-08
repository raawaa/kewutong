/**
 * 物化引擎 + 命令层（tickets #25 / #48）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/materialization.rs` + `src-tauri/src/commands/materialization.rs` 的语义：
 *
 * 1. **纯函数侧**：`expandRule` 把 `StructuredRule` + 日期范围展开为一系列
 *    墙钟日；`wallClockToUtcSql` 把墙钟日转成 UTC `scheduled_at` 文本；
 *    `applyHolidayBehavior` 把墙钟日按节假日行为（SKIP / SHIFT）拆成具
 *    体动作。三者**不碰 SQLite**，单元测试可以无 DB 跑死。
 *
 * 2. **DB 写入侧**：`materializeTemplate` 拿一条模板 + 当前内存日历视图，
 *    把展开结果落成 `task` 行；幂等性靠 V005 的唯一索引
 *    `(recurring_template_id, scheduled_at) WHERE recurring_template_id
 *    IS NOT NULL` 保证。
 *
 * 3. **跨周触发侧**：`shouldMaterializeThisTick` 读 `materialization_meta`
 *    决定本次 tick 是不是进入了新的 ISO 周——只在新的一周里跑一次，避免
 *    每次 focus 都扫全表。
 *
 * 时区策略承接 ADR 0001 §3.4：规则存墙钟 + 时区，实例物化时转 UTC。v1
 * 固定 `Asia/Shanghai`（中国自 1991 年起不实行夏令时，固定偏移 + 8h 与
 * IANA 规则等价），不引 `chrono-tz`。
 */

import type Database from "better-sqlite3";

import { AppError } from "../error.js";
import { parseSqlDate, toSqlTimestamp } from "../clock.js";
import type {
  RecurringEnds,
  RecurringFreq,
  RecurringHolidayBehavior,
  StructuredRule,
} from "../types.js";
import { HolidayCalendar } from "../holiday/index.js";
import type { AppState } from "../state.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 物化窗口 = 12 周（ADR 0002 §物化策略）。一次触发生成的实例覆盖未来
 *  84 天；超出 84 天的查询不算「出错」，只是「未物化」。 */
export const MATERIALIZATION_WINDOW_WEEKS = 12;

/** 物化窗口的天数，`12 * 7 = 84`。 */
export const MATERIALIZATION_WINDOW_DAYS = MATERIALIZATION_WINDOW_WEEKS * 7;

/** `iana_zone = 'Asia/Shanghai'` 相对 UTC 的固定偏移秒数。v1 不引
 *  `chrono-tz`——中国自 1991 年起不实行夏令时，固定偏移与 IANA 规则等价。 */
export const SHANGHAI_OFFSET_SECONDS = 8 * 3600;

/** `materialization_meta` 单行表的主键写死 `'singleton'`。 */
export const META_SINGLETON_ID = "singleton";

/** SHIFT 顺延搜索的最大跨度——超过这个值视为「找不到」，原实例照常
 *  `Cancelled`、不建新实例。定 30 天（覆盖最长春节 7 天 + 双倍 buffer）：
 *  中国假期不会更长，30 天是绝无仅有的安全网。 */
const SHIFT_MAX_LOOKAHEAD_DAYS = 30;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 物化层用的模板轻量结构——只装规则 + 必要 FK，不装全部 `RecurringTemplate`。
 *  由 [`loadEnabledTemplates`] 读出。 */
export interface TemplateMaterializeInput {
  id: number;
  name: string;
  rule: StructuredRule;
  ownerPersonId: number;
  projectId: number | null;
  subTeamId: number | null;
}

/** 物化层对一条候选日的三种处置。
 *
 *  - `keep`：正常生成 instance。
 *  - `skip`：节假日 / 默认周末 → 不生成；UI 看不到这一条（SKIP 默认行
 *    为）。SKIP 路径**不**写 Cancelled 记录——「没安排」与「节假日跳过」
 *    在视图上是无差别的空位。
 *  - `shift`：节假日 → 原日 `Cancelled`（UI 标签「已跳过」，留改期溯源
 *    空白位）+ 下一个非节假日工作日 `Open`（`rescheduledFromId` 指向
 *    原 instance）。**调休工作日（种子 workday / override workday）算
 *    工作日**，SHIFT 路径可以顺延到它上面。 */
export type MaterializedEvent =
  | { kind: "keep"; date: NaiveDate }
  | { kind: "skip"; date: NaiveDate }
  | { kind: "shift"; original: NaiveDate; target: NaiveDate };

/** 这一条最终要在 `task` 表上「实际创建 instance」的日期。
 *  `skip` 路径返回 `null`（不创建）；`shift` 路径返回 target（原日
 *  单独作为 Cancelled 写入，见 [`materializeTemplate`]）。 */
export function keptDateOf(event: MaterializedEvent): NaiveDate | null {
  if (event.kind === "keep") return event.date;
  if (event.kind === "shift") return event.target;
  return null;
}

/** 单条模板的物化结果。`kept` / `skipped` / `shifted` 是该模板本轮产
 *  生的 instance 数；`cancelled` 是 SHIFT 路径下「原日 Cancelled」记录
 *  数（每条 Shift 占 1 条 cancelled + 1 条 kept）。 */
export interface MaterializeCounts {
  kept: number;
  skipped: number;
  shifted: number;
  cancelled: number;
}

export function emptyMaterializeCounts(): MaterializeCounts {
  return { kept: 0, skipped: 0, shifted: 0, cancelled: 0 };
}

/** 一次全量物化（`materializeAll`）的合计。 */
export interface MaterializeTotals {
  templates: number;
  kept: number;
  skipped: number;
  shifted: number;
  cancelled: number;
}

export function emptyMaterializeTotals(): MaterializeTotals {
  return { templates: 0, kept: 0, skipped: 0, shifted: 0, cancelled: 0 };
}

/** `materializeIfNewWeek` 的返回 DTO。前端据此决定是否提示「刚刚生
 *  成了 N 个 instance」——`materialized = false` 时不弹提示。 */
export interface MaterializeIfNewWeekResult {
  materialized: boolean;
  totals: MaterializeTotals;
}

/** 当前 (ISO year, ISO week) 元组。SQLite 的 `strftime('%W', date)` 取
 *  的是「周一开始的周序号」（00..53），与 ISO 8601 一致——但年份字段
 *  `strftime('%Y', date)` 仍是日历年；v1 简化处理：用日历年 + 周序号
 *  而不是 ISO 整年（后者在 1 月初的几天可能跨年）。
 *
 *  算法：「Thursday of this week」技巧——所在周的周四落在哪一年/哪一
 *  周，这一周就算那一年的 week N。 */
export interface IsoWeek {
  year: number;
  week: number;
}

// ---------------------------------------------------------------------------
// 日期工具：NaiveDate ↔ JS Date（UTC 分量即墙钟分量）
// ---------------------------------------------------------------------------

/** 纯日期（无时区、无时间）。year/month/day 全是整数；month 1-12。 */
export interface NaiveDate {
  year: number;
  month: number;
  day: number;
}

const MS_PER_DAY = 24 * 3600 * 1000;

/** 把 `YYYY-MM-DD` 解析为 `NaiveDate`。非此格式返回 `null`。 */
export function fromIsoString(text: string): NaiveDate | null {
  const parsed = parseSqlDate(text);
  if (parsed === null) return null;
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate(),
  };
}

/** 把 `NaiveDate` 渲染成 `YYYY-MM-DD`。 */
export function toIsoString(d: NaiveDate): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/** 把 `NaiveDate` 转成 JS `Date`（UTC 00:00:00）。 */
export function naiveDateToDate(d: NaiveDate): Date {
  return new Date(Date.UTC(d.year, d.month - 1, d.day));
}

/** 把 JS `Date`（任意时刻）的 UTC 分量取出来当 `NaiveDate`。 */
export function dateToNaiveDate(date: Date): NaiveDate {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** `NaiveDate` + `n` 天，超出合法范围时返回 `null`。 */
export function addDays(d: NaiveDate, n: number): NaiveDate | null {
  const ms = naiveDateToDate(d).getTime() + n * MS_PER_DAY;
  if (!Number.isFinite(ms)) return null;
  const next = new Date(ms);
  if (Number.isNaN(next.getTime())) return null;
  return dateToNaiveDate(next);
}

/** `NaiveDate` + `n` 天，越界时抛 `AppError.internal`。 */
function addDaysOrThrow(d: NaiveDate, n: number, errMessage: string): NaiveDate {
  const next = addDays(d, n);
  if (next === null) throw AppError.internal(errMessage);
  return next;
}

/** 比较两个 `NaiveDate`：返回 -1 / 0 / 1。 */
export function compareDates(a: NaiveDate, b: NaiveDate): number {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1;
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// 纯函数：rule 展开
// ---------------------------------------------------------------------------

/**
 * 展开 [`StructuredRule`] 在 `[rangeStart, rangeEnd]` 闭区间内**所有**
 * 命中该规则的墙钟日（含起点与终点）。命中规则时**不**做节假日裁剪
 * ——节假日行为由 [`applyHolidayBehavior`] 单独处理。
 *
 * `alreadyEmitted` 仅对 `EndsSpec::After { n }` 有意义——表示模板
 * 此前已物化出的非 Cancelled instance 数，本窗口只补到 N 为止。计数
 * 由 [`materializeTemplate`] 在事务前 SELECT 出来，确保跨窗口累计
 * 符合「到点即停」语义。`EndsSpec::On { date }` 忽略此参数。
 */
export function expandRule(
  rule: StructuredRule,
  rangeStart: NaiveDate,
  rangeEnd: NaiveDate,
  alreadyEmitted: number,
): NaiveDate[] {
  if (compareDates(rangeStart, rangeEnd) > 0) return [];
  const candidates: NaiveDate[] = (() => {
    switch (rule.freq) {
      case "daily":
        return expandDaily(rangeStart, rangeEnd);
      case "weekly":
        return expandWeekly(rule, rangeStart, rangeEnd);
      case "monthly":
        return expandMonthly(rule, rangeStart, rangeEnd);
      case "yearly":
        return expandYearly(rule, rangeStart, rangeEnd);
    }
  })();
  return applyEnds(candidates, rule.ends, alreadyEmitted);
}

function expandDaily(start: NaiveDate, end: NaiveDate): NaiveDate[] {
  const out: NaiveDate[] = [];
  let current: NaiveDate | null = start;
  while (current !== null && compareDates(current, end) <= 0) {
    out.push(current);
    current = addDays(current, 1);
  }
  return out;
}

function expandWeekly(
  rule: StructuredRule,
  start: NaiveDate,
  end: NaiveDate,
): NaiveDate[] {
  const mask = rule.bydayMask;
  if (mask === 0) {
    throw AppError.internal("expandWeekly 收到 mask=0；校验层应收掉");
  }
  const out: NaiveDate[] = [];
  let current: NaiveDate | null = start;
  while (current !== null && compareDates(current, end) <= 0) {
    if ((mask & weekdayBit(weekdayOf(current))) !== 0) {
      out.push(current);
    }
    current = addDays(current, 1);
  }
  return out;
}

function expandMonthly(
  rule: StructuredRule,
  start: NaiveDate,
  end: NaiveDate,
): NaiveDate[] {
  const days = rule.bymonthday;
  if (days === null) {
    throw AppError.internal("expandMonthly 缺 bymonthday；校验层应收掉");
  }
  if (days.length === 0) {
    throw AppError.internal("expandMonthly bymonthday 空；校验层应收掉");
  }
  const out: NaiveDate[] = [];
  let year = start.year;
  let month = start.month;
  // 防御性上限：end.year + 1 后强制 break（避免畸形输入死循环）。
  for (;;) {
    const lastOfMonth = lastDayOfMonth(year, month);
    for (const d of days) {
      const day = d === 0 ? lastOfMonth : d;
      if (day > lastOfMonth) continue;
      const candidate: NaiveDate = { year, month, day };
      if (
        compareDates(candidate, start) >= 0 &&
        compareDates(candidate, end) <= 0
      ) {
        out.push(candidate);
      }
    }
    // 推进到下一月。
    if (month === 12) {
      year += 1;
      month = 1;
    } else {
      month += 1;
    }
    const firstOfNext: NaiveDate = { year, month, day: 1 };
    if (compareDates(firstOfNext, end) > 0) break;
    if (year > end.year + 1) break;
  }
  out.sort((a, b) => compareDates(a, b));
  return out;
}

function expandYearly(
  rule: StructuredRule,
  start: NaiveDate,
  end: NaiveDate,
): NaiveDate[] {
  const months = rule.bymonth;
  if (months === null) {
    throw AppError.internal("expandYearly 缺 bymonth；校验层应收掉");
  }
  if (months.length === 0) {
    throw AppError.internal("expandYearly bymonth 空；校验层应收掉");
  }
  const days = rule.bymonthday;
  const out: NaiveDate[] = [];
  for (let year = start.year; year <= end.year; year += 1) {
    for (const month of months) {
      const monthU = month;
      const lastOfMonth = lastDayOfMonth(year, monthU);
      if (days !== null) {
        for (const d of days) {
          if (d > lastOfMonth) continue;
          const candidate: NaiveDate = { year, month: monthU, day: d };
          if (
            compareDates(candidate, start) >= 0 &&
            compareDates(candidate, end) <= 0
          ) {
            out.push(candidate);
          }
        }
      } else {
        // YEARLY 不给 bymonthday 时：默认每月 1 号（RFC 5545 行为）。
        const candidate: NaiveDate = { year, month: monthU, day: 1 };
        if (
          compareDates(candidate, start) >= 0 &&
          compareDates(candidate, end) <= 0
        ) {
          out.push(candidate);
        }
      }
    }
  }
  out.sort((a, b) => compareDates(a, b));
  return out;
}

/**
 * 按 `EndsSpec` 截断候选日期。
 *
 * - `On { date }`：所有 `> date` 的丢弃。`date` 解析走 `parseFromString` —
 *   V004 的 DB CHECK `CHECK (length(ends_on) = 10) + 业务层 StructuredRule`
 *   已经保证形如 `YYYY-MM-DD`，这里非 `null` 即可。
 * - `After { n }`：取前 `n - alreadyEmitted` 项，其中
 *   `alreadyEmitted` = 模板历史已生成的非 Cancelled instance 数。**这是
 *   全局计数**（跨物化窗口累计），符合 ticket #25 验收「到点即停」——
 *   不是单窗口内的前 n 项，否则 daily + COUNT=84 + 12 周窗口会被截掉
 *   7 个。用户改 `ends_after_n` 后不会立刻生效：下次启动时取到新的 n
 *   即可（改大能继续生成，改小下一窗口才开始截断）。
 */
function applyEnds(
  candidates: NaiveDate[],
  ends: RecurringEnds,
  alreadyEmitted: number,
): NaiveDate[] {
  if (ends.kind === "on") {
    const cutoff = fromIsoString(ends.date);
    if (cutoff === null) {
      throw AppError.internal("V004 已保证 ends_on 是 YYYY-MM-DD");
    }
    return candidates.filter((d) => compareDates(d, cutoff) <= 0);
  }
  const remaining = Math.max(0, ends.n - alreadyEmitted);
  return candidates.slice(0, remaining);
}

/** Mon=0..Sun=6 → bit。 */
function weekdayBit(w: number): number {
  return 1 << w;
}

/** `NaiveDate` 的星期（Mon=0..Sun=6）。 */
function weekdayOf(d: NaiveDate): number {
  // JS `getUTCDay()`：Sun=0..Sat=6；转 Mon=0..Sun=6。
  return (naiveDateToDate(d).getUTCDay() + 6) % 7;
}

function lastDayOfMonth(year: number, month: number): number {
  // 下个月 1 号 - 1 天 = 当月最后一天；12 月回卷到下一年 1 月。
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const firstNext = new Date(Date.UTC(nextYear, nextMonth - 1, 1));
  const last = new Date(firstNext.getTime() - MS_PER_DAY);
  return last.getUTCDate();
}

// ---------------------------------------------------------------------------
// 纯函数：墙钟 → UTC 入库文本
// ---------------------------------------------------------------------------

/**
 * 墙钟 `(date, hour, minute)` 在 `Asia/Shanghai` 时区下，转成 UTC 时刻
 * 文本（`'%Y-%m-%d %H:%M:%S'`）。固定偏移 + 8h，无夏令时。
 *
 * v1 不引 `chrono-tz`——直接手算偏移；中国自 1991 年起不实行夏令时，
 * 固定偏移 + 8h 与 IANA 规则等价。
 */
export function wallClockToUtcSql(
  d: NaiveDate,
  hour: number,
  minute: number,
): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw AppError.internal(`wallClockToUtcSql 收到非法 hour=${hour}`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw AppError.internal(`wallClockToUtcSql 收到非法 minute=${minute}`);
  }
  // Asia/Shanghai (+8h) 墙钟 → UTC 文本
  // 2026-10-01 08:00 +08:00 = 2026-10-01 00:00 UTC
  const utc = new Date(
    Date.UTC(d.year, d.month - 1, d.day, hour - 8, minute, 0),
  );
  if (Number.isNaN(utc.getTime())) {
    throw AppError.internal(
      `wallClockToUtcSql 计算越界：${toIsoString(d)} ${hour}:${minute}`,
    );
  }
  return toSqlTimestamp(utc);
}

/**
 * 从入库格式的 UTC 时间戳反推 `Asia/Shanghai` 墙钟日期（用于「按本
 * 机 zone 渲染」）。在 SQL 端可用 `date(scheduled_at, '+8 hours')` 替代
 * ——本函数供 TS 端读回后用。
 */
export function utcSqlToLocalDate(text: string): NaiveDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const utc = new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    ),
  );
  if (Number.isNaN(utc.getTime())) return null;
  const local = new Date(utc.getTime() + SHANGHAI_OFFSET_SECONDS * 1000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

// ---------------------------------------------------------------------------
// 纯函数：节假日行为
// ---------------------------------------------------------------------------

/**
 * 把候选日期按节假日行为拆成 [`MaterializedEvent`] 列表。
 *
 * - `SKIP`：节假日 → `Skip`；工作日（含调休） → `Keep`。
 * - `SHIFT`：节假日 → 搜索 SHIFT_MAX_LOOKAHEAD_DAYS 范围内的首个非节假
 *   日工作日（把调休工作日视为合法目标），`Shift { original, target }`。
 *   找不到 → 仍 `Shift { original, target = original + 30d }`（上层
 *   写入时按「超出 12 周窗口就标 Cancelled 但不建新实例」处理——见
 *   [`materializeTemplate`]`）。这里**总**返回 `Shift`，失败用
 *   `target = original + SHIFT_MAX_LOOKAHEAD_DAYS` 占位，这样调用方不
 *   必为「找不到」单独加一个变体。
 */
export function applyHolidayBehavior(
  dates: NaiveDate[],
  calendar: HolidayCalendar,
  behavior: RecurringHolidayBehavior,
): MaterializedEvent[] {
  return dates.map((date) => {
    if (behavior === "skip") {
      if (calendarIsHoliday(calendar, date)) {
        return { kind: "skip", date };
      }
      return { kind: "keep", date };
    }
    // shift
    if (!calendarIsHoliday(calendar, date)) {
      return { kind: "keep", date };
    }
    // 顺延到下一个非节假日工作日（调休工作日算工作日）。
    const target = findNextWorkday(calendar, date);
    return { kind: "shift", original: date, target };
  });
}

/** `NaiveDate` → 字符串 → `HolidayCalendar.kindOf`。 */
function calendarIsHoliday(calendar: HolidayCalendar, date: NaiveDate): boolean {
  const yyyymmdd = toIsoString(date);
  return calendar.kindOf(yyyymmdd) === "holiday";
}

function findNextWorkday(
  calendar: HolidayCalendar,
  from: NaiveDate,
): NaiveDate {
  let candidate: NaiveDate | null = from;
  for (let i = 0; i < SHIFT_MAX_LOOKAHEAD_DAYS; i += 1) {
    candidate = candidate === null ? null : addDays(candidate, 1);
    if (candidate === null) break;
    if (!calendarIsHoliday(calendar, candidate)) return candidate;
  }
  // 30 天内找不到——返回占位（超出窗口）。调用方在 materializeTemplate
  // 里看到这个 target 离 `now + 12 周` 太远时，只建 Cancelled、不建
  // 新实例，等下一窗口滚到这里再补。
  return addDaysOrThrow(
    from,
    SHIFT_MAX_LOOKAHEAD_DAYS,
    "findNextWorkday 占位日期越界",
  );
}

// ---------------------------------------------------------------------------
// 实例标题
// ---------------------------------------------------------------------------

/** 实例标题：模板名 + 当日日期（「周一例会 @ 2026-09-14」）。 */
function instanceTitle(templateName: string, on: NaiveDate): string {
  return `${templateName} @ ${toIsoString(on)}`;
}

// ---------------------------------------------------------------------------
// 元数据：跨周触发去重
// ---------------------------------------------------------------------------

/**
 * 从 `NaiveDate` 算当前 `(year, week)`。SQLite 在物化层用，这里给一个
 * TS 实现，主要供测试 + 跨平台行为比对。
 */
export function isoWeekFromDate(date: NaiveDate): IsoWeek {
  // ISO 8601 week：week 1 = 含 1 月 4 日的那一周；周一为周首日。
  // 「Thursday of this week」算法：所在周的周四落在哪一年/哪一周，
  // 这一周就算那一年的 week N。
  const weekday = weekdayOf(date);
  const thursdayMs =
    naiveDateToDate(date).getTime() + (3 - weekday) * MS_PER_DAY;
  const thursday = new Date(thursdayMs);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7;
  const week1MondayMs = jan4.getTime() - jan4Weekday * MS_PER_DAY;
  const daysSinceWeek1 =
    (naiveDateToDate(date).getTime() - week1MondayMs) / MS_PER_DAY;
  const week = Math.floor(daysSinceWeek1 / 7) + 1;
  return { year, week };
}

/** 读 `materialization_meta` 的当前 `(year, week)`。表空 → `null`。 */
export function readLastMaterializedWeek(db: Database.Database): IsoWeek | null {
  const row = db
    .prepare<[string], { last_iso_year: number; last_iso_week: number }>(
      "SELECT last_iso_year, last_iso_week FROM materialization_meta WHERE id = ?",
    )
    .get(META_SINGLETON_ID);
  if (!row) return null;
  return { year: row.last_iso_year, week: row.last_iso_week };
}

/** 把「当前 `(year, week)`」写入 `materialization_meta`。单行 upsert。 */
export function writeLastMaterializedWeek(db: Database.Database, week: IsoWeek): void {
  db.prepare(
    "INSERT INTO materialization_meta (id, last_iso_year, last_iso_week) " +
      "VALUES (?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "  last_iso_year = excluded.last_iso_year, " +
      "  last_iso_week = excluded.last_iso_week, " +
      "  last_run_at   = datetime('now')",
  ).run(META_SINGLETON_ID, week.year, week.week);
}

/**
 * 决定本次 tick 要不要跑物化。
 *
 * - `last == null`（首次启动 / 表被清过）：**跑**。
 * - `last == current`：同一 ISO 周内重复 tick，**不跑**。
 * - `last != current`：跨入新的一周，**跑**。
 */
export function shouldMaterializeThisTick(
  last: IsoWeek | null,
  current: IsoWeek,
): boolean {
  if (last === null) return true;
  return last.year !== current.year || last.week !== current.week;
}

// ---------------------------------------------------------------------------
// DB 写入层
// ---------------------------------------------------------------------------

/**
 * 把 [`MaterializedEvent`] 序列中需要写入的行 INSERT 进 `task` 表。
 *
 * - `keep`：插入一条 `Open` 状态 instance，`scheduledAtUtc` 取墙钟
 *   `date + rule.byhour + rule.byminute` 转 UTC。
 * - `shift { original, target }`：
 *   - `original` 写一条 `Cancelled` instance（`rescheduledFromId = null`，
 *     `originalScheduledAt = original.scheduled_at`）。UI 标签「已跳过」
 *     由前端根据 `status = Cancelled && recurringTemplateId IS NOT NULL`
 *     决定。
 *   - `target` 写一条 `Open` instance，`rescheduledFromId = 上一步刚
 *     插入的 cancelled instance.id`，`originalScheduledAt =
 *     original.scheduled_at`。
 *   - target 超出 12 周窗口时，只写 cancelled，不写新 instance。
 *
 * - `skip`：**不**写任何行（「没安排」与「节假日跳过」在 UI
 *   上都是空格位）。
 *
 * 幂等性：唯一索引 `(recurring_template_id, scheduled_at) WHERE
 * recurring_template_id IS NOT NULL`。`INSERT OR IGNORE` 在唯一冲突
 * 时跳过，自然幂等。
 */
export function materializeTemplate(
  db: Database.Database,
  template: TemplateMaterializeInput,
  calendar: HolidayCalendar,
  now: NaiveDate,
): MaterializeCounts {
  const rangeStart = now;
  const rangeEnd = addDaysOrThrow(
    now,
    MATERIALIZATION_WINDOW_DAYS,
    "now+12 周日期越界",
  );
  // 模板已物化出的非 Cancelled instance 数（全局累计）——`EndsSpec::After
  // { n }` 用它实现「到点即停」：本窗口只补 `(n - emitted)` 个。
  // 在事务外 SELECT，放大后再开事务，锁内只剩 INSERT。
  const alreadyEmittedRow = db
    .prepare<[number], { c: number }>(
      "SELECT COUNT(*) AS c FROM task " +
        " WHERE recurring_template_id = ? " +
        "   AND status != 'Cancelled' " +
        "   AND scheduled_at IS NOT NULL",
    )
    .get(template.id);
  const alreadyEmitted = alreadyEmittedRow?.c ?? 0;

  const candidates = expandRule(
    template.rule,
    rangeStart,
    rangeEnd,
    alreadyEmitted,
  );
  const events = applyHolidayBehavior(
    candidates,
    calendar,
    template.rule.holidayBehavior,
  );

  const counts = emptyMaterializeCounts();
  const tx = db.transaction(() => {
    for (const event of events) {
      if (event.kind === "skip") {
        counts.skipped += 1;
        continue;
      }
      if (event.kind === "keep") {
        const utcSql = wallClockToUtcSql(
          event.date,
          template.rule.byhour,
          template.rule.byminute,
        );
        if (
          insertInstance(
            db,
            template,
            utcSql,
            event.date,
            event.date, // original_scheduled_at = scheduled_at（keep 路径上两者相同）
            null,
            "Open",
          )
        ) {
          counts.kept += 1;
        }
        continue;
      }
      // shift
      const { original, target } = event;
      const originalUtc = wallClockToUtcSql(
        original,
        template.rule.byhour,
        template.rule.byminute,
      );
      const cancelledId = insertInstanceReturningId(
        db,
        template,
        originalUtc,
        original,
        original,
        null,
        "Cancelled",
      );
      if (cancelledId !== null) counts.cancelled += 1;
      if (compareDates(target, rangeEnd) > 0) {
        // 顺延到窗口外：仅记 cancelled，新实例等下一窗口
        // 滚到这里时补——但其实 SHIFT_MAX_LOOKAHEAD_DAYS=30
        // 不会让 target 一次跑出 84 天外，这条分支主要防御
        // 极端输入。
        continue;
      }
      const targetUtc = wallClockToUtcSql(
        target,
        template.rule.byhour,
        template.rule.byminute,
      );
      const targetTitle = instanceTitle(template.name, original);
      // 走共享 INSERT 体——与手工 reschedule 路径同形。
      const newId = insertRescheduledInstance(
        db,
        template,
        targetUtc,
        originalUtc,
        targetTitle,
      );
      // 回填 rescheduledFromId。幂等命中时（已有 target 行）
      // 该 UPDATE 是 no-op（0 rows affected），跳过即可。
      if (cancelledId !== null) {
        const updated = db
          .prepare(
            "UPDATE task " +
              "   SET rescheduled_from_id = ? " +
              " WHERE id = ? " +
              "   AND rescheduled_from_id IS NULL",
          )
          .run(cancelledId, newId);
        if (updated.changes > 0) counts.shifted += 1;
      }
    }
  });
  tx();
  return counts;
}

/** 跑全部已启用模板的物化。返回合计。 */
export function materializeAll(
  db: Database.Database,
  calendar: HolidayCalendar,
  now: NaiveDate,
): MaterializeTotals {
  const templates = loadEnabledTemplates(db);
  const totals: MaterializeTotals = {
    ...emptyMaterializeTotals(),
    templates: templates.length,
  };
  for (const template of templates) {
    const counts = materializeTemplate(db, template, calendar, now);
    totals.kept += counts.kept;
    totals.skipped += counts.skipped;
    totals.shifted += counts.shifted;
    totals.cancelled += counts.cancelled;
  }
  return totals;
}

/**
 * 从 `AppState` 跑的便捷入口——拿 state 的连接与内存日历，调
 * [`materializeAll`]，把元数据 `materialization_meta.last_iso_year/week`
 * 也跟着写一次。
 *
 * 单写者本机 app 不需要锁升级——`state.db` 与 `state.calendar` 各
 * 自一把 `Mutex` 锁；按 `db → materializeAll → meta → release` 顺序
 * 借即可。两次借锁的窗口里 calendar 可能被改（override 写命令），但
 * materialize 全程在 db 锁内、calendar 一致性不强求——下次跨周触发
 * 会重读，override 已生效。
 */
export function materializeFromState(state: AppState): MaterializeTotals {
  const now = dateToNaiveDate(state.clock.today());
  const conn = state.db;
  // state.calendar 一定是 HolidayCalendar（启动时 loadHolidayCalendar 已挂）；
  // 占位实现 emptyCalendar 也满足 HolidayCalendarLike，这里显式断言以访问
  // findNextWorkday 等的方法。
  const calendar = state.calendar as HolidayCalendar;
  const totals = materializeAll(conn, calendar, now);
  const week = isoWeekFromDate(now);
  writeLastMaterializedWeek(conn, week);
  return totals;
}

/**
 * 跨周检查：本次 tick 是不是进入了新 ISO 周，是就跑一次物化。其它
 * 时间直接返回 `MaterializeIfNewWeekResult { materialized: false, .. }`。
 *
 * 启动后挂个每小时一次的定时器调它——每小时一次的粒度够用：科长不
 * 会在跨入新一周后 1 小时内还看不到物化结果。
 */
export function materializeIfNewWeek(state: AppState): MaterializeIfNewWeekResult {
  const now = dateToNaiveDate(state.clock.today());
  const currentWeek = isoWeekFromDate(now);
  const conn = state.db;
  const last = readLastMaterializedWeek(conn);
  if (!shouldMaterializeThisTick(last, currentWeek)) {
    return {
      materialized: false,
      totals: emptyMaterializeTotals(),
    };
  }
  const totals = materializeFromState(state);
  return { materialized: true, totals };
}

// ---------------------------------------------------------------------------
// 内部辅助：模板加载
// ---------------------------------------------------------------------------

interface TemplateRow {
  id: number;
  name: string;
  freq: string;
  byday_mask: number;
  bymonthday: string | null;
  bymonth: string | null;
  byhour: number;
  byminute: number;
  iana_zone: string;
  ends_on: string | null;
  ends_after_n: number | null;
  holiday_behavior: string;
  // 读但丢弃：sanity check 由 upsert 入口做，这里仅信任结构化字段。
  rrule_text: string;
  project_id: number | null;
  sub_team_id: number | null;
}

/**
 * 读出全部 `enabled = 1` 的模板，转成 [`TemplateMaterializeInput`]
 * 列表。`recurring_template` 不直接存 `owner_person_id`——它挂
 * `project` / `sub_team`，物化层需要「这条 instance 的负责人是谁」。
 * v1 简化：`ownerPersonId` 取 `template.subTeamId` 所在子组里排序
 * 最小的在岗人员；若 `subTeamId` 为空则取 `template.projectId` 负责
 * 人；都没有 → 取全员排序最小的在岗人员（本票兜底策略，后续票
 * 可在模板上加显式 owner 列）。
 */
export function loadEnabledTemplates(
  db: Database.Database,
): TemplateMaterializeInput[] {
  const rows = db
    .prepare<[], TemplateRow>(
      "SELECT id, name, freq, byday_mask, bymonthday, bymonth, byhour, byminute, " +
        "       iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text, " +
        "       project_id, sub_team_id " +
        "  FROM recurring_template " +
        " WHERE enabled = 1 " +
        " ORDER BY id ASC",
    )
    .all();
  const out: TemplateMaterializeInput[] = [];
  for (const row of rows) {
    out.push(parseTemplateRow(db, row));
  }
  return out;
}

function parseTemplateRow(
  db: Database.Database,
  row: TemplateRow,
): TemplateMaterializeInput {
  const id = row.id;
  const name = row.name;
  const freq: RecurringFreq = parseFreqDb(row.freq, id);
  const bydayMask = row.byday_mask;
  const bymonthday = parseIntArray(
    row.bymonthday,
    `recurring_template.id=${id} bymonthday`,
  );
  const bymonth = parseIntArray(
    row.bymonth,
    `recurring_template.id=${id} bymonth`,
  );
  const byhour = row.byhour;
  const byminute = row.byminute;
  const ianaZone = row.iana_zone;
  const holidayBehavior = parseHolidayBehaviorDb(row.holiday_behavior, id);
  const ends: RecurringEnds = parseEnds(row.ends_on, row.ends_after_n, id);
  const ownerPersonId = resolveOwner(db, row.project_id, row.sub_team_id);

  return {
    id,
    name,
    rule: {
      freq,
      bydayMask,
      bymonthday,
      bymonth,
      byhour,
      byminute,
      ianaZone,
      ends,
      holidayBehavior,
    },
    ownerPersonId,
    projectId: row.project_id,
    subTeamId: row.sub_team_id,
  };
}

function parseFreqDb(text: string, id: number): RecurringFreq {
  switch (text) {
    case "DAILY":
      return "daily";
    case "WEEKLY":
      return "weekly";
    case "MONTHLY":
      return "monthly";
    case "YEARLY":
      return "yearly";
    default:
      throw AppError.internal(
        `recurring_template.id=${id} freq 非法 ${JSON.stringify(text)}`,
      );
  }
}

function parseHolidayBehaviorDb(
  text: string,
  id: number,
): RecurringHolidayBehavior {
  switch (text) {
    case "SKIP":
      return "skip";
    case "SHIFT":
      return "shift";
    default:
      throw AppError.internal(
        `recurring_template.id=${id} holiday_behavior 非法 ${JSON.stringify(text)}`,
      );
  }
}

function parseEnds(
  endsOn: string | null,
  endsAfterN: number | null,
  id: number,
): RecurringEnds {
  if (endsOn !== null && endsAfterN === null) {
    return { kind: "on", date: endsOn };
  }
  if (endsOn === null && endsAfterN !== null) {
    return { kind: "after", n: endsAfterN };
  }
  throw AppError.internal(`recurring_template.id=${id} ends 漂移`);
}

function parseIntArray(text: string | null, label: string): number[] | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw AppError.internal(`${label} JSON 数组解析失败：${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw AppError.internal(`${label} JSON 顶层不是数组`);
  }
  const out: number[] = [];
  for (const item of parsed) {
    if (typeof item !== "number" || !Number.isInteger(item)) {
      throw AppError.internal(
        `${label} 数组元素非整数：${JSON.stringify(item)}`,
      );
    }
    out.push(item);
  }
  return out;
}

/**
 * 解析模板实例的负责人。
 *
 * 优先级：`subTeamId` 内的最小 id 在岗人员 → `projectId` 的
 * `ownerPersonId` → 全员最小 id 在岗人员。空库 → `Internal` 错误
 * （此时物化没法给 instance 写 owner）。
 */
export function resolveOwner(
  db: Database.Database,
  projectId: number | null,
  subTeamId: number | null,
): number {
  if (subTeamId !== null) {
    const owner = db
      .prepare<[number], { id: number }>(
        "SELECT id FROM person " +
          " WHERE sub_team_id = ? AND deactivated_at IS NULL " +
          " ORDER BY id ASC LIMIT 1",
      )
      .get(subTeamId);
    if (owner) return owner.id;
  }
  if (projectId !== null) {
    const project = db
      .prepare<[number], { owner_person_id: number }>(
        "SELECT owner_person_id FROM project WHERE id = ?",
      )
      .get(projectId);
    if (project) {
      const active = db
        .prepare<[number], { id: number }>(
          "SELECT id FROM person " +
            " WHERE id = ? AND deactivated_at IS NULL",
        )
        .get(project.owner_person_id);
      if (active) return active.id;
    }
  }
  // 兜底：全员最小 id 在岗人员。
  const fallback = db
    .prepare<[], { id: number }>(
      "SELECT id FROM person WHERE deactivated_at IS NULL " +
        " ORDER BY id ASC LIMIT 1",
    )
    .get();
  if (!fallback) {
    throw AppError.internal(
      "recurring_template 无法解析 owner_person_id：花名册为空",
    );
  }
  return fallback.id;
}

// ---------------------------------------------------------------------------
// INSERT helpers
// ---------------------------------------------------------------------------

/** KEEP 路径用。返回是否实际插入了行（`INSERT OR IGNORE` 命中已有则返回 false）。 */
function insertInstance(
  db: Database.Database,
  template: TemplateMaterializeInput,
  scheduledAtUtc: string,
  localDate: NaiveDate,
  originalScheduledDate: NaiveDate | null,
  rescheduledFromId: number | null,
  status: string,
): boolean {
  const originalScheduledAt =
    originalScheduledDate === null
      ? null
      : wallClockToUtcSql(
          originalScheduledDate,
          template.rule.byhour,
          template.rule.byminute,
        );
  const title = instanceTitle(
    template.name,
    originalScheduledDate ?? localDate,
  );
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO task " +
        "  (title, status, owner_person_id, project_id, sub_team_id, " +
        "   recurring_template_id, scheduled_at, original_scheduled_at, " +
        "   rescheduled_from_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
    )
    .run(
      title,
      status,
      template.ownerPersonId,
      template.projectId,
      template.subTeamId,
      template.id,
      scheduledAtUtc,
      originalScheduledAt,
      rescheduledFromId,
    );
  return result.changes > 0;
}

/** SHIFT 路径用。返回新行 id；幂等命中时返回已有行 id。 */
function insertInstanceReturningId(
  db: Database.Database,
  template: TemplateMaterializeInput,
  scheduledAtUtc: string,
  localDate: NaiveDate,
  originalScheduledDate: NaiveDate | null,
  rescheduledFromId: number | null,
  status: string,
): number | null {
  insertInstance(
    db,
    template,
    scheduledAtUtc,
    localDate,
    originalScheduledDate,
    rescheduledFromId,
    status,
  );
  const row = db
    .prepare<[number, string], { id: number }>(
      "SELECT id FROM task " +
        " WHERE recurring_template_id = ? AND scheduled_at = ?",
    )
    .get(template.id, scheduledAtUtc);
  return row ? row.id : null;
}

/**
 * 写一条新的「改期后」instance 行（公开版，ticket #26 / #49）。
 *
 * SHIFT 路径（[`materializeTemplate`] 里节假日顺延）与手工改期路径
 * [`rescheduleInstance`] **共用**这一段 INSERT 体——验收点 #26 AC：
 * 两条路径产出的数据形状一致。
 *
 * 与 [`insertInstance`] 的差别：本函数由调用方传完整时间戳（不再
 * `wallClockToUtcSql` 一次），方便手工改期时把「原始模板时间」和
 * 「新时间」分别由调用方算好；返回新行的 id（用于回填
 * `rescheduledFromId`）。
 *
 * 幂等性同样靠 V005 的唯一索引 `(recurring_template_id, scheduled_at)
 * WHERE recurring_template_id IS NOT NULL`——同 `(template, scheduledAt)`
 * 重复调会被 `INSERT OR IGNORE` 静默吃掉。
 */
export function insertRescheduledInstance(
  db: Database.Database,
  template: TemplateMaterializeInput,
  newScheduledAtUtc: string,
  originalScheduledAtUtc: string,
  title: string,
): number {
  db.prepare(
    "INSERT OR IGNORE INTO task " +
      "  (title, status, owner_person_id, project_id, sub_team_id, " +
      "   recurring_template_id, scheduled_at, original_scheduled_at, " +
      "   rescheduled_from_id, created_at, updated_at) " +
      "VALUES (?, 'Open', ?, ?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))",
  ).run(
    title,
    template.ownerPersonId,
    template.projectId,
    template.subTeamId,
    template.id,
    newScheduledAtUtc,
    originalScheduledAtUtc,
  );
  // `INSERT OR IGNORE` 之后，lastInsertRowid() 仅在新行被实际插入时
  // 有意义；幂等命中（已存在）需要 SELECT 一次拿原行 id。
  const row = db
    .prepare<[number, string], { id: number }>(
      "SELECT id FROM task " +
        " WHERE recurring_template_id = ? AND scheduled_at = ?",
    )
    .get(template.id, newScheduledAtUtc);
  if (!row) {
    throw AppError.internal(
      `materialization：rescheduled instance SELECT 不一致 template.id=${template.id} ${newScheduledAtUtc}`,
    );
  }
  return row.id;
}