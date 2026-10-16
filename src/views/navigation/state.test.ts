/**
 * Navigation reducer — 表驱动 + scenario 双覆盖（issues #97 / #99）。
 *
 * 单一 seam：`navigationReducer(state, event) → newState`。无 DOM / React /
 * IPC 依赖。父 spec 见 #96 §Testing Decisions 引用 ADR 0011 §6(table-driven
 * by `src/lib/taskStatus.test.ts`) 同型范式。
 *
 * 表驱动覆盖每条 (state, event) → nextState 一行；scenario 锁定 UX
 * 契约 ——
 *   #97:duplicate `OpenPerson` add-or-focus、`CloseActiveSubTab` 左-右 fallback、
 *        activeId invariant post-step;
 *   #99:dialog 唯一性（已有 dialog 时 `OpenTaskDialog` 是 no-op）。
 *
 * 本测试文件 (#97 + #99) 覆盖 sub-tab / 主 tab / dialog 路径;palette/
 * PalettePick/pendingIntent 等 case 在 #100-#101 接入,本文件不为其断言,
 * reducer 已就位以保持 union 编译期阻挡。
 */

import { describe, expect, it } from "vitest";

import {
  initialState,
  navigationReducer,
  type DialogTarget,
  type MainTabId,
  type NavigationEvent,
  type NavigationState,
  type OpenPersonTab,
} from "./state";
import type { AssigneeCandidate, ProjectCandidate, Task } from "@/lib/api";

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
// dialog —— OpenTaskDialog / CloseTaskDialog / TaskSaved (issue #99)
//
// dialog 字段在 reducer 里,case 体实施 = #99。dialog 唯一性:同一瞬间
// 只能一份 dialog,已有 dialog 时再 `OpenTaskDialog` 是 no-op —— 同
// 意 issue #99 §dialog 唯一性。`CloseTaskDialog` / `TaskSaved` 在无
// dialog 时也是 no-op(防御性,通常由 Esc / X / Save 入口触发,不该在
// 没有 dialog 时收到)。
// ---------------------------------------------------------------------------

/** 测试用最小 assignee / project / task 工厂 —— TaskDialog 入口参数。 */
function assignee(personId: number, name = "张三", subTeamName = "暖通"): AssigneeCandidate {
  return { personId, name, subTeamName };
}
function project(projectId: number, name = "某项目", subTeamName = "暖通"): ProjectCandidate {
  return { projectId, name, subTeamName };
}
function taskFixture(id: number): Task {
  return {
    id,
    title: `任务 ${id}`,
    description: null,
    status: "Open",
    ownerPersonId: 1,
    projectId: null,
    dueDate: null,
    recurringTemplateId: null,
    scheduledAt: null,
    originalScheduledAt: null,
    rescheduledFromId: null,
    isRecurring: false,
    effectiveDate: null,
    createdAt: "2026-09-01 09:00:00",
    updatedAt: "2026-09-01 09:00:00",
    blockedAt: null,
    blockedReason: null,
    waitingOnPersonId: null,
  };
}

