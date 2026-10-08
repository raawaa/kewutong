-- ============================================================================
-- V006__notification_log.sql — 通知日志表（ticket #30）
-- ============================================================================
--
-- 承接 ADR 0001 §3.6：通知落库、错过弹窗也不丢信息——未读面板基于此表
-- （`viewed_at IS NULL`）。同一规则对同一对象不反复轰炸，去重也走这张
-- 表（`UNIQUE` 不引入，靠调用方在 INSERT 前 SELECT 一次判定；详见
-- `src-tauri/src/notifications.rs::dedup_insert`）。
--
-- 设计要点：
-- - `kind` 三值枚举：`due_24h` / `blocked_3d` / `weekly_digest` —— DB
--   层用 CHECK 锁死；与 Rust 端 `NotificationKind` 字面量一一对应。
-- - `related_task_id` / `related_template_id` 至少一项非空：CHECK 保证
--   "通知至少关联一个实体"。weekly_digest 不挂任务也不挂模板，本票
--   不发；保留可空为 future-proof（如"今天放假提醒"挂一条模板 NULL
--   task NULL 的覆盖情况——但目前 weekly_digest 不发,本票用不到）。
--   若未来需要新增 `related_task_id IS NULL AND related_template_id IS
--   NULL` 的 kind,放开这个 CHECK 即可。
-- - `payload TEXT` + `CHECK (json_valid(payload))`：与 Rust 端
--   `NotificationPayload` enum（`#[serde(tag = "kind")]`) 双绑；序列化
--   形状单源。
-- - `viewed_at` 部分索引 `WHERE viewed_at IS NULL`：未读面板查询路径，
--   命中"未读子集"避免全表扫；已读行的索引项不入 partial。
-- - `idx_notification_log_kind_target`：dedup 走 `WHERE kind = ? AND
--   related_task_id = ?` / `WHERE kind = ? AND triggered_at LIKE ?`，
--   这一复合索引让 weekly_digest 的"同一周一条"判定和 due_24h /
--   blocked_3d 的"同一任务一条"判定都走 index seek。
--
-- FTS5 影子表与同步触发器不引入——通知日志不参与全文搜索。
-- ============================================================================

CREATE TABLE notification_log (
    id                  INTEGER PRIMARY KEY,
    triggered_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    kind                TEXT    NOT NULL,
    related_task_id     INTEGER          REFERENCES task(id) ON DELETE CASCADE,
    related_template_id INTEGER          REFERENCES recurring_template(id) ON DELETE CASCADE,
    payload             TEXT    NOT NULL,
    viewed_at           TEXT,

    CHECK (kind IN ('due_24h', 'blocked_3d', 'weekly_digest')),
    CHECK (json_valid(payload)),
    -- 至少关联一个实体,但 `weekly_digest` 的语义对象是「这一周」而非单条
    -- task / template,允许两者均为 NULL——把约束放宽到仅 due_24h /
    -- blocked_3d 必填。共三种 kind 中两种仍受「至少关联一个实体」约束,
    -- 与 ADR 0001 §3.6 精神对齐。
    CHECK (
        kind = 'weekly_digest'
        OR related_task_id IS NOT NULL
        OR related_template_id IS NOT NULL
    )
);

-- 未读面板查询路径（`WHERE viewed_at IS NULL`）。partial index 把已读
-- 行的索引项剔除——只服务"未读"路径，省空间。
CREATE INDEX idx_notification_log_viewed_at_unread
    ON notification_log(viewed_at)
    WHERE viewed_at IS NULL;

-- dedup 查询路径：
--   - due_24h / blocked_3d: `WHERE kind = ? AND related_task_id = ?`
--   - weekly_digest: `WHERE kind = ? AND triggered_at LIKE ?`（同周）
-- 复合 (kind, related_task_id) 索引覆盖前两条；weekly_digest 路径在已
-- 知"一周只一条"的语义下量很小（一年 ≤ 53 条），全表扫可接受。
CREATE INDEX idx_notification_log_kind_task
    ON notification_log(kind, related_task_id);