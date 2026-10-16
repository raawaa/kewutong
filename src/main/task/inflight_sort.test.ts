/**
 * `inflight_sort` 行为测试（ticket #92 P1）。
 *
 * 覆盖：
 * - 三个 comparator 的 happy path + tiebreak；
 * - NOT NULL 列的 null 路径走 `AppError.internal`（invariant violation）；
 * - `dueDate` 仍按「null 排末」处理（业务上可空，不是 schema 违反）；
 * - `comparatorFor(status)` 的映射表与每个 status 一一对应。
 */

import { describe, expect, it } from "vitest";

import { AppError } from "../error.js";
import type { Task, TaskStatus } from "../types.js";
import {
  compareByBlockedAtAsc,
  compareByDueDateAscNullLast,
  compareByUpdatedAtDesc,
  comparatorFor,
} from "./inflight_sort.js";

function task(overrides: Partial<Task> & { id: number }): Task {
  return {
    title: "T",
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
    createdAt: "2026-09-10 08:00:00",
    updatedAt: "2026-09-10 08:00:00",
    blockedAt: null,
    blockedReason: null,
    waitingOnPersonId: null,
    ...overrides,
  };
}

/**
 * 构造「病态 task」：NOT NULL 列（updatedAt / blockedAt）允许 null，
 * 用于触发 comparator 的 invariant violation 路径。DB schema 不会
 * 让这种 task 落库——若落到比较器了，说明 schema 被绕过，比较器必须
 * 拒掉（抛 AppError.internal）。
 */
function malformedTask(overrides: {
  id: number;
  status?: TaskStatus;
  updatedAt?: string | null;
  blockedAt?: string | null;
}): Task {
  const defaults: Task = task({ id: overrides.id });
  return { ...defaults, ...overrides } as unknown as Task;
}

// ---------------------------------------------------------------------------
// compareByDueDateAscNullLast
// ---------------------------------------------------------------------------