describe("navigationReducer · OpenTaskDialog", () => {
  it("空 dialog 状态 OpenTaskDialog(create) → dialog = {mode:'create'}", () => {
    const next = navigationReducer(initialState, {
      kind: "OpenTaskDialog",
      target: { mode: "create" },
    });
    expect(next.dialog).toEqual({ mode: "create" });
  });

  it("OpenTaskDialog(create, initialAssignee=X) → dialog 保留 initialAssignee 透传", () => {
    const a = assignee(7);
    const next = navigationReducer(initialState, {
      kind: "OpenTaskDialog",
      target: { mode: "create", initialAssignee: a },
    });
    expect(next.dialog).toEqual({ mode: "create", initialAssignee: a });
  });

  it("OpenTaskDialog(edit, task, assignee, project) → dialog 完整透传", () => {
    const t = taskFixture(42);
    const a = assignee(7);
    const p = project(99);
    const next = navigationReducer(initialState, {
      kind: "OpenTaskDialog",
      target: { mode: "edit", task: t, assignee: a, project: p },
    });
    expect(next.dialog).toEqual({ mode: "edit", task: t, assignee: a, project: p });
  });

  it("已有 dialog 时 OpenTaskDialog → 维持原 dialog(no-op,唯一性)", () => {
    const first: DialogTarget = { mode: "create", initialAssignee: assignee(1) };
    const state: NavigationState = { ...initialState, dialog: first };
    const second: DialogTarget = { mode: "edit", task: taskFixture(2), assignee: assignee(3), project: null };
    const next = navigationReducer(state, {
      kind: "OpenTaskDialog",
      target: second,
    });
    // 严格同一份(引用相等)— 不被新事件覆盖
    expect(next).toBe(state);
    expect(next.dialog).toBe(first);
  });

  it("OpenTaskDialog 不动主 tab / subTabs / palette / pendingIntent", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "matrix",
      subTabs: [tab(1), tab(2)],
      activeSubTabId: 1,
      palette: { open: true },
      pendingIntent: { kind: "locateProject", id: 5 },
    };
    const next = navigationReducer(state, {
      kind: "OpenTaskDialog",
      target: { mode: "create" },
    });
    expect(next.tab).toBe("matrix");
    expect(next.subTabs).toEqual([tab(1), tab(2)]);
    expect(next.activeSubTabId).toBe(1);
    expect(next.palette).toEqual({ open: true });
    expect(next.pendingIntent).toEqual({ kind: "locateProject", id: 5 });
  });
});

describe("navigationReducer · CloseTaskDialog", () => {
  it("有 dialog → dialog 置 null", () => {
    const state: NavigationState = {
      ...initialState,
      dialog: { mode: "create", initialAssignee: assignee(1) },
    };
    const next = navigationReducer(state, { kind: "CloseTaskDialog" });
    expect(next.dialog).toBeNull();
  });

  it("无 dialog → no-op(state 不变,防御性)", () => {
    const next = navigationReducer(initialState, { kind: "CloseTaskDialog" });
    expect(next).toBe(initialState);
  });

  it("CloseTaskDialog 不动其它字段(palette / pendingIntent / subTabs 等)", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "projects",
      subTabs: [tab(1)],
      activeSubTabId: 1,
      dialog: { mode: "edit", task: taskFixture(1), assignee: assignee(1), project: null },
      palette: { open: true },
      pendingIntent: { kind: "locateProject", id: 5 },
    };
    const next = navigationReducer(state, { kind: "CloseTaskDialog" });
    expect(next.dialog).toBeNull();
    expect(next.tab).toBe("projects");
    expect(next.subTabs).toEqual([tab(1)]);
    expect(next.activeSubTabId).toBe(1);
    expect(next.palette).toEqual({ open: true });
    expect(next.pendingIntent).toEqual({ kind: "locateProject", id: 5 });
  });
});

describe("navigationReducer · TaskSaved", () => {
  it("有 dialog → dialog 置 null(reducer 不沾 refreshToken —— shell 显式 +1)", () => {
    const state: NavigationState = {
      ...initialState,
      dialog: { mode: "edit", task: taskFixture(5), assignee: assignee(7), project: project(9) },
    };
    const next = navigationReducer(state, { kind: "TaskSaved" });
    expect(next.dialog).toBeNull();
    // 不动其它字段
    expect(next.tab).toBe(initialState.tab);
    expect(next.subTabs).toEqual(initialState.subTabs);
    expect(next.palette).toBe(initialState.palette);
    expect(next.pendingIntent).toBe(initialState.pendingIntent);
  });

  it("无 dialog → no-op(state 不变,防御性)", () => {
    const next = navigationReducer(initialState, { kind: "TaskSaved" });
    expect(next).toBe(initialState);
  });

  it("TaskSaved 路径跟 CloseTaskDialog 同结果 —— 都是 dialog → null", () => {
    const target: DialogTarget = { mode: "create", initialAssignee: assignee(1) };
    const opened: NavigationState = { ...initialState, dialog: target };
    const afterSave = navigationReducer(opened, { kind: "TaskSaved" });
    const afterClose = navigationReducer(opened, { kind: "CloseTaskDialog" });
    expect(afterSave.dialog).toBeNull();
    expect(afterClose.dialog).toBeNull();
    // 两者结果除了 dialog null 之外其它字段一致
    expect(afterSave).toEqual(afterClose);
  });
});

