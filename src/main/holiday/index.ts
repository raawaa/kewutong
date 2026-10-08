/**
 * 节假日数据层 + 命令层（tickets #23 / #47）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/holiday.rs` + `src-tauri/src/commands/holiday.rs` 的语义：
 * - 启动加载当前年 + 下一年 `holidays/cn-<year>.json`（ADR 0003）
 * - App 内覆盖（`holiday_override` 表）优先于种子
 * - 默认 weekend = Holiday，weekday = Workday（且不算调休）
 * - 闭区间日历视图：仅返回 Seed / Override 的 Holiday / Workday——默认
 *   工作日（含周末）不返回，前端按日历格子自己渲染
 *
 * 设计要点：
 * - DTO 字段名与原 Rust 端 camelCase 对齐（前端无需翻译）
 * - JSON 解析零容错：未知字段直接抛错（信任抓取脚本 + 人工 git diff review）
 * - 缺种子文件 = 降级为空日历（年末过渡场景），不 panic
 * - 跨年区间按文件名年份截断（与原 Rust 端 `merge_seed_into` 同形）
 * - 命令层只做入参校验 + 错误映射，不直接写 SQL
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type Database from "better-sqlite3";

import { AppError } from "../error.js";
import { parseSqlDate, toSqlDate } from "../clock.js";
import type { AppState, HolidayCalendarLike } from "../state.js";

// ---------------------------------------------------------------------------
// DTO / 枚举
// ---------------------------------------------------------------------------

/** 一天的 effective 类别——与原 Rust 端 `DayKind` 一一对应（kebab-case）。 */
export type DayKind = "holiday" | "workday";

/** 一天记录的来源——与原 Rust 端 `DaySource` 一一对应（kebab-case）。 */
export type DaySource = "default" | "seed" | "override";

/** 日历视图（ticket #23 验收点）的一行。 */
export interface HolidayCalendarDay {
  date: string;
  kind: DayKind;
  name: string | null;
  source: DaySource;
}

/** `holiday_calendar` 入参——闭区间 `[startInclusive, endInclusive]`。 */
export interface HolidayCalendarArgs {
  startInclusive: string;
  endInclusive: string;
}

/** `set_holiday_override` 入参。 */
export interface SetHolidayOverrideArgs {
  date: string;
  kind: DayKind;
}

/** `clear_holiday_override` 入参。 */
export interface ClearHolidayOverrideArgs {
  date: string;
}

/** `load_holiday_calendar` 入参——加载当年 + 下一年。 */
export interface LoadHolidayCalendarArgs {
  year: number;
  /** 种子目录绝对路径（dev = repo 根，prod = `process.resourcesPath/holidays`）。 */
  seedDir: string;
}

/** `load_holiday_calendar` 返回——实际加载到的文件年份列表。 */
export interface HolidayLoadResult {
  loadedYears: number[];
}

/** 一条种子文件 entry（与 ADR 0003 schema 对齐）。 */
interface HolidayEntryJson {
  start: string;
  end: string;
  name?: string | null;
}

