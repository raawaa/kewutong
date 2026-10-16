/**
 * Navigation reducer — 表驱动 + scenario 双覆盖（issue #97）。
 *
 * 单一 seam：`navigationReducer(state, event) → newState`。无 DOM / React /
 * IPC 依赖。父 spec 见 #96 §Testing Decisions 引用 ADR 0011 §6(table-driven
 * by `src/lib/taskStatus.test.ts`) 同型范式。
 *
 * 表驱动覆盖每条 (state, event) → nextState 一行；scenario 锁定 3 条 UX
 * 契约:duplicate `OpenPerson` add-or-focus、`CloseActiveSubTab` 左-右 fallback、
 * activeId invariant post-step。
 *
 * 本期 (#97) 仅覆盖 sub-tab + 主 tab 路径;dialog/palette/PalettePick/
 * pendingIntent 等 case 在 #98-#101 接入,本测试文件**不**为它们加断言,
 * 但 reducer 已就位以保持 union 编译期阻挡。
 */

import { describe, expect, it } from "vitest";

import {
  initialState,
  navigationReducer,
  type MainTabId,
  type NavigationEvent,
  type NavigationState,
  type OpenPersonTab,
} from "./state";

// ---------------------------------------------------------------------------
// 工厂 / 辅助
// ---------------------------------------------------------------------------

/**
 * 构造一条 `OpenPersonTab`,唯一字段 `personId`。
 */
function tab(personId: number): OpenPersonTab {
  return { personId };
}

/**
 * 构造一份带指定 sub-tab 列表 + active 的状态——只填本测试关心的字段,
 * 其余(主 tab / dialog / palette / pendingIntent)继承 initialState 默认。
 *
 * 测试不关心这些其他字段时让 `mainTabId`/`dialog`/`palette`/`pendingIntent`
 * 走 default,断言里也只 spot-check sub-tab 相关坐标,不重复 expect
 * 各 default 字段(那是初始化的契约,不是 reducer 的契约)。
 */