// ---------------------------------------------------------------------------
// dialog —— Scenario: dialog 唯一性(#99 §dialog 唯一性 + AC #1)
//
// "同一瞬间只能一份 dialog" —— 已有 dialog 时再发起 OpenTaskDialog 是
// no-op。新事件发起前 reducer 显式 noop;gate 形式在 effect 层(window
// keydown ⌘N 在 App.tsx useEffect 内检查 state.dialog == null 才 dispatch)。
// ---------------------------------------------------------------------------

describe("Scenario: dialog 唯一性 (#99)", () => {
  it("空 dialog → Open(create) → Open(edit) 第二次被忽略,仍是 create", () => {
    const s0 = initialState;
    const s1 = navigationReducer(s0, {
      kind: "OpenTaskDialog",
      target: { mode: "create", initialAssignee: assignee(1) },
    });
    const s2 = navigationReducer(s1, {
      kind: "OpenTaskDialog",
      target: { mode: "edit", task: taskFixture(2), assignee: assignee(3), project: null },
    });
    expect(s1.dialog).toEqual({ mode: "create", initialAssignee: assignee(1) });
    // 第二次被唯一性规则 noop,s2 == s1(引用相等)
    expect(s2).toBe(s1);
    expect(s2.dialog).toEqual({ mode: "create", initialAssignee: assignee(1) });
  });

  it("dialog 唯一性 + 关闭序列:Open → Close → Open 第二次生效(close 后再开)", () => {
    let s = initialState;
    s = navigationReducer(s, {
      kind: "OpenTaskDialog",
      target: { mode: "create" },
    });
    expect(s.dialog).toEqual({ mode: "create" });
    s = navigationReducer(s, { kind: "CloseTaskDialog" });
    expect(s.dialog).toBeNull();
    // close 后第二次 open 应生效
    s = navigationReducer(s, {
      kind: "OpenTaskDialog",
      target: { mode: "edit", task: taskFixture(5), assignee: assignee(7), project: null },
    });
    expect(s.dialog).toEqual({
      mode: "edit",
      task: taskFixture(5),
      assignee: assignee(7),
      project: null,
    });
  });

  it("dialog 唯一性 + save 序列:Open → TaskSaved → Open 第二次生效(save 后再开)", () => {
    let s = initialState;
    s = navigationReducer(s, {
      kind: "OpenTaskDialog",
      target: { mode: "create" },
    });
    s = navigationReducer(s, { kind: "TaskSaved" });
    expect(s.dialog).toBeNull();
    // save 后第二次 open 应生效(用户保存一条后立刻新建另一条)
    s = navigationReducer(s, {
      kind: "OpenTaskDialog",
      target: { mode: "create", initialAssignee: assignee(9) },
    });
    expect(s.dialog).toEqual({ mode: "create", initialAssignee: assignee(9) });
  });
});

// ---------------------------------------------------------------------------
// palette —— OpenPalette / ClosePalette (issue #100)
//
// palette 字段为 `{ open: boolean } | null` —— non-null = 开,null = 关。
// 二次开是幂等(已是 open 时再 OpenPalette 不重建对象);无 palette 时关是 no-op。
// ---------------------------------------------------------------------------

