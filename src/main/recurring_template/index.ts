/**
 * 周期性模板命令层（ticket #24 / 平迁工单 #46）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/commands/recurring_template.rs` 的语义：
 * - `recurring_template` 表的 upsert / list / set_enabled
 * - 入参 → `derive_rrule` → `rrule_text` 列；DB 不重算
 * - `ends_on` / `ends_after_n` 二选一 + `project_id` / `sub_team_id` 至
 *   少一项非空（DB CHECK + 命令层预检双兜）
 * - 模板可停用（`enabled = 0`）而不删除——物化层只扫 `enabled = 1`
 *
 * 解析优先信任结构化字段，`rrule_text` 作 sanity check（ADR 0002）。
 *
 * 所有命令入参与返回都是稳定 DTO，不透传行结构。
 */

import type Database from "better-sqlite3";

import { AppError } from "../error.js";
import { parseSqlDate } from "../clock.js";
import type { AppState } from "../state.js";
import type {
  ListRecurringTemplatesArgs,
  RecurringEnds,
  RecurringFreq,
  RecurringHolidayBehavior,
  RecurringTemplate,
  SetRecurringTemplateEnabledArgs,
  StructuredRule,
  UpsertRecurringTemplateArgs,
} from "../types.js";

// ---------------------------------------------------------------------------
// byday bitmask（ADR 0002）
// ---------------------------------------------------------------------------

export const BYDAY_MO = 1 << 0;
export const BYDAY_TU = 1 << 1;
export const BYDAY_WE = 1 << 2;
export const BYDAY_TH = 1 << 3;
export const BYDAY_FR = 1 << 4;
export const BYDAY_SA = 1 << 5;
export const BYDAY_SU = 1 << 6;
export const BYDAY_ALL = BYDAY_MO | BYDAY_TU | BYDAY_WE | BYDAY_TH | BYDAY_FR | BYDAY_SA | BYDAY_SU;

const BYDAY_TABLE: ReadonlyArray<readonly [string, number]> = [
  ["MO", BYDAY_MO],
  ["TU", BYDAY_TU],
  ["WE", BYDAY_WE],
  ["TH", BYDAY_TH],
  ["FR", BYDAY_FR],
  ["SA", BYDAY_SA],
  ["SU", BYDAY_SU],
];

function bydayMaskOf(token: string): number | null {
  for (const [name, bit] of BYDAY_TABLE) {
    if (name === token) return bit;
  }
  return null;
}

/** 给定位掩码 → 字面量（按 MO→SU 顺序拼接）。掩码为 0 时返空串。 */
function bydayTokensOf(mask: number): string {
  const out: string[] = [];
  for (const [name, bit] of BYDAY_TABLE) {
    if ((mask & bit) !== 0) out.push(name);
  }
  return out.join(",");
}

// ---------------------------------------------------------------------------
// 频率 / 节假日字面量
// ---------------------------------------------------------------------------

function freqAsDb(freq: RecurringFreq): string {
  switch (freq) {
    case "daily":
      return "DAILY";
    case "weekly":
      return "WEEKLY";
    case "monthly":
      return "MONTHLY";
    case "yearly":
      return "YEARLY";
  }
}

function freqAsRrule(freq: RecurringFreq): string {
  return freqAsDb(freq);
}

function parseFreqDb(text: string): RecurringFreq {
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
      throw AppError.internal(`recurring_template.freq 未知字面量：${text}`);
  }
}

function holidayAsDb(value: RecurringHolidayBehavior): string {
  return value === "skip" ? "SKIP" : "SHIFT";
}

