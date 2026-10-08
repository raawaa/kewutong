import { describe, expect, it } from "vitest";

import {
  FixedClock,
  formatLocalDate,
  parseSqlDate,
  parseSqlTimestamp,
  toSqlDate,
  toSqlTimestamp,
} from "./clock.js";

describe("clock (ADR 0006)", () => {
  it("入库时间戳往返", () => {
    const text = "2026-10-01 15:04:05";
    expect(toSqlTimestamp(parseSqlTimestamp(text)!)).toBe(text);
  });

  it("非标准格式解析失败而不是静默兜底", () => {
    expect(parseSqlTimestamp("2026-10-01T15:04:05Z")).toBeNull();
    expect(parseSqlTimestamp("")).toBeNull();
  });

  it("入库日期格式往返", () => {
    const date = parseSqlDate("2026-10-01")!;
    expect(toSqlDate(date)).toBe("2026-10-01");
  });

  it("非标准日期格式解析失败", () => {
    expect(parseSqlDate("2026/10/01")).toBeNull();
    expect(parseSqlDate("2026-10-01 00:00:00")).toBeNull();
    expect(parseSqlDate("")).toBeNull();
  });

  it("FixedClock 把现在钉在给定时刻", () => {
    const clock = FixedClock.at("2026-09-10 08:00:00");
    expect(clock.nowSql()).toBe("2026-09-10 08:00:00");
  });

  it("FixedClock 可以拨动", () => {
    const clock = FixedClock.at("2026-09-10 08:00:00");
    clock.setAt("2027-01-01 00:00:00");
    expect(clock.nowSql()).toBe("2027-01-01 00:00:00");
  });

  it("UTC 20:00 在科长本地（UTC+8）已经是次日 04:00 → 'today' 跟着本地走", () => {
    const clock = FixedClock.at("2026-09-10 20:00:00");
    expect(formatLocalDate(clock.today())).toBe("2026-09-11");
  });
});