describe("navigationReducer · OpenPalette", () => {
  it("空 palette → palette = { open: true }", () => {
    const next = navigationReducer(initialState, { kind: "OpenPalette" });
    expect(next.palette).toEqual({ open: true });
  });

  it("已是 open 时再 OpenPalette → state 引用不变(幂等)", () => {
    const state: NavigationState = { ...initialState, palette: { open: true } };
    const next = navigationReducer(state, { kind: "OpenPalette" });
    expect(next).toBe(state);
  });

  it("OpenPalette 不动其它字段(tab / subTabs / dialog / pendingIntent)", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "matrix",
      subTabs: [tab(1), tab(2)],
      activeSubTabId: 1,
      dialog: { mode: "create" },
      pendingIntent: { kind: "locateProject", id: 5 },
    };
    const next = navigationReducer(state, { kind: "OpenPalette" });
    expect(next.palette).toEqual({ open: true });
    expect(next.tab).toBe("matrix");
    expect(next.subTabs).toEqual([tab(1), tab(2)]);
    expect(next.activeSubTabId).toBe(1);
    expect(next.dialog).toEqual({ mode: "create" });
    expect(next.pendingIntent).toEqual({ kind: "locateProject", id: 5 });
  });
});

describe("navigationReducer · ClosePalette", () => {
  it("open 时 ClosePalette → palette = null", () => {
    const state: NavigationState = { ...initialState, palette: { open: true } };
    const next = navigationReducer(state, { kind: "ClosePalette" });
    expect(next.palette).toBeNull();
  });

  it("已 null 时 ClosePalette → state 引用不变(防御性)", () => {
    const next = navigationReducer(initialState, { kind: "ClosePalette" });
    expect(next).toBe(initialState);
  });

  it("ClosePalette 不动其它字段(dialog / pendingIntent / subTabs 等)", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "projects",
      subTabs: [tab(1)],
      activeSubTabId: 1,
      dialog: { mode: "edit", task: taskFixture(1), assignee: assignee(1), project: null },
      palette: { open: true },
      pendingIntent: { kind: "locateProject", id: 5 },
    };
    const next = navigationReducer(state, { kind: "ClosePalette" });
    expect(next.palette).toBeNull();
    expect(next.dialog).toEqual({
      mode: "edit",
      task: taskFixture(1),
      assignee: assignee(1),
      project: null,
    });
    expect(next.pendingIntent).toEqual({ kind: "locateProject", id: 5 });
    expect(next.tab).toBe("projects");
    expect(next.subTabs).toEqual([tab(1)]);
  });
});

// ---------------------------------------------------------------------------
// PalettePick —— 4 条子路由原子（issue #100 §What to build）
//
// 一条 PalettePick 事件同时改 tab / pendingIntent / dialog / palette.open
// 多态 —— React 不渲染中间帧(reducer 同一帧返回完整 nextState)。
// ---------------------------------------------------------------------------

describe("navigationReducer · PalettePick · openCreateTask", () => {
  it("PalettePick(openCreateTask) → dialog = {mode:'create'} + palette = null(原子)", () => {
    const state: NavigationState = { ...initialState, palette: { open: true } };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openCreateTask" },
    });
    expect(next.dialog).toEqual({ mode: "create" });
    expect(next.palette).toBeNull();
  });

  it("PalettePick(openCreateTask) 已有 dialog 时不打开新 dialog(唯一性)", () => {
    const first: DialogTarget = { mode: "create", initialAssignee: assignee(1) };
    const state: NavigationState = {
      ...initialState,
      dialog: first,
      palette: { open: true },
    };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openCreateTask" },
    });
    expect(next.dialog).toBe(first); // 维持原 dialog 引用
    expect(next.palette).toBeNull(); // 但 palette 仍要关
  });
});

describe("navigationReducer · PalettePick · openEditTask", () => {
  it("PalettePick(openEditTask) → dialog = edit + palette = null(原子)", () => {
    const t = taskFixture(42);
    const a = assignee(7);
    const p = project(99);
    const state: NavigationState = { ...initialState, palette: { open: true } };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openEditTask", task: t, assignee: a, project: p },
    });
    expect(next.dialog).toEqual({ mode: "edit", task: t, assignee: a, project: p });
    expect(next.palette).toBeNull();
  });

  it("PalettePick(openEditTask) 已有 dialog 时不替换(唯一性 + 仍关 palette)", () => {
    const first: DialogTarget = { mode: "create", initialAssignee: assignee(1) };
    const state: NavigationState = {
      ...initialState,
      dialog: first,
      palette: { open: true },
    };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: {
        kind: "openEditTask",
        task: taskFixture(2),
        assignee: assignee(3),
        project: null,
      },
    });
    expect(next.dialog).toBe(first);
    expect(next.palette).toBeNull();
  });
});