describe("compareByDueDateAscNullLast", () => {
  it("earlier dueDate comes first", () => {
    const a = task({ id: 1, dueDate: "2026-09-01" });
    const b = task({ id: 2, dueDate: "2026-09-15" });
    expect(compareByDueDateAscNullLast(a, b)).toBeLessThan(0);
    expect(compareByDueDateAscNullLast(b, a)).toBeGreaterThan(0);
  });

  it("null dueDate goes last (业务可空,不是 invariant violation)", () => {
    const withDate = task({ id: 1, dueDate: "2026-09-15" });
    const noDate = task({ id: 2, dueDate: null });
    expect(compareByDueDateAscNullLast(withDate, noDate)).toBeLessThan(0);
    expect(compareByDueDateAscNullLast(noDate, withDate)).toBeGreaterThan(0);
  });

  it("two nulls tiebreak by id ascending", () => {
    const a = task({ id: 1, dueDate: null });
    const b = task({ id: 2, dueDate: null });
    expect(compareByDueDateAscNullLast(a, b)).toBeLessThan(0);
  });

  it("same dueDate tiebreak by id ascending", () => {
    const a = task({ id: 1, dueDate: "2026-09-15" });
    const b = task({ id: 2, dueDate: "2026-09-15" });
    expect(compareByDueDateAscNullLast(a, b)).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// compareByBlockedAtAsc —— NOT NULL 列,null → AppError
// ---------------------------------------------------------------------------

describe("compareByBlockedAtAsc", () => {
  it("earlier blockedAt comes first (longest-stuck)", () => {
    const a = task({ id: 1, blockedAt: "2026-09-01 10:00:00" });
    const b = task({ id: 2, blockedAt: "2026-09-15 10:00:00" });
    expect(compareByBlockedAtAsc(a, b)).toBeLessThan(0);
  });

  it("same blockedAt tiebreak by id ascending", () => {
    const a = task({ id: 1, blockedAt: "2026-09-15 10:00:00" });
    const b = task({ id: 2, blockedAt: "2026-09-15 10:00:00" });
    expect(compareByBlockedAtAsc(a, b)).toBeLessThan(0);
  });

  it("throws AppError.internal when a.blockedAt is null", () => {
    const a = task({ id: 1, blockedAt: null });
    const b = task({ id: 2, blockedAt: "2026-09-15 10:00:00" });
    expect(() => compareByBlockedAtAsc(a, b)).toThrow(AppError);
  });

  it("throws AppError.internal when b.blockedAt is null", () => {
    const a = task({ id: 1, blockedAt: "2026-09-15 10:00:00" });
    const b = task({ id: 2, blockedAt: null });
    expect(() => compareByBlockedAtAsc(a, b)).toThrow(AppError);
  });

  it("AppError.detail carries taskId and status for triage", () => {
    const a = task({ id: 42, status: "Blocked", blockedAt: null });
    const b = task({ id: 1, blockedAt: "2026-09-15 10:00:00" });
    try {
      compareByBlockedAtAsc(a, b);
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.code).toBe("INTERNAL");
      expect(err.detail).toContain("taskId=42");
      expect(err.detail).toContain("status=Blocked");
    }
  });
});

// ---------------------------------------------------------------------------
// compareByUpdatedAtDesc —— NOT NULL 列,null → AppError
// ---------------------------------------------------------------------------

describe("compareByUpdatedAtDesc", () => {
  it("later updatedAt comes first", () => {
    const a = task({ id: 1, updatedAt: "2026-09-15 10:00:00" });
    const b = task({ id: 2, updatedAt: "2026-09-01 10:00:00" });
    expect(compareByUpdatedAtDesc(a, b)).toBeLessThan(0);
  });

  it("same updatedAt tiebreak by id descending", () => {
    const a = task({ id: 1, updatedAt: "2026-09-15 10:00:00" });
    const b = task({ id: 2, updatedAt: "2026-09-15 10:00:00" });
    expect(compareByUpdatedAtDesc(a, b)).toBeGreaterThan(0);
  });

  it("throws AppError.internal when a.updatedAt is null", () => {
    const a = malformedTask({ id: 1, updatedAt: null });
    const b = task({ id: 2, updatedAt: "2026-09-15 10:00:00" });
    expect(() => compareByUpdatedAtDesc(a, b)).toThrow(AppError);
  });

  it("throws AppError.internal when b.updatedAt is null", () => {
    const a = task({ id: 1, updatedAt: "2026-09-15 10:00:00" });
    const b = malformedTask({ id: 2, updatedAt: null });
    expect(() => compareByUpdatedAtDesc(a, b)).toThrow(AppError);
  });

  it("AppError.detail carries taskId for triage", () => {
    const a = malformedTask({ id: 99, updatedAt: null });
    const b = task({ id: 1, updatedAt: "2026-09-15 10:00:00" });
    try {
      compareByUpdatedAtDesc(a, b);
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.code).toBe("INTERNAL");
      expect(err.detail).toContain("taskId=99");
    }
  });
});

// ---------------------------------------------------------------------------
// comparatorFor 映射
// ---------------------------------------------------------------------------

describe("comparatorFor", () => {
  it.each<[TaskStatus, "due" | "blocked" | "updated"]>([
    ["Open", "due"],
    ["In-progress", "due"],
    ["Blocked", "blocked"],
    ["Waiting-on", "blocked"],
    ["Done", "updated"],
    ["Cancelled", "updated"],
  ])("%s → 对应 family 的 comparator", (status, _family) => {
    // 参考相等而非行为判定:映射表是单点改,引用对得上就保证未来不被无意替换。
    const cmp = comparatorFor(status);
    switch (status) {
      case "Open":
      case "In-progress":
        expect(cmp).toBe(compareByDueDateAscNullLast);
        break;
      case "Blocked":
      case "Waiting-on":
        expect(cmp).toBe(compareByBlockedAtAsc);
        break;
      case "Done":
      case "Cancelled":
        expect(cmp).toBe(compareByUpdatedAtDesc);
        break;
    }
  });

  it("所有 6 个 status 都映射到非 undefined 的 comparator", () => {
    const statuses: TaskStatus[] = [
      "Open",
      "In-progress",
      "Blocked",
      "Waiting-on",
      "Done",
      "Cancelled",
    ];
    for (const s of statuses) {
      expect(comparatorFor(s)).toBeTypeOf("function");
    }
  });
});