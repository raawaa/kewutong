-- ============================================================================
-- V002__project.sql — project 表全列（ticket #20）
-- ============================================================================
--
-- 承接 ADR 0001 §3.3：项目是科长把一组相关任务挂在一起的容器；`status` 列
-- 不存,由视图层聚合 task.status 计算(本票 #20 验收点)。
--
-- V001 已建的 `project` 仅 `id INTEGER PRIMARY KEY`(占位骨架,本表用来
-- 给 task.project_id FK 提供合法目标)。本 migration 直接 drop + create:
-- 截至本票无任何部署的库,task 行即便存在也没有 project_id 可指
-- (task.project_id 列允许 NULL,且占位骨架 project 没有其它列插不进任何
-- 有意义的行)——drop 不会撞 FK。
--
-- 删除项目的语义:task.project_id 的 FK 默认 NO ACTION,删有任务的 project
-- 会被 DB 挡下来。ticket #20 选「项目下任务的 project_id 置 NULL」语义,由
-- App 层在事务里 UPDATE + DELETE 协同实现,不在本 SQL 里换 FK(避免触发
-- task 的 table-recreate)。
--
-- refinery 已经把整条 migration 包在事务里了,所以这里不再 BEGIN / COMMIT。
-- ============================================================================

PRAGMA foreign_keys = OFF;

DROP TABLE project;

CREATE TABLE project (
    id              INTEGER PRIMARY KEY,
    name            TEXT    NOT NULL,
    owner_person_id INTEGER NOT NULL REFERENCES person(id),
    sub_team_id     INTEGER NOT NULL REFERENCES sub_team(id),
    start_date      TEXT,
    due_date        TEXT,
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

    CHECK (length(trim(name)) > 0)
);

-- ADR 0001 §索引策略 #7:子组项目面板,按 (子组, due_date) 扫。
CREATE INDEX idx_project_sub_team_due_date ON project(sub_team_id, due_date);

PRAGMA foreign_keys = ON;