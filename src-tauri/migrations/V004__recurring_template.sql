-- ============================================================================
-- V004__recurring_template.sql — recurring_template 全列（ticket #24）
-- ============================================================================
--
-- 承接 ADR 0001 §3.4：周期性模板（template）是周期性事务的可复用定义;
-- 实例（instance）是 task 行,通过 recurring_template_id FK 关联。
--
-- 本票只建模板表;instance 由 ticket #25 物化层写出——本票不引 FK 引用
-- 之外的耦合。`recurring_template_id` 与 `scheduled_at` 的"instance 必有"
-- 互斥由 task 表 V001 的 CHECK 约束保证。
--
-- 字段说明（承接 ADR 0001 §3.4 + ADR 0002）：
--   name            模板名称（一次性任务的"标题"在 instance 端）；
--   freq            DAILY / WEEKLY / MONTHLY / YEARLY 四值枚举;
--   byday_mask      bitmask,MO=1<<0 .. SU=1<<6;WEEKLY 时按位判定;非
--                   WEEKLY 时存 0（兼容 DAILY/MONTHLY/YEARLY 不需星
--                   期子句的场景）;
--   bymonthday      JSON 数组,如 [1,15] / [0];0 表示"月末",与 RFC 5545
--                   对齐;非 MONTHLY/YEARLY 时存 NULL;
--   bymonth         JSON 数组,如 [1,4,7,10] 表示 1/4/7/10 月;仅 YEARLY
--                   用;其它 freq 存 NULL;
--   byhour          0-23,默认 9;
--   byminute        0-59,默认 0;
--   iana_zone       IANA 时区名,默认 'Asia/Shanghai';**规则存墙钟+时区
--                   而非 UTC**,UTC 换算归 ticket #10 物化层,本票不做;
--   ends_on         终止日期(DATE),与 ends_after_n 二选一;
--   ends_after_n    出现次数(>=1),与 ends_on 二选一;
--   holiday_behavior SKIP(默认)/ SHIFT 二值枚举;
--   rrule_text      App 层 upsert 入口由结构化字段派生的 RRULE 字符串
--                   (sanity check 用途,解析时优先信任结构化字段);
--   project_id      挂项目(NULL = 不挂项目);
--   sub_team_id     挂子组(NULL = 不挂子组);两者至少一项非空
--                   (CHECK 保证);
--   enabled         1=启用 / 0=停用,物化层只扫 enabled=1;
--   notes           可选备注;
--   created_at      UTC 时间戳。
--
-- 索引策略承接 ADR 0001 §索引策略 #8:recurring_template(enabled, ends_on)
-- ——物化层"扫活跃模板"主路径。ends_on NULL 的(用 ends_after_n 终止的)
-- 模板同样参与扫描;索引并不禁 NULL,物化层 WHERE 已加 enabled=1。
-- ============================================================================

PRAGMA foreign_keys = OFF;

DROP TABLE recurring_template;

CREATE TABLE recurring_template (
    id                INTEGER PRIMARY KEY,
    name              TEXT    NOT NULL,
    freq              TEXT    NOT NULL,
    byday_mask        INTEGER NOT NULL DEFAULT 0,
    bymonthday        TEXT,    -- JSON 数组,NULL 表示"该 freq 不需日期"
    bymonth           TEXT,    -- JSON 数组,仅 YEARLY 用
    byhour            INTEGER NOT NULL DEFAULT 9,
    byminute          INTEGER NOT NULL DEFAULT 0,
    iana_zone         TEXT    NOT NULL DEFAULT 'Asia/Shanghai',
    ends_on           TEXT,    -- DATE,二选一
    ends_after_n      INTEGER, -- >=1,二选一
    holiday_behavior  TEXT    NOT NULL DEFAULT 'SKIP',
    rrule_text        TEXT    NOT NULL,
    project_id        INTEGER          REFERENCES project(id),
    sub_team_id       INTEGER          REFERENCES sub_team(id),
    enabled           INTEGER NOT NULL DEFAULT 1,
    notes             TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),

    -- 二选一:都填或都不填都被拒(承接 ADR 0002)
    CHECK ((ends_on IS NOT NULL) <> (ends_after_n IS NOT NULL)),
    -- scope 至少一项非空
    CHECK (project_id IS NOT NULL OR sub_team_id IS NOT NULL),
    -- JSON 字段(若非 NULL)必须合法
    CHECK (bymonthday IS NULL OR json_valid(bymonthday)),
    CHECK (bymonth    IS NULL OR json_valid(bymonth)),
    -- 频率 4 值枚举
    CHECK (freq IN ('DAILY','WEEKLY','MONTHLY','YEARLY')),
    -- 节假日策略 2 值枚举
    CHECK (holiday_behavior IN ('SKIP','SHIFT')),
    -- 时间字段范围
    CHECK (byhour   >= 0 AND byhour   <= 23),
    CHECK (byminute >= 0 AND byminute <= 59),
    -- bitmask 仅占低 7 位(MO..SU)
    CHECK (byday_mask >= 0 AND byday_mask < 128),
    CHECK (ends_after_n IS NULL OR ends_after_n >= 1),
    -- 必填字符串
    CHECK (length(trim(name)) > 0),
    -- 时区不能空(避免误写空字符串)
    CHECK (length(trim(iana_zone)) > 0)
);

-- ADR 0001 §索引策略 #8:活跃模板扫描(物化层触发)
CREATE INDEX idx_recurring_template_enabled_ends_on
    ON recurring_template(enabled, ends_on);

PRAGMA foreign_keys = ON;