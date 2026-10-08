import { describe, expect, it } from "vitest";

import { AppError } from "../error.js";
import { freshDb } from "../test/commands/fresh_db.js";
import * as Export from "./index.js";

/**
 * 本地 fixture：复用项目统一的 `freshDb`——后者已经处理好「跑 migrations
 * + 清掉 V007 示例数据 + FixedClock + 注入 state」。
 */
function freshExportDb(options: { now?: string } = {}) {
  return freshDb(options);
}

// ---------------------------------------------------------------------------
// CSV 转义（unit tests —— 直接对齐 Rust 端 src-tauri/src/commands/export.rs:530-604）
// ---------------------------------------------------------------------------

describe("export / CSV 转义（RFC 4180）", () => {
  it("普通字段不加引号", () => {
    const out: string[] = [];
    Export.pushCsvRow(out, ["id", "title", "owner"]);
    expect(out.join("")).toBe("id,title,owner\r\n");
  });

  it("含逗号字段要加引号", () => {
    const out: string[] = [];
    Export.pushCsvRow(out, ["a,b"]);
    expect(out.join("")).toBe('"a,b"\r\n');
  });

  it('含双引号字段要加引号 且内部双引号转义', () => {
    const out: string[] = [];
    Export.pushCsvRow(out, ['hello "world"']);
    expect(out.join("")).toBe('"hello ""world"""\r\n');
  });

  it("含换行字段要加引号", () => {
    const out: string[] = [];
    Export.pushCsvRow(out, ["line1\nline2"]);
    expect(out.join("")).toBe('"line1\nline2"\r\n');
  });

  it("中文不加引号", () => {
    const out: string[] = [];
    Export.pushCsvRow(out, ["张三", "周一例会"]);
    expect(out.join("")).toBe("张三,周一例会\r\n");
  });

  it("中文含逗号要加引号", () => {
    const out: string[] = [];
    Export.pushCsvRow(out, ["张三,暖通组"]);
    expect(out.join("")).toBe('"张三,暖通组"\r\n');
  });

  it("空字符串输出空字段", () => {
    const out: string[] = [];
    Export.pushCsvRow(out, ["a", "", "b"]);
    expect(out.join("")).toBe("a,,b\r\n");
  });

  it("CRLF 行结束 保证 Excel / WPS 兼容", () => {
    const out: string[] = [];
    Export.pushCsvRow(out, ["x"]);
    expect(out.join("")).toBe("x\r\n");
  });
});

