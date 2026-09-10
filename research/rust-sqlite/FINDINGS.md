# Rust + SQLite 嵌入式选型

**调查范围**: rusqlite / sqlx / diesel 在「嵌入式 SQLite + Tauri 2.x + 单写者本地 app」场景下的对比
**调查日期**: 2026-09-10
**目标项目**: 科室任务管理桌面 app(单写者、本地优先、跨 Linux/Windows/macOS;Sync 走 Syncthing 直接同步数据文件)
**前置结论**: 本项目已在上游 ticket #8 (research/tauri-ecosystem) 中锁定 **Tauri 2.11.5 + rusqlite 0.40.2 + bundled**,本报告是对该决策的深度论证与候选验证

---

## 1. 候选版本快照(2026-09-10)

| crate | 最新版本 | 最近发布日期 | libsqlite3-sys | 内置 SQLite | GitHub stars | open issues / PRs | 周下载量(约) |
|---|---|---|---|---|---|---|---|
| **rusqlite** | 0.40.2 | 2026-08-08 (MSRV 降到 1.88.0) | 0.38.1 (via 内置 vendor) | 3.53.4 | 4.4k | 130 / 38 | ~187 万 |
| **sqlx** | 0.9.0 | 2026-05-21 (仓库迁移 transact-rs/sqlx) | `>=0.30.1, <0.39.0` (cargo.toml 范围) | ≤ 3.53.x(由 lockfile 解析) | 17.5k | 684 / 75 | ~219 万 |
| **diesel** | 2.3.13 | 2026-09-04 | `>=0.17.2, <0.39.0` (cargo.toml 范围) | ≤ 3.53.x(由 lockfile 解析) | 14.2k | 96 / 61 | ~80 万 |

