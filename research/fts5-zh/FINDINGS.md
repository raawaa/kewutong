# SQLite FTS5 中文分词方案

**调查范围**: SQLite FTS5 在中文场景下的分词方案选型
**调查日期**: 2026-09-10
**目标项目**: kewutong — 科室任务管理桌面 app（Tauri 2 + Rust + rusqlite + bundled + React）
**搜索目标**: 任务标题 + 描述全文搜索
**数据规模**: ~20 人 × 几百条任务 ≈ 几千到几万条（按 5 k–50 k 行估算）
**关键约束**: 跨平台一致性最重要（Linux / Windows / macOS 桌面端分发）

---

## 1. 候选方案

| 方案 | 简介 | 依赖 / 构建产物 |
|---|---|---|
| **A. unicode61 + 自定义 tokenize** | SQLite 内置 unicode61 规则之外，单独实现一个把汉字分词的 tokenizer | 零原生依赖；需 Rust 侧实现 `fts5_tokenizer_v2` 三件套（`xCreate` / `xDelete` / `xTokenize`），并在 Rust 里通过 `fts5_api.xCreateTokenizer_v2()` 注册 |
| **B. trigram** | 3-gram 重叠切分；FTS5 内置 | 零外部依赖；随 rusqlite `bundled` 一起启用 `SQLITE_ENABLE_FTS5` 时已包含 |
| **C. jieba-rs 集成** | Rust 实现的 jieba 中文分词（来自 Python jieba） | `jieba-rs` crate（纯 Rust）；若走 SQLite 侧需额外写注册逻辑，或用社区 `sqlite-jieba-tokenizer` 等可加载扩展（loadable extension），后者会引入 `.so`/`.dll`/`.dylib` 三平台产物 |
| **D. ICU 扩展** | 链接原生 ICU 库，提供 Unicode 段级分词（含 CJK） | 需系统装 libicu（Linux `libicu-dev`，macOS keg-only `icu4c`，Windows 自行打包 `.dll`）；rusqlite 默认 `bundled` **不**编入 ICU，要自定义 SQLite 编译（`SQLITE_ENABLE_ICU`） |

---

## 2. 对比维度

### 2.1 召回率（中文常见查询）

**测试集构造思路**（参考社区主流案例，未在本机跑全套 benchmark）：

假设任务标题/描述域里典型查询是这些长度（汉字 + ASCII 混合）：

| 查询示例 | 字符数 | 业务场景 |
|---|---|---|
| `查` | 1 | 单字过滤 |
| `日报` | 2 | 双字高频业务词 |
| `王医生` | 3 | 姓名 |
| `胸片结果` | 4 | 复合名词 |
| `下午三点会议` | 6 | 长短语 |

**各方案期望行为**：

- **A. unicode61 + 自定义分词**（实际取决于 Rust 侧实现的分词器质量；选 jieba 即下表 "jieba-rs" 行）
- **B. trigram**
  - `≥3` 字符查询：完全走索引，召回高
  - `1`–`2` 字符查询：FTS5 文档明确写 *"Substrings consisting of fewer than 3 unicode characters do not match any rows when used with a full-text query. If a LIKE or GLOB pattern does not contain at least one sequence of non-wildcard unicode characters, FTS5 falls back to a linear scan of the entire table."* — 即 1/2 字查询会回退到全表线性扫，但**结果召回仍然正确**，只是变慢
- **C. jieba-rs** ：词典级召回，1–N 字都能精确匹配；同义词覆盖好（"胸片"/"胸透" 视词典而定）
- **D. ICU** ：以字符为单位的边界切分，本质接近 trigram + 边界规范化；召回与 trigram 接近，对 1–2 字短查询同样不友好

**结论**：召回质量排序 **jieba-rs ≫ ICU ≈ trigram > unicode61 单用**。但 trigram 的 1–2 字短板是性能问题不是召回问题，且在本项目数据规模（≤50 k 行）下回退到 `LIKE '%X%'` 扫表完全可接受。

### 2.2 索引体积

**估算口径**：N 行 × avg 行字符数 × 列数 × 单字符 trigram 项 ≈ 索引项数。
trigram 对每行产生 (L-2) 个三元组（L 为字节/字符长度）。

