# Task 阻塞字段 — `blocked_at` / `blocked_reason` / `waiting_on_person_id`

**Status**: accepted

承接 ADR 0001 §3.5（`task` 表原始定义）与 ticket #13 的 UI 决议（`prototype/task-editing`，三变体 sheet / popover / modal 已交付；状态变更走徽章菜单 + 阻塞独立字段）。本 ADR 是 ADR 0001 的 **delta**：在 `task` 表上补 3 列 + 加 1 条部分索引 + 加 migration `V003`，不修订 ADR 0001 原文（保留当时的决策判断与被拒方案）。

## 上下文

#13 落地后，`Blocked` / `Waiting-on` 状态需要 3 个字段支撑：

| 列 | 类型 | 可空 | 默认 | 角色 |
|---|---|---|---|---|
| `blocked_at` | TEXT | YES | NULL | 阻塞**快照**起始时间；与 `updated_at` 解耦；通知规则「Blocked > 3 天」直接查询 |
| `blocked_reason` | TEXT | YES | NULL | 阻塞 / 等待中原因；UI 自由文本；DB 约束保证 Blocked 状态下非空 |
| `waiting_on_person_id` | INTEGER FK→`person.id` | YES | NULL | 仅 Waiting-on 状态指向具体等待的人；**不替换** `owner_person_id` |

通知规则的查询路径：
```sql
SELECT … FROM task
 WHERE status IN ('Blocked','Waiting-on')
   AND blocked_at < datetime('now', '-3 days');
```
需要部分索引 `(status, blocked_at) WHERE status IN ('Blocked','Waiting-on')` 直接服务扫表。

## 决策

### D1 · 落地形态 — 新 ADR，不修订 ADR 0001

原 ADR 0001 保持 `accepted` 不动；本 ADR 记 delta。可追溯性 > 单文件阅读便利（ADR 模式的本意）。原 ADR 当时拒绝过的方案（`is_archived` 软删 / `AUTOINCREMENT` / DB trigger 维护 `updated_at` 等）仍是当时的判断，不被事后改写。

ADR 0001 §衔接链 末尾追加下行链接 → 本 ADR。

### D2 · `blocked_at` — 快照语义 + 每次进入刷新 + 切出清空

- 进入 Blocked / Waiting-on → `blocked_at = datetime('now')`（覆盖前值；同一 task 在 Blocked ↔ Waiting-on 之间反复切换时，**每次进入都刷新**，不累计）。
- 切出到 Open / In-progress / Done / Cancelled → `blocked_at = NULL`。
- DB **不加**跨列 CHECK `(status IN ('Blocked','Waiting-on')) = (blocked_at IS NOT NULL)`。约束一致性由 App 层 `task::set_status` repository 方法保证（见 D6）。
- 通知查询 `blocked_at < datetime('now', '-3 days')` 因此直接命中「当前已阻塞 > 3 天」的 task，不会被历史脏数据干扰。

### D3 · `blocked_reason` — 条件 CHECK（Blocked/Waiting-on 必填，其余态允许任意）

```sql
CHECK (status NOT IN ('Blocked','Waiting-on') OR length(trim(blocked_reason)) >= 1)
```

- Blocked / Waiting-on 状态下 reason 必填（trim 后长度 ≥ 1）——承接 #13 「不阻塞保存 + ⚠ 提示」的语义：⚠ 不再是「允许空存」，而是「保存后 trim 边角的边角提示」（实践中几乎不会触发，因保存入口会 trim）。
- **Open / In-progress / Done / Cancelled 状态下允许非空**——reason 列可预填上下文（如「预计下周一进入阻塞：等外委回函」），不视为脏数据。
- 长度上限 500 字符：`CHECK (length(blocked_reason) <= 500)`。理由：「阻塞原因」UI 是 textarea 但语境是「等外委单位盖章 / 等分管领导批示」级别的短理由；500 字符 ≈ 150–250 个汉字，覆盖两三句话足够；>500 已是「应写 description 字段」信号，且会撑爆卡片布局。

### D4 · `waiting_on_person_id` — 严格 CHECK + 允许自反