describe("export / needsCsvQuoting", () => {
  it("覆盖四类边界", () => {
    expect(Export.needsCsvQuoting("")).toBe(false);
    expect(Export.needsCsvQuoting("普通文本")).toBe(false);
    expect(Export.needsCsvQuoting("中文 + 123")).toBe(false);
    expect(Export.needsCsvQuoting("a,b")).toBe(true);
    expect(Export.needsCsvQuoting('a"b')).toBe(true);
    expect(Export.needsCsvQuoting("a\nb")).toBe(true);
    expect(Export.needsCsvQuoting("a\rb")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 整库 JSON 导出 / 导入
// ---------------------------------------------------------------------------

describe("export / exportDatabaseJson", () => {
  it("空库导出合法 JSON 包含 schemaVersion", () => {
    const { state, close } = freshExportDb();
    try {
      const result = Export.exportDatabaseJson(state);
      const parsed = JSON.parse(result.jsonText) as {
        schemaVersion: number;
        exportedAt: string;
        tables: Record<string, unknown[]>;
      };
      expect(parsed.schemaVersion).toBe(result.schemaVersion);
      expect(parsed.schemaVersion).toBeGreaterThan(0);
      expect(parsed.exportedAt).toBe(state.clock.nowSql());
      // 空库时所有表都是空数组
      for (const tableName of [
        "task",
        "notification_log",
        "holiday_override",
        "recurring_template",
        "project",
        "person",
        "sub_team",
      ]) {
        expect(parsed.tables[tableName]).toEqual([]);
      }
      expect(result.byteSize).toBe(result.jsonText.length);
    } finally {
      close();
    }
  });

  it("导出非空库时记录表行 / 含 JSON 文本列（bymonthday / payload）", () => {
    const { state, db, close } = freshExportDb({ now: "2026-09-10 08:00:00" });
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO sub_team (name) VALUES (?)").run("一组");
        db.prepare(
          "INSERT INTO person (name, sub_team_id, contact) VALUES (?, ?, ?)",
        ).run("张三", 1, "1");
        db.prepare(
          `INSERT INTO recurring_template
             (name, freq, rrule_text, sub_team_id, bymonthday, bymonth, ends_after_n)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "月报",
          "MONTHLY",
          "RRULE:FREQ=MONTHLY",
          1,
          JSON.stringify([1, 15]),
          null,
          12,
        );
        db.prepare(
          `INSERT INTO notification_log (kind, payload, related_template_id)
           VALUES (?, ?, ?)`,
        ).run(
          "due_24h",
          JSON.stringify({ kind: "due_24h", task_id: 999 }),
          1,
        );
      })();

      const result = Export.exportDatabaseJson(state);
      const parsed = JSON.parse(result.jsonText) as {
        tables: Record<string, Array<Record<string, unknown>>>;
      };
      expect(parsed.tables.sub_team?.length).toBe(1);
      expect(parsed.tables.person?.length).toBe(1);
      expect(parsed.tables.recurring_template?.length).toBe(1);
      // bymonthday 是 JSON 文本列——导出时应被解析为数组
      expect(parsed.tables.recurring_template?.[0]?.bymonthday).toEqual([1, 15]);
      expect(parsed.tables.recurring_template?.[0]?.bymonth).toBeNull();
      // payload 同理
      expect(parsed.tables.notification_log?.[0]?.payload).toEqual({
        kind: "due_24h",
        task_id: 999,
      });
    } finally {
      close();
    }
  });
});

describe("export / importDatabaseJson", () => {
  it("round-trip：export → import 后 schemaVersion 一致", () => {
    const { state, db, close } = freshExportDb({ now: "2026-09-10 08:00:00" });
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO sub_team (name) VALUES (?)").run("一组");
        db.prepare(
          "INSERT INTO person (name, sub_team_id, contact) VALUES (?, ?, ?)",
        ).run("张三", 1, "1");
        db.prepare(
          "INSERT INTO task (title, status, owner_person_id) VALUES (?, ?, ?)",
        ).run("待办", "Open", 1);
      })();

      const exported = Export.exportDatabaseJson(state);

      // 第二份空库，导入
      const target = freshExportDb({ now: "2026-09-11 08:00:00" });
      try {
        const summary = Export.importDatabaseJson(target.state, {
          jsonText: exported.jsonText,
        });
        expect(summary.rowsImported).toBe(3); // sub_team + person + task
        // 三张表都至少有一行
        expect(summary.tablesImported).toBe(3);

        // target 库里能查到相同的行
        const teamCount = target.db
          .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sub_team")
          .get()?.c;
        expect(teamCount).toBe(1);
        const personCount = target.db
          .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM person")
          .get()?.c;
        expect(personCount).toBe(1);
        const taskCount = target.db
          .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM task")
          .get()?.c;
        expect(taskCount).toBe(1);
      } finally {
        target.close();
      }
    } finally {
      close();
    }
  });

  it("schemaVersion 不一致时拒绝", () => {
    const { state, close } = freshExportDb();
    try {
      const currentVersion = Export.exportDatabaseJson(state).schemaVersion;
      expect(() =>
        Export.importDatabaseJson(state, {
          jsonText: JSON.stringify({
            schemaVersion: currentVersion + 1,
            exportedAt: "2026-09-10T08:00:00Z",
            tables: {},
          }),
        }),
      ).toThrow(/schema 版本/);
    } finally {
      close();
    }
  });

  it("schemaVersion 缺失时拒绝", () => {
    const { state, close } = freshExportDb();
    try {
      expect(() =>
        Export.importDatabaseJson(state, {
          jsonText: JSON.stringify({
            exportedAt: "2026-09-10T08:00:00Z",
            tables: {},
          }),
        }),
      ).toThrow(/缺少 schemaVersion/);
    } finally {
      close();
    }
  });

  it("JSON 解析失败时拒绝（中文错误）", () => {
    const { state, close } = freshExportDb();
    try {
      expect(() =>
        Export.importDatabaseJson(state, { jsonText: "not json {" }),
      ).toThrow(/解析失败/);
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// CSV 导出
// ---------------------------------------------------------------------------

describe("export / exportTasksCsv", () => {
  it("表头行与期望一致", () => {
    const { state, close } = freshExportDb();
    try {
      const result = Export.exportTasksCsv(state);
      const firstLine = result.csvText.split("\r\n")[0];
      expect(firstLine).toBe(
        "id,title,status,owner,sub_team,project,due_date,scheduled_at,is_recurring,blocked_at,blocked_reason,waiting_on,created_at",
      );
    } finally {
      close();
    }
  });

  it("空库返回 header + 0 行", () => {
    const { state, close } = freshExportDb();
    try {
      const result = Export.exportTasksCsv(state);
      // 1 行 header + 一个尾部 CRLF
      const lines = result.csvText.split("\r\n");
      expect(lines[0]?.length).toBeGreaterThan(0);
      expect(lines[1]).toBe("");
      expect(result.rowCount).toBe(0);
    } finally {
      close();
    }
  });

  it("Done / Cancelled 不在导出范围", () => {
    const { state, db, close } = freshExportDb();
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO sub_team (name) VALUES (?)").run("一组");
        db.prepare(
          "INSERT INTO person (name, sub_team_id, contact) VALUES (?, ?, ?)",
        ).run("张三", 1, "1");
        db.prepare(
          "INSERT INTO task (title, status, owner_person_id) VALUES (?, ?, ?)",
        ).run("待办", "Open", 1);
        db.prepare(
          "INSERT INTO task (title, status, owner_person_id) VALUES (?, ?, ?)",
        ).run("已完成", "Done", 1);
        db.prepare(
          "INSERT INTO task (title, status, owner_person_id) VALUES (?, ?, ?)",
        ).run("已取消", "Cancelled", 1);
      })();

      const result = Export.exportTasksCsv(state);
      expect(result.rowCount).toBe(1);
      expect(result.csvText).toContain("待办");
      expect(result.csvText).not.toContain("已完成");
      expect(result.csvText).not.toContain("已取消");
    } finally {
      close();
    }
  });

  it("含逗号 / 双引号的字段会被 RFC 4180 转义", () => {
    const { state, db, close } = freshExportDb({ now: "2026-09-10 08:00:00" });
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO sub_team (name) VALUES (?)").run("张三,暖通组");
        db.prepare(
          "INSERT INTO person (name, sub_team_id, contact) VALUES (?, ?, ?)",
        ).run("甲 \"乙\" 丙", 1, "1");
        db.prepare(
          "INSERT INTO task (title, status, owner_person_id, blocked_reason) VALUES (?, ?, ?, ?)",
        ).run("待办", "Blocked", 1, '他说 "明天再说"');
      })();

      const result = Export.exportTasksCsv(state);
      expect(result.csvText).toContain('"张三,暖通组"');
      // owner 字段含双引号——必须被包成 "..." 且内部 " 转 ""
      expect(result.csvText).toContain('"甲 ""乙"" 丙"');
      // blocked_reason 同理
      expect(result.csvText).toContain('"他说 ""明天再说"""');
    } finally {
      close();
    }
  });
});

describe("export / AppError 形状", () => {
  it("导入时 schemaVersion 不匹配抛 AppError(INVALID_ARGUMENT)", () => {
    const { state, close } = freshExportDb();
    try {
      try {
        Export.importDatabaseJson(state, {
          jsonText: JSON.stringify({
            schemaVersion: 999,
            exportedAt: "2026-09-10T08:00:00Z",
            tables: {},
          }),
        });
        expect.unreachable("应该抛错");
      } catch (cause) {
        expect(cause).toBeInstanceOf(AppError);
        const err = cause as AppError;
        expect(err.code).toBe("INVALID_ARGUMENT");
        expect(err.message).toMatch(/schema 版本/);
      }
    } finally {
      close();
    }
  });
});