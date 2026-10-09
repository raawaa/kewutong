/**
 * 导出命令层（ticket #53）的 TypeScript 平迁。
 *
 * 承接原 `src-tauri/src/commands/export.rs` 的语义：
 * - 整库 JSON 导出 / 导入 = 回环等价（round-trip）—— 用于备份 / 迁移
 * - 当前视图 CSV 导出 —— 发给领导
 *
 * 三个命令：
 * - `exportDatabaseJson(state)` → 全库 JSON 字符串 + 元信息
 * - `importDatabaseJson(state, { jsonText })` → 表 / 行计数摘要
 * - `exportTasksCsv(state)` → CSV 文本 + 行数
 *
 * 所有命令入参与返回都是稳定 DTO，不透传行结构。
 *
 * 不参与导出的表：
 * - `_migrations` —— 迁移历史，导入不会跨版本覆盖
 * - `task_fts` —— FTS5 影子表，由 task INSERT 触发器同步
 * - `materialization_meta` —— 物化元数据，导入后由下一次 tick 重建
 *
 * JSON 文本列（`bymonthday` / `bymonth` / `payload`）导出时解析为嵌套
 * JSON 值，导入时序列化为文本——保证 round-trip 形状对齐。
 */

import type { DatabaseSync } from "node:sqlite";

import { AppError } from "../error.js";
import { schemaVersion } from "../db.js";
import type { AppState } from "../state.js";
import type {
  DatabaseExport as DatabaseExportDto,
  DatabaseImportSummary,
  ImportDatabaseJsonArgs,
  TasksCsvExport as TasksCsvExportDto,
} from "../types.js";
import { withTx } from "../sqlite.js";

/** `importDatabaseJson` 入参——从 `@/main/types` 重新导出便于调用方 import 单一模块。 */
export type { ImportDatabaseJsonArgs };

// ---------------------------------------------------------------------------
// 表元数据 —— 导出 / 导入顺序的单一来源
// ---------------------------------------------------------------------------

/**
 * 一张表的导出元数据。`columns` 是 SELECT 列表（决定导出形状）。
 *
 * 顺序按 FK 安全删 / 插排：子表在前（导出时先 SELECT、删除时先
 * DELETE），父表在后；导入时反向走。**新增 / 删表都要改这里**，否则
 * round-trip 不一致。
 */
interface TableSpec {
  name: string;
  columns: readonly string[];
}

/**
 * 整库导出的表清单 + FK 安全的删 / 插顺序。
 *
 * Schema check: src-tauri/src/commands/export.rs:92-194。
 */
const TABLES: readonly TableSpec[] = [
  {
    name: "task",
    columns: [
      "id",
      "title",
      "description",
      "status",
      "owner_person_id",
      "project_id",
      "due_date",
      "recurring_template_id",
      "scheduled_at",
      "original_scheduled_at",
      "rescheduled_from_id",
      "created_at",
      "updated_at",
      "blocked_at",
      "blocked_reason",
      "waiting_on_person_id",
      "sub_team_id",
      "is_sample",
    ],
  },
  {
    name: "notification_log",
    columns: [
      "id",
      "triggered_at",
      "kind",
      "related_task_id",
      "related_template_id",
      "payload",
      "viewed_at",
    ],
  },
  {
    name: "holiday_override",
    // 无 id 列；`date` 是 PRIMARY KEY，排序按 date 走。
    columns: ["date", "kind"],
  },
  {
    name: "recurring_template",
    columns: [
      "id",
      "name",
      "freq",
      "byday_mask",
      "bymonthday",
      "bymonth",
      "byhour",
      "byminute",
      "iana_zone",
      "ends_on",
      "ends_after_n",
      "holiday_behavior",
      "rrule_text",
      "project_id",
      "sub_team_id",
      "enabled",
      "notes",
      "created_at",
      "is_sample",
    ],
  },
  {
    name: "project",
    columns: [
      "id",
      "name",
      "owner_person_id",
      "sub_team_id",
      "start_date",
      "due_date",
      "notes",
      "created_at",
      "is_sample",
    ],
  },
  {
    name: "person",
    columns: [
      "id",
      "name",
      "sub_team_id",
      "contact",
      "deactivated_at",
      "created_at",
      "is_sample",
    ],
  },
  {
    name: "sub_team",
    columns: ["id", "name", "description", "sort_order", "created_at", "is_sample"],
  },
];

/** 导出时这 3 列是 JSON 文本——解析回嵌套 Value 让导出更易读。 */
const JSON_TEXT_COLUMNS: ReadonlySet<string> = new Set([
  "bymonthday",
  "bymonth",
  "payload",
]);

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/**
 * 整库 JSON 导出。
 *
 * 输出是稳定 UTF-8 JSON 字符串（缩进 2 空格），前端拿到存盘即可。
 * `schemaVersion` 沿用 `schemaVersion`，导入时校验一致。
 */