```sql
CHECK (waiting_on_person_id IS NULL OR status = 'Waiting-on')
```

- 列只在 `status = 'Waiting-on'` 时有定义；其它状态填了就是脏数据，DB 直接拒绝。
- **不**加 `waiting_on_person_id <> owner_person_id` 限制：合法场景「等 owner 自己拍板」存在；UI 在录入时若检测自反给 ⚠ 即可。
- FK 默认 `NO ACTION`：`person.deactivated_at` ≠ DELETE，被 deactivated 的人仍是合法 FK target；schema 不拦「等一个离岗的人」（implementation 阶段 UI 提示即可）。

### D5 · 部分索引 — `(status, blocked_at) WHERE status IN ('Blocked','Waiting-on')`

等值列 `status` 在前、范围列 `blocked_at` 在后：SQLite 在等值 + 范围组合下走「status 定位前缀 + blocked_at 范围扫」，列序正确利用 partial 谓词 + 复合索引。替代方案 `(blocked_at, status)` 把范围列放前会让 SQLite 每行检查 status，partial 已缩基数但 index 内部仍多一跳。命名 `idx_task_status_blocked_at`，与 ADR 0001 §索引策略 命名风格一致。

### D6 · App 层负责状态衍生字段（模式惯例）

`blocked_at` 与 `updated_at` / `rrule_text` 同构：**状态/结构化字段变化时由 Rust repository 写时派生，不写 DB trigger**。理由：

- DB trigger 不能调 Rust，重算逻辑统一放 App 层（`RecurringTemplate::upsert` 派生 `rrule_text`、`task::update_*` 派生 `updated_at`、`task::set_status` 派生 `blocked_at`）。
- 跨机器同步时若某台机器因部分写入失败留下 status 与 `blocked_at` 不一致的脏数据，DB trigger 反而会让重试爆炸；App 层 repository 在事务内统一 set 两列更可控。

本惯例承接 ADR 0001 §后果「代码层」一段；不在 CONTEXT.md 重申（CONTEXT.md 是词汇表，不承载实现层惯例）。

### D7 · migration — `V003__add_task_block_fields.sql`，forward-only

文件命名沿用 ADR 0001 §迁移工具链 `V00X__*.sql` 惯例。

**SQLite 限制备注**：`ALTER TABLE … ADD COLUMN` 不支持在已存在表上加 CHECK 约束。两种执行方式：

- **(a) table-recreate 模式**：rename `task` → `task_old`；create new `task` with full constraints；copy data from `task_old`；drop `task_old`。事务内执行，对单写者场景安全。
- **(b) V001 `__initial.sql` 同步更新**：任何新装直接拿到完整 CHECK 与新列；升级路径仍走 (a)。实现阶段推荐 (b)+(a) 组合：新装走 V001 全量，升级走 V003 table-recreate。

CHECK 与索引在 migration 内一并创建。

### D7.1 · 完整 DDL（V003 body）

```sql
-- V003__add_task_block_fields.sql
-- Forward-only; no down (refinery deliberately does not support rollback,
-- see https://github.com/rust-db/refinery README; ADR 0003 §D7).

PRAGMA foreign_keys = OFF;
BEGIN;

ALTER TABLE task RENAME TO task__v2_old;

CREATE TABLE task (
  id                       INTEGER PRIMARY KEY,
  title                    TEXT    NOT NULL,
  description              TEXT,
  status                   TEXT    NOT NULL,
  owner_person_id          INTEGER NOT NULL REFERENCES person(id),
  project_id               INTEGER          REFERENCES project(id),
  due_date                 TEXT,
  recurring_template_id    INTEGER          REFERENCES recurring_template(id),
  scheduled_at             TEXT,
  original_scheduled_at    TEXT,
  rescheduled_from_id      INTEGER          REFERENCES task(id) ON DELETE SET NULL,
  created_at               TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT    NOT NULL DEFAULT (datetime('now')),

  -- delta columns
  blocked_at               TEXT,
  blocked_reason           TEXT,
  waiting_on_person_id     INTEGER          REFERENCES person(id),

  CHECK (status IN ('Open','In-progress','Blocked','Waiting-on','Done','Cancelled')),
  CHECK ((recurring_template_id IS NULL AND scheduled_at IS NULL)
      OR (recurring_template_id IS NOT NULL AND scheduled_at IS NOT NULL)),
  CHECK (waiting_on_person_id IS NULL OR status = 'Waiting-on'),
  CHECK (status NOT IN ('Blocked','Waiting-on') OR length(trim(blocked_reason)) >= 1),
  CHECK (length(blocked_reason) <= 500),
  length(trim(title)) > 0
);

INSERT INTO task SELECT * FROM task__v2_old;
DROP TABLE task__v2_old;

CREATE INDEX idx_task_status_blocked_at ON task(status, blocked_at)
  WHERE status IN ('Blocked','Waiting-on');

COMMIT;
PRAGMA foreign_keys = ON;
```