function withTabs(
  subTabs: OpenPersonTab[],
  activeSubTabId: number | null = null,
  mainTabId: MainTabId = initialState.tab,
): NavigationState {
  return {
    ...initialState,
    tab: mainTabId,
    subTabs,
    activeSubTabId,
  };
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

describe("navigationReducer · 初始状态", () => {
  it("默认 tab = today, 无子 tab, 无激活, 无 dialog / palette / pendingIntent", () => {
    expect(initialState.tab).toBe("today");
    expect(initialState.subTabs).toEqual([]);
    expect(initialState.activeSubTabId).toBeNull();
    expect(initialState.dialog).toBeNull();
    expect(initialState.palette).toBeNull();
    expect(initialState.pendingIntent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 主 tab
// ---------------------------------------------------------------------------

describe("navigationReducer · SetTab", () => {
  it("SetTab(matrix) 切到矩阵主 tab,不动 sub tab 状态", () => {
    const state = withTabs([tab(1), tab(2)], 1);
    const next = navigationReducer(state, { kind: "SetTab", tab: "matrix" });
    expect(next.tab).toBe("matrix");
    expect(next.subTabs).toEqual([tab(1), tab(2)]);
    expect(next.activeSubTabId).toBe(1);
  });

  it("SetTab 切到 personDetail 但无 sub tab 时仍允许(后续 OpenPerson 会 add)", () => {
    const next = navigationReducer(initialState, {
      kind: "SetTab",
      tab: "personDetail",
    });
    expect(next.tab).toBe("personDetail");
    expect(next.subTabs).toEqual([]);
    expect(next.activeSubTabId).toBeNull();
  });

  it("SetTab 同一主 tab 是幂等(null 写入 profile-safe)", () => {
    const state = withTabs([tab(1), tab(2)], 1);
    const next = navigationReducer(state, { kind: "SetTab", tab: "today" });
    expect(next.tab).toBe("today");
    expect(next.subTabs).toEqual(state.subTabs);
    expect(next.activeSubTabId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sub-tab —— OpenPerson (Q10: add-or-focus + 切到 personDetail 主 tab)
// ---------------------------------------------------------------------------

describe("navigationReducer · OpenPerson", () => {
  it("空表 OpenPerson(3) → 末尾追加 + 激活 + 切到 personDetail", () => {
    const next = navigationReducer(initialState, {
      kind: "OpenPerson",
      personId: 3,
    });
    expect(next.tab).toBe("personDetail");
    expect(next.subTabs).toEqual([tab(3)]);
    expect(next.activeSubTabId).toBe(3);
  });

  it("已有 [1,2] 时 OpenPerson(3) → 末尾追加 + 激活", () => {
    const state = withTabs([tab(1), tab(2)], 1, "today");
    const next = navigationReducer(state, { kind: "OpenPerson", personId: 3 });
    expect(next.tab).toBe("personDetail");
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(3);
  });

  it("已有 [1,2] 时 OpenPerson(1) (Q10 add-or-focus) → 不新增,只激活 1", () => {
    const state = withTabs([tab(1), tab(2)], 2, "today");
    const next = navigationReducer(state, { kind: "OpenPerson", personId: 1 });
    expect(next.tab).toBe("personDetail");
    expect(next.subTabs).toEqual([tab(1), tab(2)]); // 长度仍 = 2
    expect(next.activeSubTabId).toBe(1); // 激活切到 1
  });

  it("OpenPerson 在 personDetail 主 tab 上仍是 add-or-focus", () => {
    const state = withTabs([tab(1)], 1, "personDetail");
    const next = navigationReducer(state, { kind: "OpenPerson", personId: 1 });
    expect(next.tab).toBe("personDetail");
    expect(next.subTabs).toEqual([tab(1)]);
    expect(next.activeSubTabId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sub-tab —— ActivatePersonTab
// ---------------------------------------------------------------------------

describe("navigationReducer · ActivatePersonTab", () => {
  it("ActivatePersonTab(2) 在 [1,2,3] 上 → 激活 2,不动 subTabs", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "ActivatePersonTab",
      personId: 2,
    });
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(2);
  });

  it("ActivatePersonTab(不存在的 id) → 静默 no-op,不引发 active 收敛", () => {
    const state = withTabs([tab(1), tab(2)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "ActivatePersonTab",
      personId: 99,
    });
    expect(next.activeSubTabId).toBe(1); // 维持原 active
    expect(next.subTabs).toEqual([tab(1), tab(2)]);
  });

  it("空表 ActivatePersonTab(5) → 静默 no-op(active 不变)", () => {
    const next = navigationReducer(initialState, {
      kind: "ActivatePersonTab",
      personId: 5,
    });
    expect(next.subTabs).toEqual([]);
    expect(next.activeSubTabId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sub-tab —— CloseActiveSubTab(父 spec §useReducer 注 4:左-右-null 精细兜底)
//
// 关激活态 → 左邻居 / 右邻居 / null(全空)。非激活态下收到 case 视为
// no-op(App.tsx ⌘W 实现: `if (activePersonId != null) closePersonTab(activePersonId)`)。
// ---------------------------------------------------------------------------

describe("navigationReducer · CloseActiveSubTab", () => {
  it("[1,2,3] active=2 → 关 2,激活收敛到左邻居 1", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 2, "personDetail");
    const next = navigationReducer(state, { kind: "CloseActiveSubTab" });
    expect(next.subTabs).toEqual([tab(1), tab(3)]);
    expect(next.activeSubTabId).toBe(1);
  });

  it("[1,2,3] active=3 → 关 3,激活收敛到右邻居(无右)→ 左邻居 2", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 3, "personDetail");
    const next = navigationReducer(state, { kind: "CloseActiveSubTab" });
    expect(next.subTabs).toEqual([tab(1), tab(2)]);
    expect(next.activeSubTabId).toBe(2);
  });

  it("[1,2,3] active=1 → 关 1,激活收敛到右邻居 2", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, { kind: "CloseActiveSubTab" });
    expect(next.subTabs).toEqual([tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(2);
  });

  it("[1] active=1 → 关后表空,active=null", () => {
    const state = withTabs([tab(1)], 1, "personDetail");
    const next = navigationReducer(state, { kind: "CloseActiveSubTab" });
    expect(next.subTabs).toEqual([]);
    expect(next.activeSubTabId).toBeNull();
  });

  it("空表 CloseActiveSubTab → no-op(state 不变)", () => {
    const next = navigationReducer(initialState, { kind: "CloseActiveSubTab" });
    expect(next.subTabs).toEqual([]);
    expect(next.activeSubTabId).toBeNull();
  });

  it("active 不在 subTabs(破损态)— CloseActiveSubTab 不关任何一条,但 post-step 把 active 兜回 [0]", () => {
    // 强制构建一处 invariant 破损 —— 用于验证 reducer 在「外部强制改
    // state」的异常路径下的不变量维护。spec #97 §不变量 要求 post-step
    // 兜底,本 case 正是锁这条:主路径本身不动 subTabs,但末尾 reconcile
    // 强制 active 进入 subTabs —— 跌到 subTabs[0] = 1。
    const broken: NavigationState = {
      ...initialState,
      tab: "personDetail",
      subTabs: [tab(1), tab(2)],
      activeSubTabId: 99, // 不存在的 id —— 破损态。
    };
    const next = navigationReducer(broken, { kind: "CloseActiveSubTab" });
    expect(next.subTabs).toEqual([tab(1), tab(2)]); // 主路径未动
    expect(next.activeSubTabId).toBe(1); // post-step 兜底到 [0]
  });
});

// ---------------------------------------------------------------------------
// sub-tab —— ClosePersonTab(x)
//
// 关指定 personId —— active / 非 active / 不存在,分支与 CloseActiveSubTab 同
// 形,但传入的不是 active 而是显式 id。
// ---------------------------------------------------------------------------

describe("navigationReducer · ClosePersonTab", () => {
  it("[1,2,3] active=2 关 2 → 关后 [1,3],active 收左邻居 1", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 2, "personDetail");
    const next = navigationReducer(state, {
      kind: "ClosePersonTab",
      personId: 2,
    });
    expect(next.subTabs).toEqual([tab(1), tab(3)]);
    expect(next.activeSubTabId).toBe(1);
  });

  it("[1,2,3] active=1 关 2 (非激活) → 关后 [1,3],active 不变", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "ClosePersonTab",
      personId: 2,
    });
    expect(next.subTabs).toEqual([tab(1), tab(3)]);
    expect(next.activeSubTabId).toBe(1);
  });

  it("[1,2,3] active=3 关 1 → 关后 [2,3],active 不变(关非激活态)", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 3, "personDetail");
    const next = navigationReducer(state, {
      kind: "ClosePersonTab",
      personId: 1,
    });
    expect(next.subTabs).toEqual([tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(3);
  });

  it("[1,2,3] 关 99 (不存在) → no-op", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 2, "personDetail");
    const next = navigationReducer(state, {
      kind: "ClosePersonTab",
      personId: 99,
    });
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(2);
  });

  it("[1] active=1 关 1 → 表空,active=null(左-右-null 全 null 走全空分支)", () => {
    const state = withTabs([tab(1)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "ClosePersonTab",
      personId: 1,
    });
    expect(next.subTabs).toEqual([]);
    expect(next.activeSubTabId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sub-tab —— CloseOtherPersonTabs(personId) / CloseAllPersonTabs()
// / CloseLeftPersonTabs(personId) / CloseRightPersonTabs(personId)
//
// 四种右键菜单动作 ——「关闭其他 / 全部 / 左侧 / 右侧」。父 spec §右
// 键菜单 决策(App.tsx `:415-444`)。
// ---------------------------------------------------------------------------

describe("navigationReducer · CloseOtherPersonTabs", () => {
  it("[1,2,3] 关其他(2) → 只剩 [2],active=2", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseOtherPersonTabs",
      personId: 2,
    });
    expect(next.subTabs).toEqual([tab(2)]);
    expect(next.activeSubTabId).toBe(2);
  });

  it("[1,2] 关其他(1) → 只剩 [1],active=1", () => {
    const state = withTabs([tab(1), tab(2)], 2, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseOtherPersonTabs",
      personId: 1,
    });
    expect(next.subTabs).toEqual([tab(1)]);
    expect(next.activeSubTabId).toBe(1);
  });

  it("[1,2] 关其他(99 不存在) → 表空 [].active=null(post-step 收敛)", () => {
    const state = withTabs([tab(1), tab(2)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseOtherPersonTabs",
      personId: 99,
    });
    expect(next.subTabs).toEqual([]);
    expect(next.activeSubTabId).toBeNull();
  });

  it("[1] 关其他(1) → 表空 [].active=null", () => {
    const state = withTabs([tab(1)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseOtherPersonTabs",
      personId: 1,
    });
    expect(next.subTabs).toEqual([tab(1)]); // 自己保留
    expect(next.activeSubTabId).toBe(1);
  });
});

describe("navigationReducer · CloseAllPersonTabs", () => {
  it("[1,2,3] 关全部 → 表空,active=null", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 2, "personDetail");
    const next = navigationReducer(state, { kind: "CloseAllPersonTabs" });
    expect(next.subTabs).toEqual([]);
    expect(next.activeSubTabId).toBeNull();
  });

  it("空表关全部 → no-op(state 不变)", () => {
    const next = navigationReducer(initialState, { kind: "CloseAllPersonTabs" });
    expect(next.subTabs).toEqual([]);
    expect(next.activeSubTabId).toBeNull();
  });
});

describe("navigationReducer · CloseLeftPersonTabs", () => {
  it("[1,2,3] 关左侧(2) → 剩 [2,3].active 不变(若 active 不在 2,3 则兜底到 [0])", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseLeftPersonTabs",
      personId: 2,
    });
    expect(next.subTabs).toEqual([tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(2); // post-step 兜底到 [0] = 2
  });

  it("[1,2,3] 关左侧(1) → 已在最左.no-op", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 2, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseLeftPersonTabs",
      personId: 1,
    });
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(2); // 不变
  });

  it("[1,2,3] active=1 关左侧(3) → subTabs 全砍(active 1 不在剩表 → post-step 兜底到 [0] = 1)", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseLeftPersonTabs",
      personId: 3,
    });
    expect(next.subTabs).toEqual([tab(3)]);
    expect(next.activeSubTabId).toBe(3); // post-step 兜底到 [0] = 3
  });

  it("[1,2,3] 关左侧(99 不存在) → no-op(state 不变)", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 2, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseLeftPersonTabs",
      personId: 99,
    });
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(2);
  });
});

