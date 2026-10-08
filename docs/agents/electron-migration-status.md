# Electron 迁移实施进度（#37）

承接 spec #37（Tauri → Electron 迁移）。本文档是本仓库实际落地进度，
对应 GitHub 工单 #38–#59。

## 已完成

### M1：Shell + IPC scaffold（✅ 落地）

| 工单 | 标题                                       | 落地                                                                                                |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| #38 | Electron shell 起骨架                       | `src/main/index.ts` + `electron.vite.config.ts` + `electron-builder.yml` + `index.html` CSP          |
| #39 | DB + migrations runner + Tauri→Electron 胶水 | `src/main/db.ts` + `src/main/migrations/runner.ts` + `src/main/migrations/V001–V008.sql` 复制       |
| #40 | preload + IPC seam + ping + dataFileLocation | `src/preload/index.ts` + `src/main/ipc/register.ts` + `src/lib/api-types.ts` + `ping` / `dataFileLocation` / `trayStatus` |

**共享基础设施（自建）：**

- `src/main/clock.ts` — Clock 接口 + SystemClock + FixedClock（UTC ↔ 本地日历日双向）
- `src/main/error.ts` — AppError 类（code / message / detail）
- `src/main/state.ts` — AppState 单例（db + clock + calendar + trayStatus + dbPath）
- `src/main/types.ts` — DTO 类型契约（与前端 `src/lib/ipc.ts` 同形）
- `src/main/test/commands/fresh_db.ts` — `freshDb()` fixture（内存库 + FixedClock）
- `vitest.config.ts` — vitest 三套 include：renderer (.test.tsx) + 主进程 (.test.ts)

### M2 #41：Personnel 平迁（✅ 完整 example）

完整的 domain 平迁示例——`src-tauri/src/commands/personnel.rs`（798 行）
→ `src/main/personnel/index.ts`（~430 行）+ `personnel.test.ts`（10 个 case）。

- 子组 CRUD + 重排 + 删除空检查
- 人员 CRUD + 调岗 + 离岗 / 复岗（用 `state.clock.nowSql()`，可注入）
- `listAssigneeCandidates`（query 子串匹配 + LIKE 元字符转义 + 6 条封顶）
- `personnelMatrix`（段头 + 段内人员 + 每人 inFlightCount / blockedCount）
- IPC 注册（`personnel.list_sub_teams` 等 13 个 channel）
- preload typed wrapper + `src/lib/api-types.ts` 暴露同形 API

`src/main/task/index.ts` 提供 `fetchInFlightTasksForPerson` 给 personnel 矩阵
调用；任务 CRUD / today_week / search 等在 M2 #43 / #44 / #45 ticket 内补齐。

## 进行中 / 待办

### M2（13 个 domain 平迁）

| 工单 | 标题                                | 剩余工作量估算 |
| --- | ----------------------------------- | -------------- |
| #41 | Personnel                            | ✅ 已完成       |
| #42 | Project CRUD                         | ~510 行 Rust → TS |
| #43 | Task CRUD + view queries (today_week) | ~1408 行（最大模块） |
| #44 | Task status                          | 已合并到 #43 的 `setTaskStatus` |
| #45 | Task FTS5 search                     | 搜索代码 + 测试 |
| #46 | Recurring template                   | ~461 行 |
| #47 | Holiday                              | ~180 行 + calendar 实现 |
| #48 | Materialization                      | ~1409 行 + 测试 |
| #49 | Instance actions                     | ~443 行 |
| #50 | Wayfinder                            | ~441 行 |
| #51 | Notification commands (CRUD)         | ~76 行（短） |
| #52 | Sample data                          | ~234 行 |
| #53 | Export                               | ~605 行 |

**剩余 M2 工作量 ~5500 行 Rust → TS + 等量测试。**

### M3：行为对齐 + 验证（4 个 ticket）

| 工单 | 标题                                            |
| --- | ----------------------------------------------- |
| #54 | Tray + window lifecycle + 单实例锁              |
| #55 | Global shortcut ⌘K + IPC 事件总线               |
| #56 | Notification scheduler（3 规则扫描）            |
| #57 | 行为对齐 smoke（5 核心场景 Electron vs Tauri）  |

### M4：切发布 + 撤 Tauri（2 个 ticket）

| 工单 | 标题                                                              |
| --- | ----------------------------------------------------------------- |
| #58 | electron-builder 4-runner 矩阵                                    |
| #59 | Cutover PR：删 src-tauri/ + Cargo.toml + @tauri-apps/*             |

注：#58 的 `electron-builder.yml` 已经在 M1 阶段落地；只是 CI workflow 与
draft release 流程还要写。

## 本地构建 / 测试

### 已知阻塞：better-sqlite3 native build 失败

环境里 Python 3.14 已删除 `distutils`，node-gyp 编译 better-sqlite3 时报
`ModuleNotFoundError: No module named 'distutils'`。

**复现步骤（用户环境跑）：**

```bash
python3 -m pip install --user --break-system-packages setuptools
```

装上 setuptools 后再 `npm install --legacy-peer-deps` 即可拿到 prebuilt
binary（注：electron-vite 2.x 与 vite 8.x 的 peer 冲突需要 `--legacy-peer-deps`）。

### 跑测

```bash
npm test                                  # 全部 vitest
npm test -- src/main/personnel             # Personnel 单测
npm run typecheck                         # 三段 tsc --noEmit
```

## 模式说明（后续 ticket 套用）

每个 domain 平迁 ticket 都遵循同一形状：

1. **`src/main/<domain>/index.ts`** — 命令函数 `command(state, args)`，无 IPC 边界感。
2. **`src/main/<domain>/<domain>.test.ts`** — vitest case 套原 Rust 集成测试。
3. **`src/main/ipc/register.ts`** 增一段 `registerXxx(state)`，channel 名用 `domain.command_name`。
4. **`src/preload/index.ts`** 增一段 `domain: { … }`。
5. **`src/lib/api-types.ts`** 增一段对应 typed wrapper。
6. **commit message**：`<type>(electron,#<N>): <领域> 平迁（M2 #<N>）`。

## ADR 衔接

- 上游：[ADR 0001–0004](https://github.com/raawaa/kewutong/tree/master/docs/adr) Tauri 端
- 本仓库：[ADR 0005–0009](https://github.com/raawaa/kewutong/tree/master/docs/adr) Electron 端（已 commit `fd6158f`）

所有 ADR 状态 = `accepted`，与 ADR 0001–0004 同。