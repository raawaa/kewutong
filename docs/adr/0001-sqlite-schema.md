# SQLite Schema — 字段、外键、索引

**Status**: accepted

承接 ADR 0002（RRULE 子集与物化）与 tickets #6（FTS5 中文分词）/ #7（Rust + SQLite 嵌入式选型）的结论，定义 7 张核心表（实际为 6 张：`recurring_instance` 按 Q6 合入 `task`）+ FTS5 影子表 + 9 条索引 + 4 条同步触发器 + 运行时 PRAGMA 块。

## 命名与公共约定

- **主键**：`INTEGER PRIMARY KEY`（不用 `AUTOINCREMENT`）。单写者本机场景下 rowid 复用无冲突；避免 `sqlite_sequence` 表跨机器同步引入新冲突源。
- **时间戳**：所有 `*_at` / `*_date` 列存 `TEXT`，格式 `YYYY-MM-DD HH:MM:SS`（UTC）或 `YYYY-MM-DD`（DATE），默认值 `datetime('now')`。
- **JSON 字段**：`TEXT` 列 + `CHECK (json_valid(...))`（SQLite 3.53 默认含 JSON1 扩展）。Rust 端走 `serde_json::Value` 双向绑定。
- **CHECK 约束**：必填字符串 `length(trim(col)) > 0`，枚举列 `CHECK (col IN (...))`。
- **视图层派生**：`project.status` 不存，由视图聚合 `task.status` 计算（见 §3.3）。
- **软删**：不引入 `archived_at` / `deleted_at`；删除 = 物理 `DELETE`；`task.status='Cancelled'` 是 task 层的"软删"。`person.deactivated_at` 不是软删而是"暂时离岗"语义，保留。

## 运行时 PRAGMA（每次 `Connection::open` 后立即执行）

```sql
PRAGMA journal_mode = WAL;        -- 写不阻塞读;多端 Syncthing 冲突窗口更小
PRAGMA synchronous  = NORMAL;     -- WAL 模式下 FULL 收益小、性能差
PRAGMA foreign_keys = ON;         -- SQLite 默认 OFF,每次连接需重设
PRAGMA busy_timeout = 5000;       -- 避免短时锁竞争立即抛 SQLITE_BUSY
```

## 表

### 3.1 `sub_team`（子组）

| 列 | 类型 | 可空 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | INTEGER PK | NO | — | |
| `name` | TEXT UNIQUE | NO | — | 中文名 |
| `description` | TEXT | YES | NULL | 简短描述 |
| `sort_order` | INTEGER | NO | 0 | UI 显示顺序 |
| `created_at` | TEXT | NO | `datetime('now')` | |

约束：`length(trim(name)) > 0`。

### 3.2 `person`（人员）

| 列 | 类型 | 可空 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | INTEGER PK | NO | — | |
| `name` | TEXT | NO | — | 姓名 |
| `sub_team_id` | INTEGER FK→`sub_team.id` | NO | — | 所属子组 |
| `contact` | TEXT | NO | — | 联系方式（电话/微信/工号自由填） |
| `deactivated_at` | TEXT | YES | NULL | 离岗时间戳；NULL = 在岗 |
| `created_at` | TEXT | NO | `datetime('now')` | |

约束：`UNIQUE (sub_team_id, name)`（同子组不重名）、`length(trim(name)) > 0`。

### 3.3 `project`（项目）

| 列 | 类型 | 可空 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | INTEGER PK | NO | — | |
| `name` | TEXT | NO | — | |
| `owner_person_id` | INTEGER FK→`person.id` | NO | — | 项目负责人 |
| `sub_team_id` | INTEGER FK→`sub_team.id` | NO | — | 所属子组 |
| `start_date` | TEXT | YES | NULL | |
| `due_date` | TEXT | YES | NULL | |
| `notes` | TEXT | YES | NULL | |
| `created_at` | TEXT | NO | `datetime('now')` | |

**`status` 不存**：视图层派生（`task.status` 聚合）。不引入 `created_by_person_id`（单写者 = 科长本人）。

### 3.4 `recurring_template`（周期性模板）