describe("navigationReducer · CloseRightPersonTabs", () => {
  it("[1,2,3] 关右侧(2) → 剩 [1,2]", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseRightPersonTabs",
      personId: 2,
    });
    expect(next.subTabs).toEqual([tab(1), tab(2)]);
    expect(next.activeSubTabId).toBe(1); // 不变(在 [1,2] 内)
  });

  it("[1,2,3] 关右侧(3) → 已在最右.no-op", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseRightPersonTabs",
      personId: 3,
    });
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(1);
  });

  it("[1,2,3] 关右侧(1) → 剩 [1]", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 3, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseRightPersonTabs",
      personId: 1,
    });
    expect(next.subTabs).toEqual([tab(1)]);
    expect(next.activeSubTabId).toBe(1); // post-step 兜底 [0]
  });

  it("[1,2,3] 关右侧(99 不存在) → no-op", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "CloseRightPersonTabs",
      personId: 99,
    });
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sub-tab —— ReorderPersonTabs(from, to)
//
// 拖拽重排 —— App.tsx `:447-458` 主路径。越界 / 同位置 → no-op。
// ---------------------------------------------------------------------------

describe("navigationReducer · ReorderPersonTabs", () => {
  it("[1,2,3] reorder(0→2) → [2,3,1]", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "ReorderPersonTabs",
      from: 0,
      to: 2,
    });
    expect(next.subTabs).toEqual([tab(2), tab(3), tab(1)]);
    expect(next.activeSubTabId).toBe(1); // active 不变(同人)
  });

  it("[1,2,3] reorder(2→0) → [3,1,2]", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 3, "personDetail");
    const next = navigationReducer(state, {
      kind: "ReorderPersonTabs",
      from: 2,
      to: 0,
    });
    expect(next.subTabs).toEqual([tab(3), tab(1), tab(2)]);
    expect(next.activeSubTabId).toBe(3);
  });

  it("[1,2,3] reorder(0→0) 同位置 → no-op", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "ReorderPersonTabs",
      from: 0,
      to: 0,
    });
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(1);
  });

  it("[1,2,3] reorder(from 越界 -1) → no-op", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "ReorderPersonTabs",
      from: -1,
      to: 1,
    });
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(1);
  });

  it("[1,2,3] reorder(to 越界 5) → no-op", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "ReorderPersonTabs",
      from: 0,
      to: 5,
    });
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(1);
  });

  it("空表 ReorderPersonTabs(0→0) → no-op", () => {
    const next = navigationReducer(initialState, {
      kind: "ReorderPersonTabs",
      from: 0,
      to: 0,
    });
    expect(next.subTabs).toEqual([]);
    expect(next.activeSubTabId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// post-step 不变量收敛 ——
//
// `activeSubTabId ∉ subTabs` 在 reducer 末尾收敛:
//   - subTabs 空 → active = null;
//   - subTabs 非空但 active 不在表中 → active = subTabs[0].personId。
//
// 取代 App.tsx `:399-413` 兜底 useEffect + `openPersonTabsRef` 反模式。
// ---------------------------------------------------------------------------

describe("navigationReducer · post-step 不变量收敛", () => {
  it("正常路径(active 在表中)→ 状态维持", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 2, "personDetail");
    // 任何不改 active 的事件后应维持。
    const next = navigationReducer(state, { kind: "SetTab", tab: "today" });
    expect(next.activeSubTabId).toBe(2);
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
  });

  it("OpenPerson 追加新子 tab 后 active 在表中 → 不动 active", () => {
    const state = withTabs([tab(1), tab(2)], 1, "personDetail");
    const next = navigationReducer(state, { kind: "OpenPerson", personId: 7 });
    expect(next.activeSubTabId).toBe(7);
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(7)]);
  });

  it("active 异常(不在表中)— —> SetTab 是 no-op,但 path 上的事件会被 reconcile 修",
    // 异常: active=99 不在 [1,2,3] 内 —— CloseOtherPersonTabs 关闭
    // 「非自身」全关 → 表空 → active = null(spec §post-step 收敛)。
    () => {
      const broken: NavigationState = {
        ...initialState,
        tab: "personDetail",
        subTabs: [tab(1), tab(2), tab(3)],
        activeSubTabId: 99,
      };
      const next = navigationReducer(broken, {
        kind: "CloseOtherPersonTabs",
        personId: 5, // 也不存在
      });
      expect(next.subTabs).toEqual([]);
      expect(next.activeSubTabId).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario —— 3 条 UX 契约锁定(issue #97 验收点)
//
// 独立 describe 命名 + 名描述:测试名形如"Scenario: ..."。
// 这三条合约是与 reducer 行为相邻的不变量 —— 实施中若改动 reducer,
// 这些合约将先暴露被破坏。
// ---------------------------------------------------------------------------

describe("Scenario: duplicate OpenPerson add-or-focus (Q10)", () => {
  it("连续 OpenPerson 同一 id 不会重复增 —— Q10 决议契约", () => {
    // 三次 OpenPerson(1) → 只开一次 + 始终激活 1。
    const s0 = withTabs([tab(2)], 2, "today");
    const s1 = navigationReducer(s0, { kind: "OpenPerson", personId: 1 });
    const s2 = navigationReducer(s1, { kind: "OpenPerson", personId: 1 });
    const s3 = navigationReducer(s2, { kind: "OpenPerson", personId: 1 });
    expect(s3.subTabs).toEqual([tab(2), tab(1)]);
    expect(s3.activeSubTabId).toBe(1);
    // 长度仅增一次
    expect(s3.subTabs.length).toBe(2);
  });

  it("duplicate OpenPerson 后插入另一人 → 顺序保持先开的在前", () => {
    const s0 = withTabs([], null, "today");
    const s1 = navigationReducer(s0, { kind: "OpenPerson", personId: 1 });
    const s2 = navigationReducer(s1, { kind: "OpenPerson", personId: 2 });
    // 重打开 1 → 应聚焦 1,不新增,顺序仍 [1,2]
    const s3 = navigationReducer(s2, { kind: "OpenPerson", personId: 1 });
    expect(s3.subTabs).toEqual([tab(1), tab(2)]);
    expect(s3.activeSubTabId).toBe(1);
  });
});

describe("Scenario: CloseActiveSubTab 左-右-null fallback", () => {
  it("[1,2,3] 关 active 中间 → 收敛到左邻居", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 2, "personDetail");
    const next = navigationReducer(state, { kind: "CloseActiveSubTab" });
    expect(next.subTabs).toEqual([tab(1), tab(3)]);
    expect(next.activeSubTabId).toBe(1);
  });

  it("[1,2,3] 关 active 最左 → 收敛到右邻居", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 1, "personDetail");
    const next = navigationReducer(state, { kind: "CloseActiveSubTab" });
    expect(next.subTabs).toEqual([tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(2);
  });

  it("[1,2,3] 关 active 最右 → 收敛到左邻居", () => {
    const state = withTabs([tab(1), tab(2), tab(3)], 3, "personDetail");
    const next = navigationReducer(state, { kind: "CloseActiveSubTab" });
    expect(next.subTabs).toEqual([tab(1), tab(2)]);
    expect(next.activeSubTabId).toBe(2);
  });

  it("[1] 关 active 唯一 → 表空,active=null", () => {
    const state = withTabs([tab(1)], 1, "personDetail");
    const next = navigationReducer(state, { kind: "CloseActiveSubTab" });
    expect(next.subTabs).toEqual([]);
    expect(next.activeSubTabId).toBeNull();
  });

  it("[1,2] 反复关到底 → 顺序仍按左-右兜底,最终 active=null", () => {
    let s = withTabs([tab(1), tab(2)], 1, "personDetail");
    // 先激活最右的 2(模拟用户切到右边);再 ⌘W 关
    s = navigationReducer(s, { kind: "ActivatePersonTab", personId: 2 });
    s = navigationReducer(s, { kind: "CloseActiveSubTab" });
    expect(s.subTabs).toEqual([tab(1)]);
    expect(s.activeSubTabId).toBe(1);
    s = navigationReducer(s, { kind: "CloseActiveSubTab" });
    expect(s.subTabs).toEqual([]);
    expect(s.activeSubTabId).toBeNull();
  });
});

describe("Scenario: activeId invariant post-step", () => {
  it("reducer 输出永远满足 `activeSubTabId ∈ subTabs ∪ {null}`", () => {
    // 对一组手工构造 + reducer 应用过的事件序列,任何次态都满足
    // 不变量 —— 用 property-style 验证,跨多个 case 同步校验。
    const fixtures: Array<{
      name: string;
      state: NavigationState;
      events: Array<NavigationEvent>;
    }> = [
      {
        name: "OpenPerson / ClosePersonTab / Reorder 序列",
        state: initialState,
        events: [
          { kind: "OpenPerson", personId: 1 },
          { kind: "OpenPerson", personId: 2 },
          { kind: "OpenPerson", personId: 3 },
          { kind: "ActivatePersonTab", personId: 2 },
          { kind: "ClosePersonTab", personId: 2 },
          { kind: "ReorderPersonTabs", from: 0, to: 1 },
        ],
      },
      {
        name: "closeAll + reopen 序列",
        state: withTabs([tab(1), tab(2), tab(3)], 1, "personDetail"),
        events: [
          { kind: "CloseAllPersonTabs" },
          { kind: "OpenPerson", personId: 4 },
          { kind: "OpenPerson", personId: 5 },
        ],
      },
      {
        name: "closeLeft / closeRight 序列",
        state: withTabs([tab(1), tab(2), tab(3), tab(4)], 2, "personDetail"),
        events: [
          { kind: "CloseLeftPersonTabs", personId: 3 },
          { kind: "CloseRightPersonTabs", personId: 1 },
          // 此时仅剩 [1]; 主动激活 1
          { kind: "ActivatePersonTab", personId: 1 },
        ],
      },
      {
        name: "SetTab / CloseActive 交错",
        state: withTabs([tab(1), tab(2)], 2, "personDetail"),
        events: [
          { kind: "SetTab", tab: "today" },
          { kind: "CloseActiveSubTab" },
          { kind: "SetTab", tab: "personDetail" },
        ],
      },
    ];

    for (const fx of fixtures) {
      let s = fx.state;
      for (const ev of fx.events) {
        s = navigationReducer(s, ev);
        // 不变量校验
        if (s.activeSubTabId == null) {
          expect(s.subTabs.length).toBe(0);
        } else {
          expect(
            s.subTabs.some((entry) => entry.personId === s.activeSubTabId),
          ).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 本期未实施 kind 的占位 — 它们的 case 体在 #98-#101 接入,仅校验
// reducer 收到时返 state 不变(消费路径尚未接线)。
// ---------------------------------------------------------------------------

describe("navigationReducer · 延后 kind 在本期是 no-op 兜底", () => {
  it("OpenTaskDialog → state 不变(dialog 字段本期不进 reducer)", () => {
    // 重申:dialog 字段存在,只是本期 reducer 不动 —— #98 接入。
    const state = withTabs([tab(1), tab(2)], 1, "personDetail");
    const next = navigationReducer(state, {
      kind: "OpenTaskDialog",
      target: { mode: "create" },
    });
    expect(next).toBe(state); // 引用相等(返回 state)
  });

  it("CloseTaskDialog / TaskSaved / OpenPalette / ClosePalette / PalettePick / IntentConsumed → state 不变", () => {
    const state = withTabs([tab(1), tab(2)], 1, "personDetail");
    for (const ev of [
      { kind: "CloseTaskDialog" as const },
      { kind: "TaskSaved" as const },
      { kind: "OpenPalette" as const },
      { kind: "ClosePalette" as const },
      {
        kind: "PalettePick" as const,
        target: { kind: "openCreateTask" as const },
      },
      { kind: "IntentConsumed" as const },
    ]) {
      expect(navigationReducer(state, ev)).toBe(state);
    }
  });
});
