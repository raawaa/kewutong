-- ============================================================================
-- V003__holiday_override.sql — holiday_override 表（ticket #23）
-- ============================================================================
--
-- App 内"切换某一天为 Holiday/Workday"的覆盖持久化层。
--
-- 写入入口仅 [`crate::holiday::set_override`] / [`crate::holiday::clear_override`]
-- 两处（命令层 `commands/holiday.rs` 调用）；读取入口仅
-- [`crate::holiday::HolidayCalendar::load`] 启动时一次性读入内存。
--
-- 设计要点：
-- - `(date, kind)` 二元组；`date` 用 PRIMARY KEY 保证一条日期最多一条覆盖。
-- - `date TEXT` 格式 '%Y-%m-%d'，与 `holidays/cn-YYYY.json` 的字段对齐。
-- - `kind` 取值 `'holiday'` / `'workday'`，CHECK 拒非法；语义与
--   `holiday.rs::DayKind` 一一对应。
-- - 不存 `name`：App 内覆盖只关心是/不是节假日，不关心叫什么名字。
--   物化层拿 `name` 只来自种子。
-- - 不存 `created_at` / `updated_at`：单写者本机场景下没审计需求；
--   Syncthing 文件级同步若需追溯可看 git 历史（暂无 git 化的覆盖）。
-- ============================================================================

CREATE TABLE holiday_override (
    date TEXT    PRIMARY KEY,
    kind TEXT    NOT NULL,
    CHECK (kind IN ('holiday', 'workday')),
    CHECK (length(date) = 10) -- YYYY-MM-DD 固定 10 字符,拦下脏写
);

-- `date` 已是 PRIMARY KEY (隐式 UNIQUE 索引),`kind` 列当前**没有按值
-- 查询的读路径**——「列出所有 override」会用 `ORDER BY date` 走主键。
-- 等 UI 真出现「筛选全部 App 标记为 holiday 的天」之类需求时再加
-- `idx_holiday_override_kind`。过早建索引属于 §Speculative Generality。