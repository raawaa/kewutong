/**
 * Drift test（ticket #92 C1 P3）。
 *
 * 验证 renderer adapter（`src/lib/taskStatus.ts`）与主进程
 *（`src/main/task/index.ts`）关于状态枚举的三对数组一致：
 * 1. `TASK_STATUS_ORDER`（renderer） vs `TASK_STATUSES`（main）
 * 2. `IN_FLIGHT`（renderer） vs `IN_FLIGHT_STATUSES`（main）
 * 3. `BLOCKED`（renderer） vs `BLOCKED_STATUSES`（main）
 *
 * 任何一对漂移（新增 status / 重排 / 子集漏改）该测试报红，CI 拦下。
 */

import { describe, expect, it } from "vitest";

import {
  BLOCKED_STATUSES,
  IN_FLIGHT_STATUSES,
  TASK_STATUSES,
} from "@/main/task";
import {
  BLOCKED,
  IN_FLIGHT,
  TASK_STATUS_ORDER,
} from "@/lib/taskStatus";

describe("renderer ↔ main 状态枚举 drift", () => {
  it("TASK_STATUS_ORDER 与 TASK_STATUSES 元素顺序一致", () => {
    expect([...TASK_STATUS_ORDER]).toEqual([...TASK_STATUSES]);
  });

  it("IN_FLIGHT 与 IN_FLIGHT_STATUSES 元素顺序一致", () => {
    expect([...IN_FLIGHT]).toEqual([...IN_FLIGHT_STATUSES]);
  });

  it("BLOCKED 与 BLOCKED_STATUSES 元素顺序一致", () => {
    expect([...BLOCKED]).toEqual([...BLOCKED_STATUSES]);
  });

  it("BLOCKED 是 IN_FLIGHT 的真子集（Blocked ∈ InFlight）", () => {
    for (const s of BLOCKED) {
      expect(IN_FLIGHT).toContain(s);
    }
    expect(BLOCKED.length).toBeLessThan(IN_FLIGHT.length);
  });

  it("Done / Cancelled 不在 IN_FLIGHT", () => {
    expect(IN_FLIGHT).not.toContain("Done");
    expect(IN_FLIGHT).not.toContain("Cancelled");
  });
});