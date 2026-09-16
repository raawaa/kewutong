/**
 * TrayStatusBanner（ticket #29）的组件级测试。
 *
 * Banner 由 App 启动时拉到的 [`TrayStatusDto`] 驱动：
 * - `available = true` → 不渲染（`null` 进 → 树里也没有 banner 节点）
 * - `available = false` → 渲染一条带 `reason` 的告警 banner
 *
 * 三个验收点：
 * 1. 不可用时 banner 在 DOM 里,文案里要带上 reason。
 * 2. 可用时 banner 完全不在 DOM 里——不留占位容器。
 * 3. 拉数据未完成(`status = null`)时也不渲染——避免短暂闪烁。
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrayStatusBanner } from "./TrayStatusBanner";
import type { TrayStatusDto } from "@/lib/ipc";

function unavailableDto(
  overrides: Partial<TrayStatusDto> = {},
): TrayStatusDto {
  return { available: false, reason: "Linux 上 GTK 初始化失败", ...overrides };
}

describe("TrayStatusBanner · 托盘可达性 banner", () => {
  it("托盘不可用时渲染 banner 并带上 reason", () => {
    render(<TrayStatusBanner status={unavailableDto()} />);

    const banner = screen.getByRole("alert");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent("Linux 上 GTK 初始化失败");
  });

  it("托盘可用时不渲染 banner", () => {
    render(
      <TrayStatusBanner status={{ available: true, reason: "" }} />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("拉数据未完成时不渲染 banner", () => {
    render(<TrayStatusBanner status={null} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reason 为空但不可用时仍渲染 banner —— 不允许 reason 漏给科长", () => {
    render(
      <TrayStatusBanner
        status={{ available: false, reason: "" }}
      />,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});