export function exportDatabaseJson(state: AppState): DatabaseExportDto {
  const version = schemaVersion(state.db);
  if (version === null) {
    throw AppError.internal("迁移历史为空，数据库未初始化。");
  }
  const exportedAt = state.clock.nowSql();

  const tables: Record<string, unknown[]> = {};
  for (const spec of TABLES) {
    tables[spec.name] = dumpTable(state.db, spec);
  }

  const payload = {
    schemaVersion: version,
    exportedAt,
    tables,
  };
  const jsonText = JSON.stringify(payload, null, 2);
  return {
    jsonText,
    schemaVersion: version,
    byteSize: jsonText.length,
  };
}

/**
 * 整库 JSON 导入（回环）。
 *
 * 流程：
 * 1. 解析 JSON，校验 `schemaVersion` 与当前库一致。
 * 2. 在单个事务里，按 FK 子 → 父顺序清空全部业务表。
 * 3. 按 FK 父 → 子顺序 INSERT 各表行。
 * 4. 整个事务包在 `PRAGMA foreign_keys = OFF` 下——避开"清空时
 *    task→template FK 互锁"与"插入时 template→sub_team 触发"。
 *
 * `_migrations` / `task_fts` / `materialization_meta` 不在 TABLES 中：
 * `_migrations` 不动；`task_fts` 由 task INSERT 触发器同步填；
 * `materialization_meta` 删除后由下一次 `materializeIfNewWeek` 自然重建。
 */
export function importDatabaseJson(
  state: AppState,
  args: ImportDatabaseJsonArgs,
): DatabaseImportSummary {
  const currentVersion = schemaVersion(state.db);
  if (currentVersion === null) {
    throw AppError.internal("迁移历史为空，数据库未初始化。");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(args.jsonText);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw AppError.invalid(`导入 JSON 解析失败：${detail}`);
  }

  if (!isObject(parsed)) {
    throw AppError.invalid("导入 JSON 顶层必须是对象。");
  }
  const importedVersion = parsed.schemaVersion;
  if (typeof importedVersion !== "number" || !Number.isInteger(importedVersion)) {
    throw AppError.invalid("导入 JSON 缺少 schemaVersion 字段。");
  }
  if (importedVersion !== currentVersion) {
    throw AppError.invalid(
      `导入 schema 版本（${importedVersion}）与当前库（${currentVersion}）不一致，请用同版本 app 导出。`,
    );
  }
  if (!isObject(parsed.tables)) {
    throw AppError.invalid("导入 JSON 缺少 tables 字段。");
  }
  const tablesObj = parsed.tables;

  let tablesImported = 0;
  let rowsImported = 0;

  withTx(state.db, () => {
    state.db.exec("PRAGMA foreign_keys = OFF");

    // 1) 清空——子 → 父顺序。
    for (const spec of TABLES) {
      state.db.prepare(`DELETE FROM ${spec.name}`).run();
    }

    // 2) 重新插入——父 → 子顺序。
    for (const spec of [...TABLES].reverse()) {
      const arr = tablesObj[spec.name];
      if (!Array.isArray(arr)) continue;

      const placeholders = new Array(spec.columns.length).fill("?").join(",");
      const sql = `INSERT INTO ${spec.name} (${spec.columns.join(",")}) VALUES (${placeholders})`;
      const stmt = state.db.prepare(sql);

      let count = 0;
      for (const rowValue of arr) {
        if (!isObject(rowValue)) {
          throw AppError.invalid(`表 ${spec.name} 的某行不是对象`);
        }
        const params: unknown[] = [];
        for (const col of spec.columns) {
          params.push(jsonToSql(rowValue[col] ?? null));
        }
        stmt.run(...params);
        count += 1;
      }
      rowsImported += count;
      if (count > 0) tablesImported += 1;
    }

    state.db.exec("PRAGMA foreign_keys = ON");
  });

  return { tablesImported, rowsImported };
}

/**
 * 当前视图 CSV 导出。
 *
 * "当前视图" = 全部在飞任务（剔除 Done / Cancelled），按 `effective_date`
 * 升序——与 `list_tasks` 的默认排序对齐，前端把视图上的内容直接落
 * CSV，发给领导时与他看到的一致。
 *
 * owner 是 INNER JOIN——若 task 行因导入漂移产生了悬空 owner，这条会
 * 被静默丢弃（对应 AC「导入后无悬空 FK」由 `importDatabaseJson` 的
 * round-trip 测试兜底）。
 */
