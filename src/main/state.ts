/**
 * 主进程共享的应用状态（ADR 0006 §模块布局）。
 *
 * 一个 SQLite 连接 + 一个 Clock + 一个合并后的节假日日历视图 +
 * 一个托盘状态 + 数据库文件路径。命令层全部从这里借出 db / clock /
 * calendar；后台 tick 直接 clone 整个 state（共享同一份 db / calendar）。
 */

import type Database from "better-sqlite3";
import type { Clock } from "./clock.js";

/** 托盘可达性（ticket #29）。 */
export type TrayStatus =
  | { kind: "available" }
  | { kind: "unavailable"; reason: string };

export const DEFAULT_TRAY_STATUS: TrayStatus = {
  kind: "unavailable",
  reason: "托盘尚未初始化",
};

/**
 * 主进程共享状态——单例。
 *
 * 单写者本机场景下，`db` 不需要 Mutex 包装（SQLite 本身串行化）。后台 tick
 * 与命令层共用同一份 db 引用即可。
 */
export interface AppState {
  readonly db: Database.Database;
  readonly clock: Clock;
  /** 启动时调一次，后续 override 写命令原地刷新。 */
  calendar: HolidayCalendarLike;
  /** 托盘可达性。 */
  trayStatus: TrayStatus;
  /** 数据库文件绝对路径——`data_file_location` 命令返回此值。 */
  dbPath: string | null;
}

/**
 * 节假日日历最小接口（实现见 `src/main/holiday/calendar.ts`）。
 *
 * 这里只暴露命令层需要的方法，避免 calendar 内部状态泄漏到 state 类型
 * 上。M2 阶段（ticket #47）把 calendar 实现补齐。
 */
export interface HolidayCalendarLike {
  /** 给定日期是否节假日（含调休工作日的反向判断）。 */
  kindOf(yyyymmdd: string): "holiday" | "makeup" | "workday";
}

export function newAppState(db: Database.Database, clock: Clock): AppState {
  return {
    db,
    clock,
    calendar: emptyCalendar(),
    trayStatus: DEFAULT_TRAY_STATUS,
    dbPath: null,
  };
}

/** 还没装 calendar 时的占位——所有日期都按 workday 处理。 */
function emptyCalendar(): HolidayCalendarLike {
  return { kindOf: () => "workday" };
}

/** 取一个可入库的 UTC 时间戳文本——业务代码用这个，不要直接 `clock.now()`。 */
export function nowSql(state: AppState): string {
  return state.clock.nowSql();
}

/** 取科长本地的「今天」。 */
export function todayLocal(state: AppState): Date {
  return state.clock.today();
}