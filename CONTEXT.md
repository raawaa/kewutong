# 科室任务管理

科室任务管理桌面 app 的领域词汇表。

## Language

**Template（模板）**:
周期性事务的可复用定义，包含频率、规则、时区、终止条件、节假日行为；不含具体发生日期。
_Avoid_: 重复规则、计划集、规则集

**Instance（实例）**:
由 Template 按规则物化出的具体一次工作项；与 Task 同构（同 6 状态、可关联 Project、可指派负责人），但归属 Template 而非 Project。
_Avoid_: 任务、Task、自动任务

**Materialization（物化）**:
将 Template 按规则展开为 Instance 的过程；应用启动 + 进入下一周时各执行一次，生成未来 12 周（`MaterializationWindow`）。
_Avoid_: 展开、生成

**RescheduledFrom（改期来源）**:
Instance 的可选外键，指向被改期（或顺延）的原实例；用于追溯"为什么本周一例会在周三"。
_Avoid_: 原任务、上一个实例

**Holiday（节假日）**:
由国务院公告定义的一段日期，期间不产生 Template 实例（若 `holiday_behavior=SKIP`）或顺延到下一个非节假日工作日（若 `SHIFT`）。以打包 JSON（`holidays/cn-<year>.json`）为权威；App 内"切换某一天为节假日"操作覆盖种子。
_Avoid_: 假期、假日

**Makeup Workday（调休工作日）**:
原本是周末但被国务院调休安排转为工作日的一天；与 Holiday 同表打包但语义相反。物化层中若 Template 实例的 `scheduled_at` 落在调休工作日上，按普通工作日处理（不跳过、不顺延）。
_Avoid_: 调班、补班

**Holiday Behavior（节假日行为）**:
Template 上的策略列，`SKIP`（默认；节假日不生成该实例）/ `SHIFT`（顺延到下一个非节假日工作日）。
_Avoid_: 节假日策略、跳过模式

**Shifted（改期）**:
对 Instance 的一次性改期动作，结果是原 Instance `Cancelled` + 新 Instance `rescheduled_from_id` 指向原 Instance。是动词，不是状态。
_Avoid_: 移动

**Instance Status（实例状态）**:
实例在工作流中所处的位置；固定 6 个取值之一：`Open / In-progress / Blocked / Waiting-on / Done / Cancelled`。`Skipped` / `Shifted` 是触发状态变更的动作，不是状态本身。
_Avoid_: 状态机

**人员详情 Tab**:
全局主导航 tab 之一，承载每位人员的子 tab 列表与（子 tab 全空时的）全员浏览网格。
_Avoid_: 人员档案 tab、人员子页

**人员子 Tab**:
「人员详情」tab 内的子级 tab 条目；每条对应一位已打开的人员档案。
_Avoid_: 详情 tab

**人员详情 DTO**:
`get_person_detail(id)` 命令返回的聚合 DTO，由主进程从现有查询组合而成（人员档案 + 6 段在飞任务 + 负责项目 + 等 TA 推动任务 + 所在子组周期模板）。
_Avoid_: 详情接口返回

**Longest-Stuck 排序**:
Blocked / Waiting-on 状态的展示顺序按 `blocked_at` 升序，卡得最久的排最前，体现 chief 的关注优先级。`NULL` 列排到末尾。
_Avoid_: 阻塞优先

**人员浏览网格**:
「人员详情」tab 内子 tab 全空时显示的全员卡片网格；每张卡片 = 姓名 + 子组名 + 在岗/离岗徽章 + 联系方式前 8 字，可按姓名/子组名子串即时过滤；**不**显示在飞任务数（与人员矩阵「任务负载」维度区分）。
_Avoid_: 全员视图