export function exportTasksCsv(state: AppState): TasksCsvExportDto {
  const sql = `
    SELECT t.id, t.title, t.status,
           COALESCE(p.name, '') AS owner_name,
           COALESCE(s.name, '') AS owner_sub_team,
           COALESCE(pr.name, '') AS project_name,
           COALESCE(t.due_date, '') AS due_date,
           COALESCE(t.scheduled_at, '') AS scheduled_at,
           CASE WHEN t.recurring_template_id IS NOT NULL THEN 'true' ELSE 'false' END AS is_recurring,
           COALESCE(t.blocked_at, '') AS blocked_at,
           COALESCE(t.blocked_reason, '') AS blocked_reason,
           COALESCE(wp.name, '') AS waiting_on_name,
           t.created_at
      FROM task t
      JOIN person p ON p.id = t.owner_person_id
      LEFT JOIN sub_team s ON s.id = p.sub_team_id
      LEFT JOIN project pr ON pr.id = t.project_id
      LEFT JOIN person wp ON wp.id = t.waiting_on_person_id
     WHERE t.status NOT IN ('Done','Cancelled')
     ORDER BY COALESCE(t.due_date, substr(t.scheduled_at, 1, 10)) ASC,
              t.created_at ASC,
              t.id ASC
  `;
  const header: readonly string[] = [
    "id",
    "title",
    "status",
    "owner",
    "sub_team",
    "project",
    "due_date",
    "scheduled_at",
    "is_recurring",
    "blocked_at",
    "blocked_reason",
    "waiting_on",
    "created_at",
  ];
  const out: string[] = [];
  pushCsvRow(out, header);
  let rowCount = 0;
  const rows = state.db.prepare<[], TaskCsvRow>(sql).all();
  for (const row of rows) {
    pushCsvRow(out, [
      String(row.id),
      row.title,
      row.status,
      row.owner_name,
      row.owner_sub_team,
      row.project_name,
      row.due_date,
      row.scheduled_at,
      row.is_recurring,
      row.blocked_at,
      row.blocked_reason,
      row.waiting_on_name,
      row.created_at,
    ]);
    rowCount += 1;
  }
  return {
    csvText: out.join(""),
    rowCount,
  };
}

// ---------------------------------------------------------------------------
// 内部辅助 —— SELECT 行 → JSON 对象
// ---------------------------------------------------------------------------

interface TaskCsvRow {
  id: number;
  title: string;
  status: string;
  owner_name: string;
  owner_sub_team: string;
  project_name: string;
  due_date: string;
  scheduled_at: string;
  is_recurring: string;
  blocked_at: string;
  blocked_reason: string;
  waiting_on_name: string;
  created_at: string;
}

/**
 * 一张表的所有行 SELECT 成 `Record<string, unknown>[]`。
 *
 * `holiday_override` 表只有 `date` 主键，无 `id` 列；其余表都按 id 排。
 */
function dumpTable(db: DatabaseSync, spec: TableSpec): Record<string, unknown>[] {
  const orderBy = spec.name === "holiday_override" ? "date" : "id";
  const sql = `SELECT ${spec.columns.join(",")} FROM ${spec.name} ORDER BY ${orderBy} ASC`;
  const stmt = db.prepare(sql);
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map((row) => rowToJsonObject(row, spec.columns));
}

/**
 * 一行 → `Record<column, json_value>`。
 *
 * `bymonthday` / `bymonth` / `payload` 是 JSON 字符串列——解析回
 * 嵌套 Value，让导出后易读（解析失败时回退到字面字符串，与 Rust 端
 * 一致）。
 */
function rowToJsonObject(
  row: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    const value = row[col];
    if (value === null || value === undefined) {
      out[col] = null;
      continue;
    }
    if (JSON_TEXT_COLUMNS.has(col) && typeof value === "string") {
      try {
        out[col] = JSON.parse(value);
        continue;
      } catch {
        out[col] = value;
        continue;
      }
    }
    out[col] = value;
  }
  return out;
}

/**
 * JSON 值 → node:sqlite SQLInputValue 兼容值。
 *
 * JSON `null` → SQL `NULL`；布尔 → 0/1；数字 → 整数或实数；字符串
 * → 文本；对象 / 数组 → JSON 字符串（目标列必须是 TEXT）。
 */
function jsonToSql(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** 收窄类型：判断值是否为普通对象（非数组 / 非 null）。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// CSV 转义（RFC 4180）
// ---------------------------------------------------------------------------

/**
 * 一行 CSV 字段的转义 + 拼装（RFC 4180）：
 * - 含 `,` / `"` / `\n` / `\r` 的字段用双引号包裹；
 * - 字段内的双引号转义为 `""`；
 * - 行结束符固定 CRLF（Excel / WPS 兼容性最好）。
 */
export function pushCsvRow(out: string[], fields: readonly string[]): string {
  for (let i = 0; i < fields.length; i += 1) {
    if (i > 0) out.push(",");
    const field = fields[i] ?? "";
    if (needsCsvQuoting(field)) {
      out.push('"');
      for (const ch of field) {
        if (ch === '"') out.push('""');
        else out.push(ch);
      }
      out.push('"');
    } else {
      out.push(field);
    }
  }
  out.push("\r\n");
  return out.join("");
}

/** RFC 4180：含 `,` / `"` / `\n` / `\r` 的字段需要双引号包裹。 */
export function needsCsvQuoting(field: string): boolean {
  return (
    field.includes(",") ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r")
  );
}