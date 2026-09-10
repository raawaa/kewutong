# 周期性事务模板的时间规则

**Status**: accepted

本项目（科室任务管理桌面 app）的周期性事务需要一套时间规则，覆盖每周 / 每月 / 工作日 / 月末特定星期等场景，支持节假日跳过 / 顺延以及一次性例外。采用 RRULE（RFC 5545 子集）作为内部表示，UI 引导式表单生成；节假日处理与一次性例外通过物化层与实例级字段处理；实例保持 6 个状态。

## 表示形式

- **UI**：引导式表单（频率 / 星期 / 日期 / 时间 / 时区 / 终止条件 / 节假日行为）。科长不直接读写规则字符串。
- **存储**：结构化字段 + 派生 `rrule_text TEXT` 冗余列；解析优先信任结构化字段，文本列作 sanity check 与未来切库兼容。

### 规则字段

| 字段            | 类型                | 说明                                       |
| --------------- | ------------------- | ------------------------------------------ |
| `freq`          | ENUM                | `DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY`  |
| `byday_mask`    | INTEGER (bitmask)   | `MO=1<<0`, `TU=1<<1`, …, `SU=1<<6`         |
| `bymonthday`    | SMALLINT[]          | 1–31；`0` 表示"最后一天"                   |
| `bymonth`       | SMALLINT[]          | 1–12；用于 `YEARLY`                        |
| `byhour`        | SMALLINT            | 0–23                                       |
| `byminute`      | SMALLINT            | 0–59                                       |
| `iana_zone`     | TEXT                | IANA 时区名；默认科长 home zone            |
| `ends_on`       | DATE (nullable)     | 终止日期                                   |
| `ends_after_n`  | INTEGER (nullable)  | 出现次数                                   |
| `holiday_behavior` | ENUM            | `SKIP`（默认）/ `SHIFT`                    |
| `rrule_text`    | TEXT                | 由上述字段派生的 RRULE 字符串              |

`ends_on` 与 `ends_after_n` 二选一，模板创建时强制要求其一。

## 时区

- 规则存 `wall_clock + iana_zone`；实例物化为绝对 UTC 时间戳；视图按本机 zone 渲染。
- 科长出差场景：编辑规则 zone，或对单个实例覆盖 `scheduled_at`。

## 节假日

- 数据源：打包 `holidays/cn-<year>.json`（每年一份）。
- 应用内"切换某一天为节假日"操作优先级高于种子。
- `holiday_behavior = SKIP`：物化层不生成该实例。
- `holiday_behavior = SHIFT`：原实例 `Cancelled`（"已跳过"）+ 新实例 `rescheduled_from_id` 指向原实例；与手动改期走同一路径，由物化层触发。

## 例外（一次性改期）

- 原实例 `status = Cancelled`，UI 标签"已跳过"。
- 新实例创建，`rescheduled_from_id` 指向原实例（`rescheduled_to` 反向指针可选）。
- 模板规则不变。

## 状态

- 实例保持 6 个状态：`Open / In-progress / Blocked / Waiting-on / Done / Cancelled`。
- `Done` ← 用户动作 `done`。
- `Cancelled` ← 用户动作 `skipped`，或自动（节假日 `SKIP`）。
- `Shifted` 是动词，不是状态——它变更 `scheduled_at` 并记录 `rescheduled_to` / `rescheduled_from_id`。

## 物化策略

- **混合式**：应用启动 + 进入下一周时各执行一次，饥饿生成未来 12 周实例。
- `MaterializationWindow = 12 weeks` 常量。
- 超出窗口的查询不报错，不主动补齐；UI 给出提示。

## 备选方案

- **自定义 DSL**（如 `WEEKLY:MON,WED@08:00`）：被拒。UI 引导式下科长不读字符串，DSL 可读性优势不复存在；解析器得自己写。
- **标准 5 字段 cron**：被拒。不支持"每月最后一个周五""隔周"等用例；可读性差。

## 后果

- Rust 端用 `rrule` crate（或等价 RFC 5545 解析库）；实例生成与 RRULE 解析走同一代码路径。
- 节假日 JSON 格式与维护流程单独建 ticket。
- 物化层需要定时器（Tauri 2.x 的 scheduler plugin 或应用内 scheduler）；可与"周一 08:00 周报"通知规则共用 trigger。
- `byday_mask` bitmask 编码在 ORM 层可能需要手写映射（sqlx 直接支持 `INTEGER`，无障碍）。