function parseHolidayDb(text: string): RecurringHolidayBehavior {
  switch (text) {
    case "SKIP":
      return "skip";
    case "SHIFT":
      return "shift";
    default:
      throw AppError.internal(`recurring_template.holiday_behavior 未知字面量：${text}`);
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 时区校验：v1 不引 chrono-tz，只允许 Asia/Shanghai。 */
export function validateIanaZone(zone: string): void {
  if (zone.trim().length === 0) {
    throw AppError.invalid("时区不能为空。");
  }
  if (zone !== "Asia/Shanghai") {
    throw AppError.invalid("本票仅支持 Asia/Shanghai 时区,跨时区场景归后续票。");
  }
}

function validateByhour(h: number): void {
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    throw AppError.invalid("小时须在 0–23 之间。");
  }
}

function validateByminute(m: number): void {
  if (!Number.isInteger(m) || m < 0 || m > 59) {
    throw AppError.invalid("分钟须在 0–59 之间。");
  }
}

function validateBydayMaskForFreq(freq: RecurringFreq, mask: number): void {
  if (!Number.isInteger(mask) || mask < 0 || mask >= 128) {
    throw AppError.invalid("星期掩码非法。");
  }
  if (freq === "weekly") {
    if (mask === 0) {
      throw AppError.invalid("每周规则必须至少选一天。");
    }
  } else if (mask !== 0) {
    throw AppError.invalid("仅每周规则能选星期;其它频率请留空。");
  }
}

function validateBymonthdayForFreq(freq: RecurringFreq, days: number[] | null): void {
  if (freq === "monthly") {
    if (days === null) {
      throw AppError.invalid("每月规则必须指定日期。");
    }
    if (days.length === 0) {
      throw AppError.invalid("每月规则至少指定一个日期。");
    }
    for (const d of days) {
      if (d === 0) {
        if (days.length !== 1) {
          throw AppError.invalid("「月末」只能单独使用,不能与其它日期混填。");
        }
      } else if (d >= 1 && d <= 31) {
        // 合法
      } else {
        throw AppError.invalid("日期须在 1–31 之间或填 0 表示月末。");
      }
    }
    return;
  }

  if (freq === "yearly") {
    if (days !== null) {
      for (const d of days) {
        if (!Number.isInteger(d) || d < 1 || d > 31) {
          throw AppError.invalid("日期须在 1–31 之间(年末规则不支持 0/月末)。");
        }
      }
    }
    return;
  }

  // daily / weekly
  if (days !== null) {
    throw AppError.invalid("仅每月/每年规则能指定日期。");
  }
}

function validateBymonthForFreq(freq: RecurringFreq, months: number[] | null): void {
  if (freq === "yearly") {
    if (months === null) {
      throw AppError.invalid("每年规则必须指定月份。");
    }
    if (months.length === 0) {
      throw AppError.invalid("每年规则至少指定一个月份。");
    }
    for (const m of months) {
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        throw AppError.invalid("月份须在 1–12 之间。");
      }
    }
    return;
  }

  if (months !== null) {
    throw AppError.invalid("仅每年规则能指定月份。");
  }
}

function validateEnds(ends: RecurringEnds): void {
  if (ends.kind === "on") {
    const date = ends.date;
    if (date.length !== 10) {
      throw AppError.invalid("终止日格式应为 YYYY-MM-DD。");
    }
    if (parseSqlDate(date) === null) {
      throw AppError.invalid("终止日格式不对,应形如 2026-12-31。");
    }
  } else {
    if (!Number.isInteger(ends.n) || ends.n < 1) {
      throw AppError.invalid("出现次数须 ≥ 1。");
    }
  }
}

// ---------------------------------------------------------------------------
// RRULE 派生（commands 入口的「结构化 → rrule_text」单写者）
// ---------------------------------------------------------------------------

function encodeBymonthdayList(days: number[]): string {
  return days.map((d) => (d === 0 ? "-1" : String(d))).join(",");
}

function encodeIntList(values: number[]): string {
  return values.map(String).join(",");
}

/**
 * 把 date ("YYYY-MM-DD") 变成 RRULE UNTIL 字面量
 * （UTC 当日 23:59:59Z——避免 wall-clock 跨日漂移）。
 */