注：FTS5 `task_fts` 影子表与 3 条同步触发器在 `task` 表 rename 后由触发器自动跟随新表，无需重建。

### D8 · rollback 路径

refinery 无原生 `.down.sql` 支持（README 明示「to undo, write a new migration」）。本 migration forward-only。回滚的正确姿势是「在所有 Syncthing 机器上都未跑 V003 之前修代码 + 发新 forward migration `V00X__revert_task_block_fields.sql`」（仍走 D7.1 table-recreate 模式反向）。一旦任一台机器跑了 V003，跨机协调的复杂度高于「接受 delta + 写新 migration」的成本，不靠 down.sql 解决。

## 备选方案（已 reject）

### R1 · 修订 ADR 0001 原地改 §3.5

原地改 ADR 0001 把 status 从 `accepted` 升 `accepted (revised)`；读者一站式看到 schema 全貌。**拒绝理由**：原 ADR 当时拒绝过的方案（`is_archived` 软删 / `AUTOINCREMENT` / DB trigger 维护 `updated_at`）的判断被事后改写；delta 应作为独立决策可追溯。**何时重开**：若 ADR 数量膨胀到 10+ 且单条 ADR 都开始引 delta，读拼两份体验明显恶化时。

### R2 · `blocked_at` 走 history（只追加不更新）

首次进入 Blocked/Waiting-on 时设 `blocked_at`，后续切回 Blocked 不刷新，保留首次阻塞时间。**拒绝理由**：通知规则「Blocked > 3 天」语义是「当前已阻塞 > 3 天」；history 语义要求通知规则改为「最近一次切出 > 3 天前」，与「Blocked > 3 天」的中文直觉不符。**何时重开**：若 v2+ 引入「阻塞历史分析」需求（最长阻塞时长 / 平均阻塞时长），可在 `task_block_event` 旁表落事件流；不动 `blocked_at` 列语义。

### R3 · `blocked_reason` 走 JSON 结构化（`{kind: 'waiting_external', note: '…'}`）

未来 reason 需要 kind 分类时（如「等外部」「等内部」「等资源」「等审批」）可走 JSON 半结构化。**拒绝理由**：v1 阶段 UI 三变体统一展示自由文本，没有 kind 子分类需求；JSON 化增加 `Deserialize` schema 维护成本与 UI 输入复杂度，**过度工程**。**何时重开**：v2+ 阻塞分析需要 kind 切分时，可加 `task_block_event(kind TEXT, reason TEXT, …)` 旁表；不动 `task.blocked_reason` 列。

### R4 · `blocked_reason` NOT NULL + UI 拦截

整列 NOT NULL；保存时强制填写。**拒绝理由**：破坏 #13 「不阻塞保存 + ⚠ 提示」原则；Open → Blocked 状态变更时 DB 拒绝空 reason，App 层被迫先 INSERT 空 reason 再 UPDATE 绕过，难看。条件 CHECK（D3）已把语义锁在「Block 态必填、非 Block 态随意」，效果相同且更顺。

### R5 · `blocked_reason` 无长度上限

