-- ============================================================================
-- V001__initial.sql — sub_team / person / task 及其索引（tickets #17, #18）
-- ============================================================================
--
-- 这是整个 app 迁移链的第一张;按 ADR 0001 公共约定,后续票按各自需要在本
-- 文件之后追加 V002 / V003 等 migration。
--
-- 截至本票：
--   - sub_team / person：ticket #17（人员管理）。
--   - task：ticket #18（一次性任务与 6 状态机）。ADR 0001 §3.5 列 +
--     ADR 0003 阻塞三列（blocked_at / blocked_reason / waiting_on_person_id）
--     一次性写齐——尚无已部署的库，升级路径不存在，按 #18 的决议不走 V003。
--   - project / recurring_template：占位骨架（仅 `id` 主键），ticket #21
--     与 #22 在后续 migration 中 ALTER TABLE 补齐其余列。建在这里只是为了
--     `task` 上的 FK 引用有合法目标。
--
-- 公共约定承接 ADR 0001 §命名与公共约定:
--   - 主键 INTEGER PRIMARY KEY（不带 AUTOINCREMENT,单写者本地场景 rowid
--     自然递增已够,且避免引入跨机器同步时多一处冲突源 sqlite_sequence）。
--   - 时间戳 TEXT,格式 '%Y-%m-%d %H:%M:%S' UTC;默认值 datetime('now')。
--   - 必填字符串走 length(trim(col)) > 0。
--   - 软删:不引入 archived_at / deleted_at。`person.deactivated_at` 不是
--     软删,而是"暂时离岗"语义,保留。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- sub_team — 子组（科室内的二级分组,用于把人员归桶）
-- ----------------------------------------------------------------------------
-- `name` 在全 app 范围内唯一:科长不会同时存在两个同名的子组,后续 task /
-- recurring_template 也以此作 FK 目标。`sort_order` 由 UI 拖拽维护,
-- 默认按子组创建顺序递增（0、1、2…）。
CREATE TABLE sub_team (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK (length(trim(name)) > 0)
);

-- ----------------------------------------------------------------------------
-- person — 人员（科长能把他们录进来、分子组、标记离岗 / 复岗）
-- ----------------------------------------------------------------------------
-- 同子组内姓名唯一(UNIQUE(sub_team_id, name)):子组内部不重名,但允许
-- "张三"在子组 A 与子组 B 同时存在——科室里跨组重名常见。`deactivated_at`
-- NULL = 在岗,非 NULL = 离岗时刻(UTC);离岗人员保留记录,从指派候选里
-- 滤掉但仍在花名册里可见。
CREATE TABLE person (
    id             INTEGER PRIMARY KEY,
    name           TEXT    NOT NULL,
    sub_team_id    INTEGER NOT NULL REFERENCES sub_team(id) ON DELETE RESTRICT,
    contact        TEXT    NOT NULL,
    deactivated_at TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (sub_team_id, name),
    CHECK (length(trim(name)) > 0),
    CHECK (length(trim(contact)) > 0)
);

-- ----------------------------------------------------------------------------
-- project — 占位骨架（ticket #21 补齐其余列）
-- ----------------------------------------------------------------------------
-- 仅留 `id` 主键供 `task.project_id` 的 FK 引用解析。后续 ALTER TABLE
-- 加列 / 加索引。
CREATE TABLE project (
    id INTEGER PRIMARY KEY
);

-- ----------------------------------------------------------------------------
-- recurring_template — 占位骨架（ticket #22 补齐其余列）
-- ----------------------------------------------------------------------------
-- 同上,留 `id` 主键供 `task.recurring_template_id` 与
-- `task.rescheduled_from_id` 的 FK 引用解析。
CREATE TABLE recurring_template (
    id INTEGER PRIMARY KEY
);

