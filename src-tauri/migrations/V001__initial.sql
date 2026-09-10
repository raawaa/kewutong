-- ============================================================================
-- V001__initial.sql — sub_team 与 person（ticket #17）
-- ============================================================================
--
-- 这是整个 app 迁移链的第一张;按 spec #17 的范围,本票只建 `sub_team` 与
-- `person` 两张表 + `person(sub_team_id, deactivated_at)` 一条索引。
-- 其余表（project / task / recurring_template / notification_log / task_fts）
-- 由后续票按 ADR 0001 各自建 migration,不堆在本文件里。
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
-- 索引：子组花名册（在岗过滤）,即 ADR 0001 §索引策略 #6 的本票实现。
-- ----------------------------------------------------------------------------
-- 花名册视图按 (子组, 是否离岗) 查询;该复合索引让"某子组在岗人员"
-- 走 index seek,不再扫全表。`deactivated_at IS NULL` 的 partial predicate
-- 不加——离岗记录也需要被查询到（只是被应用层过滤掉）。
CREATE INDEX idx_person_sub_team_deactivated_at
    ON person(sub_team_id, deactivated_at);