/** 种子文件顶层（与 ADR 0003 schema 对齐）。 */
interface HolidayFileJson {
  holidays: HolidayEntryJson[];
  workdays: HolidayEntryJson[];
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 日历视图范围上限（约一季度）。超出拒绝——一次 RPC 不返回数千行。 */
const MAX_CALENDAR_SPAN_DAYS = 92;

// ---------------------------------------------------------------------------
// 入参校验与字符串处理
// ---------------------------------------------------------------------------

function requireNonBlank(value: string, message: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw AppError.invalid(message);
  return trimmed;
}

/** 把 `YYYY-MM-DD` 文本解析为 `Date`。非此格式抛中文 `INVALID_ARGUMENT`。 */
function parseIsoDate(text: string, label: string): Date {
  const trimmed = requireNonBlank(text, `${label}不能为空。`);
  const parsed = parseSqlDate(trimmed);
  if (parsed === null) {
    throw AppError.invalid(`${label}格式不对,应形如 2026-09-10。`);
  }
  return parsed;
}

/**
 * 把 `holiday_override` 一行 → `DayKind`。
 * CHECK 约束保证 kind 取值合法；这里再校验一次,DB 已被手工编辑过的情形
 * 也能被识别。
 */
function rowKindToDayKind(raw: string): DayKind | null {
  if (raw === "holiday") return "holiday";
  if (raw === "workday") return "workday";
  return null;
}

// ---------------------------------------------------------------------------
// 种子文件解析
// ---------------------------------------------------------------------------

/**
 * 加载单份种子文件——读取 + 解析；文件不存在/JSON 不合法分别处理。
 * 与原 Rust `load_one_seed_file` 同形：
 * - Missing → 返回 `null`
 * - Invalid → 抛 `AppError.internal`（启动应当立即失败）
 */
function loadOneSeedFile(filePath: string): HolidayFileJson | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (cause) {
    const err = cause as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw AppError.fromIo(cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw AppError.internal(`解析节假日文件 ${filePath} 失败：${String(cause)}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { holidays?: unknown }).holidays) ||
    !Array.isArray((parsed as { workdays?: unknown }).workdays)
  ) {
    throw AppError.internal(
      `解析节假日文件 ${filePath} 失败：顶层结构应为 {holidays,workdays}`,
    );
  }
  const file = parsed as HolidayFileJson;
  // 解析每个 entry 的日期字段——非 `YYYY-MM-DD` 立刻抛错（与原 Rust 端
  // `deserialize_naive_date_iso` 同语义）。
  file.holidays.forEach((e, i) => {
    if (parseSqlDate(e.start) === null) {
      throw AppError.internal(`解析节假日文件 ${filePath} 失败：holidays[${i}].start 非法`);
    }
    if (parseSqlDate(e.end) === null) {
      throw AppError.internal(`解析节假日文件 ${filePath} 失败：holidays[${i}].end 非法`);
    }
  });
  file.workdays.forEach((e, i) => {
    if (parseSqlDate(e.start) === null) {
      throw AppError.internal(`解析节假日文件 ${filePath} 失败：workdays[${i}].start 非法`);
    }
    if (parseSqlDate(e.end) === null) {
      throw AppError.internal(`解析节假日文件 ${filePath} 失败：workdays[${i}].end 非法`);
    }
  });
  return file;
}

/**
 * 把 `[start, end]` 闭区间展开成逐日 `YYYY-MM-DD`。`start > end` 退化为空
 * ——畸形输入会让展开死循环或错位,这个点非查不可;其余 (start <= end、
 * 无重叠) 仍交给 git diff review（ADR 0003 §解析层）。
 */
function* expandDays(start: string, end: string): Generator<string> {
  const cur = parseSqlDate(start);
  const last = parseSqlDate(end);
  if (cur === null || last === null) return;
  const lastMs = last.getTime();
  let curMs = cur.getTime();
  while (curMs <= lastMs) {
    yield toSqlDate(new Date(curMs));
    curMs += 24 * 3600 * 1000;
  }
}

// ---------------------------------------------------------------------------
// HolidayCalendar ——合并后的内存视图
// ---------------------------------------------------------------------------

/**
 * 加载完的日历视图：当年 + 下一年的种子合并进 `seed*`，override 单独存。
 *
 * 实现 [`HolidayCalendarLike`]（即只暴露 `kindOf()`）。命令层需要更
 * 强 API（`setOverride` / `clearOverride` 等）时,通过显式类型断言拿到
 * 完整类能力。
 */
export class HolidayCalendar implements HolidayCalendarLike {
  private seedHolidays = new Map<string, string>();
  private seedWorkdays = new Map<string, string>();
  private overrides = new Map<string, DayKind>();
  private readonly loadedYears: number[] = [];

  private constructor() {}

  /**
   * 从 `seedDir` 读 `cn-<year>.json` 与 `cn-<year+1>.json`;再从 `conn` 读
   * `holiday_override` 表合并覆盖。**两个文件都缺**也能启动（年末过渡
   * 场景）——空日历生效。
   *
   * 解析层零容错：JSON 不合法 → 抛 `AppError.internal`（启动应当立即失
   * 败,而不是带着垃圾数据跑下去）。
   */
  static load(db: Database.Database, seedDir: string, currentYear: number): HolidayCalendar {
    const cal = new HolidayCalendar();
    for (const year of [currentYear, currentYear + 1]) {
      const filePath = path.join(seedDir, `cn-${year}.json`);
      const file = loadOneSeedFile(filePath);
      if (file === null) continue; // 缺文件不 panic
      cal.mergeSeedInto(file, year);
      cal.loadedYears.push(year);
    }
    cal.loadOverridesFromDb(db);
    return cal;
  }

  /** 实际加载到的年份列表（按升序）。供启动日志/调试使用。 */
  getLoadedYears(): number[] {
    return [...this.loadedYears];
  }

  // ----- 公共查询接口 -----

  /**
   * 给定日期的有效类别。**满足 [`HolidayCalendarLike`] 接口**——物化层与
   * 日历视图之外的所有调用都通过这一个入口。
   *
   * 返回字面量集合 `"holiday" | "makeup" | "workday"`：默认周末归
   * `holiday`，调休工作日（seed workday 或 override workday）归
   * `makeup`，普通 weekday 归 `workday`。
   */
  kindOf(yyyymmdd: string): "holiday" | "makeup" | "workday" {
    const info = this.info(yyyymmdd);
    if (info.kind === "holiday") return "holiday";
    if (info.source === "default") return "workday";
    return "makeup";
  }

  /** 当天的 effective 信息——日历视图与物化层共用这一个入口。 */
  info(yyyymmdd: string): { kind: DayKind; name: string | null; source: DaySource } {
    const override = this.overrides.get(yyyymmdd);
    if (override !== undefined) {
      return { kind: override, name: null, source: "override" };
    }
    const holidayName = this.seedHolidays.get(yyyymmdd);
    if (holidayName !== undefined) {
      return { kind: "holiday", name: holidayName, source: "seed" };
    }
    const workdayName = this.seedWorkdays.get(yyyymmdd);
    if (workdayName !== undefined) {
      return { kind: "workday", name: workdayName, source: "seed" };
    }
    return {
      kind: isWeekend(yyyymmdd) ? "holiday" : "workday",
      name: null,
      source: "default",
    };
  }

  /** 闭区间 `[start, end]` 内所有 effective 信息（含默认天）。 */
  *iterRange(
    start: string,
    end: string,
  ): Generator<{ date: string; kind: DayKind; name: string | null; source: DaySource }> {
    const startDate = parseSqlDate(start);
    const endDate = parseSqlDate(end);
    if (startDate === null || endDate === null) return;
    const endMs = endDate.getTime();
    let curMs = startDate.getTime();
    while (curMs <= endMs) {
      const dateStr = toSqlDate(new Date(curMs));
      yield { date: dateStr, ...this.info(dateStr) };
      curMs += 24 * 3600 * 1000;
    }
  }

  // ----- override 写入 -----

  /** App 内"切换某一天为 Holiday/Workday"——upsert 进 `holiday_override`。 */
  setOverride(db: Database.Database, yyyymmdd: string, kind: DayKind): void {
    const dateText = requireNonBlank(yyyymmdd, "覆盖日期不能为空。");
    parseIsoDate(dateText, "覆盖日期"); // 仅校验格式
    try {
      db.prepare(
        "INSERT INTO holiday_override (date, kind) VALUES (?, ?) " +
          "ON CONFLICT(date) DO UPDATE SET kind = excluded.kind",
      ).run(dateText, dayKindAsDbString(kind));
    } catch (cause) {
      throw AppError.fromSqlite(cause);
    }
    this.reloadOverridesFromDb(db);
  }

  /** 清除某天的覆盖（恢复种子/默认）。 */
  clearOverride(db: Database.Database, yyyymmdd: string): void {
    const dateText = requireNonBlank(yyyymmdd, "覆盖日期不能为空。");
    parseIsoDate(dateText, "覆盖日期");
    try {
      db.prepare("DELETE FROM holiday_override WHERE date = ?").run(dateText);
    } catch (cause) {
      throw AppError.fromSqlite(cause);
    }
    this.reloadOverridesFromDb(db);
  }

  /** 从 SQLite 重读全部覆盖,替换内存中的 overrides。 */
  reloadOverridesFromDb(db: Database.Database): void {
    this.overrides.clear();
    this.loadOverridesFromDb(db);
  }

  // ----- 私有辅助 -----

  /** 把 `HolidayFile` 合并到种子视图，按文件名年份截断跨年区间。 */
  private mergeSeedInto(file: HolidayFileJson, year: number): void {
    for (const entry of file.holidays) {
      for (const date of expandDays(entry.start, entry.end)) {
        if (dateYear(date) !== year) continue; // 跨年截断
        this.seedHolidays.set(date, entry.name ?? "");
      }
    }
    for (const entry of file.workdays) {
      for (const date of expandDays(entry.start, entry.end)) {
        if (dateYear(date) !== year) continue;
        this.seedWorkdays.set(date, entry.name ?? "");
      }
    }
  }

  /** 从 SQLite 读 `holiday_override` 全表,落到 `this.overrides`。 */
  private loadOverridesFromDb(db: Database.Database): void {
    let rows: { date: string; kind: string }[];
    try {
      rows = db
        .prepare<[], { date: string; kind: string }>(
          "SELECT date, kind FROM holiday_override",
        )
        .all();
    } catch (cause) {
      throw AppError.fromSqlite(cause);
    }
    for (const row of rows) {
      const date = parseSqlDate(row.date);
      if (date === null) {
        throw AppError.internal(`holiday_override.date 格式不合法：${row.date}`);
      }
      const kind = rowKindToDayKind(row.kind);
      if (kind === null) {
        throw AppError.internal(`holiday_override.kind 未知取值：${row.kind}`);
      }
      this.overrides.set(toSqlDate(date), kind);
    }
  }
}

/** 判断 `YYYY-MM-DD` 是否周末（Sat / Sun）。与原 Rust `chrono::Weekday` 一致。 */
function isWeekend(yyyymmdd: string): boolean {
  const d = parseSqlDate(yyyymmdd);
  if (d === null) return false;
  const dow = d.getUTCDay(); // 0 = Sun, 6 = Sat
  return dow === 0 || dow === 6;
}

/** 取 `YYYY-MM-DD` 的年份分量（用于跨年截断判定）。 */
function dateYear(yyyymmdd: string): number {
  const d = parseSqlDate(yyyymmdd);
  if (d === null) return 0;
  return d.getUTCFullYear();
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/**
 * 加载种子文件 + 从 DB 合并 overrides,挂到 `state.calendar`。
 *
 * 调用一次,启动时调；后续 override 写命令原地刷新。
 */
export function loadHolidayCalendar(
  state: AppState,
  args: LoadHolidayCalendarArgs,
): HolidayLoadResult {
  const year = args.year;
  if (!Number.isInteger(year)) {
    throw AppError.invalid("年份应为整数。");
  }
  const seedDir = requireNonBlank(args.seedDir, "种子目录不能为空。");
  const cal = HolidayCalendar.load(state.db, seedDir, year);
  state.calendar = cal;
  return { loadedYears: cal.getLoadedYears() };
}

/**
 * 列出闭区间 `[start, end]` 内所有 effective Holiday / Workday 的天。
 *
 * 默认工作日（含默认周末）不返回——前端按日历格子自己渲染就好。返回
 * 的列表按 `date` 升序,便于 UI 走一遍循环就把日历填上。
 */
export function holidayCalendar(
  state: AppState,
  args: HolidayCalendarArgs,
): HolidayCalendarDay[] {
  const startDate = parseIsoDate(args.startInclusive, "起始日");
  const endDate = parseIsoDate(args.endInclusive, "结束日");
  if (startDate.getTime() > endDate.getTime()) {
    throw AppError.invalid("起始日不能晚于结束日。");
  }
  const spanDays = Math.floor(
    (endDate.getTime() - startDate.getTime()) / (24 * 3600 * 1000),
  );
  if (spanDays > MAX_CALENDAR_SPAN_DAYS) {
    throw AppError.invalid(
      `日历视图范围最多 ${MAX_CALENDAR_SPAN_DAYS} 天（约一季度），当前 ${spanDays} 天。`,
    );
  }

  const startStr = toSqlDate(startDate);
  const endStr = toSqlDate(endDate);

  // state.calendar 一定是 HolidayCalendar（启动时 loadHolidayCalendar 已挂）;
  // 占位实现 emptyCalendar 也满足 HolidayCalendarLike,这里显式断言以访问
  // iterRange()。
  const calendar = state.calendar as HolidayCalendar;
  const days: HolidayCalendarDay[] = [];
  for (const day of calendar.iterRange(startStr, endStr)) {
    // 只列 Seed / Override 的 Holiday/Workday——默认工作日(含周末)
    // 不在返回里,前端按日历格子自己画底色。
    if (
      (day.kind === "holiday" || day.kind === "workday") &&
      (day.source === "seed" || day.source === "override")
    ) {
      days.push({
        date: day.date,
        kind: day.kind,
        name: day.name,
        source: day.source,
      });
    }
  }
  return days;
}

/**
 * App 内覆盖：把 `date` 标记为 Holiday 或 Workday。
 *
 * 写完 SQLite 后**不**重读整张日历——下次查询自动走 effective set；如
 * 果要让前端立即看到本次改动，调用方自己再发一次 `holiday_calendar`。
 *
 * 内部仍 reloadOverridesFromDb 刷新内存视图，便于物化层后续判断。
 */
export function setHolidayOverride(state: AppState, args: SetHolidayOverrideArgs): void {
  if (args.kind !== "holiday" && args.kind !== "workday") {
    throw AppError.invalid("覆盖类别应为「holiday」或「workday」。");
  }
  const calendar = state.calendar as HolidayCalendar;
  calendar.setOverride(state.db, args.date, args.kind);
}

/** 清除 App 内某天的覆盖——回到种子/默认。 */
export function clearHolidayOverride(state: AppState, args: ClearHolidayOverrideArgs): void {
  const calendar = state.calendar as HolidayCalendar;
  calendar.clearOverride(state.db, args.date);
}