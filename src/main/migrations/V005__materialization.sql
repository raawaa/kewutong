-- ============================================================================
-- V005__materialization.sql — 物化引擎索引 + 元数据表（ticket #25）
-- ============================================================================
--
-- ticket #25「物化引擎」交付的两个 Schema 改动：
--
-- 1) Instance 列已有（V001）：task.recurring_template_id / scheduled_at /
--    original_scheduled_at / rescheduled_from_id。本票不引新列,只补**唯
--    一索引**与**查询索引**——前者保幂等,后者保今日 / 本周视图扫
--    instance 的性能。
--
-- 2) materialization_meta 表：跟踪「最后一次跨入下一周的物化触发」是哪
--    一周；物化层用这个判断本次启动 / 后台 tick 是不是进入了新的 ISO
--    周,只在新的一周里再跑一次（虽然因为幂等,重复跑不影响正确性,
--    但省一次扫描）。
--
-- 设计要点:
-- - 唯一索引只覆盖 instance（WHERE recurring_template_id IS NOT NULL）,
--   一次性 task 两列都是 NULL,不受唯一约束;否则建库时一次性 task
--   会被拒。
-- - scheduled_at 入库格式 '%Y-%m-%d %H:%M:%S'（与 V001 task.due_date
--   一致的 SQL 文本类型,UTC 时刻）;直接走 scheduled_at 索引无需做
--   函数转换,因为物化写入的就是「UTC 当日 00:00」等价墙钟「本地 08:00」
--   ——见 materialization.rs::wall_clock_to_utc_sql 的解释。
-- - materialization_meta 单行表：last_iso_year + last_iso_week。1 行,
--   PK 写死 'singleton',任何更新都只动这一行。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Instance 唯一索引：保物化层幂等
-- ----------------------------------------------------------------------------
-- 同一模板在同一 UTC 时刻只能有一个 instance(同生同灭语义)。重跑物化
-- 不会产生重复行：INSERT OR IGNORE 在唯一冲突时跳过。
--
-- 走部分索引 predicate WHERE recurring_template_id IS NOT NULL：一次性
-- task 的两列都是 NULL,本索引不覆盖；也避免 `(NULL, NULL)` 触发唯一冲
-- 突(虽然 SQLite 把 NULL 视为彼此不同,但加 predicate 让语义更清楚)。
CREATE UNIQUE INDEX idx_task_template_scheduled_at_unique
    ON task(recurring_template_id, scheduled_at)
    WHERE recurring_template_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) Instance 普通索引：今日 / 本周视图扫 instance
-- ----------------------------------------------------------------------------
-- ticket #25 验收:今日视图里的"今天"列要混排 instance(带 ↻ 标记);
-- 视图按 scheduled_at 分桶扫,需要 (recurring_template_id IS NOT NULL,
-- scheduled_at) 的二级索引,免去全表扫。V001 的 idx_task_due_date 是
-- 一次性 task 的,本索引是 instance 端的对应物。
--
-- 仅看 instance(`recurring_template_id IS NOT NULL` 部分索引)：一次性
-- task 的 scheduled_at 列恒为 NULL,partial predicate 把它们预筛掉。
CREATE INDEX idx_task_scheduled_at
    ON task(scheduled_at)
    WHERE recurring_template_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3) 物化元数据：跨周触发去重
-- ----------------------------------------------------------------------------
-- 单行表,主键写死 'singleton'。存「上一次物化触发所在 ISO 周」的
-- (year, week) 元组;启动 / 后台 tick 拿到当前 ISO 周,若二者相等就
-- 跳过整个物化流程,否则更新本表并跑一次物化。
--
-- ISO 周算法:date('now', 'weekday 0', '-6 days') 取该 ISO 周的周一,
-- 然后 strftime('%Y', monday) 与 strftime('%W', monday) 拿 (year, week)。
-- 详见 materialization.rs::should_materialize_this_tick。
CREATE TABLE materialization_meta (
    id            TEXT    PRIMARY KEY CHECK (id = 'singleton'),
    last_iso_year INTEGER NOT NULL CHECK (last_iso_year BETWEEN 1900 AND 2999),
    last_iso_week INTEGER NOT NULL CHECK (last_iso_week BETWEEN 1 AND 53),
    last_run_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------------------------------------------------------
-- 4) task.sub_team_id：周期性 instance 继承模板的子组
-- ----------------------------------------------------------------------------
-- 物化层(ticket #25)写 instance 时把模板的 sub_team_id 落到 task 行——
-- 一次性 task 该列 NULL。子组非强约束(可以 NULL),挂模板的子组可
-- 能被改 / 被删——所以不加 FK,instance 落地后用最宽松语义。
--
-- 与 person 表上 sub_team_id 是 NOT NULL 不冲突:person 是花名册,必有
-- 归属;task 上的 sub_team_id 只在 instance 行里用作"属于哪个子组"
-- 的轻量标识,人员矩阵的 owner_person_id 才是查询主路径。
ALTER TABLE task ADD COLUMN sub_team_id INTEGER;
