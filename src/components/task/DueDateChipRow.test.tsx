/**
 * 截止 chip 行的组件级验证（ticket #19 验收点：「前端组件级测试覆盖 chip 选值」）。
 *
 * 这里只验「渲染与选值」：chip 有哪几格、日期是什么，权威都在命令层，
 * 测试因此直接喂 `DueDateOption[]`，不去算日期。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DueDateChipRow } from "./DueDateChipRow";
import type { DueDateOption } from "@/lib/ipc";

/** 命令层在 2026-09-10 这天会返回的 chip 行。 */
const OPTIONS: DueDateOption[] = [
  { chip: "today", label: "今天", dueDate: "2026-09-10" },
  { chip: "tomorrow", label: "明天", dueDate: "2026-09-11" },
  { chip: "next-week", label: "一周后", dueDate: "2026-09-17" },
  { chip: "none", label: "无", dueDate: null },
];

function setup(value: string | null = null) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<DueDateChipRow options={OPTIONS} value={value} onChange={onChange} />);
  return { onChange, user };
}

describe("DueDateChipRow", () => {
  it("把命令层给的四格原样渲染出来", () => {
    setup();

    const labels = screen
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels).toEqual(["今天", "明天", "一周后", "无"]);
  });

  it("点 chip 上报的是命令层算好的日期", async () => {
    const { onChange, user } = setup();

    await user.click(screen.getByRole("button", { name: "明天" }));

    expect(onChange).toHaveBeenCalledWith("2026-09-11");
  });

  it("点「无」上报清空截止日", async () => {
    const { onChange, user } = setup("2026-09-10");

    await user.click(screen.getByRole("button", { name: "无" }));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("当前值对应的那格是选中态，其余都不是", () => {
    setup("2026-09-17");

    expect(screen.getByRole("button", { name: "一周后" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const label of ["今天", "明天", "无"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
  });

  it("value=null（默认）：「无」chip 是选中态", () => {
    setup(null);

    expect(screen.getByRole("button", { name: "无" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("value=null 且 noneHighlighted=false：四格都不高亮（新建弹窗留空默认）", () => {
    const onChange = vi.fn();
    render(
      <DueDateChipRow
        options={OPTIONS}
        value={null}
        onChange={onChange}
        noneHighlighted={false}
      />,
    );

    for (const label of ["今天", "明天", "一周后", "无"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
  });

  it("chip 覆盖不到的日期：四格都不选中，日历里显示该日期", () => {
    setup("2026-10-01");

    for (const label of ["今天", "明天", "一周后", "无"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
    expect(screen.getByLabelText("精确选日")).toHaveValue("2026-10-01");
  });

  it("日历精确选日上报所选日期", async () => {
    const { onChange, user } = setup(null);

    const calendar = screen.getByLabelText("精确选日");
    await user.type(calendar, "2026-10-01");

    expect(onChange).toHaveBeenLastCalledWith("2026-10-01");
  });

  it("清空日历等同于「无截止」", async () => {
    const { onChange, user } = setup("2026-09-10");

    await user.clear(screen.getByLabelText("精确选日"));

    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
