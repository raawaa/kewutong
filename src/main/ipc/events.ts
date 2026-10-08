/**
 * Main → renderer IPC 事件总线（ticket #55）。
 *
 * 设计要点（对应 ADR 0008 §事件总线 + ticket 验收点）：
 *
 * 1. **统一通道名常量**：所有 main → renderer 的事件名集中在这里定义,
 *    避免与 preload 字符串漂移。`tray.status` 当前在
 *    `src/main/tray/dto.ts` 里也有一份 `TRAY_STATUS_CHANNEL`——本期不
 *    强迁（ticket 边界外),但 `IPC_CHANNELS.TRAY_STATUS_CHANGED` 是未
 *    来中央化的目标值,与 tray 模块常量同字符串,人为保持一致。
 *
 * 2. **sendEvent 包装**：所有 `webContents.send` 调用都走这一层——它
 *    内置「窗口已销毁 → 静默跳过」,集中处理 close→quit 边界竞态。业
 *    务方不再各自写 `if (window.isDestroyed()) return;`。
 *
 * 3. **payload 类型泛型**：通道名 + payload 类型由调用方声明,TS 在编
 *    译期就能确认「payload 形状与通道对得上」。新事件只要在这里加一
 *    行常量 + 在 preload 加对应 wrapper,不需要改任何基础设施代码。
 *
 * 纯函数 / 常量剥到这里是为了让 `events.test.ts`(未来)能在不加载
 * Electron 二进制的情况下断言 channel 字符串契约——与 tray 的
 * `dto.ts` 同形。
 */

import type { BrowserWindow } from "electron";

/**
 * Main → renderer 事件通道常量——集中定义,避免与 preload 字符串漂移。
 *
 * 命名约定: `domain.event-name`,与 IPC 命令通道(`domain.command_name`)
 * 同前缀规则,便于跨通道分类与追踪。
 */
export const IPC_CHANNELS = {
  /** 托盘可达性变化(ticket #29/#54)。 */
  TRAY_STATUS_CHANGED: "tray.status",
  /** ⌘K / Ctrl+K 全局命令面板触发(ticket #55)。 */
  SHORTCUT_COMMAND_PALETTE: "shortcut.command-palette",
  // 后续 ticket 在这里追加:
  // - notification.received (#51 增强)
  // - window.focus-changed (#58 残留)
} as const;

/** 通道名 → payload 形状的映射——给 sendEvent 提供编译期类型约束。 */
export interface IpcChannelPayloads {
  [IPC_CHANNELS.TRAY_STATUS_CHANGED]: import("../types.js").TrayStatusDto;
  [IPC_CHANNELS.SHORTCUT_COMMAND_PALETTE]: { shortcut: string };
}

/**
 * 把 payload 推到指定窗口的 renderer。
 *
 * - 窗口 `null`(还没装好) → 静默跳过;
 * - 窗口已销毁 → 静默跳过(close→quit 边界竞态);
 * - renderer 未加载完时 `webContents.send` 会丢消息,目前不重试——
 *   下一轮 IPC 命令会拿到最新值兜底(参见 tray 模块同形注释)。
 */
export function sendEvent<K extends keyof IpcChannelPayloads>(
  window: BrowserWindow | null,
  channel: K,
  payload: IpcChannelPayloads[K],
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}