describe("navigationReducer · PalettePick · openProject", () => {
  it("PalettePick(openProject, 42) 原子: pendingIntent 设 + tab projects + palette null", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "today",
      palette: { open: true },
    };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openProject", projectId: 42 },
    });
    expect(next.pendingIntent).toEqual({ kind: "locateProject", id: 42 });
    expect(next.tab).toBe("projects");
    expect(next.palette).toBeNull();
  });

  it("PalettePick(openProject) 不动 subTabs / activeSubTabId / dialog", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "today",
      subTabs: [tab(1), tab(2)],
      activeSubTabId: 1,
      palette: { open: true },
    };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openProject", projectId: 7 },
    });
    expect(next.subTabs).toEqual([tab(1), tab(2)]);
    expect(next.activeSubTabId).toBe(1);
    expect(next.dialog).toBeNull();
  });

  it("PalettePick(openProject) palette 已 null 时仍生效(用户可直派)", () => {
    const state: NavigationState = { ...initialState, tab: "today" };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openProject", projectId: 7 },
    });
    expect(next.pendingIntent).toEqual({ kind: "locateProject", id: 7 });
    expect(next.tab).toBe("projects");
    expect(next.palette).toBeNull();
  });
});

describe("navigationReducer · PalettePick · openPerson", () => {
  it("PalettePick(openPerson, 3) 原子: add-or-focus subTab + active 切 + tab personDetail + palette null", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "today",
      palette: { open: true },
    };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openPerson", personId: 3 },
    });
    expect(next.tab).toBe("personDetail");
    expect(next.subTabs).toEqual([tab(3)]);
    expect(next.activeSubTabId).toBe(3);
    expect(next.palette).toBeNull();
  });

  it("PalettePick(openPerson, 2) 已有 [1,2,3] active=1 → 不重复增 + 激活 2 + palette null", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "today",
      subTabs: [tab(1), tab(2), tab(3)],
      activeSubTabId: 1,
      palette: { open: true },
    };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openPerson", personId: 2 },
    });
    expect(next.subTabs).toEqual([tab(1), tab(2), tab(3)]);
    expect(next.activeSubTabId).toBe(2);
    expect(next.tab).toBe("personDetail");
    expect(next.palette).toBeNull();
  });

  it("PalettePick(openPerson) 终点与 OpenPerson(personId) 同 state(矩阵卡等价 dispatch)", () => {
    // 等价契约(issue #100 AC #4):命令面板「人员」路径与矩阵卡点击终点同
    // state —— 同一 reducer state 上的等价 dispatch 子集。
    const s0: NavigationState = {
      ...initialState,
      tab: "matrix",
      subTabs: [tab(1)],
      activeSubTabId: 1,
      palette: { open: true },
    };
    const viaPalette = navigationReducer(s0, {
      kind: "PalettePick",
      target: { kind: "openPerson", personId: 7 },
    });
    // 抹掉 palette 字段后,应与 OpenPerson(7) 结果相同。
    const s0WithoutPalette: NavigationState = { ...s0, palette: null };
    const viaOpenPerson = navigationReducer(s0WithoutPalette, {
      kind: "OpenPerson",
      personId: 7,
    });
    expect({
      tab: viaPalette.tab,
      subTabs: viaPalette.subTabs,
      activeSubTabId: viaPalette.activeSubTabId,
      dialog: viaPalette.dialog,
      pendingIntent: viaPalette.pendingIntent,
    }).toEqual({
      tab: viaOpenPerson.tab,
      subTabs: viaOpenPerson.subTabs,
      activeSubTabId: viaOpenPerson.activeSubTabId,
      dialog: viaOpenPerson.dialog,
      pendingIntent: viaOpenPerson.pendingIntent,
    });
    expect(viaPalette.palette).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// IntentConsumed —— 清 pendingIntent slot (issue #100)
//
// ProjectsView 选中具体卡片后 dispatch IntentConsumed 清空 slot ——
// 等同于旧 App.tsx onProjectLocated + onCreateOwnerConsumed 双 callback。
// ---------------------------------------------------------------------------

describe("navigationReducer · IntentConsumed", () => {
  it("有 pendingIntent → 置 null", () => {
    const state: NavigationState = {
      ...initialState,
      pendingIntent: { kind: "locateProject", id: 5 },
    };
    const next = navigationReducer(state, { kind: "IntentConsumed" });
    expect(next.pendingIntent).toBeNull();
  });

  it("已 null 时 IntentConsumed → state 引用不变(防御性)", () => {
    const next = navigationReducer(initialState, { kind: "IntentConsumed" });
    expect(next).toBe(initialState);
  });

  it("createProjectFor / createTemplateFor 也走同条 IntentConsumed", () => {
    for (const initial of [
      { kind: "createProjectFor" as const, id: 7 },
      { kind: "createTemplateFor" as const, subTeamId: 3 },
    ]) {
      const state: NavigationState = { ...initialState, pendingIntent: initial };
      const next = navigationReducer(state, { kind: "IntentConsumed" });
      expect(next.pendingIntent).toBeNull();
    }
  });

  it("IntentConsumed 不动其它字段(palette / subTabs / dialog 等)", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "projects",
      subTabs: [tab(1), tab(2)],
      activeSubTabId: 1,
      dialog: { mode: "edit", task: taskFixture(1), assignee: assignee(1), project: null },
      palette: { open: true },
      pendingIntent: { kind: "locateProject", id: 5 },
    };
    const next = navigationReducer(state, { kind: "IntentConsumed" });
    expect(next.pendingIntent).toBeNull();
    expect(next.palette).toEqual({ open: true });
    expect(next.tab).toBe("projects");
    expect(next.subTabs).toEqual([tab(1), tab(2)]);
    expect(next.dialog).toEqual({
      mode: "edit",
      task: taskFixture(1),
      assignee: assignee(1),
      project: null,
    });
  });
});

