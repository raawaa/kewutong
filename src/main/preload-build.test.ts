/**
 * Regression test for the sandbox-preload loader contract (ticket #75).
 *
 * 背景：`src/main/index.ts` 里 `BrowserWindow.webPreferences.preload` 在
 * dev / prod 两个分支都解析到 `out/preload/index.mjs`（electron-vite@5
 * 对 `format: "es"` 的 preload 强制写 `.mjs`,无法在
 * `rollupOptions.output.entryFileNames` 覆盖）。Chromium 在
 * `sandbox: true` 下加载 preload 时需要 ESM 提示——`.mjs` 扩展名或相邻
 * 的 `package.json` `{"type":"module"}` 二选一。本项目选后者（双保险）,
 * 所以这个测试断言：
 *
 *   1. 构建产物里 `out/preload/index.mjs` 存在（防止 entry 漂走或被无
 *      意删除）。
 *   2. `out/preload/package.json` 存在且 `{"type":"module"}`（防止
 *      rollup 插件被无意删除——这条 hint 才是把 Chromium 的 script loader
 *      切到 ESM 的实际开关）。
 *
 * `beforeAll` 跑一次 `electron-vite build`——约 3 秒，作为整个测试套
 * 的一部分成本可接受。CI 流水线本身也会跑 `npm run build`,这里只是把
 * 「build 产物必须满足这条契约」提前到 vitest 失败时立刻可见。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const PRELOAD_DIR = path.resolve(import.meta.dirname, "../../out/preload");
const INDEX_MJS = path.join(PRELOAD_DIR, "index.mjs");
const PACKAGE_JSON = path.join(PRELOAD_DIR, "package.json");

beforeAll(() => {
  // 用 `build:app` 而非 `build`——后者包含 typecheck + electron-builder,
  // 对单测来说太重且会签 dmg。typecheck / 打包分别由各自脚本兜底。
  execFileSync("npm", ["run", "build:app"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    stdio: "pipe",
  });
}, 60_000);

describe("preload build output (ticket #75)", () => {
  it("emits index.mjs as the preload entry", () => {
    expect(existsSync(INDEX_MJS)).toBe(true);
  });

  it("writes an adjacent package.json with type=module so Chromium's sandboxed-preload loader treats the .mjs as ESM", () => {
    expect(existsSync(PACKAGE_JSON)).toBe(true);
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8")) as {
      type?: string;
    };
    expect(pkg.type).toBe("module");
  });
});
