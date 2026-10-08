/**
 * Tray 模块测试（ticket #54）。
 *
 * `createTray` 本身强依赖 Electron 原生 API（`Tray` / `Menu` /
 * `nativeImage` / `BrowserWindow.webContents`），不 mock 整个 Electron
 * 起不来——这部分靠 `npm run typecheck` + dev 启动人工冒烟覆盖。
 *
 * 这里只测「主进程 IPC 命令 `trayStatus` 与 renderer banner 共用的
 * DTO 转换」`trayStatusToDto`——它就是契约,错了会让 banner 误显
 * 误隐,属于该有测试的过程。
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_TRAY_STATUS, type TrayStatus } from "../state.js";
import { TRAY_STATUS_CHANNEL, trayStatusToDto } from "./dto.js";

describe("tray #54", () => {
  describe("trayStatusToDto", () => {
    it("available → available: true, reason 为空", () => {
      const status: TrayStatus = { kind: "available" };
      expect(trayStatusToDto(status)).toEqual({ available: true, reason: "" });
    });

    it("unavailable → available: false, reason 原样透传", () => {
      const reason = "系统托盘不可用，请检查系统设置。";
      const status: TrayStatus = { kind: "unavailable", reason };
      expect(trayStatusToDto(status)).toEqual({ available: false, reason });
    });

    it("DEFAULT_TRAY_STATUS 默认 unavailable", () => {
      // state 启动时 trayStatus = DEFAULT_TRAY_STATUS = { kind: 'unavailable',
      //  reason: '托盘尚未初始化' }。这条测试守住「启动时 banner 一定显」
      // 的隐含契约——一旦有人把 default 改成 available，banner 在
      // 托盘 init 完成前会隐藏，但那时候 IPC `trayStatus` 还没返
      // 回过，renderer 会短暂空过；保持 unavailable 让 banner 一直显
      // 示直到第一条 `tray.status` 事件 / 命令回包。
      expect(DEFAULT_TRAY_STATUS.kind).toBe("unavailable");
      const dto = trayStatusToDto(DEFAULT_TRAY_STATUS);
      expect(dto.available).toBe(false);
      expect(dto.reason.length).toBeGreaterThan(0);
    });
  });

  describe("IPC channel 常量", () => {
    it("TRAY_STATUS_CHANNEL 与 preload 对齐", () => {
      // 改了这里必须同步改 src/preload/index.ts 的
      // `ipcRenderer.on('tray.status', ...)` 字符串。typecheck 阶段
      // 不会抓这个漂移，所以这里写死断言。
      expect(TRAY_STATUS_CHANNEL).toBe("tray.status");
    });
  });
});