// ---------------------------------------------------------------------------
// OpenCreateProjectFor / OpenCreateTemplateFor —— PersonDetailTabsView
// 「+」按钮专用事件,代替旧 App.tsx 的 openCreateProject / openCreateTemplate
// 回调(setPendingProjectCreateOwnerId + dispatch SetTab 两步)。
// 一条事件原子设置 tab + pendingIntent。
// ---------------------------------------------------------------------------

describe("navigationReducer · OpenCreateProjectFor", () => {
  it("OpenCreateProjectFor(7) → tab projects + pendingIntent createProjectFor(7)", () => {
    const state: NavigationState = { ...initialState, tab: "personDetail" };
    const next = navigationReducer(state, {
      kind: "OpenCreateProjectFor",
      personId: 7,
    });
    expect(next.tab).toBe("projects");
    expect(next.pendingIntent).toEqual({ kind: "createProjectFor", id: 7 });
  });

  it("OpenCreateProjectFor 不动 palette / subTabs / dialog", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "personDetail",
      subTabs: [tab(1), tab(2)],
      activeSubTabId: 1,
      dialog: { mode: "create" },
      palette: { open: true },
    };
    const next = navigationReducer(state, {
      kind: "OpenCreateProjectFor",
      personId: 9,
    });
    expect(next.palette).toEqual({ open: true });
    expect(next.subTabs).toEqual([tab(1), tab(2)]);
    expect(next.activeSubTabId).toBe(1);
    expect(next.dialog).toEqual({ mode: "create" });
  });
});