function dateToUntil(date: string): string {
  const parsed = parseSqlDate(date);
  if (parsed === null) {
    throw AppError.internal(`dateToUntil 解析 ${JSON.stringify(date)} 失败`);
  }
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const d = String(parsed.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}T235959Z`;
}

/**
 * 校验结构化字段的内在一致性，然后派生 RRULE 字符串。
 *
 * 与原 `recurring::derive_rrule` 同语义：校验失败 → `AppError::InvalidArgument`
 * 给科长看的中文消息；DB 层只是把派生出来的字符串落到 `rrule_text` 列。
 */
export function deriveRrule(rule: StructuredRule): string {
  validateIanaZone(rule.ianaZone);
  validateByhour(rule.byhour);
  validateByminute(rule.byminute);
  validateBydayMaskForFreq(rule.freq, rule.bydayMask);
  validateBymonthdayForFreq(rule.freq, rule.bymonthday);
  validateBymonthForFreq(rule.freq, rule.bymonth);
  validateEnds(rule.ends);

  const parts: string[] = [];
  parts.push(`FREQ=${freqAsRrule(rule.freq)}`);

  if (rule.freq === "weekly") {
    parts.push(`BYDAY=${bydayTokensOf(rule.bydayMask)}`);
  }
  if (rule.bymonthday !== null) {
    parts.push(`BYMONTHDAY=${encodeBymonthdayList(rule.bymonthday)}`);
  }
  if (rule.bymonth !== null) {
    parts.push(`BYMONTH=${encodeIntList(rule.bymonth)}`);
  }
  parts.push(`BYHOUR=${rule.byhour}`);
  parts.push(`BYMINUTE=${rule.byminute}`);

  if (rule.ends.kind === "on") {
    parts.push(`UNTIL=${dateToUntil(rule.ends.date)}`);
  } else {
    parts.push(`COUNT=${rule.ends.n}`);
  }

  return parts.join(";");
}

// ---------------------------------------------------------------------------
// RRULE 反向解析（仅 sanity check 用途，不是真理来源）
// ---------------------------------------------------------------------------

/**
 * 把 RRULE 字符串解析回结构化字段——仅在 `rrule_text` sanity check 里用。
 *
 * 注意：`iana_zone` 与 `holiday_behavior` 不在 RRULE 字符串里携带，解析结果里
 * 用占位值（"Asia/Shanghai" / "skip"），调用方不会拿这两字段去做比较。
 */
export function parseRruleIntoStructured(text: string): {
  freq: RecurringFreq;
  bydayMask: number;
  bymonthday: number[] | null;
  bymonth: number[] | null;
  byhour: number;
  byminute: number;
  ends: RecurringEnds;
} {
  let freq: RecurringFreq | null = null;
  let bydayMask = 0;
  let bymonthday: number[] | null = null;
  let bymonth: number[] | null = null;
  let byhour = 9;
  let byminute = 0;
  let ends: RecurringEnds | null = null;

  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      throw AppError.internal(`RRULE 分句形如 KEY=VALUE，收到 ${JSON.stringify(part)}`);
    }
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    switch (key) {
      case "FREQ": {
        switch (value) {
          case "DAILY":
            freq = "daily";
            break;
          case "WEEKLY":
            freq = "weekly";
            break;
          case "MONTHLY":
            freq = "monthly";
            break;
          case "YEARLY":
            freq = "yearly";
            break;
          default:
            throw AppError.internal(`RRULE FREQ 未知取值：${JSON.stringify(value)}`);
        }
        break;
      }
      case "BYDAY": {
        bydayMask = 0;
        for (const token of value.split(",")) {
          const bit = bydayMaskOf(token);
          if (bit === null) {
            throw AppError.internal(`RRULE BYDAY 未知字面量：${JSON.stringify(token)}`);
          }
          bydayMask |= bit;
        }
        break;
      }
      case "BYMONTHDAY": {
        const v: number[] = [];
        for (const token of value.split(",")) {
          const parsed = Number.parseInt(token, 10);
          if (!Number.isFinite(parsed)) {
            throw AppError.internal(`RRULE BYMONTHDAY 非整数：${JSON.stringify(token)}`);
          }
          // RRULE 的 -1 = "末"（RFC 5545 BYMONTHDAY 接受 -1..-31），回填到结
          // 构化字段时折叠回 0——业务层只见一种表示。
          v.push(parsed === -1 ? 0 : parsed);
        }
        bymonthday = v;
        break;
      }
      case "BYMONTH": {
        const v: number[] = [];
        for (const token of value.split(",")) {
          const parsed = Number.parseInt(token, 10);
          if (!Number.isFinite(parsed)) {
            throw AppError.internal(`RRULE BYMONTH 非整数：${JSON.stringify(token)}`);
          }
          v.push(parsed);
        }
        bymonth = v;
        break;
      }
      case "BYHOUR": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) {
          throw AppError.internal(`RRULE BYHOUR 非整数：${JSON.stringify(value)}`);
        }
        byhour = parsed;
        break;
      }
      case "BYMINUTE": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) {
          throw AppError.internal(`RRULE BYMINUTE 非整数：${JSON.stringify(value)}`);
        }
        byminute = parsed;
        break;
      }
      case "UNTIL": {
        if (value.length !== 16 || !value.endsWith("Z") || value[8] !== "T") {
          throw AppError.internal(
            `RRULE UNTIL 应为 YYYYMMDDTHHMMSSZ，收到 ${JSON.stringify(value)}`,
          );
        }
        const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
        ends = { kind: "on", date };
        break;
      }
      case "COUNT": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) {
          throw AppError.internal(`RRULE COUNT 非整数：${JSON.stringify(value)}`);
        }
        ends = { kind: "after", n: parsed };
        break;
      }
      default:
        throw AppError.internal(
          `RRULE 含未知关键字：${JSON.stringify(key)}（v1 子集之外的扩展字段未启用）`,
        );
    }
  }

  if (freq === null) throw AppError.internal("RRULE 缺 FREQ");
  if (ends === null) throw AppError.internal("RRULE 缺 UNTIL 或 COUNT");
  return { freq, bydayMask, bymonthday, bymonth, byhour, byminute, ends };
}

// ---------------------------------------------------------------------------
// JSON 数组 ↔ TEXT 列
// ---------------------------------------------------------------------------

function encodeJsonArray(values: number[] | null): string | null {
  if (values === null) return null;
  return JSON.stringify(values);
}

function parseJsonIntArray(text: string | null): number[] | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error("顶层不是数组");
    }
    const out: number[] = [];
    for (const item of parsed) {
      if (typeof item !== "number" || !Number.isInteger(item)) {
        throw new Error("数组元素非整数");
      }
      out.push(item);
    }
    return out;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw AppError.internal(`recurring_template JSON 数组反序列化失败：${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 行 → DTO
// ---------------------------------------------------------------------------

interface RecurringTemplateRow {
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
  rrule_text: string;
  project_id: number | null;
  sub_team_id: number | null;
  enabled: number;
  notes: string | null;
  created_at: string;
}

const TEMPLATE_SELECT_COLUMNS =
  "id, name, freq, byday_mask, bymonthday, bymonth, byhour, byminute, " +
  "iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text, " +
  "project_id, sub_team_id, enabled, notes, created_at";

function rowToTemplate(row: RecurringTemplateRow): RecurringTemplate {
  const ends = rowToEnds(row.ends_on, row.ends_after_n);
  return {
    id: row.id,
    name: row.name,
    freq: parseFreqDb(row.freq),
    bydayMask: row.byday_mask,
    bymonthday: parseJsonIntArray(row.bymonthday),
    bymonth: parseJsonIntArray(row.bymonth),
    byhour: row.byhour,
    byminute: row.byminute,
    ianaZone: row.iana_zone,
    ends,
    holidayBehavior: parseHolidayDb(row.holiday_behavior),
    rruleText: row.rrule_text,
    projectId: row.project_id,
    subTeamId: row.sub_team_id,
    enabled: row.enabled !== 0,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function rowToEnds(endsOn: string | null, endsAfterN: number | null): RecurringEnds {
  // DB CHECK 已保证 XOR——落库后读到二者要么 date 要么 n。
  if (endsOn !== null && endsAfterN === null) {
    return { kind: "on", date: endsOn };
  }
  if (endsOn === null && endsAfterN !== null) {
    return { kind: "after", n: endsAfterN };
  }
  throw AppError.internal("recurring_template.ends_on/ends_after_n 同时为空或同时非空");
}

/** 读 `recurring_template` 行 + sanity check（ADR 0002）——instance 命令层
 *  也借这条入口（ticket #49），保证读出后 `rrule_text` 与结构化字段一致。 */
export function fetchTemplate(db: Database.Database, id: number): RecurringTemplate | null {
  const row = db
    .prepare<[number], RecurringTemplateRow>(
      `SELECT ${TEMPLATE_SELECT_COLUMNS} FROM recurring_template WHERE id = ?`,
    )
    .get(id);
  if (!row) return null;
  const template = rowToTemplate(row);
  sanityCheckRruleMatchesStructured(template);
  return template;
}

/** 比对 `template.rruleText` 与结构化字段是否一致（ADR 0002）。 */
function endsEqual(a: RecurringEnds, b: RecurringEnds): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "on" && b.kind === "on") return a.date === b.date;
  if (a.kind === "after" && b.kind === "after") return a.n === b.n;
  return false;
}

function sanityCheckRruleMatchesStructured(template: RecurringTemplate): void {
  const parsed = parseRruleIntoStructured(template.rruleText);
  // parsed 里的 holidayBehavior / ianaZone 是占位；只比对 RRULE 实际承
  // 载的字段。
  const mismatches: string[] = [];
  if (parsed.freq !== template.freq) mismatches.push("freq");
  if (parsed.bydayMask !== template.bydayMask) mismatches.push("bydayMask");
  if (
    JSON.stringify(parsed.bymonthday) !== JSON.stringify(template.bymonthday)
  ) {
    mismatches.push("bymonthday");
  }
  if (JSON.stringify(parsed.bymonth) !== JSON.stringify(template.bymonth)) {
    mismatches.push("bymonth");
  }
  if (parsed.byhour !== template.byhour) mismatches.push("byhour");
  if (parsed.byminute !== template.byminute) mismatches.push("byminute");
  if (!endsEqual(parsed.ends, template.ends)) {
    mismatches.push("ends");
  }
  if (mismatches.length > 0) {
    throw AppError.internal(
      `recurring_template id=${template.id} rrule_text 与结构化字段不一致：${mismatches.join(",")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 入参归一化
// ---------------------------------------------------------------------------

function requireNonBlank(value: string, message: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw AppError.invalid(message);
  return trimmed;
}

function trimToOption(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function ensureProjectExists(db: Database.Database, id: number): void {
  const row = db
    .prepare<[number], { id: number }>("SELECT id FROM project WHERE id = ?")
    .get(id);
  if (!row) throw AppError.invalid("所属项目不存在。");
}

function ensureSubTeamExists(db: Database.Database, id: number): void {
  const row = db
    .prepare<[number], { id: number }>("SELECT id FROM sub_team WHERE id = ?")
    .get(id);
  if (!row) throw AppError.invalid("所属子组不存在。");
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/**
 * upsert 模板：`id = null` 新建，`id = <n>` 编辑。
 *
 * `rrule_text` 在事务外由 `deriveRrule` 派生，DB 不重算（票面 AC）；写库与
 * 读回都不再二次解析 RRULE——结构化字段才是真理来源。
 *
 * 编辑时**刻意不改 `enabled`**：季节性事务可停用，启停由
 * `setRecurringTemplateEnabled` 单独管；upsert 不应顺手把停用的模板复
 * 活。
 */
export function upsertRecurringTemplate(
  state: AppState,
  args: UpsertRecurringTemplateArgs,
): RecurringTemplate {
  const name = requireNonBlank(args.name, "模板名称不能为空。");
  const rruleText = deriveRrule(args.rule);
  const now = state.clock.nowSql();
  const notes = trimToOption(args.notes);

  if (args.projectId !== null) ensureProjectExists(state.db, args.projectId);
  if (args.subTeamId !== null) ensureSubTeamExists(state.db, args.subTeamId);

  const bymonthdayJson = encodeJsonArray(args.rule.bymonthday);
  const bymonthJson = encodeJsonArray(args.rule.bymonth);

  // 先算 id：编辑就是 args.id；新建由 lastInsertRowid 决定。
  // 放进闭包里让事务能写，再在事务外 fetch。
  let insertedId: number | null = null;
  const tx = state.db.transaction(() => {
    if (args.id !== null) {
      const result = state.db
        .prepare(
          `UPDATE recurring_template
              SET name             = ?,
                  freq             = ?,
                  byday_mask       = ?,
                  bymonthday       = ?,
                  bymonth          = ?,
                  byhour           = ?,
                  byminute         = ?,
                  iana_zone        = ?,
                  ends_on          = ?,
                  ends_after_n     = ?,
                  holiday_behavior = ?,
                  rrule_text       = ?,
                  project_id       = ?,
                  sub_team_id      = ?,
                  notes            = ?
            WHERE id = ?`,
        )
        .run(
          name,
          freqAsDb(args.rule.freq),
          args.rule.bydayMask,
          bymonthdayJson,
          bymonthJson,
          args.rule.byhour,
          args.rule.byminute,
          args.rule.ianaZone,
          endsOnDb(args.rule.ends),
          endsAfterNDb(args.rule.ends),
          holidayAsDb(args.rule.holidayBehavior),
          rruleText,
          args.projectId,
          args.subTeamId,
          notes,
          args.id,
        );
      if (result.changes === 0) {
        throw AppError.invalid("模板不存在或已被删除。");
      }
      insertedId = args.id;
    } else {
      const result = state.db
        .prepare(
          `INSERT INTO recurring_template
              (name, freq, byday_mask, bymonthday, bymonth, byhour, byminute,
               iana_zone, ends_on, ends_after_n, holiday_behavior, rrule_text,
               project_id, sub_team_id, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          name,
          freqAsDb(args.rule.freq),
          args.rule.bydayMask,
          bymonthdayJson,
          bymonthJson,
          args.rule.byhour,
          args.rule.byminute,
          args.rule.ianaZone,
          endsOnDb(args.rule.ends),
          endsAfterNDb(args.rule.ends),
          holidayAsDb(args.rule.holidayBehavior),
          rruleText,
          args.projectId,
          args.subTeamId,
          notes,
          now,
        );
      insertedId = Number(result.lastInsertRowid);
    }
  });

  // 进入事务取 id，再事务外 fetch（fetch 自带 sanity check）。
  tx();
  if (insertedId === null) {
    throw AppError.internal("recurring_template upsert 后 id 未确定");
  }
  const fetched = fetchTemplate(state.db, insertedId);
  if (!fetched) {
    throw AppError.internal(`recurring_template id=${insertedId} 立即查不到,数据库状态异常`);
  }
  return fetched;
}

/**
 * 列出模板。默认只看启用（`enabled = 1`），`includeDisabled = true` 含已
 * 停用的——便于"按模板管理"页面看到全部。排序：启用优先 + 创建时间升序。
 *
 * 读路径的 `rrule_text` sanity check 在 `rowToTemplate` 后逐行跑——任一
 * 行漂移就让整个 list 抛 Internal，避免前端拿到自相矛盾的 DTO。
 */
export function listRecurringTemplates(
  state: AppState,
  args: ListRecurringTemplatesArgs,
): RecurringTemplate[] {
  const where = args.includeDisabled ? "" : " WHERE enabled = 1";
  const sql = `SELECT ${TEMPLATE_SELECT_COLUMNS}
                 FROM recurring_template
                 ${where}
                ORDER BY enabled DESC, created_at ASC, id ASC`;
  const rows = state.db.prepare<[], RecurringTemplateRow>(sql).all();
  return rows.map((row) => {
    const template = rowToTemplate(row);
    sanityCheckRruleMatchesStructured(template);
    return template;
  });
}

/**
 * 启用 / 停用模板——季节性事务可以停用而不删除（票面 AC）。
 *
 * 模板不存在 / 已被物理删除 → INVALID_ARGUMENT；状态相同时**仍写库**，不
 * 去重——DB 一次 UPDATE 代价远低于"先查再决定"。
 */
export function setRecurringTemplateEnabled(
  state: AppState,
  args: SetRecurringTemplateEnabledArgs,
): RecurringTemplate {
  const result = state.db
    .prepare("UPDATE recurring_template SET enabled = ? WHERE id = ?")
    .run(args.enabled ? 1 : 0, args.id);
  if (result.changes === 0) {
    throw AppError.invalid("模板不存在或已被删除。");
  }
  const fetched = fetchTemplate(state.db, args.id);
  if (!fetched) throw AppError.internal(`recurring_template id=${args.id} 查询不一致`);
  return fetched;
}

// ---------------------------------------------------------------------------
// `EndsSpec` → SQL 列值
// ---------------------------------------------------------------------------

function endsOnDb(ends: RecurringEnds): string | null {
  return ends.kind === "on" ? ends.date : null;
}

function endsAfterNDb(ends: RecurringEnds): number | null {
  return ends.kind === "after" ? ends.n : null;
}