| 列 | 类型 | 可空 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | INTEGER PK | NO | — | |
| `name` | TEXT | NO | — | |
| `freq` | TEXT ENUM | NO | — | `DAILY`/`WEEKLY`/`MONTHLY`/`YEARLY` |
| `byday_mask` | INTEGER bitmask | NO | 0 | `MO=1<<0` … `SU=1<<6` |
| `bymonthday` | TEXT (JSON) | YES | — | `[1,15]` / `[0]`（0 = 月末） |
| `bymonth` | TEXT (JSON) | YES | — | `[1,4,7,10]`（用于 YEARLY） |
| `byhour` | SMALLINT | NO | 9 | 0–23 |
| `byminute` | SMALLINT | NO | 0 | 0–59 |
| `iana_zone` | TEXT | NO | `'Asia/Shanghai'` | IANA 时区名 |
| `ends_on` | TEXT | YES | NULL | 终止日期（DATE） |
| `ends_after_n` | INTEGER | YES | NULL | 出现次数 |
| `holiday_behavior` | TEXT ENUM | NO | `'SKIP'` | `SKIP` / `SHIFT` |
| `rrule_text` | TEXT | NO | — | App 层写时派生的 RRULE 字符串 |
| `project_id` | INTEGER FK→`project.id` | YES | NULL | 项目级模板 |
| `sub_team_id` | INTEGER FK→`sub_team.id` | YES | NULL | 子组级模板 |
| `enabled` | INTEGER | NO | 1 | 1 = 启用 |
| `notes` | TEXT | YES | NULL | |
| `created_at` | TEXT | NO | `datetime('now')` | |

约束：
- `CHECK ((ends_on IS NOT NULL) <> (ends_after_n IS NOT NULL))`（二选一必填，承接 ADR 0002）
- `CHECK (project_id IS NOT NULL OR sub_team_id IS NOT NULL)`（scope 至少一项非空；跨组部门模板也可）
- `CHECK (json_valid(bymonthday))` / `CHECK (json_valid(bymonth))`
- `CHECK (freq IN ('DAILY','WEEKLY','MONTHLY','YEARLY'))`
- `CHECK (holiday_behavior IN ('SKIP','SHIFT'))`
- `length(trim(name)) > 0`

`rrule_text` 由 Rust 端 `RecurringTemplate::upsert` 入口派生，DB 不重算。

### 3.5 `task`（任务；含 `recurring_instance`）

承接 ADR 0002 决议 "Instance 与 Task 同构"（见 `CONTEXT.md`）：instance = task 行，靠 `recurring_template_id IS NOT NULL` 区分。instance 特有字段（`scheduled_at` / `original_scheduled_at` / `rescheduled_from_id`）作为 nullable 列直接挂在 `task` 上。

| 列 | 类型 | 可空 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | INTEGER PK | NO | — | |
| `title` | TEXT | NO | — | |
| `description` | TEXT | YES | NULL | 纯 TEXT；不走 JSON（v1 不强结构化） |
| `status` | TEXT ENUM | NO | — | `Open`/`In-progress`/`Blocked`/`Waiting-on`/`Done`/`Cancelled` |
| `owner_person_id` | INTEGER FK→`person.id` | NO | — | |
| `project_id` | INTEGER FK→`project.id` | YES | NULL | instance 也可挂项目（项目级模板的产物） |
| `due_date` | TEXT | YES | NULL | 一次性任务的截止日 |
| `recurring_template_id` | INTEGER FK→`recurring_template.id` | YES | NULL | NULL = 一次性；非空 = instance |
| `scheduled_at` | TEXT | YES | NULL | instance 当前触发时间（UTC） |
| `original_scheduled_at` | TEXT | YES | NULL | 模板原说该触发的时间（shifted 追溯用） |
| `rescheduled_from_id` | INTEGER FK→`task.id` ON DELETE SET NULL | YES | NULL | 指向被顺延的原 instance |
| `created_at` | TEXT | NO | `datetime('now')` | |
| `updated_at` | TEXT | NO | `datetime('now')` | App 层写时设（无 DB trigger，避免递归） |

约束：
- `CHECK (status IN ('Open','In-progress','Blocked','Waiting-on','Done','Cancelled'))`
- `CHECK ((recurring_template_id IS NULL AND scheduled_at IS NULL) OR (recurring_template_id IS NOT NULL AND scheduled_at IS NOT NULL))`（一次性 / instance 二选一不可混）
- `length(trim(title)) > 0`

