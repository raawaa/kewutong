/**
 * 外键存在性预检——命令层复用的「记录存在吗？」单源。
 *
 * 每个域（personnel / project / task / recurring_template）原本各写
 * 一份 `ensureXxxExists`，字符串资源 + 中文消息分散到 4+ 文件。集中后
 * 一处定义,新增域只要 import + 调一行。
 */

import type Database from "better-sqlite3";

/** 给「项目负责人不存在」一类业务专属中文消息留扩展点——错误码是统一的 `INVALID_ARGUMENT`。 */
function ensureExists(
  db: Database.Database,
  table: string,
  id: number,
  message: string,
): void {
  const row = db
    .prepare<[number], { id: number }>(`SELECT id FROM ${table} WHERE id = ?`)
    .get(id);
  if (!row) throw AppError.invalid(message);
}

// 拆成具体 helper 暴露给调用方——既保留「表名不出现在业务代码」的可读性,
import { AppError } from "../error.js";

/** 项目负责人（person 表）必须已存在；不存在 → 中文错误。 */
export function ensurePersonExists(db: Database.Database, id: number): void {
  ensureExists(db, "person", id, "负责人不存在,请先在人员管理里录入。");
}

/** 子组（sub_team 表）必须已存在；不存在 → 中文错误。 */
export function ensureSubTeamExists(db: Database.Database, id: number): void {
  ensureExists(db, "sub_team", id, "所属子组不存在。");
}

/** 项目（project 表）必须已存在；不存在 → 中文错误。 */
export function ensureProjectExists(db: Database.Database, id: number): void {
  ensureExists(db, "project", id, "所属项目不存在。");
}