describe("navigationReducer · OpenCreateTemplateFor", () => {
  it("OpenCreateTemplateFor(3) → tab holiday + pendingIntent createTemplateFor(3)", () => {
    const state: NavigationState = { ...initialState, tab: "personDetail" };
    const next = navigationReducer(state, {
      kind: "OpenCreateTemplateFor",
      subTeamId: 3,
    });
    expect(next.tab).toBe("holiday");
    expect(next.pendingIntent).toEqual({ kind: "createTemplateFor", subTeamId: 3 });
  });

  it("OpenCreateTemplateFor 不动 palette / subTabs / dialog", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "personDetail",
      subTabs: [tab(1)],
      activeSubTabId: 1,
      dialog: { mode: "edit", task: taskFixture(2), assignee: assignee(1), project: null },
    };
    const next = navigationReducer(state, {
      kind: "OpenCreateTemplateFor",
      subTeamId: 5,
    });
    expect(next.palette).toBeNull();
    expect(next.subTabs).toEqual([tab(1)]);
    expect(next.activeSubTabId).toBe(1);
    expect(next.dialog).toEqual({
      mode: "edit",
      task: taskFixture(2),
      assignee: assignee(1),
      project: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario: PalettePick 4 条子路由同帧原子(issue #100 §AC)
//
// 锁定 UX 契约 —— PalettePick 一条事件内同帧多状态变化,React 不渲染中间帧。
// 对每条 PalettePick 子路由,验证:
//   1. palette 一定归 null(关窗)
//   2. 副作用字段(tab / pendingIntent / dialog / subTabs / active)与"显式
//      走 OpenPerson / OpenTaskDialog / SetTab + setIntent"两步派发结果同
//   3. 不被影响的字段不动
// ---------------------------------------------------------------------------

describe("Scenario: PalettePick(openCreateTask) 原子", () => {
  it("一条 PalettePick 同时关 palette + 开 dialog.create,中间帧无 paint", () => {
    const state: NavigationState = { ...initialState, palette: { open: true } };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openCreateTask" },
    });
    // 同一 nextState 内 palette=null + dialog=create —— 中间帧不存在。
    expect(next.palette).toBeNull();
    expect(next.dialog).toEqual({ mode: "create" });
  });
});

describe("Scenario: PalettePick(openEditTask) 原子", () => {
  it("一条 PalettePick 同时关 palette + 开 dialog.edit,中间帧无 paint", () => {
    const t = taskFixture(11);
    const a = assignee(3);
    const state: NavigationState = { ...initialState, palette: { open: true } };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openEditTask", task: t, assignee: a, project: null },
    });
    expect(next.palette).toBeNull();
    expect(next.dialog).toEqual({ mode: "edit", task: t, assignee: a, project: null });
  });
});

describe("Scenario: PalettePick(openProject) 原子 —— 三态同帧", () => {
  it("一条 PalettePick 同时关 palette + 切 tab + 设 pendingIntent,中间帧无 paint", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "today",
      palette: { open: true },
    };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openProject", projectId: 42 },
    });
    expect(next.palette).toBeNull();
    expect(next.tab).toBe("projects");
    expect(next.pendingIntent).toEqual({ kind: "locateProject", id: 42 });
  });

  it("PalettePick(openProject) 完成后 dispatch IntentConsumed 清 slot —— ProjectsView 选中卡片路径", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "today",
      palette: { open: true },
    };
    const picked = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openProject", projectId: 42 },
    });
    // ProjectsView 拿到 pendingIntent,选中卡片 → dispatch IntentConsumed
    const consumed = navigationReducer(picked, { kind: "IntentConsumed" });
    expect(consumed.pendingIntent).toBeNull();
    expect(consumed.tab).toBe("projects"); // tab 不回滚
  });
});

describe("Scenario: PalettePick(openPerson) 原子 —— 等价于 OpenPerson + 关 palette", () => {
  it("一条 PalettePick 走完 subTabs add-or-focus + active 切 + tab personDetail + palette null", () => {
    const state: NavigationState = {
      ...initialState,
      tab: "today",
      subTabs: [tab(1)],
      activeSubTabId: 1,
      palette: { open: true },
    };
    const next = navigationReducer(state, {
      kind: "PalettePick",
      target: { kind: "openPerson", personId: 7 },
    });
    // 5 个字段同一帧确定 —— 中间帧不存在。
    expect(next.palette).toBeNull();
    expect(next.tab).toBe("personDetail");
    expect(next.subTabs).toEqual([tab(1), tab(7)]);
    expect(next.activeSubTabId).toBe(7);
    expect(next.dialog).toBeNull();
  });
});
