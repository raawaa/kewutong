/**
 * 托盘相关纯函数 / 常量（ticket #54）。
 *
 * 与 `./index.ts` 分离的原因：`index.ts` 顶部 `import "electron"` 会把
 * `electron` 二进制加载进来（vitest 不跑 Electron 时直接报「Electron
 * failed to install」）。把无副作用的 DTO 转换与 channel 常量剥到本
 * 文件，让 `tray.test.ts` 不用起 Electron 也能断言 IPC 契约。
 */

import type { TrayStatus } from "../state.js";
import type { TrayStatusDto } from "../types.js";

/**
 * `tray.status` IPC 通道——主进程 `webContents.send` / preload
 * `ipcRenderer.on` 共用同一字符串。本期仅一处使用，集中常量避免
 * 与 preload 字符串漂移；后续 #55 拆出 `src/main/events.ts`。
 */
export const TRAY_STATUS_CHANNEL = "tray.status";

/**
 * `TrayStatus` → `TrayStatusDto` 的纯转换。renderer banner 只看 DTO
 * 形态,IPC 命令 `trayStatus` 也从这里组装——保证两层一致性。
 */
export function trayStatusToDto(status: TrayStatus): TrayStatusDto {
  return status.kind === "available"
    ? { available: true, reason: "" }
    : { available: false, reason: status.reason };
}