视图层：`WHERE recurring_template_id IS NOT NULL` 即"周期性实例"子集；与一次性 task 共享全部状态机与 FTS5 索引。

### 3.6 `notification_log`（通知日志）

| 列 | 类型 | 可空 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | INTEGER PK | NO | — | |
| `triggered_at` | TEXT | NO | `datetime('now')` | |
| `kind` | TEXT | NO | — | `due_24h` / `blocked_3d` / `weekly_digest` |
| `related_task_id` | INTEGER FK→`task.id` | YES | NULL | |
| `related_template_id` | INTEGER FK→`recurring_template.id` | YES | NULL | |
| `payload` | TEXT (JSON) | NO | — | 通知 payload（`CHECK (json_valid(payload))`） |
| `viewed_at` | TEXT | YES | NULL | NULL = 未读；时间戳 = 首次查看时刻 |

约束：
- `CHECK (json_valid(payload))`
- `CHECK ((related_task_id IS NOT NULL) OR (related_template_id IS NOT NULL))`（至少关联一个实体）

## FTS5（影子表 + 同步触发器）

承接 #6：`tokenize = 'trigram'`、`external content`、`task` 增删改全量同步。

```sql
CREATE VIRTUAL TABLE task_fts USING fts5(
  title, description,
  content  = 'task',
  tokenize = 'trigram'
);

CREATE TRIGGER task_ai AFTER INSERT ON task BEGIN
  INSERT INTO task_fts(rowid, title, description)
    VALUES (new.id, new.title, new.description);
END;

CREATE TRIGGER task_ad AFTER DELETE ON task BEGIN
  INSERT INTO task_fts(task_fts, rowid, title, description)
    VALUES ('delete', old.id, old.title, old.description);
END;

CREATE TRIGGER task_au AFTER UPDATE ON task BEGIN
  INSERT INTO task_fts(task_fts, rowid, title, description)
    VALUES ('delete', old.id, old.title, old.description);
  INSERT INTO task_fts(rowid, title, description)
    VALUES (new.id, new.title, new.description);
END;
```

注：`task_fts` 本身由 `refinery` 迁入 migration 文件，作为 `V001__initial.sql` 一部分（SQLite 的 `CREATE VIRTUAL TABLE` 可在普通 `.sql` 中执行）。

## 索引策略

| # | 表 | 索引 | 服务视图 |
|---|---|---|---|
| 1 | `task` | `(owner_person_id, status, due_date)` | 人员矩阵（按人 + 状态 + 到期日） |
| 2 | `task` | `(project_id, status, due_date)` | 项目看板（按项目 + 状态 + 到期日） |
| 3 | `task` | `(due_date)` `WHERE due_date IS NOT NULL` | Today/Week 面板（按到期日聚合） |
| 4 | `task` | `(recurring_template_id, scheduled_at)` | 模板实例查询 / 物化层窗口扫 |
| 5 | `task` | `(status)` `WHERE status IN ('Open','In-progress','Blocked','Waiting-on')` | 在飞任务面板（排除 Done/Cancelled） |
| 6 | `person` | `(sub_team_id, deactivated_at)` | 子组花名册（在岗过滤） |
| 7 | `project` | `(sub_team_id, due_date)` | 子组项目面板 |
| 8 | `recurring_template` | `(enabled, ends_on)` | 活跃模板扫描（物化层触发） |
| 9 | `notification_log` | `(viewed_at)` `WHERE viewed_at IS NULL` | 未读通知面板 |

部分索引（partial index）省空间：`#3` / `#5` / `#9` 利用 NULL / 枚举子集裁剪。

## 迁移工具链

- **`refinery`** + `embed_migrations!("migrations/")`（承接 #7）
- 文件命名：`V001__initial.sql` / `V002__add_xxx.sql`（顺序递增、纯 SQL、git diff 友好）
- `refinery_schema_history` 表由 refinery 自动创建，无需手写
- 初始 migration `V001__initial.sql` 含：所有 `CREATE TABLE` + 所有 `CREATE INDEX` + `CREATE VIRTUAL TABLE task_fts` + 3 条 FTS5 触发器

## 备选方案（已 reject）

