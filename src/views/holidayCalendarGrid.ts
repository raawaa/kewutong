/**
 * 「节假日日历」视图的纯逻辑（ticket #62）。
 *
 * 设计要点：
 * - 4 周窗口 = 当周 Monday 起 + 27 天（28 格）。
 * - IPC 只返 Seed / Override 行；其余格按"周末 = holiday / 工作日 =
 *   workday、source = default"在客户端填底（ADR 0003 §跨年加载 +
 *   ticket #62 设计决策 §2）。
 * - 日期一律走本地日历日（与 `Clock.today()` 同语义：前端不需要 UTC 8
 *   小时补偿；`Date` 对象本地时区分量就是用户视角的"今天"）。
 * - 跨年场景：4 周窗口跨 Dec 31 → Jan 1 时,IPC 一次性拉 [Mon, +27天]
 *   闭区间;主进程 `mergeSeedInto` 按文件年份截断,返回的列表天然合并
 *   两个 seed 年份的条目。本模块无需做跨年合并——只负责把返回的列表
 *   落到格子里。
 */

import type { HolidayCalendarDay } from "@/lib/api";
import type { DayKind, DaySource } from "@/main/holiday/index";

/** 一格最终渲染所需的全部信息——视图层直接拿这个数组渲染 DOM。 */
export interface HolidayCell {
  /** 本地日历日 `YYYY-MM-DD`。 */
  date: string;
  /** 月内日号（1..31），用于格子右下角的小数字。 */
  dayOfMonth: number;
  /** 周内下标 0 = Monday, 6 = Sunday。 */
  weekdayIndex: number;
  kind: DayKind;
  /** 节日 / 调休名称（如 "春节"）；null = 默认日无名称。 */
  name: string | null;
  source: DaySource;
}

/** 4 周窗口的行 × 列；行固定 4,列固定 7（Mon..Sun）。 */
export type HolidayGrid = HolidayCell[][];

/** 一格底色对应的 Tailwind class——视图层把这个字符串塞 `className` 即可。 */
export interface HolidayCellStyle {
  /** 格子底色（Tailwind class）。 */
  backgroundClass: string;
  /** "app 内覆盖"小徽章——只在 source === "override" 时显示。 */
  showOverrideBadge: boolean;
  /** 节日 / 调休名 chip——seed 与 override 都可能携带 name,override 永远 name=null。 */
  showNameChip: boolean;
}

const DAY_NAMES_MON_FIRST = [
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
  "日",
] as const;

/** 周内表头（周一..周日）——视图层放列头用。 */
export const WEEKDAY_HEADERS: readonly string[] = DAY_NAMES_MON_FIRST;

/** 一周天数（与 ISO 周一致）。 */
export const DAYS_PER_WEEK = 7;

/** 窗口固定 4 周——与 ticket #62 设计决策 §1 钉死。 */
export const WEEKS_PER_WINDOW = 4;

/** 窗口总格数 = 4 * 7 = 28。 */
export const CELLS_PER_WINDOW = WEEKS_PER_WINDOW * DAYS_PER_WEEK;

/**
 * 给一个本地日历日,返回它所在周的 Monday 的 `Date`（本地 0 点）。
 *
 * 注意 `Date` 用本地时区分量取年月日——前端"今天"是用户视角,不绕 UTC。
 */
export function mondayOf(date: Date): Date {
  // getDay(): 0=Sun..6=Sat
  const dow = date.getDay();
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysFromMonday);
}

/** `date + n` 天的本地 0 点 `Date`。 */
export function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** 把本地日历日渲染成 `YYYY-MM-DD`——与主进程 `toSqlDate` 一形（前端视角）。 */
export function formatLocalDateIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 判断 `YYYY-MM-DD` 是否周六或周日（Sat / Sun）。 */
export function isWeekendIso(yyyymmdd: string): boolean {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !d) return false;
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  return dow === 0 || dow === 6;
}

/**
 * 合并 IPC 返回的节假日行 + 客户端默认填充,产出 4 周 × 7 天的网格。
 *
 * `calendarResponse` 里的 `date` 一定是 `YYYY-MM-DD`（主进程返回已校
 * 验）。缺失日按"周末 = holiday / 工作日 = workday、source = default"
 * 填——见 ADR 0003 §跨年加载 + ticket #62 设计决策 §2。
 */
export function buildHolidayGrid({
  today,
  calendarResponse,
}: {
  today: Date;
  calendarResponse: HolidayCalendarDay[];
}): HolidayGrid {
  const startMonday = mondayOf(today);
  const byDate = new Map<string, HolidayCalendarDay>();
  for (const entry of calendarResponse) {
    byDate.set(entry.date, entry);
  }
  const grid: HolidayGrid = [];
  for (let weekIndex = 0; weekIndex < WEEKS_PER_WINDOW; weekIndex++) {
    const row: HolidayCell[] = [];
    for (let weekdayIndex = 0; weekdayIndex < DAYS_PER_WEEK; weekdayIndex++) {
      const dayDate = addDays(startMonday, weekIndex * DAYS_PER_WEEK + weekdayIndex);
      const yyyymmdd = formatLocalDateIso(dayDate);
      const seed = byDate.get(yyyymmdd);
      const isWeekend = dayDate.getDay() === 0 || dayDate.getDay() === 6;
      if (seed) {
        row.push({
          date: yyyymmdd,
          dayOfMonth: dayDate.getDate(),
          weekdayIndex,
          kind: seed.kind,
          name: seed.name,
          source: seed.source,
        });
      } else {
        row.push({
          date: yyyymmdd,
          dayOfMonth: dayDate.getDate(),
          weekdayIndex,
          kind: isWeekend ? "holiday" : "workday",
          name: null,
          source: "default",
        });
      }
    }
    grid.push(row);
  }
  return grid;
}

/**
 * 把一格的 (kind, source) 翻译成渲染所需的 Tailwind class + 徽章标志。
 *
 * 配色：
 * - holiday（种子 / 默认周末）：橙红底
 * - workday（调休 / 默认工作日）：蓝绿底
 * - override（App 内覆盖）：紫底,带"app 内覆盖"徽章
 *
 * 视图层不写 Tailwind 调色,全部走这个映射——便于 ADR 0008 §渲染进程
 * seam "前端不含业务逻辑,只调命令、显示 DTO"的归口。
 */
export function cellStyleOf(kind: DayKind, source: DaySource): HolidayCellStyle {
  if (source === "override") {
    return {
      backgroundClass: "bg-violet-200 text-violet-950",
      showOverrideBadge: true,
      showNameChip: false,
    };
  }
  if (kind === "holiday") {
    return {
      backgroundClass: "bg-rose-200 text-rose-950",
      showOverrideBadge: false,
      showNameChip: true,
    };
  }
  // workday
  return {
    backgroundClass: "bg-sky-200 text-sky-950",
    showOverrideBadge: false,
    showNameChip: true,
  };
}