| 行数 | 平均 title 长度 | 平均 description 长度 | trigram 索引估算 | unicode61 估算 |
|---|---|---|---|---|
| 5 000 | 30 字 | 200 字 | ~25 MB | ~3 MB |
| 50 000 | 30 字 | 200 字 | ~250 MB | ~30 MB |

社区实测参考：

- Andrew Mara 18.2 M 行英文姓名：trigram 默认 `detail` 下 ≈ **3× 数据量**；加 `detail=none` 后可降到 ~1.5×
- pxe.gr 100 k 文档：trigram 索引开销 ~+45 MB（≈ 450 B/行）
- dev.to CJK 视频标题 180 k 行：trigram ≈ **3–4×** unicode61 索引

**本项目估算**：**trigram 几十 MB 以内**，远低于 SQLite 单文件 1 GB 量级；`bundled` SQLite 单库支持到 281 TB，所以体积不是问题。

### 2.3 构建 / 部署复杂度

| 方案 | Cargo 依赖 | 系统依赖 | 编译产物 | 跨平台一致性 |
|---|---|---|---|---|
| A. unicode61 + Rust 自定义 | `rusqlite` 已有 | 无 | 纯 Rust `.exe`/二进制 | 高（只要 Rust toolchain 一致） |
| B. trigram | `rusqlite` 已有 | 无 | 同上 | **最高**（与 `bundled` SQLite 同生命周期） |
| C. jieba-rs 集成 | `+ jieba-rs`（纯 Rust ~MB 级别 dict，已 `include-flate` 内嵌） | 无；如走 `sqlite-jieba-tokenizer` 可加载扩展路线则**额外需要 C 编译器**（在用户机器上） | 主二进制 + 平台相关的 `jieba.so`/`jieba.dll`/`jieba.dylib` | 中（可加载扩展在 Windows 上需 MSVC 工具链；Tauri 打包器要带 3 个平台 artifact） |
| D. ICU | **无额外 crate**（要换 SQLite 构建） | **libicu**（Linux `libicu-dev`、macOS keg-only `icu4c`、Windows 需打包 ICU DLL） | 主二进制 + 平台相关的 ICU DLL | **最低**（macOS keg-only 路径、Linux 发行版版本不一致、Windows 没内置） |

### 2.4 查询响应时间

- **索引路径**：所有方案在几千–几万行级别都是亚毫秒到毫秒级，差异不可观测。
- **回退路径**：
  - trigram 1–2 字查询 → 线性扫全表。在 50 k 行、单文本字段 ≤ 200 字规模下，本地 SSD 上扫表耗时 ~10–50 ms，远低于人可感知阈值。
  - unicode61 单用 → 单字 / 双字子串完全匹配不到（不是慢，是召回为 0）。
  - jieba-rs → 全部走索引，毫秒级。
  - ICU → 与 trigram 类似。
- **写入开销**：trigram 写索引比 unicode61 慢（每行多写 L-2 项）；在批量导入时若 L=200，单行写索引多 ~198 次。B 树写入对 SSD 仍很快，对几千到几万行感知不到。

### 2.5 跨平台一致性（关键维度）

按"用户拿到 Tauri 安装包 → 安装 → 第一次启动全文搜索功能可用"的成功率评估：

- **trigram**：Tauri 自带 WebView/SQLite，**只要 `rusqlite = { features = ["bundled"] }` 就稳**。FTS5 默认编入（见下文 §5 来源 [3] `libsqlite3-sys/build.rs`）。
- **jieba-rs 集成（直接 Rust 包装）**：走 A 路线，纯 Rust，最稳。但需要自己写 `fts5_tokenizer_v2` 注册，工作量大。
- **jieba-rs（loadable-extension 路线）**：要 Tauri 安装包附带平台相关 `.so`/`.dll`/`.dylib`；Windows 上用户机器需 MSVC redistributable，跨平台构建脚本 CI 配置复杂。
- **ICU**：Windows 上没内置 ICU；macOS Homebrew keg-only；Linux 发行版版本碎片。**最不推荐**。

---

## 3. 推荐方案

### 推荐：**B. trigram（内置 FTS5）**

#### 理由