- **`sqlx` 0.9 / `diesel` 2.3** —— 见 #7：async + 连接池在 SQLite 单写者场景负担大于收益；diesel schema-first DSL 与 JSON 半结构化字段不友好。
- **UUID 主键** —— 8 字节 vs 16 字节、跨机器碰撞冲突概率更高；单写者本机 `INTEGER PRIMARY KEY` 已够。
- **`AUTOINCREMENT`** —— 引入 `sqlite_sequence` 表，跨机器同步多一处冲突源；单写者用 rowid 自然递增即可。
- **显式 `sort_order` 列** —— 单写者 5k–50k 行规模按 `(due_date, created_at)` 索引够快；拖拽改顺序的 UI 复杂度大于收益。
- **`is_archived` 软删** —— 单写者 + Syncthing 文件级同步下，软删字段让"删了之后是否同步"成为新坑；物理删除最简单。task 层用 `Cancelled` 状态替代软删。
- **contentless FTS5** —— external content + 手写 sync triggers 已在 `task` 增删改路径上，contentless 收益小；保留外部内容便于未来重建索引。
- **DB trigger 维护 `updated_at`** —— SQLite trigger 跑 SQL 不能调 Rust，重算 RRULE 等字段统一放 App 层。

## 后果

### 代码层

- Rust 端 `Repository<T>` trait 形状：每个 entity 一个 `fn upsert(&self, conn: &Connection, value: T) -> Result<i64>` + `fn list_with_filters(...)`。sync API + `Mutex<Connection>` + `tauri::State`（#7 决议）；长查询（FTS5 MATCH + 聚合）走 `tokio::task::spawn_blocking`。
- `RecurringTemplate::upsert` 入口派生 `rrule_text`（结构化字段 → RRULE 字符串），DB 不重算。
- `task.updated_at` 由所有 UPDATE 入口（repository 方法）显式 `datetime('now')` 写入；DB 无 trigger，避免递归触发。
- 物化层：`MaterializationJob::run(conn)` 扫 `idx_template_enabled` 取出 enabled 模板，对每条按 ADR 0002 的混合策略（启动 + 进入下一周）饥饿生成未来 12 周 instance；instance 写入走 `INSERT INTO task(..., recurring_template_id=?, scheduled_at=?, original_scheduled_at=?, rescheduled_from_id=NULL)`。
- FTS5 升级路径：若未来真实数据显示 trigram 召回不够，首选改写 Rust 端 `fts5_tokenizer_v2` 包装（jieba-rs），不走可加载扩展路线（#6 决议）。

### 与下游 ticket 的衔接

- **#11 初始子组分桶与示例数据集**（之前被 #10 阻塞）现已解锁：可在 `V001__initial.sql` 之外单独建 `V002__seed_sample.sql`（也可由 App 层首启时种），落到 `docs/data/initial-sub-teams.md`。
- **#12 节假日 JSON schema**：与 `recurring_template.holiday_behavior`（`SKIP` / `SHIFT`）联动；`SHIFT` 路径下物化层读 `holidays/cn-<year>.json` 决定顺延目标。`notification_log.kind='weekly_digest'` 也与节假日数据耦合（避免在节假日触发）。
- **#13 任务的创建与编辑交互**：UI 表单字段直接对应本 ADR §3.5 的列；`recurring_template_id` 字段在 UI 层要么是表单上的"周期性"开关（checked → 弹模板配置），要么是 nullable FK 下拉。

## ADR 衔接链

- 上游：[ADR 0002](./0002-recurring-time-rule.md)（RRULE 子集 / 物化策略 / 节假日行为）
- 上游：[#6](https://github.com/raawaa/kewutong/issues/6) FTS5 中文分词
- 上游：[#7](https://github.com/raawaa/kewutong/issues/7) Rust + SQLite 嵌入式选型
- 下游：[#11](https://github.com/raawaa/kewutong/issues/11) 初始子组分桶与示例数据集（解锁）
- 下游：[#12](https://github.com/raawaa/kewutong/issues/12) 节假日 JSON schema（输入约束）
- 下游：[#13](https://github.com/raawaa/kewutong/issues/13) 任务的创建与编辑交互（UI 字段映射）
- 下游：[ADR 0003](./0003-task-block-fields.md) task 阻塞字段 delta（补 `blocked_at` / `blocked_reason` / `waiting_on_person_id` 三列 + 部分索引 `idx_task_status_blocked_at`）