不加 `length(...) <= 500` CHECK；UI textarea 加 maxlength=1000。**拒绝理由**：DB 一致性散；500 字符上限与「短理由」语义对齐；>500 已是「应写 description 字段」信号。**何时重开**：若 v2 引入「阻塞报告」导出 reason 字段到外部系统且需要长文，移除该 CHECK 即可。

### R6 · 跨列 CHECK `(status IN ('Blocked','Waiting-on')) = (blocked_at IS NOT NULL)`

DB 层锁死 status ↔ blocked_at 同步。**拒绝理由**：跨机器同步时一处漂移（部分写入失败 / Syncthing 中途断开）会让整条 UPDATE 直接失败，破坏单写者「最终一致」预期。App 层 repository（D6）已保证一致性，DB 不重复约束。

### R7 · `waiting_on_person_id` 禁止自反（`<> owner_person_id`）

更严，防止「等自己」的误操作。**拒绝理由**：合法场景「等 owner 自己拍板」存在；DB 拦过严；UI 层提示即可。

### R8 · 提供 `.down.sql`

refinery 维护双文件 `V003__*.sql` + `V003__*.down.sql`。**拒绝理由**：refinery 不原生支持（README 明示）；手动维护成本高于「写新 forward migration」；单写者 + Syncthing 场景下回滚是跨机协调问题，down.sql 仅在本机生效，不解决根问题。

## 后果

### 代码层

- 新增 Rust repository 方法 `task::set_status(conn, task_id, new_status, …)`：在事务内统一 set `status` / `blocked_at` / `blocked_reason` / `waiting_on_person_id` 四个字段。**不**散落在各自入口。
- `task::set_status` 入口的语义化映射：
  - 进入 Blocked / Waiting-on → `blocked_at = now`（覆盖）。
  - 切出到 Open / In-progress / Done / Cancelled → `blocked_at = NULL`、`blocked_reason = NULL`、`waiting_on_person_id = NULL`。
  - 切到 Waiting-on 且 `waiting_on_person_id` 为空 → DB CHECK `status NOT IN OR length(trim(reason)) >= 1` 不会拒绝（reason 可以临时空字符串），但 UI 会在保存前提示「waiting_on 为何人不填」。DB 不强求 waiting_on 在 Waiting-on 状态必填（与 reason 不同：reason 是「为什么要阻塞」必填，waiting_on 是「等谁」可选——例如「等系统自动恢复」无需指人）。
- `Task::upsert` 写入路径不直接动 `blocked_at`：只在显式 status 变更入口才动；批量导入 / migration 写入时保持原值或 NULL。
- 通知规则 SQL 落 `notification/jobs/blocked_3d.rs`，查询直接命中 `idx_task_status_blocked_at`；`payload` 字段 shape 留给 ADR 0001 §3.6 fog ticket（已在 map #2 Not-yet-specified 标记）。

### 与上下游 ticket 的衔接

- **#13**（任务创建与编辑交互）：三变体原型的橙色/黄色阻塞面板已对齐 D3 条件 CHECK 语义；徽章 ⚠ 提示对应 CHECK `length(trim(reason)) >= 1` 边角。
- **#11**（初始子组分桶与示例数据集）：解锁 — 示例 task 可含 `Blocked` / `Waiting-on` 样例，演示 blocked_reason / waiting_on_person_id 取值。
- **notification_log.payload JSON shape per kind**（map #2 Not-yet-specified）：`blocked_3d` payload 字段需含 `task_id` / `blocked_at` / `days_blocked` / `blocked_reason`；本 ADR 不展开，留给后续 ticket。

### ADR 衔接链

- 上游：[ADR 0001 §3.5](./0001-sqlite-schema.md#35-task任务含-recurring_instance)（task 表原始定义；本 ADR 是 delta）
- 上游：[#13](https://github.com/raawaa/kewutong/issues/13)（UI 决议与三变体原型）
- 下游：实现阶段 migration `V003__add_task_block_fields.sql`（D7.1 body）
- 下游：map #2 Not-yet-specified `notification_log.payload` JSON shape（`blocked_3d` kind 需 `blocked_at` / `days_blocked` 字段）
