/**
 * 可注入的时钟（ADR 0006 §测试 seam）。
 *
 * 「到期前 24h」「阻塞 > 3 天」「跨周物化」这三类逻辑要能确定性测试，业务
 * 代码就不能直接读宿主时间。全 app 只通过 [`Clock`] 取「现在」，测试注入
 * [`FixedClock`] 把它钉在任意时刻。
 */

/** ADR 0001：时间戳一律以 UTC 文本入库。 */
export const SQL_TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S";

/** 纯日期列（`task.due_date` 等）的入库格式。 */
export const SQL_DATE_FORMAT = "%Y-%m-%d";

/** 科长所在时区相对 UTC 的偏移秒数（UTC+8）。 */
const LOCAL_UTC_OFFSET_SECONDS = 8 * 3600;

/** 把一个 `Date` 渲染成入库格式的 UTC 时间戳文本。 */
export function toSqlTimestamp(at: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
  );
}

/** 把入库格式的 UTC 时间戳文本解析回 `Date`。格式不对时返回 `null`。 */
export function parseSqlTimestamp(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 把一个 `Date` 渲染成入库格式的 `YYYY-MM-DD`。 */
export function toSqlDate(date: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 解析入库格式的 `YYYY-MM-DD`。非此格式返回 `null`——不做宽松兜底。 */
export function parseSqlDate(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 「现在」的唯一来源。 */
export interface Clock {
  now(): Date;
  /** 直接给出可入库的时间戳文本。 */
  nowSql(): string;
  /** 科长本地的「今天」（日历日，不是 UTC 日）。 */
  today(): Date;
}

/** 生产环境用的真实时钟。 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowSql(): string {
    return toSqlTimestamp(this.now());
  }

  today(): Date {
    // 本地日历日——科长 UTC+20:00 已经是本地次日 04:00，「今天」得是本地。
    return new Date(this.now().getTime() + LOCAL_UTC_OFFSET_SECONDS * 1000);
    // 这里返回的是「本地日历日对应的 UTC 0:00」，调用方用 `getUTCFullYear/Month/Date`
    // 取日期分量即可。本地 8:00 = UTC 0:00，所以「加 8 小时后取 UTC 日分量」=
    // 「本地日分量」。
    // 见 `getLocalDateComponents` helper。
  }
}

/** 测试用时钟：把「现在」钉死，也可以随时拨动。 */
export class FixedClock implements Clock {
  private at: Date;

  constructor(at: Date) {
    this.at = at;
  }

  /** 从入库格式的 UTC 文本建钟，如 `"2026-09-10 08:00:00"`。
   *
   * 文本格式不合法时抛错——这是测试助手，写错就该当场炸。 */
  static at(text: string): FixedClock {
    const parsed = parseSqlTimestamp(text);
    if (!parsed) {
      throw new Error(`时间戳格式应为 \`${SQL_TIMESTAMP_FORMAT}\`，收到 ${JSON.stringify(text)}`);
    }
    return new FixedClock(parsed);
  }

  /** 拨到指定 `Date`。 */
  set(at: Date): void {
    this.at = at;
  }

  /** 从入库格式的 UTC 文本拨钟（同 `FixedClock.at` 但用于已有实例）。 */
  setAt(text: string): void {
    const parsed = parseSqlTimestamp(text);
    if (!parsed) {
      throw new Error(`时间戳格式应为 \`${SQL_TIMESTAMP_FORMAT}\`，收到 ${JSON.stringify(text)}`);
    }
    this.set(parsed);
  }

  now(): Date {
    return new Date(this.at.getTime());
  }

  nowSql(): string {
    return toSqlTimestamp(this.at);
  }

  today(): Date {
    return new Date(this.at.getTime() + LOCAL_UTC_OFFSET_SECONDS * 1000);
  }
}

/** 把本地日历日的年 / 月 / 日取出来（UTC 分量即本地分量，见上）。 */
export function getLocalDateComponents(date: Date): { year: number; month: number; day: number } {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** 渲染本地日历日为 `YYYY-MM-DD`。 */
export function formatLocalDate(date: Date): string {
  const c = getLocalDateComponents(date);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${c.year}-${pad(c.month)}-${pad(c.day)}`;
}