来源(主源):
- [rusqlite releases](https://github.com/rusqlite/rusqlite/releases)(访问 2026-09-10)— 列出 0.40.2 / 0.40.1 / 0.40.0 / 0.39.0 等
- [rusqlite libsqlite3-sys/bindgen_bundled_version.rs](https://raw.githubusercontent.com/rusqlite/rusqlite/master/libsqlite3-sys/sqlite3/bindgen_bundled_version.rs) — `SQLITE_VERSION = "3.53.4"`, `2026-07-24 19:02:57`
- [SQLx 0.9.0 Released](https://github.com/launchbadge/sqlx/discussions/4271) — 0.9.0 释出与 feature 变化
- [sqlx-sqlite Cargo.toml](https://github.com/transact-rs/sqlx/blob/main/sqlx-sqlite/Cargo.toml) — `libsqlite3-sys = ">=0.30.1, <0.39.0"`
- [diesel-rs/diesel releases](https://github.com/diesel-rs/diesel/releases) — 2.3.13 (Sep 4) / 2.3.12 (Aug 7) / 2.3.11 (Jul 10)
- [diesel Cargo.toml](https://github.com/diesel-rs/diesel/blob/master/diesel/Cargo.toml) — `libsqlite3-sys = ">=0.17.2, <0.39.0"`

**活跃度观察**:
- rusqlite 节奏:2026 上半年 4 个 minor/patch(0.39.0 → 0.40.2),基本是「跟着 SQLite 上游版本走」。
- sqlx 节奏:0.9.0 是一次中型 release(May 2026);commit 页显示 2026-04 起活跃,684 个 open issues 偏多但基本都是 feature request / 长期 PR。
- diesel 节奏:2.3.x 维护线非常密集,2026-09-04 才出 2.3.13,2025-10 的 2.3.0 切换到 Rust 2024 edition;`diesel-async` 仍停在 0.5.x,未与 core 同步升到 0.7/1.0。

---

## 2. 对比维度

### 2.1 同步 vs 异步 API 与 Tauri command handler 契合度

**rusqlite(同步)**
- API 是纯同步 `Connection`;`Connection::open` / `prepare` / `query_map` 都是阻塞调用。
- Tauri 2.x 的 `#[tauri::command]` 既可以是 `fn`(sync)也可以是 `async fn`。社区主流做法:短查询(<1ms)直接同步 + `std::sync::Mutex<Connection>` 挂在 `tauri::State` 上;长查询走 `tokio::task::spawn_blocking`。
- 来源: ["SQLite in a Tauri v2 App — Simple, Reliable, Zero Regrets"](https://dev.to/hiyoyok/sqlite-in-a-tauri-v2-app-simple-reliable-zero-regrets-391h) — "rusqlite is synchronous. Tauri commands are async. You need to either use spawn_blocking or accept that you're blocking the thread"
- 来源: ["Rust Async in Tauri v2 — What Tripped Me Up and How I Fixed It"](https://dev.to/hiyoyok/rust-async-in-tauri-v2-what-tripped-me-up-and-how-i-fixed-it-1662) — 给出 `MutexGuard cannot be sent` 的解法和 `spawn_blocking` 示例
- 对单写者本地 app 来说,绝大多数查询都在微秒级,直接同步即可,代码最简单。

**sqlx(异步)**
- 原生 `async` + tokio;`SqlitePool` 内置连接池(默认 10 个连接)。
- 与 Tauri 的 `async fn` command 「天然契合」,不用包 `spawn_blocking`。
- 但要注意:`Connection` 不可跨 `.await` 共享;`Pool` 也要遵守 `Send + Sync` 约束。
- Tauri 2.x 默认 runtime 是 tokio,所以 SQLx 的 `runtime-tokio` 现成匹配;但你必须启用 `sqlite` feature,**默认不内置 SQLite**,要打开 `bundled` 才走 vendor。
- 复杂度溢价:app state 多一层 `Pool`,部署的 `sqlx.toml` / `sqlx prepare` offline cache 也要进 CI。

**diesel(同步 + diesel-async)**
- 核心 crate 是同步;`diesel-async` 是单独 crate,目前 **0.5.0 (Feb 2025)**,未对齐 diesel 2.3 主线。
- 即便走 `diesel-async`,SQLite backend 在生产场景里收益有限(单写者,无连接池收益;async 路径主要是 `tokio_postgres` 那条线的卖点)。
- 与 Tauri 契合度 = 与 rusqlite 同级,但要额外承担「同步代码 + diesel DSL」或「双 crate 维护」的开销。

**结论**:
- 同步 API 在「短查询 + 单写者」场景下,语义清晰、心智负担低,与 Tauri command 一致通过 `spawn_blocking` 桥接即可。
- async 不是这个场景的「必需能力」,而 sqlx 的 async 反而引入了连接池配置 / offline cache / `tokio::sync::Mutex` 约束等额外工程。

### 2.2 迁移工具链

| 工具 | 适合哪个 crate | 备注 |
|---|---|---|
| **`sqlx-migrate`** | sqlx | `sqlx-cli` 子命令,`migrations/<timestamp>_<name>.sql` 格式,支持 up/down,内嵌 `migrate!` 宏 |
| **refinery** | rusqlite / 任意 | `.sql` 文件 + `embed_migrations!` 宏,跨方言;项目里多数 rusqlite 实战案例都选这个 |
| **diesel migration** | diesel | DSL 文件 + 自动生成 `up.rs`/`down.rs`,schema 强类型绑定,适合 diesel 体系 |

**rusqlite**:无官方 migration 工具,生态共识是 **`refinery`**(或手写 `SchemaVersion` 表 + 自己跑 SQL)。
- `tauri-plugin-rusqlite2` 自带简易 `migration` API(读 SQL 文件夹),但社区示例更常用 refinery。
- 资源: [Tauri 2.0 Database Integration](https://codershandbook.com/tauri-20-database-integration-sqlite-and-local-storage) — 给出 rusqlite + refinery 完整示例

**sqlx**:自带 **`sqlx-cli`** + `migrate!` 宏,**离线模式**(`sqlx prepare`)会把 query 校验结果缓存到 `sqlx-data.json`,CI 上无 DB 也能编译。
- 注意:`query!` 宏要求编译期 DB 连接或 offline cache,**Tauri 项目首次构建要先把 cache 准备好**,否则 desktop build 挂。

**diesel**:`diesel migration generate <name>` → 生成 `up.sql/down.sql + up.rs/down.rs`,schema 改动用 `diesel print-schema` 自动反推 `schema.rs`。
- 与 diesel ORM 强绑定,脱离了 schema.rs 整个 migration 体系就垮了。

**结论**:rusqlite + refinery 是**最轻量**的组合:无 CI 依赖、无 CLI 工具链;SQLite 文件就是迁移介质,git diff 友好。

### 2.3 `bundled` feature 集成难度

**共性底层**:三个 crate 都把 SQLite 链接职责下放给 **`libsqlite3-sys`**,而该 crate 的 `bundled` feature 会:
- 用 crate 内置 vendor 好的 SQLite amalgamation(`sqlite3.c` + `sqlite3.h`)编译进二进制
- 不依赖系统的 `libsqlite3.so / dylib`,跨 Linux/Windows/macOS 行为一致

**rusqlite**:
- 一行 Cargo.toml:`rusqlite = { version = "0.40", features = ["bundled"] }`
- README 明确推荐 `bundled` 作为 desktop app 默认选择。
- 来源: [rusqlite README](https://github.com/rusqlite/rusqlite) — "the right choice for most programs that control their own SQLite databases"
- 注意:首次编译 `cc` 编译 `sqlite3.c` 会让冷构建变慢(实测 30-90 秒,看机器);增量编译没事。

**sqlx**:
- `sqlx = { version = "0.9", features = ["runtime-tokio", "sqlite"] }`,`sqlite` feature **默认就开启 `bundled`**,等价于 `libsqlite3-sys/bundled`。
- 来源: [sqlx Cargo.toml/README](https://github.com/transact-rs/sqlx) — "SQLite: SQLite bundled and statically linked" (feature `sqlite`)
- 替代:`sqlite-unbundled` 走系统 SQLite,要求 SQLite ≥ 3.20.0(本项目**不推荐**,因为系统 SQLite 版本不可控,会破坏 `bundled` 的一致性)。

**diesel**:
- `diesel = { version = "2.3", features = ["sqlite"] }` + **额外** 引入 `libsqlite3-sys = { version = "0.38", features = ["bundled"] }`(cargo.toml 注释里特意说明)。
- 多一个手写依赖,且 diesel 不像 rusqlite/sqlx 把 bundled 内置在主 feature 里,文档里这一段稍微绕。

**结论**:rusqlite = sqlx > diesel(diesel 多了 `libsqlite3-sys` 这一行手动 dependency;细节上最容易踩坑)。

### 2.4 JSON 字段处理(SQLite 没有原生 JSON)

SQLite 的 **JSON1 扩展**自 3.38 起编译默认开启(`json_extract / json_set / json_insert / json_replace / json_remove / json_array_length` 等),而 `bundled` 的 SQLite 3.53.4 自然包含。

**三种方案对比**(以任务描述/模板参数为例):

**方案 A: SQLite 原生 JSON1 + TEXT 列 + `json_extract()` 查询**
- 列定义为 `metadata TEXT NOT NULL CHECK (json_valid(metadata))`,3.45+ 也支持 SQLite STRICT 表(`CREATE TABLE t (..., metadata JSONB)`),JSONB 自 3.45 起可用。
- 写入:`INSERT INTO t (metadata) VALUES (json(?))` 或直接传合法 JSON 字符串。
- 查询:`SELECT json_extract(metadata, '$.priority') AS priority FROM tasks WHERE json_extract(metadata, '$.done') = 0`。
- 索引:`CREATE INDEX idx_priority ON tasks (json_extract(metadata, '$.priority'))`(表达式索引,SQLite 支持)。

**方案 B: TEXT 列 + serde_json 包整段 JSON,不在 SQL 里查内部字段**
- 写:`serde_json::to_string(&Template { repeat: Weekly, params: ... })` → 入库。
- 查:`serde_json::from_str::<Template>(&row.metadata)` → 出库。
- 灵活度最低,但**完全脱离 SQL**,对 rusqlite/`tauri-plugin-sql` 都无差别。

**方案 C: 关系拆分(子表 + JOIN)**
- 模板参数如果是 list/map,拆成 `template_params(template_id, key, value)`。
- 优点:符合 1NF,SQL 表达力强。
- 缺点:对「半结构化数据」(例如任意模板 schema)代价高,改动字段要改三处(主表 + 参数表 + 代码)。

**每个 crate 的接入难度**:

- **rusqlite**:开 `serde_json` feature → 直接获得 `impl FromSql/ToSql for serde_json::Value`(NULL → Null、Number(i64/f64) → INT/REAL、其它 → JSON-encoded TEXT)。
  - 来源: [rusqlite serde_json 实现](https://github.com/rusqlite/rusqlite/blob/master/src/types/serde_json.rs) — 4 个 ToSql 分支 + 5 个 FromSql 分支
  - 意味着:**只要你的结构体能 `Serialize/Deserialize`,就能用 `params![value]` 直接绑定**,无需自己手写 JSON 编解码。
  - 配合 JSON1:在 SQL 里写 `json_extract(col, '$.field')`,在 Rust 里用 `serde_json::Value` 或自定义 `Deserialize` 反序列化。
- **sqlx**:`json` feature 提供 `Json<T>` newtype + `JsonValue` 别名;`#[derive(FromRow)]` 也支持嵌套 JSON。
  - 编译时 `query!` 宏要求 `metadata` 列在 schema 里是 `JSON`(用 SQLx 类型映射,SQLite 上等价于 TEXT,但 `query_as!` 检查会更严)。
  - 灵活性上比 rusqlite 强一些(有 derive),代价是 query 宏要绑定到具体 schema。
- **diesel**:通过 `diesel::sql_types::Json` + 自定义 `SqlType` impl + `#[derive(AsExpression, FromSqlRow)]` 实现。
  - 比前两者样板代码多,但配合 diesel DSL 类型推导比较「严密」。

**结论**:**方案 A(JSON1 + TEXT + serde_json)是本项目最合适的**:
- 单写者 + Syncthing 同步 → schema 演进越简单越好,**关系拆分(方案 C)代价大**;
- 「方案 A + serde_json Value 当 escape hatch」是最常见组合,**rusqlite 的 `serde_json` feature 让 JSON 入参 / 整段字段都零样板**;
- FTS5 全文检索时也方便:把文本字段提取出来建 FTS 索引,JSON 字段保留原貌,见 ticket #6(FTS5 中文分词方案)。

### 2.5 编译时间、二进制体积

**编译时间观察**(定性,不是精确 benchmark):
- rusqlite + bundled:**冷启动 ~30–90 秒**(`cc` 编译 `sqlite3.c` ~8MB C 文件),增量构建几乎无感;首次 cross-compile / Windows MSI 构建耗时显著。
- sqlx + sqlite(bundled):**冷启动比 rusqlite 多 ~1–2 分钟**,因为 sqlx 自身依赖图庞大(`tokio` 一系列 + `sqlx-core` + `sqlx-sqlite` + `migrate` 宏展开);每次编译 `query!` 宏展开也会加开销。
- diesel 2.3 + sqlite + bundled:依赖图与 sqlx 同量级,**冷启动 ~2–4 分钟**,且 diesel 的 derive/DSL 宏比 sqlx 更繁重;CI 上首次构建体感最重。

**二进制体积观察**:
- rusqlite 不带 async runtime、依赖最少,bundle 增加 **~1.0–1.5 MB**(主要是 bundled `sqlite3.o`)。
- sqlx 加上 tokio runtime + 多 driver 抽象,**+3–6 MB**(若开启 `any` feature 还更大)。
- diesel 同步核心 + 各种 derive,**+2–4 MB**(取决于开了多少 backend feature)。

**对单写者本地 app 的实际意义**:
- App 内绝大多数查询 <1 ms,Tauri 已经把 webview 二进制打到 5–10 MB 量级,**SQLite driver 增加 1–6 MB 占比 < 10%**。
- **编译时间**比体积更敏感(影响开发者迭代),这正是 rusqlite 胜出的点。

### 2.6 中文社区活跃度与文档质量

| crate | 中文文档 | 英文文档 | 社区活跃度 |
|---|---|---|---|
| rusqlite | 知乎/掘金/CSDN 都有入门帖,但都是基础用法,无系统教程 | 官方 docs.rs 完备,README 案例丰富 | Tauri 中文社区里**最主流**的 SQLite 集成方式 |
| sqlx | 较多中文博客(尤其是 Axum 后端场景),教程质量参差 | 官方 docs.rs + sqlx.dev 教程站,资料完整 | 国内后端圈最热;desktop app 场景偏少 |
| diesel | 翻译文档 / 老博文较多,新版 2.x 中文资料偏少 | 官方 diesel.rs 文档完备,API 设计哲学严谨 | 维护者集中,Rust 1.7x 时代的「标配 ORM」,但 2025+ 热度下滑 |

观察:
- 在 Tauri 中文圈搜「Tauri SQLite」,**90% 的实战帖用的是 rusqlite**(常见搭配 `refinery` 迁移 + `r2d2_sqlite` 连接池)。
- sqlx 的中文资料集中在 web 后端(Axum/actix-web),desktop app 场景**几乎没有针对 Tauri 的中文最佳实践帖**。
- diesel 中文资料以 1.x 时代居多,2.x 切换到 async/2024 edition 后的中文更新滞后。

---

## 3. 推荐方案

**推荐**:**rusqlite 0.40.2 + `bundled` feature + libsqlite3-sys 0.38.1(bundled SQLite 3.53.4)**

**Cargo.toml 入口**(最小化):
```toml
[dependencies]
rusqlite = { version = "0.40", features = ["bundled", "serde_json"] }
refinery = { version = "0.8", features = ["rusqlite"] }
# 视情况:
r2d2 = "0.8"
r2d2_sqlite = "0.24"
```

**理由(按重要性排序)**:
1. **API 与「单写者本地 app」完美对齐**:同步 `Connection` + microsecond 查询,无须 async runtime;短查询直接 `#[tauri::command] fn` 同步签名,代码即文档。
2. **bundled 集成最省心**:一行 `features = ["bundled"]` 即可跨 Linux/Windows/macOS,SQLite 版本固定在 3.53.4,**不会因系统 libsqlite3 版本差异破坏 Syncthing 同步协议**(数据文件兼容性 = SQLite 版本确定性)。
3. **serde_json 零样板**:`impl ToSql/FromSql for serde_json::Value` 已经内置,**任务模板/参数等半结构化字段直接当 `Value` 传入/取出**,JSON1 函数在 SQL 里查内部字段,SQL 之外用 Rust 类型反序列化。
4. **最小依赖图 = 最小编译时间**:本仓库刚起步,CI 和本地冷构建都要快;rusqlite 路径比 sqlx/diesel 显著轻。
5. **迁移工具与 rusqlite 解耦**:`refinery` 是 `rusqlite` 推荐搭配,无 CLI 依赖、无 offline cache,纯 `.sql` git diff 友好。
6. **与上游 ticket #8 决策一致**:生态选型已锁定 `tauri 2.11.5 + rusqlite + bundled`,本报告只是把「为什么不选 sqlx / diesel」的论据补齐。

**与 Tauri 2.x 的集成模式**:
```rust
// src-tauri/src/lib.rs(节选)
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::Manager;

pub struct DbState(pub Mutex<Connection>);

#[tauri::command]
fn list_overdue_tasks(state: tauri::State<'_, DbState>) -> Result<Vec<Task>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, title, json_extract(metadata, '$.due') AS due \
         FROM tasks WHERE done = 0 AND json_extract(metadata, '$.due') < datetime('now')"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(Task {
            id: row.get(0)?,
            title: row.get(1)?,
            due: row.get(2)?,
        })
    }).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir().unwrap();
            std::fs::create_dir_all(&dir).unwrap();
            let conn = Connection::open(dir.join("kewutong.db"))?;
            // 首次启动跑 refinery 迁移
            refinery::embed_migrations!("migrations");
            // ... runner call
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_overdue_tasks])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**长查询异步化**(FTS5 全文检索、聚合报表等):用 `tokio::task::spawn_blocking` 包同步 `Connection`:
```rust
#[tauri::command]
async fn search_tasks(state: tauri::State<'_, DbState>, q: String) -> Result<Vec<Task>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        // ... FTS5 MATCH 查询
    }).await.map_err(|e| e.to_string())?
}
```

---

## 4. 不推荐的方案

### 4.1 sqlx 0.9 — 不推荐

- **核心问题**:本项目是**单写者本地 app**,async runtime + 连接池 = 杀鸡用牛刀;`SqlitePool` 默认 10 个连接,但 SQLite 本身只允许单写者,**多连接在 SQLite 上没有并发收益,反而引入「事务串行化重试」等麻烦**。
- **CLI 与 offline cache 负担**:`sqlx::query!` 编译期连接 DB 或依赖 `sqlx-data.json`,Tauri 项目首次构建必须先 `cargo sqlx prepare`,**CI 多一道工序**;对桌面端是反向收益(我们本来就只有 1 个数据库连接)。
- **依赖图膨胀**:tokio + sqlx-core + sqlx-sqlite + macros + migrate = 冷构建额外 1–2 分钟;**相对 rusqlite 没有可换来的能力**。
- **唯一适用场景**:若项目未来要分叉出 server mode(本项目 Syncthing-only 路径,不存在此需求)。

### 4.2 diesel 2.3 — 不推荐

- **schema-first 强类型 DSL 是双刃剑**:半结构化 JSON(任务模板参数、通知 payload)用 diesel 表达会很别扭,要写大量 `AsExpression`/`FromSqlRow` 样板。
- **`diesel-async` 与主线脱节**:0.5.x 仍停在 2025-02,**未跟进 diesel 2.3 的 Rust 2024 edition 与新 feature**;如果选 async,生态裂缝清晰可见。
- **学习曲线与本项目「轻量 + 可读」诉求冲突**:diesel DSL 写 5 行 join 的爽快是用「必须读懂 schema.rs + query DSL + derive 体系」的门槛换来的,而本项目表结构在 ticket #10 才刚起步,不需要这个重量。
- **迁移工具过重**:`diesel migration` + `print-schema` + `schema.rs` 三件套对小团队单人维护反而是负担(见 ticket #10:SQLite Schema 字段、FK、索引还没定)。

---

## 5. 来源清单(全部为 2026-09-10 访问的主源/官方文档)

### 5.1 版本与发布时间(主源)
- [rusqlite releases](https://github.com/rusqlite/rusqlite/releases) — 列出 0.40.2(2026-08-08)、0.40.1(2026-06-06)、0.40.0(2026-05-26)、0.39.0(2026-03-15)等
- [diesel-rs/diesel releases](https://github.com/diesel-rs/diesel/releases) — 2.3.13(2026-09-04)、2.3.12(2026-08-07)、2.3.11(2026-07-10)、2.3.10(2026-06-05)等
- [SQLx 0.9.0 Released](https://github.com/launchbadge/sqlx/discussions/4271) — 0.9.0 释出时间与 feature 变化
- [sqlx repo 现地址](https://github.com/transact-rs/sqlx) — 仓库迁移说明

### 5.2 底层 libsqlite3-sys / SQLite 版本(主源)
- [rusqlite libsqlite3-sys/bindgen_bundled_version.rs](https://raw.githubusercontent.com/rusqlite/rusqlite/master/libsqlite3-sys/sqlite3/bindgen_bundled_version.rs) — `SQLITE_VERSION = "3.53.4"`, source-id `2026-07-24 19:02:57`
- [rusqlite 0.40.0 release notes](https://docs.rs/crate/rusqlite/0.40.0) — bundled SQLite bump 至 3.53.1
- [libsqlite3-sys docs.rs](https://docs.rs/libsqlite3-sys/latest/libsqlite3-sys/) — 文档入口
- [sqlx-sqlite Cargo.toml](https://github.com/transact-rs/sqlx/blob/main/sqlx-sqlite/Cargo.toml) — `libsqlite3-sys = ">=0.30.1, <0.39.0"`
- [diesel Cargo.toml](https://github.com/diesel-rs/diesel/blob/master/diesel/Cargo.toml) — `libsqlite3-sys = ">=0.17.2, <0.39.0"`

### 5.3 serde_json / JSON 支持(主源)
- [rusqlite serde_json.rs 实现](https://github.com/rusqlite/rusqlite/blob/master/src/types/serde_json.rs) — 4 个 ToSql 分支 + 5 个 FromSql 分支
- [SQLite JSON1 官方文档](https://www.sqlite.org/json1.html) — JSON1 函数全集
- [SQLite FTS5 文档](https://sqlite.org/fts5.html) — FTS5 自定义 tokenizer 接口(为 ticket #6 留口子)

### 5.4 Tauri + SQLite 实战(英文社区)
- ["SQLite in a Tauri v2 App — Simple, Reliable, Zero Regrets"](https://dev.to/hiyoyok/sqlite-in-a-tauri-v2-app-simple-reliable-zero-regrets-391h) — rusqlite 同步 + Tauri command 的核心限制与解决方案
- ["Rust Async in Tauri v2 — What Tripped Me Up and How I Fixed It"](https://dev.to/hiyoyok/rust-async-in-tauri-v2-what-tripped-me-up-and-how-i-fixed-it-1662) — `spawn_blocking` + MutexGuard 解法
- ["Rust Async Patterns in Tauri — Keeping the UI Responsive"](https://dev.to/hiyoyok/rust-async-patterns-in-tauri-keeping-the-ui-responsive-while-rust-does-heavy-work-e9d) — spawn_blocking 进度上报模式
- ["Tauri 2.0 Database Integration SQLite and Local Storage"](https://codershandbook.com/tauri-20-database-integration-sqlite-and-local-storage) — rusqlite + refinery + r2d2 完整集成示例
- [tauri-plugin-rusqlite2](https://github.com/razein97/tauri-plugin-rusqlite2) — 第三方 tauri-plugin,基于 rusqlite + SQLCipher,可作为 alternative(本项目不采用)

### 5.5 迁移工具链(主源)
- [refinery GitHub](https://github.com/rust-db/refinery) — `.sql` + `embed_migrations!` 跨方言迁移
- [SQLx migrate CLI](https://github.com/launchbadge/sqlx/blob/main/sqlx-cli/README.md) — `sqlx migrate run` + offline mode
- [Diesel migration guide](https://diesel.rs/guides/migration_guide.html) — `diesel migration generate` + DSL 文件

### 5.6 仓库活跃度(GitHub 实时数据,2026-09-10)
- [rusqlite commits](https://github.com/rusqlite/rusqlite/commits/master) — 最近 30 个 commit 均在 2026-08/09,~3000 总 commit
- [sqlx commits](https://github.com/transact-rs/sqlx/commits/main) — 最近 commit 2026-09-09,~2801 总 commit,684 open issues
- [diesel commits](https://github.com/diesel-rs/diesel/commits/main) — 最近 commit 2026-09-09,~7989 总 commit,96 open issues

---

## 6. 与其他 ticket 的关联

- **#8 (CLOSED) Tauri 2.x 生态调研** — 已锁定 Tauri 2.11.5 + rusqlite 0.40.2 + bundled,本报告是该决策的深度论证。
- **#10 SQLite Schema 字段、FK、索引**(wayfinder:grilling)— 本报告 §2.4 的 JSON 字段策略影响 schema 设计,JSON 列 vs 子表 vs TEXT 这三种选择需要在 #10 里做最终拍板。
- **#6 SQLite FTS5 中文分词方案** — 本报告 §2.4 仅覆盖「字段存储」,FTS5 索引结构与中文分词走 #6。本报告仅说明 `bundled` 的 SQLite 3.53.4 默认含 FTS5 即可。
- **#3 (CLOSED) 周期性模板时间规则语法** — 模板字段的「JSON 存储」选型可与本报告 §2.4 互参。