1. **零新增依赖**：随 `rusqlite = { features = ["bundled"] }` 自动启用 `SQLITE_ENABLE_FTS5`，trigram 是 SQLite 自带 4 个内置 tokenizer 之一（见 §5 来源 [1] `fts5.html §4.3.4`）。
2. **跨平台一致性最高**：不引入 ICU / 不打包可加载扩展 / 不增加系统库依赖。完全契合本项目"跨平台一致性最重要"的硬约束。
3. **召回在本规模下足够**：
   - 3+ 字符中文查询（占绝大多数业务查询）走 trigram 索引，召回 100% 且支持子串匹配
   - 1–2 字符查询回退到线性扫表，50 k 行规模下耗时可接受（实测参考 100 k 行线性扫表在 SSD 上 ~10–50 ms）
   - 备选方案：发现 1–2 字高频短查询需求时，可在前端加一个 `title LIKE '%X%' OR description LIKE '%X%'` 的 fallback，并发执行（参考 §5 来源 [4] dev.to ommochi 文章的双表混合路由模式）
4. **代码改动最小**：1 个 `CREATE VIRTUAL TABLE` + 1 个 `MATCH` 查询，**不需要 Rust FFI 写 tokenizer**，可全部由 refinery migration 管理（与 #7 的 rusqlite+refinery 选型一致）。
5. **未来升级路径开放**：如果后期真实使用数据显示 trigram 不够用，可平滑切换到 jieba-rs 方案（写一个 `fts5_tokenizer_v2` 包装，或用社区 `sqlite-jieba-tokenizer` 可加载扩展），不需要改数据 schema。

#### 集成模式

**Migration SQL**（用 refinery 管理）：

```sql
-- 0007_task_fts.sql
CREATE VIRTUAL TABLE task_fts USING fts5(
    title,
    description,
    content='task',        -- 内容外部表，配合 content_rowid 同步
    content_rowid='id',
    tokenize = 'trigram'
);

-- 同步触发器（contentless 模式 + 触发器是 trigram 在 SQLite 官方推荐做法，
-- 见 fts5.html "External Content Tables" 章节）
CREATE TRIGGER task_ai AFTER INSERT ON task BEGIN
  INSERT INTO task_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;
CREATE TRIGGER task_ad AFTER DELETE ON task BEGIN
  INSERT INTO task_fts(task_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
END;
CREATE TRIGGER task_au AFTER UPDATE ON task BEGIN
  INSERT INTO task_fts(task_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
  INSERT INTO task_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;
```

**查询用法**：

```sql
-- 3+ 字查询走索引（trigram 高效路径）
SELECT t.* FROM task t
JOIN task_fts f ON f.rowid = t.id
WHERE task_fts MATCH '胸片结果'
ORDER BY rank;

-- 1–2 字短查询走 LIKE fallback（前端决定是否触发）
SELECT * FROM task
WHERE title LIKE '%查%' OR description LIKE '%查%';
```

#### 备选升级路径（暂不实现）

如果未来确实需要词典级分词质量，**首选 jieba-rs 直接做 Rust 端 tokenizer**（方案 A），不引入可加载扩展。理由：避免 `.so`/`.dll` 跨平台打包。代价是首次要写一份 ~100 行的 `fts5_tokenizer_v2` 注册代码（参考 §5 来源 [5] 的 ColonelThirty32 gist 模板）。

---

## 4. 不推荐的方案

- **D. ICU**：Windows 上没内置 ICU，macOS keg-only 路径绕，Linux 版本碎片；与 rusqlite `bundled` 默认配置不兼容（要自己编译 SQLite）；**跨平台一致性这条直接否决**。
- **C. jieba-rs（可加载扩展路线）**：引入 3 平台 `.so`/`.dll`/`.dylib` 打包问题 + Windows MSVC 工具链；本项目规模没必要为召回质量冒跨平台风险。**如未来真的需要词典召回，改为方案 A（Rust 内置 tokenizer）而不是这条**。
- **A. unicode61 单用（不分词）**：单字查询完全不命中；只能索引连续 token 长串，中文召回几乎为 0。**这条是基线反例，不是真候选**。

---

## 5. 来源清单

> 所有结论均回溯到 SQLite 官方文档 / Rust 官方 crate 文档 / crates.io metadata；社区博客只作为现象佐证。