-- ----------------------------------------------------------------------------
-- task — 任务（ticket #18 · 一次性任务与 6 状态机）
-- ----------------------------------------------------------------------------
-- 承接 ADR 0001 §3.5 + ADR 0003 的 delta。阻塞三列（blocked_at /
-- blocked_reason / waiting_on_person_id）写在此处,不另起 V003——尚无已部署
-- 的库,新装一次拿全。
--
-- 状态机（6 值枚举）：
--   Open / In-progress / Blocked / Waiting-on / Done / Cancelled
--   Cancelled 在 task 层充当"软删"——从在飞列表消失,但历史视图仍可见。
--
-- 阻塞语义（ADR 0003 §D2 / §D3 / §D4）：
--   - 进入 Blocked / Waiting-on：App 层 set_status 在事务内 set blocked_at =
--     now（覆盖；Blocked↔Waiting-on 反复切换时每次进入都刷新,不累计）。
--   - 切出到 Open / In-progress / Done / Cancelled：清空 blocked_at /
--     blocked_reason / waiting_on_person_id 三列。
--   - Blocked / Waiting-on 状态下 blocked_reason 必填且长度 ≤ 500；
--     waiting_on_person_id 仅在 Waiting-on 下允许非空（允许自反,UI 层给 ⚠
--     不拦,见 ADR 0003 §D4）。
--   - DB 不加跨列 status↔blocked_at 同步 CHECK：跨机器同步漂移时 App 层
--     repository 在事务内 set 两列更可控（ADR 0003 §D2 / §D6）。
--
-- 一次性 / instance 互斥（ADR 0001 §3.5）：recurring_template_id 与
-- scheduled_at 同生同灭——都 NULL = 一次性；都非 NULL = instance。
--
-- updated_at 由 App 层 repository 写时设置,DB 不加 trigger(ADR 0001 §后果
-- "代码层" + ADR 0003 §D6)。
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

    -- 阻塞三列（ADR 0003 delta）
    blocked_at               TEXT,
    blocked_reason           TEXT,
    waiting_on_person_id     INTEGER          REFERENCES person(id),

    -- 状态 6 值枚举（ADR 0001 §3.5）
    CHECK (status IN ('Open','In-progress','Blocked','Waiting-on','Done','Cancelled')),
    -- 一次性 / instance 互斥（ADR 0001 §3.5）
    CHECK ((recurring_template_id IS NULL AND scheduled_at IS NULL)
        OR (recurring_template_id IS NOT NULL AND scheduled_at IS NOT NULL)),
    -- waiting_on_person_id 仅 Waiting-on 下允许非空（ADR 0003 §D4）
    CHECK (waiting_on_person_id IS NULL OR status = 'Waiting-on'),
    -- 阻塞 / 等待态下 reason 必填（trim 后长度 ≥ 1, ADR 0003 §D3）
    CHECK (status NOT IN ('Blocked','Waiting-on') OR length(trim(blocked_reason)) >= 1),
    -- reason 长度上限 500（ADR 0003 §D3）
    CHECK (length(blocked_reason) <= 500),
    CHECK (length(trim(title)) > 0)
);

-- ----------------------------------------------------------------------------
-- 索引
-- ----------------------------------------------------------------------------
-- ADR 0001 §索引策略在 task 上的本票实现 + ADR 0003 §D5 的 partial 索引。
CREATE INDEX idx_task_owner_status_due
    ON task(owner_person_id, status, due_date);   -- 人员矩阵
CREATE INDEX idx_task_project_status_due
    ON task(project_id, status, due_date);        -- 项目看板
CREATE INDEX idx_task_due_date
    ON task(due_date) WHERE due_date IS NOT NULL; -- Today/Week 面板
CREATE INDEX idx_task_in_flight_status
    ON task(status) WHERE status IN ('Open','In-progress','Blocked','Waiting-on');
    -- 在飞任务面板(排除 Done/Cancelled)
CREATE INDEX idx_task_status_blocked_at
    ON task(status, blocked_at)
    WHERE status IN ('Blocked','Waiting-on');     -- 阻塞通知 / 卡了几天
CREATE INDEX idx_task_template_scheduled_at
    ON task(recurring_template_id, scheduled_at);
    -- 模板实例查询 / 物化层窗口扫（ADR 0001 §索引策略 #4）

-- ----------------------------------------------------------------------------
-- 索引：子组花名册（在岗过滤）,即 ADR 0001 §索引策略 #6 的本票实现。
-- ----------------------------------------------------------------------------
-- 花名册视图按 (子组, 是否离岗) 查询;该复合索引让"某子组在岗人员"
-- 走 index seek,不再扫全表。`deactivated_at IS NULL` 的 partial predicate
-- 不加——离岗记录也需要被查询到（只是被应用层过滤掉）。
CREATE INDEX idx_person_sub_team_deactivated_at
    ON person(sub_team_id, deactivated_at);
