-- ============================================================================
-- seed-example-data.sql — 首启示例数据(ticket #11 第二部分交付物)
-- ============================================================================
--
-- 一键灌入首启示例数据,演示子组 / 人员 / 项目 / 一次性任务 / 周期性模板
-- 与未来 8 周物化实例。
--
-- 适用 schema 版本:
--   - V001__initial.sql              (ADR 0001)
--   - V003__add_task_block_fields.sql (ADR 0003 task 阻塞字段 delta)
--
-- 推荐 refinery 迁移号: V004__seed_sample.sql
--   (注: ADR 0001 §与下游 ticket 的衔接 原写 V002;但 V002 已被 ADR 0003 的
--    block-fields 占用,seed 必须跑在 V003 之后才能引用 blocked_reason /
--    waiting_on_person_id,故提到 V004。若实现阶段重排迁移号,改这里即可。)
--
-- 用法(开发环境):
--   sqlite3 kewutong.db < migrations/V001__initial.sql
--   sqlite3 kewutong.db < migrations/V003__add_task_block_fields.sql
--   sqlite3 kewutong.db < docs/data/seed-example-data.sql
--
-- 用法(App 首启 / Tauri 端):
--   let sql = include_str!("../../docs/data/seed-example-data.sql");
--   conn.execute_batch(sql)?;
--
-- 标记:示例数据首起展示时带「示例」横幅,App 提供一键清除(回到空 DB)。
-- 清除后,真实数据由 #11 第一部分定义的初始子组 + 用户在 UI 中录入。
--
-- 备注:
--   - ID 显式赋值(无 AUTOINCREMENT,承接 ADR 0001 §命名与公共约定)
--   - 时间戳全部用 datetime('now') 而非固定字符串,跨日期运行保持一致
--   - 物化实例的 scheduled_at 用 SQLite date 修饰符从 now 派生
--   - 节假日 SKIP 此处硬编码(2026 国庆节 Oct 1-7);生产环境由 App 启动加载
--     holidays/cn-<year>.json 后由 MaterializationJob 判定(ADR 0002 §物化策略)
-- ============================================================================

BEGIN;

PRAGMA foreign_keys = ON;

-- ============================================================================
-- 1. 示例子组 (2 个)
-- ============================================================================
INSERT INTO sub_team (id, name, description, sort_order, created_at) VALUES
  (1, '示例一组', '演示用第一子组;首启时清除',            1, datetime('now')),
  (2, '示例二组', '演示用第二子组;首启时清除',            2, datetime('now'));

-- ============================================================================
-- 2. 示例人员 (每组 2 人,共 4 名)
--    contact 列:SQLite schema 不限定格式(电话/微信/工号自由填,见 ADR 0001 §3.2)
-- ============================================================================
INSERT INTO person (id, name, sub_team_id, contact,        deactivated_at, created_at) VALUES
  (1, '张三',     1,            '示例-工号 001',          NULL,            datetime('now')),
  (2, '李四',     1,            '示例-工号 002',          NULL,            datetime('now')),
  (3, '王五',     2,            '示例-工号 003',          NULL,            datetime('now')),
  (4, '赵六',     2,            '示例-工号 004',          NULL,            datetime('now'));

-- ============================================================================
-- 3. 示例项目 (1 个)
-- ============================================================================
INSERT INTO project (id, name,         owner_person_id, sub_team_id, start_date,  due_date,    notes,                                       created_at) VALUES
  (1,    '示例项目 A', 1,               1,              '2026-09-01', '2026-12-31', '示例项目;展示项目看板、阻塞与等待他人场景',     datetime('now'));

-- ============================================================================
-- 4. 示例任务 (5 条;覆盖 Open / In-progress / Blocked / Waiting-on / Done)
--    注: ticket #11 字面要求 3 条(Open / In-progress / Done);另加 Blocked +
--        Waiting-on 各一条以演示 ADR 0003 task 阻塞字段 delta
--        (blocked_at / blocked_reason / waiting_on_person_id)。
-- ============================================================================
INSERT INTO task (
  id,    title,                description,                       status,       owner_person_id, project_id, due_date,      recurring_template_id, scheduled_at, original_scheduled_at, rescheduled_from_id, created_at,        updated_at,        blocked_at,             blocked_reason,                  waiting_on_person_id
) VALUES
  (1,    '撰写月度汇报模板',    '为示例项目 A 准备汇报结构(一次性任务)',     'Open',         1,               1,         '2026-09-20',  NULL,                    NULL,         NULL,                  NULL,                datetime('now'),    datetime('now'),    NULL,                    NULL,                          NULL),
  (2,    '收集组内周报',        '本周示例一组工作汇总',                     'In-progress',  2,               1,         '2026-09-12',  NULL,                    NULL,         NULL,                  NULL,                datetime('now'),    datetime('now'),    NULL,                    NULL,                          NULL),
  (3,    '完成 Q3 报告初稿',    '示例项目 A 阶段性交付;已交付',             'Done',         1,               1,         '2026-09-08',  NULL,                    NULL,         NULL,                  NULL,                datetime('now'),    datetime('now'),    NULL,                    NULL,                          NULL),
  (4,    '等外委回函',          '等外部单位盖章后继续',                     'Blocked',      3,               1,         '2026-09-15',  NULL,                    NULL,         NULL,                  NULL,                datetime('now'),    datetime('now'),    datetime('now','-5 days'), '等外委单位盖章回函(已阻塞 5 天)',     NULL),
  (5,    '等赵六确认接口',      '等同事拍板接口最终版本',                   'Waiting-on',   3,               1,         '2026-09-15',  NULL,                    NULL,         NULL,                  NULL,                datetime('now'),    datetime('now'),    datetime('now','-2 days'), '等接口最终版本',                4);

-- ============================================================================
-- 5. 示例周期性模板 (2 条)
--    规则承接 ADR 0002 RRULE 子集;ends_on / ends_after_n 二选一必填
--    (ADR 0001 §3.4 CHECK),以 ends_on='2099-12-31' 模拟「无终止」。
-- ============================================================================
INSERT INTO recurring_template (
  id, name,       freq,        byday_mask, bymonthday, bymonth, byhour, byminute, iana_zone,        ends_on,      ends_after_n, holiday_behavior, rrule_text,                  project_id, sub_team_id, enabled, notes,                                created_at
) VALUES
  (1,  '周一例会', 'WEEKLY',    1,          NULL,       NULL,    8,       0,        'Asia/Shanghai',   '2099-12-31', NULL,         'SKIP',           'FREQ=WEEKLY;BYDAY=MO',     NULL,       1,            1,       '示例子组一周一例会;展示人员矩阵与今日视图', datetime('now')),
  (2,  '月度汇报', 'MONTHLY',   0,          '[1]',      NULL,    9,       0,        'Asia/Shanghai',   '2099-12-31', NULL,         'SKIP',           'FREQ=MONTHLY;BYMONTHDAY=1', NULL,       1,            1,       '示例月度工作汇报',                       datetime('now'));

-- ============================================================================
-- 6. 物化未来 8 周的 recurring_instance (共 8 条,SKIP 已应用)
--    参考起始日:今天 = 2026-09-10 (Thu)
--    8 周窗口:    2026-09-14 ~ 2026-11-05
--
-- 时区:Asia/Shanghai = UTC+8,无 DST
--   周一例会 08:00 Asia/Shanghai → 00:00 UTC(scheduled_at)
--   月度汇报 09:00 Asia/Shanghai → 01:00 UTC(scheduled_at)
--
-- SKIP 应用(2026 国庆节 Oct 1-7):
--   - 周一例会:跳过 2026-10-05(原 +3 weeks)
--   - 月度汇报:跳过 2026-10-01(原 +1 month)
-- ============================================================================

-- 6.1 周一例会实例 (7 条;Oct 5 因 2026 国庆节 SKIP)
INSERT INTO task (
  id,    title,      description, status, owner_person_id, project_id, due_date, recurring_template_id, scheduled_at,                                                    original_scheduled_at,                                          rescheduled_from_id, created_at,     updated_at,     blocked_at, blocked_reason, waiting_on_person_id
) VALUES
  (10,   '周一例会',  NULL,         'Open', 1,               NULL,        NULL,     1,                    datetime('now','weekday 1',             'start of day'), datetime('now','weekday 1',             'start of day'), NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL),
  (11,   '周一例会',  NULL,         'Open', 1,               NULL,        NULL,     1,                    datetime('now','weekday 1','+1 week',   'start of day'), datetime('now','weekday 1','+1 week',   'start of day'), NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL),
  (12,   '周一例会',  NULL,         'Open', 1,               NULL,        NULL,     1,                    datetime('now','weekday 1','+2 weeks',  'start of day'), datetime('now','weekday 1','+2 weeks',  'start of day'), NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL),
  (13,   '周一例会',  NULL,         'Open', 1,               NULL,        NULL,     1,                    datetime('now','weekday 1','+4 weeks',  'start of day'), datetime('now','weekday 1','+4 weeks',  'start of day'), NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL),
  (14,   '周一例会',  NULL,         'Open', 1,               NULL,        NULL,     1,                    datetime('now','weekday 1','+5 weeks',  'start of day'), datetime('now','weekday 1','+5 weeks',  'start of day'), NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL),
  (15,   '周一例会',  NULL,         'Open', 1,               NULL,        NULL,     1,                    datetime('now','weekday 1','+6 weeks',  'start of day'), datetime('now','weekday 1','+6 weeks',  'start of day'), NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL),
  (16,   '周一例会',  NULL,         'Open', 1,               NULL,        NULL,     1,                    datetime('now','weekday 1','+7 weeks',  'start of day'), datetime('now','weekday 1','+7 weeks',  'start of day'), NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL);

-- 6.2 月度汇报实例 (1 条;Oct 1 因 2026 国庆节 SKIP,Nov 1 落在窗口内)
INSERT INTO task (
  id,    title,      description, status, owner_person_id, project_id, due_date, recurring_template_id, scheduled_at,                                                    original_scheduled_at,                                          rescheduled_from_id, created_at,     updated_at,     blocked_at, blocked_reason, waiting_on_person_id
) VALUES
  (20,   '月度汇报',  NULL,         'Open', 1,               NULL,        NULL,     2,                    datetime('now','start of month','+2 months','01:00:00'),   datetime('now','start of month','+2 months','01:00:00'),   NULL,                datetime('now'), datetime('now'), NULL,        NULL,           NULL);

COMMIT;

-- ============================================================================
-- 验证(可选;开发环境跑完后用)
-- ============================================================================
-- SELECT 'sub_team'            AS table_name, COUNT(*) AS n FROM sub_team;
-- SELECT 'person'              AS table_name, COUNT(*) AS n FROM person;
-- SELECT 'project'             AS table_name, COUNT(*) AS n FROM project;
-- SELECT 'task (sample)'       AS table_name, COUNT(*) AS n FROM task WHERE recurring_template_id IS NULL;
-- SELECT 'task (instance)'     AS table_name, COUNT(*) AS n FROM task WHERE recurring_template_id IS NOT NULL;
-- SELECT 'recurring_template'  AS table_name, COUNT(*) AS n FROM recurring_template;
--
-- 预期(运行当天为 2026-09-10):
--   sub_team           2
--   person             4
--   project            1
--   task (sample)      5    (Open + In-progress + Done + Blocked + Waiting-on)
--   task (instance)    8    (7 周一例会 + 1 月度汇报;Oct 5 / Oct 1 因 2026 国庆节 SKIP)
--   recurring_template 2