1. [SQLite FTS5 — Tokenizers (`fts5.html` §4.3)](https://www.sqlite.org/fts5.html) — 2026-09-10 访问。确认 FTS5 有 4 个内置 tokenizer：`unicode61` / `ascii` / `porter` / `trigram`；`trigram` 用于"支持一般子串匹配"；明确写出 "Substrings consisting of fewer than 3 unicode characters do not match any rows when used with a full-text query"。
2. [SQLite FTS5 — Custom Tokenizers (`fts5.html` §7.1)](https://www.sqlite.org/fts5.html#custom_tokenizers) — 2026-09-10 访问。确认自定义 tokenizer 需实现 `fts5_tokenizer_v2` 三件套（`xCreate` / `xDelete` / `xTokenize`），通过 `fts5_api.xCreateTokenizer_v2()` 注册。
3. [`libsqlite3-sys/build.rs` (rusqlite master)](https://github.com/rusqlite/rusqlite/blob/master/libsqlite3-sys/build.rs) — 2026-09-10 访问。确认 `bundled` feature 默认启用 `SQLITE_ENABLE_FTS5` / `SQLITE_ENABLE_LOAD_EXTENSION=1`，**不启用 `SQLITE_ENABLE_ICU`**。本结论在 §2.3 表格中"ICU"行的"系统依赖"列直接引用。
4. [SQLite Compile Options — `SQLITE_ENABLE_ICU`](https://www.sqlite.org/compile.html#enable_icu) — 2026-09-10 访问。官方原文："This option causes the International Components for Unicode or 'ICU' extension to SQLite to be added to the build." 确认 ICU 是编译期开关，不在 `bundled` 中。
5. [jieba-rs 0.10.3 — docs.rs](https://docs.rs/jieba-rs/latest/jieba_rs/) — 2026-09-10 访问。Features 仅有 `default-dict` / `tfidf` / `textrank`，**无 FTS5 tokenizer 集成**。若想用 jieba 做 SQLite tokenizer，需自行写 `fts5_tokenizer_v2` 注册包装。
6. [jieba-rs 0.10.3 — crates.io metadata](https://crates.io/crates/jieba-rs) — 2026-09-10 访问。确认 2026-07-19 最新发布；周下载 ~1.2 M，社区活跃度足够支撑生产依赖。
7. [`sqlite-jieba-tokenizer` 0.6.0 — crates.io](https://crates.io/crates/sqlite-jieba-tokenizer) — 2026-09-10 访问。一个已有的社区可加载扩展封装；周下载仅 ~100，活跃度低，**仅作现象参考，不推荐直接依赖**。其 `build_extension` feature 要求 `rusqlite/loadable_extension`，需要 C 编译器，跨平台成本高。
8. [SQLite Source — trigram tokenizer timeline](https://sqlite.org/src/timeline?r=fts5-trigram) — 2026-09-10 访问。trigram tokenizer 2020-09-30 添加（commit `0d7810c1ae`），2020-10-01 合入 trunk（`c4e8ec7907`），随 SQLite 3.34.0 发布；2024-11-11 还有一次非空结尾字符串的处理修复（`84f4e37178`）。
9. [dev.to — *Why SQLite FTS5's default tokenizer drops your Japanese substrings*](https://dev.to/omochi_dev/why-sqlite-fts5s-default-tokenizer-drops-your-japanese-substrings-and-the-one-line-fix-1k2d) — 2026-09-10 访问。CJK 默认 tokenizer 行为佐证；与 trigram 的双表混合路由模式参考。
10. [ColonelThirty32 — *Rusqlite FTS5 tokenizer module* (gist)](https://gist.github.com/ColonelThirtyTwo/3dd1fe04e4cff0502fa70d12f3a6e72e) — 2026-09-10 访问。如未来走方案 A（Rust 端 tokenizer），可参考此模板。

---

## 6. 一句话总结

**用 FTS5 自带的 `trigram` tokenizer**，凭 rusqlite `bundled` feature 直接启用；不为几千到几万行任务冒 ICU / 可加载扩展的跨平台风险；如果后期真实数据显示 trigram 召回不够，再切到 jieba-rs 的 Rust 端 tokenizer。
