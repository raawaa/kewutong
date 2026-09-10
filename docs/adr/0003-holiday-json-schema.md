# 节假日 JSON Schema（holidays/cn-<year>.json）

**Status**: accepted

承接 [ADR 0002](./0002-recurring-time-rule.md)（RRULE 子集与物化）与 ticket [#12](https://github.com/raawaa/kewutong/issues/12) 的 grill 产出，定义打包节假日 JSON 的 schema、加载路径、数据源、维护节奏与解析层。替代 ADR 0002 § 节假日中"数据源：打包 `holidays/cn-<year>.json`"的一句话描述。

## 文件位置与打包

- 路径：`holidays/cn-<year>.json`，仓库根
- Tauri 配置：`src-tauri/tauri.conf.json` `bundle.resources: ["holidays/*"]`（glob 覆盖所有年份文件）
- 文件随 App 版本一起打包到二进制；JSON 改动随发版走
- `.gitignore` 不排除 `holidays/`——它们是 git-tracked 数据，每年一次 commit

## Schema

### 顶层

```json
{
  "holidays": [...],
  "workdays": [...]
}
```

| 字段        | 类型                  | 说明                                  |
|-------------|-----------------------|---------------------------------------|
| `holidays`  | `HolidayEntry[]`      | 法定节假日条目数组                    |
| `workdays`  | `HolidayEntry[]`      | 调休工作日条目数组                    |
| _（无 version）_ | —                 | schema 演进走 ADR 接力，不预留 version |

### 条目（HolidayEntry）

```json
{ "start": "2026-02-17", "end": "2026-02-23", "name": "春节" }
```

| 字段   | 类型      | 可空 | 说明                                       |
|--------|-----------|------|--------------------------------------------|
| `start`| TEXT      | NO   | `YYYY-MM-DD`，ISO 日期字符串              |
| `end`  | TEXT      | NO   | `YYYY-MM-DD`；单天时 `start == end`        |
| `name` | TEXT      | YES  | 中文节日名（"国庆节"/"春节"/"元旦"）      |

### Rust 数据结构

```rust
use chrono::NaiveDate;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HolidayEntry {
    #[serde(with = "naive_date_iso")]
    pub start: NaiveDate,
    #[serde(with = "naive_date_iso")]
    pub end: NaiveDate,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HolidayFile {
    pub holidays: Vec<HolidayEntry>,
    pub workdays: Vec<HolidayEntry>,
}
```

`naive_date_iso` 是 `serde` 自定义 visitor，把 `"YYYY-MM-DD"` 解析为 `chrono::NaiveDate`。

### 示例

```json
{
  "holidays": [
    { "start": "2026-01-01", "end": "2026-01-03", "name": "元旦" },
    { "start": "2026-02-15", "end": "2026-02-23", "name": "春节" },
    { "start": "2026-04-04", "end": "2026-04-06", "name": "清明节" },
    { "start": "2026-05-01", "end": "2026-05-05", "name": "劳动节" },
    { "start": "2026-06-19", "end": "2026-06-21", "name": "端午节" },
    { "start": "2026-09-25", "end": "2026-09-27", "name": "中秋节" },
    { "start": "2026-10-01", "end": "2026-10-07", "name": "国庆节" }
  ],
  "workdays": [
    { "start": "2026-01-04", "end": "2026-01-04", "name": "元旦" },
    { "start": "2026-02-14", "end": "2026-02-14", "name": "春节" },
    { "start": "2026-02-28", "end": "2026-02-28", "name": "春节" },
    { "start": "2026-05-09", "end": "2026-05-09", "name": "劳动节" },
    { "start": "2026-09-20", "end": "2026-09-20", "name": "中秋节" },
    { "start": "2026-10-10", "end": "2026-10-10", "name": "国庆节" }
  ]
}
```

> 上述日期为 2026 实际数据（来源 `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json` + 国务院办公厅 2026 放假通知）；`tools/fetch-holidays/` 脚本按 §响应映射 把 holiday-cn 的逐日 `name`（除夕/初一/...）合并到主名（春节）。

## 解析层

- 纯 `serde` derive；`#[serde(deny_unknown_fields)]` 拒绝未知字段
- 日期解析用 `chrono::NaiveDate` + 自定义 `serde` visitor
- 不引入 JSON Schema 校验、不写手写一致性检查（start <= end、无重叠）
- 文件读取失败 → 启动错误（具体策略由 App main 决定；建议 panic-on-init 或显式 Result）
- 解析层零容错，垃圾进 = 垃圾出：trust 抓取脚本 + 人工 git diff review

## 数据源

### 主：NateScarlet/holiday-cn

- 仓库：`https://github.com/NateScarlet/holiday-cn`
- 数据来源：每日 CI 抓取国务院办公厅公告；`papers[]` 字段直接链 `gov.cn/zhengce/...` URL（每条目可追溯到官方源）
- 拉取 URL（任选其一）：
  - `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{YYYY}.json`
  - `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{YYYY}.json`（jsDelivr CDN，国内友好）
- 响应字段：`{year, papers, days[]}`；`days` 每条 `{name, date, isOffDay}`；`isOffDay: true` = 休息日（法定节假日），`isOffDay: false` = 工作日（含调休，节日名 `name` 与调休一致）
- 覆盖：2020–2027+（2028 待国务院公告后由仓库自动填充；当前年份文件不存在 → 走 fallback）
- 优点：官方源；含多天区间 + 调休；中文节日名（除夕/初一/初二...分得清）；JSON Schema draft-07 校验；GitHub Releases 版本化快照；无鉴权、无费用
- 映射逻辑见 § 响应映射

### 备：date.nager.at

- 公共 API：`https://date.nager.at/api/v3/PublicHolidays/{year}/CN`
- **仅法定节假日首日**（每节日单日记录，无调休字段，无多天区间）
- 触发条件：主源 holiday-cn 当前年份文件不存在（404）或解析失败；当前是 2028+ 唯一可用兜底
- 缺失的调休：SKIP 路径仍准（基于法定假首日判定），SHIFT 路径可能漏跳过个别调休；维护者下个发版补回 holiday-cn 数据

### 响应映射

1. 主源按 `year` 拉取全年 JSON
2. 按 `days[].isOffDay` 分流：`true` → `holidays` 候选；`false` 且 `name` 是已知节日名 → `workdays` 候选（普通工作日不进 JSON）
3. **合并 holidays**：相邻日期（gap ≤ 1 天）+ 同 `isOffDay=true` → 一条 `{start, end, name}`；`name` 取**主名**（由脚本维护 `festival_name_aliases` 表把异名映射到主名，如 `除夕`/`初一`/`初二`/.../`初七` → `春节`；中秋节/国庆节等同理）；gap > 1 天视为不同节日
4. **合并 workdays**：每个 `isOffDay=false` 单独成条 `{start=end, name}`；相邻同主名可合并为 `{start, end, name}`（2026 数据无此情形，保险起见保留合并逻辑）
5. **跨年拆分**：holiday range 跨越 Dec 31 → Jan 1，按年份切分（同 `name` 出现在两个文件中）；即同一区间不跨年文件边界
6. 备源仅在主源当前年份文件缺失时介入；调休不进备源；接入备源时单日条目直接 `start == end`

## 跨年加载

- App 启动时枚举 `holidays/cn-*.json`，加载 **当前年 + 下一年**两份（Q11 决议）
- 缺失文件容错：仅有当前年或仅有下一年也可启动（年末过渡场景）
- 合并到内存索引；查询接口：`is_holiday(date)` / `is_makeup_workday(date)` / `get_holiday_name(date) -> Option<String>`
- 物化层（ADR 0002 § 物化策略）查这张内存表：
  - `holiday_behavior=SKIP`：`scheduled_at` ∈ `holidays` ∪ 周末 → 不生成实例
  - `holiday_behavior=SHIFT`：`scheduled_at` ∈ `holidays` → 顺延到下一个非 holiday 且非周末且非调休工作日的日期
  - `scheduled_at` ∈ `workdays` → 当作普通工作日（不跳过、不顺延）
- 物化窗口（12 周）跨越 Dec → Jan 时，两文件并查

## 维护节奏

- 频率：每年一次
- 时机：12 月初（State Council 公告通常 11 月底；+7 天缓冲）
- 执行者：手动跑 `cargo xtask fetch-holidays <year>`（xtask 二进制，路径 `tools/fetch-holidays/`）
- 流程：
  1. xtask 抓取 → 生成 `holidays/cn-<year>.json` 到 git working tree
  2. 维护者 `git diff` 人工 review
  3. commit 进 master；commit message 描述变更（如 `chore(holidays): 更新 2027 节假日`）
  4. App 下次发版 bundle 进二进制

### 漂移检测

- 脚本不生成 CHANGELOG；人工 `git diff` + PR review 即足够
- State Council 调休调整（罕见）：脚本重跑 → `git diff` 显式 → 维护者判断是否接受
- 切勿自动 commit；任何 JSON 变更必须人工 review 后再落地

### 跨年 fetcher 行为

- `cargo xtask fetch-holidays 2027` 仅拉取 2027 自然年的条目
- 若 2027 春节区间从 2026-12 起，区间起点（2026-12 部分）由 `fetch-holidays 2026` 负责
- 同一区间不跨年文件边界：跨年的"春节"区间在 `cn-2026.json` 与 `cn-2027.json` 中各自存在一条

## 备选方案（已 reject）

- **运行时拉取（每次启动拉远程 API）** — 已 reject by ADR 0002 § 时区节（本地优先硬约束）
- **手工维护 JSON** — 一年一次 + 抄写易错；脚本 + git diff + commit 流程下没必要
- **JSON Schema + `jsonschema` crate 运行时校验** — 文件小（~3KB/年）、来源可信（自家脚本 + git-tracked）；schema 校验收益为零
- **手写一致性校验（start <= end、无重叠）** — 同上；维护点 > 收益；脚本生成 + git diff 已是事实校验
- **顶层 `regions` 包装（多地区嵌套）** — 文件名（`cn`/`hk`/`tw`）已编码地区；schema 再嵌冗余
- **`schema_version` 字段** — schema 演进走 ADR 接力；JSON 不预留 version 位（Q18 决议）
- **单一 API + 失败时保留上一年 JSON** — fallback 路径要尽量给出当年真值；nager.at 至少能补法定假
- **jiejiariapi.com 作为主或备** — 仅覆盖 2007–2026；免费档 50 req/day 且禁止商用
- **timor.tech 作为主或备** — 作者官方文档明示字段不稳定（`None of the date, name, rest or wage fields are stable`）；当前网处于 DDoS 状态；2027 / 2028 返回空。完整调研见 [#12](https://github.com/raawaa/kewutong/issues/12) 研究评论

## 后果

### 代码层

- `tools/fetch-holidays/`：xtask 二进制，依赖 `ureq` + `serde_json` + `chrono`（无 async runtime；同步拉取 + JSON 解析）
- `holidays/cn-<year>.json`：git-tracked，每年 commit 一次
- App 启动加载：枚举 `holidays/cn-*.json`，挑出当前年 + 下一年，构造内存 `BTreeMap<NaiveDate, DayKind>` 或等价结构
- 物化层集成：ADR 0002 的 SKIP/SHIFT 行为查这张内存表
- 通知层集成：`notification_log.kind='weekly_digest'` 在周一 08:00 触发时，若当天是 holiday 则跳过（来源同内存表）

### Schema 演进路径

- 新字段需求：另起 ADR；不通过 `version` 字段
- 旧文件兼容性：tombstone 老文件路径（e.g., `holidays/cn-2026.json` → `holidays/archive/cn-2026.v1.json`）；Rust 端 load 逻辑按 glob 兼容新旧路径
- 多地区扩展：`holidays/cn-*.json` / `holidays/hk-*.json` / `holidays/tw-*.json` 独立文件；schema 不变；App 启动按用户配置加载对应地区

### 与上下游 ticket 的衔接

- 上游：[ADR 0002](./0002-recurring-time-rule.md) § 节假日（SKIP/SHIFT 语义）
- 上游：[ADR 0001](./0001-sqlite-schema.md) § 后果（#12 输入约束）
- 下游：实现阶段 `tools/fetch-holidays/`（xtask 二进制）
- 下游：实现阶段 App 启动加载逻辑 + 物化层查询接口

## ADR 衔接链

- 替代：ADR 0002 § 节假日中"数据源：打包 `holidays/cn-<year>.json`"的一行描述 → 本 ADR 详化
- 替代：ADR 0001 § 后果中提到的 [#12](https://github.com/raawaa/kewutong/issues/12) → 本 ADR 落地
- 上游：[ADR 0002](./0002-recurring-time-rule.md)
- 下游：实现阶段（xtask + App 启动加载 + 物化层查询）