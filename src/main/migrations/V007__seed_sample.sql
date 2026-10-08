-- ============================================================================
-- V007__seed_sample.sql — 示例数据(ticket #31)
-- ============================================================================
--
-- 科长首启时看到一份能跑通的演示数据:
-- - 2 个示例子组 + 4 名示例人员,跑通人员矩阵视图
-- - 1 个示例项目,跑通项目看板视图
-- - 5 条一次性任务(Open / In-progress / Done / Blocked / Waiting-on),
--   阻塞字段的用法一目了然
-- - 2 个示例 Template(周一例会 + 月度汇报),物化 8 条 instance 跨 8
--   周窗口;窗口落在 2026 国庆节 Oct 1-7,Oct 5 周一例会与 Oct 1 月
--   度汇报 SKIP,演示物化层的节假日处理
--
-- 所有示例行带 `is_sample = 1`,清除命令按此过滤——真实数据始终
-- `is_sample = 0`,清除不影响真实数据。
--
-- 设计要点:
-- - 显式 ID:避免 AUTOINCREMENT,rowid 自然递增已够(ADR 0001 §命名
--   与公共约定)。
-- - `is_sample` 列在本 migration 一起建出来再 INSERT,refinery 把整
--   个文件包在一个事务里——两段 SQL 在同一安装步骤中执行。
-- - instance 日期用**绝对** 2026-09-14 ~ 2026-11-02 (weekly) +
--   2026-11-01 (monthly),不用相对日期。AC 要求 seed 实例正确体现
--   2026 国庆 Oct 1-7 SKIP,相对日期在不同安装日下指向不同的真实周
--   ——绝对日期才能保证 Oct 5 / Oct 1 必然落在窗口里。窗口日期不论
--   落在过去还是未来,数据结构与 SKIP 演示都成立。
-- - 节假日 SKIP 写入 seed,不靠启动时物化层补:refinery migration 一次
--   性跑完,启动时物化不会重新生成(唯一索引 `(recurring_template_id,
--   scheduled_at)` 也会防重复)。这样示例数据"长什么样"在迁移落库
--   那一刻就钉死了,与启动物化无关。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. is_sample 列——所有"示例数据"标记位的单一来源
-- ----------------------------------------------------------------------------
-- DEFAULT 0:真实数据默认非示例;新安装若未跑过 seed,这一列保持 0。
-- NOT NULL:不引入"忘了标"导致的悬空标记;迁移层把关。
ALTER TABLE sub_team           ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE person             ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project            ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task               ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recurring_template ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;

-- 索引——清除命令按 is_sample 过滤,以及"是否还有示例数据"横幅查询
-- (`SELECT EXISTS(SELECT 1 FROM ... WHERE is_sample = 1)`)走 index seek。
-- 5 张表都建 partial index:`WHERE is_sample = 1` 让索引只覆盖示例行,
-- 不污染真实数据路径(真实数据量级 100-1000 行,示例数据 < 30 行)。
CREATE INDEX idx_sub_team_is_sample           ON sub_team(is_sample)           WHERE is_sample = 1;
CREATE INDEX idx_person_is_sample             ON person(is_sample)             WHERE is_sample = 1;
CREATE INDEX idx_project_is_sample            ON project(is_sample)            WHERE is_sample = 1;
CREATE INDEX idx_task_is_sample               ON task(is_sample)               WHERE is_sample = 1;
CREATE INDEX idx_recurring_template_is_sample ON recurring_template(is_sample) WHERE is_sample = 1;

-- ----------------------------------------------------------------------------
-- 2. 示例子组 (2 个)
-- ----------------------------------------------------------------------------
-- ID 1-2;真实子组从 ID 3 起由 V008 灌入,避免 ID 重叠混淆。
INSERT INTO sub_team (id, name, description, sort_order, created_at, is_sample) VALUES
  (1, '示例一组', '演示用第一子组;首启时清除', 1, datetime('now'), 1),
  (2, '示例二组', '演示用第二子组;首启时清除', 2, datetime('now'), 1);

-- ----------------------------------------------------------------------------
-- 3. 示例人员 (4 名,每组 2 人)
-- ----------------------------------------------------------------------------
-- contact 写示例工号,不暴露真实联系方式格式。
INSERT INTO person (id, name, sub_team_id, contact,             deactivated_at, created_at, is_sample) VALUES
  (1, '张三',     1,            '示例-工号 001',           NULL,             datetime('now'), 1),
  (2, '李四',     1,            '示例-工号 002',           NULL,             datetime('now'), 1),
  (3, '王五',     2,            '示例-工号 003',           NULL,             datetime('now'), 1),
  (4, '赵六',     2,            '示例-工号 004',           NULL,             datetime('now'), 1);

-- ----------------------------------------------------------------------------
-- 4. 示例项目 (1 个)
-- ----------------------------------------------------------------------------
-- start_date / due_date 给一个跨越整个示例窗口的区间,看板视图里能
-- 看到 due_date 排序生效。
INSERT INTO project (id, name,         owner_person_id, sub_team_id, start_date,  due_date,    notes,                                       created_at, is_sample) VALUES
  (1,    '示例项目 A', 1,               1,              '2026-09-01', '2026-12-31', '示例项目;展示项目看板、阻塞与等待他人场景', datetime('now'), 1);

-- ----------------------------------------------------------------------------
-- 5. 示例一次性任务 (5 条;覆盖 Open / In-progress / Done / Blocked / Waiting-on)
-- ----------------------------------------------------------------------------
-- blocked_at 用 datetime('now', '-N days') 让"已阻塞 N 天"字段直接
-- 有非空读数;新装时也立即可看。
-- waiting_on_person_id 指向同子组另一人——演示「等同事拍板」场景。
INSERT INTO task (
  id, title,                description,                       status,       owner_person_id, project_id, due_date,      recurring_template_id, scheduled_at, original_scheduled_at, rescheduled_from_id, created_at,     updated_at,     blocked_at,                blocked_reason,                       waiting_on_person_id, is_sample
) VALUES
  (1, '撰写月度汇报模板',  '为示例项目 A 准备汇报结构(一次性任务)',  'Open',         1,               1,         '2026-09-20',  NULL,                    NULL,         NULL,                  NULL,                datetime('now'), datetime('now'), NULL,                       NULL,                                  NULL,                  1),
  (2, '收集组内周报',      '本周示例一组工作汇总',                    'In-progress',  2,               1,         '2026-09-12',  NULL,                    NULL,         NULL,                  NULL,                datetime('now'), datetime('now'), NULL,                       NULL,                                  NULL,                  1),
  (3, '完成 Q3 报告初稿',  '示例项目 A 阶段性交付;已交付',            'Done',         1,               1,         '2026-09-08',  NULL,                    NULL,         NULL,                  NULL,                datetime('now'), datetime('now'), NULL,                       NULL,                                  NULL,                  1),
  (4, '等外委回函',        '等外部单位盖章后继续',                    'Blocked',      3,               1,         '2026-09-15',  NULL,                    NULL,         NULL,                  NULL,                datetime('now'), datetime('now'), datetime('now', '-5 days'), '等外委单位盖章回函(已阻塞 5 天)',           NULL,                  1),
  (5, '等赵六确认接口',    '等同事拍板接口最终版本',                  'Waiting-on',   3,               1,         '2026-09-15',  NULL,                    NULL,         NULL,                  NULL,                datetime('now'), datetime('now'), datetime('now', '-2 days'), '等接口最终版本',                      4,                    1);

-- ----------------------------------------------------------------------------
-- 6. 示例周期性模板 (2 条)
-- ----------------------------------------------------------------------------
-- 周一例会:WEEKLY + BYDAY=MO;月度汇报:MONTHLY + BYMONTHDAY=1。
-- 两者 ends_on = '2099-12-31' 模拟"无终止";真实终止条件由用户在 UI 维护。
-- 两者 holiday_behavior = 'SKIP'(默认行为,显式写出来便于排错)。
-- sub_team_id = 1(示例一组),让物化实例自动继承归属。
INSERT INTO recurring_template (
  id, name,       freq,        byday_mask, bymonthday, bymonth, byhour, byminute, iana_zone,        ends_on,      ends_after_n, holiday_behavior, rrule_text,                       project_id, sub_team_id, enabled, notes,                                       created_at, is_sample
) VALUES
  (1,  '周一例会', 'WEEKLY',    1,          NULL,       NULL,    8,       0,        'Asia/Shanghai',   '2099-12-31', NULL,         'SKIP',           'FREQ=WEEKLY;BYDAY=MO',           NULL,       1,            1,       '示例周一例会;展示人员矩阵与今日视图',         datetime('now'), 1),
  (2,  '月度汇报', 'MONTHLY',   0,          '[1]',      NULL,    9,       0,        'Asia/Shanghai',   '2099-12-31', NULL,         'SKIP',           'FREQ=MONTHLY;BYMONTHDAY=1',      NULL,       1,            1,       '示例月度工作汇报',                              datetime('now'), 1);

-- ----------------------------------------------------------------------------
-- 7. 物化示例 instance (8 条;2026 国庆 Oct 1-7 SKIP)
-- ----------------------------------------------------------------------------
-- 时区:Asia/Shanghai = UTC+8,固定偏移。
--   周一例会 08:00 Asia/Shanghai → 00:00:00 UTC(scheduled_at)
--   月度汇报 09:00 Asia/Shanghai → 01:00:00 UTC(scheduled_at)
--
-- 8 周窗口:2026-09-14(Mon) ~ 2026-11-02(Mon)
-- 周一例会每周一次,理论应生成 8 条:
--   2026-09-14, 09-21, 09-28, 10-05, 10-12, 10-19, 10-26, 11-02
-- 但 2026-10-05 在国庆节区间内,SKIP → 仅 7 条。
--
-- 月度汇报每月 1 日,理论应生成 2 条(09-01 在窗口外,10-01 SKIP,11-01 在窗口内):
--   2026-09-01(早于窗口,不进), 2026-10-01(SKIP), 2026-11-01
-- 仅 2026-11-01 一条进窗口。
--
-- 共 7 + 1 = 8 条,符合 AC「8 周窗口 8 条实例」。
--
-- `original_scheduled_at` 与 `scheduled_at` 同值(SKIP 不改期,只是不生
-- 成;改期是 SHIFT 路径的事,本 seed 全部 SKIP 不引入改期)。
-- `rescheduled_from_id` 恒 NULL。
INSERT INTO task (
  id, title,      description, status, owner_person_id, project_id, due_date, recurring_template_id, scheduled_at,         original_scheduled_at, rescheduled_from_id, created_at,     updated_at,     blocked_at, blocked_reason, waiting_on_person_id, is_sample
) VALUES
  -- 7.1 周一例会 (7 条,Oct 5 SKIP)
  (10, '周一例会', NULL,         'Open', 1,               NULL,        NULL,     1,                    '2026-09-14 00:00:00', '2026-09-14 00:00:00', NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL,                  1),
  (11, '周一例会', NULL,         'Open', 1,               NULL,        NULL,     1,                    '2026-09-21 00:00:00', '2026-09-21 00:00:00', NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL,                  1),
  (12, '周一例会', NULL,         'Open', 1,               NULL,        NULL,     1,                    '2026-09-28 00:00:00', '2026-09-28 00:00:00', NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL,                  1),
  -- 2026-10-05 SKIP(国庆节):不写入
  (13, '周一例会', NULL,         'Open', 1,               NULL,        NULL,     1,                    '2026-10-12 00:00:00', '2026-10-12 00:00:00', NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL,                  1),
  (14, '周一例会', NULL,         'Open', 1,               NULL,        NULL,     1,                    '2026-10-19 00:00:00', '2026-10-19 00:00:00', NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL,                  1),
  (15, '周一例会', NULL,         'Open', 1,               NULL,        NULL,     1,                    '2026-10-26 00:00:00', '2026-10-26 00:00:00', NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL,                  1),
  (16, '周一例会', NULL,         'Open', 1,               NULL,        NULL,     1,                    '2026-11-02 00:00:00', '2026-11-02 00:00:00', NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL,                  1),
  -- 7.2 月度汇报 (1 条;Oct 1 SKIP,Sep 1 在窗口外,仅 Nov 1 进窗口)
  (20, '月度汇报', NULL,         'Open', 1,               NULL,        NULL,     2,                    '2026-11-01 01:00:00', '2026-11-01 01:00:00', NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL,                  1);
