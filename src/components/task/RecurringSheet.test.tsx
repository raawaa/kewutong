/**
 * 周期规则侧抽屉的组件级验证（ticket #24）。
 *
 * 验收点：
 * - 打开抽屉时展示 5 节向导（频率 / 子句 / 时间 / 终止 / 节假日）
 * - 默认 freq=weekly 时,星期 chip 行可点;切到 monthly,换成日期 chip
 *   + "每月末" 按钮;切到 yearly,换成月份 + 日期两组
 * - 终止条件切换不报错
 * - 确认 → onConfirm 收到的 rule 形状可直接给 IPC upsert 消费
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecurringSheet } from "./RecurringSheet";
import type { StructuredRule } from "@/lib/ipc";
import { byday } from "@/lib/ipc";

const initialRule: StructuredRule = {
  freq: "weekly",
  bydayMask: 0,
  bymonthday: null,
  bymonth: null,
  byhour: 9,
  byminute: 0,
  ianaZone: "Asia/Shanghai",
  ends: { kind: "on", date: "2026-12-31" },
  holidayBehavior: "skip",
};

function renderSheet(overrides: Partial<Parameters<typeof RecurringSheet>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const user = userEvent.setup();
  render(
    <RecurringSheet
      initialRule={initialRule}
      templateName="周一三"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel, user };
}

describe("RecurringSheet · 频率向导", () => {
  it("默认 weekly 渲染 5 节", async () => {
    renderSheet();
    expect(screen.getByText("① 频率")).toBeInTheDocument();
    expect(screen.getByText("② 哪几天")).toBeInTheDocument();
    expect(screen.getByText("③ 时间")).toBeInTheDocument();
    expect(screen.getByText("④ 终止")).toBeInTheDocument();
    expect(screen.getByText("⑤ 节假日")).toBeInTheDocument();
  });

  it("weekly 至少一天才能确认,否则给中文提示", async () => {
    const { onConfirm, user } = renderSheet();
    await user.click(screen.getByRole("button", { name: "确认 →" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("每周规则");
  });

  it("选 周一 + 周三 + 确认 → onConfirm 收到 mask 与默认 ends", async () => {
    const { onConfirm, user } = renderSheet();
    await user.click(screen.getByRole("button", { name: "一" }));
    await user.click(screen.getByRole("button", { name: "三" }));
    await user.click(screen.getByRole("button", { name: "确认 →" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const rule = onConfirm.mock.calls[0][0] as StructuredRule;
    expect(rule.freq).toBe("weekly");
    expect(rule.bydayMask).toBe(byday.MO | byday.WE);
    expect(rule.ends).toEqual({ kind: "on", date: "2026-12-31" });
  });

  it("切到 monthly → 「每月末」按钮可用,确认带 bymonthday=[0]", async () => {
    const { onConfirm, user } = renderSheet();
    await user.click(screen.getByRole("button", { name: /每月/ }));
    await user.click(screen.getByRole("button", { name: "每月末" }));
    await user.click(screen.getByRole("button", { name: "确认 →" }));

    const rule = onConfirm.mock.calls[0][0] as StructuredRule;
    expect(rule.freq).toBe("monthly");
    expect(rule.bymonthday).toEqual([0]);
  });

  it("切到 yearly → 显示月份 chip + 日期输入", async () => {
    const { user } = renderSheet();
    await user.click(screen.getByRole("button", { name: /每年/ }));
    expect(screen.getByText("② 哪些月")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("切到 yearly 不选月份 → 确认被拒", async () => {
    const { onConfirm, user } = renderSheet();
    await user.click(screen.getByRole("button", { name: /每年/ }));
    // 默认已勾 1 月 —— 取消掉,确认应被拒
    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "确认 →" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("月份");
  });

  it("切终止条件到「共出现 N 次」→ onConfirm 收到 n", async () => {
    const { onConfirm, user } = renderSheet();
    await user.click(screen.getByRole("button", { name: "一" }));
    // 切到「共出现 N 次」——radio 文本含"共出现"
    const afterRadio = screen.getByRole("radio", { name: /共出现/ });
    await user.click(afterRadio);
    // 数字 input 用 fireEvent 改 value + 触发 change(避免 userEvent
    // 对 type=number 的逐字符触发把 12 → 120)。
    const nInput = screen.getByLabelText("出现次数") as HTMLInputElement;
    fireEvent.change(nInput, { target: { value: "20" } });
    await user.click(screen.getByRole("button", { name: "确认 →" }));

    const rule = onConfirm.mock.calls[0][0] as StructuredRule;
    expect(rule.ends).toEqual({ kind: "after", n: 20 });
  });

  it("取消按钮调 onCancel", async () => {
    const { onCancel, user } = renderSheet();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
