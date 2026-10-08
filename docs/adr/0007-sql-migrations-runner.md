# 迁移框架：raw .sql + 自写 runner

**Status**: accepted

承接 spec #37 与 ADR 0006（Node + better-sqlite3），把 `src-tauri/migrations/*.sql` + `refinery` 切到 Node 同等物。

## 决策

- **raw `.sql` 文件**，命名沿用 `V<NNN>__<name>.sql`（NNN 三位零填充递增）。
- **自写 migrations runner**（`src/main/migrations/runner.ts`）：
    1. 读 `migrations/` 目录所有 `V*.sql` 文件，按文件名排序；
    2. 维护 `_migrations` 表（`version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT`）；
    3. 对每个未应用的版本，开启 `db.transaction(() => { exec(sql); insert _migrations(...) })()`；
    4. PRAGMA `user_version` 与 `_migrations.last` 同步设置（仅 sanity 检查；权威源是 `_migrations` 表）。
- 文件位置：`src/main/migrations/`（迁移到 Tauri 路径一致后整体搬到这；老路径 `src-tauri/migrations/` 在 cutover PR 删除）。
- **forward-only**：无 down migration。回滚 = git revert 历史。

## 上下文

- 原 `src-tauri/migrations/*.sql` + `refinery 0.8.x` + `embed_migrations!("migrations/")`。
- `refinery_schema_history` 表（`refinery` 自建）记录每次迁移的版本、名称、checksum 与执行时长。
- TS 端的迁移 **不能直接复用 refinery**（refinery 是 Rust 库），需要同形工具。
- `refinery_schema_history` 表 schema 与 `_migrations` 表**不兼容**——这意味着现役用户的库在切到 Electron 后：
    - 第一次启动时，`_migrations` 表不存在；runner 从零跑所有 `.sql`，会把已建好的表「再 CREATE 一次」，**报错**。
    - 必须做一个**一次性 bootstrap**：检测 `refinery_schema_history` 存在时，把已应用的版本号批量 INSERT 到 `_migrations`，跳过对应 `.sql`，**等价于「迁移表 schema migration」**。
    - 这个 bootstrap 是「Tauri → Electron」特有的胶水；详见 spec #37 M2 段。

## 不做的事

- **不引 `knex` / `drizzle` / `prisma`**：raw `.sql` 是项目迁移语言，不换。
- **不做 schema-first 自动 diff**：迁移 SQL 是人工写的，不让工具出 generated migration。
- **不写 down migration**：v1 沿用 forward-only。
- **不引 `umzug` / `node-pg-migrate`**：本项目用不上 PG 方言；自写 runner ≈ 80 行更可控。
- **不做 checksum 校验**：runner 不验 `.sql` 内容 hash；tset 重新跑全量 `.sql` 就能发现语义漂移。

## 备选方案（已 reject）

- **`kne`x** —— schema builder / migrator；schema-first 与本项目 SQL-first 反；只引多一条 runner 写起来反而更难。
- **`drizzle`** —— TS schema-first；强制 DSL + 生成 `.sql`，本项目 SQL 是手工权威。
- **`prisma`** —— schema-first + 生成 client；本项目不需要 client 抽象。
- **`umzug` / `node-pg-migrate`** —— 默认 PG 方言；要剥 PG-only 特性，自写 runner ≈ 80 行净更小。
- **继续用 refinery + napi-rs** —— spec #37 明确不留 Rust。

## 后果

### runner 代码（伪代码）

```typescript
// src/main/migrations/runner.ts
export function runMigrations(db: Database, dir: string): void {
  // 1. 建 _migrations 表（如不存在）
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 2. 一次性 Tauri → Electron 胶水：检测 refinery_schema_history 表，把已应用版本搬到 _migrations
  const tauriHistory = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='refinery_schema_history'")
    .get();
  if (tauriHistory) {
    bootstrapFromTauriRefineryHistory(db);
    db.exec("DROP TABLE refinery_schema_history;"); // 一次性；下次启动不再走此分支
  }

  // 3. 扫 migrations/ 目录
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^V\d+__.*\.sql$/.test(f))
    .sort();

  // 4. 拿到当前 user_version 与 _migrations 已应用最大 version
  const applied = new Set(
    db.prepare<[], { version: number }>("SELECT version FROM _migrations").all().map((r) => r.version),
  );

  // 6. 跑增量
  for (const file of files) {
    const version = parseInt(file.match(/^V(\d+)/)![1], 10);
    if (applied.has(version)) continue;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(text);
      db.prepare("INSERT INTO _migrations(version, name) VALUES (?, ?)").run(version, file);
    })();
  }

  // 7. 同步 PRAGMA user_version 为 _migrations 最大 version（仅 sanity）
  const maxApplied = db.prepare<[], { v: number | null }>("SELECT MAX(version) AS v FROM _migrations").get();
  if (maxApplied?.v != null) {
    db.pragma(`user_version = ${maxApplied.v}`);
  }
}
```

### 行为契约

- 迁移文件命名、forward-only、写顺序 = 与现状一致。
- 启动时调用一次；幂等（重跑不会打错）。
- 迁移失败 → throw；`AppError` shape `{ code: 'MIGRATION_FAILED', message, detail: <sql 错误> }`。
- bootstrap Tauri → Electron 胶水是一次性的（检测 `refinery_schema_history` 存在时执行，迁完即 DROP 此表）。

### bootstrap 胶水（伪代码）

```typescript
function bootstrapFromTauriRefineryHistory(db: Database): void {
  // refinery_schema_history 表结构：version INTEGER PK, name TEXT, checksum BLOB, execution_time INTEGER
  const tauriApplied = db
    .prepare<[], { version: number; name: string }>(
      "SELECT version, name FROM refinery_schema_history ORDER BY version",
    )
    .all();
  db.transaction(() => {
    const insert = db.prepare("INSERT INTO _migrations(version, name) VALUES (?, ?)");
    for (const row of tauriApplied) insert.run(row.version, row.name);
  })();
}
```

注：`refinery` 的 `version` 列是 `i64` 自增；`_migrations.version` 是 INTEGER，迁移到 SQLite 时自动折成 INTEGER。无精度问题。

## ADR 衔接链

- 上游：[ADR 0005](./0005-electron-as-shell.md) Electron 壳
- 上游：[ADR 0006](./0006-node-better-sqlite3.md) Node + better-sqlite3
- 上游：[ADR 0001](./0001-sqlite-schema.md) SQLite Schema（迁移文件内容沿用）
- 下游：[spec #37](https://github.com/raawaa/kewutong/issues/37) M2 段的迁移工具实现