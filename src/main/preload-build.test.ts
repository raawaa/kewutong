/**
 * Regression test for the sandbox-preload loader contract (ticket #76,
 * 接续 #75)。
 *
 * 背景：项目根 `package.json` 是 `"type": "module"`，electron-vite@5
 * 据此默认 `format: 'es'` + `entryFileNames: '[name].mjs'`(见
 * `node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:390` 与
 * `:441`)。但 Electron 沙箱 preload loader(对应 `sandbox: true` 安全
 * 模型，ADR 0008)按 plain JavaScript / CommonJS 跑——任何顶层
 * `import` 都抛 `SyntaxError: Cannot use import statement outside a
 * module`。官方明说 preload 忽略 `package.json#type`,所以 #75 那个
 * "在产物目录写 package.json#type=module"的方向是错的；正确做法是
 * `electron.vite.config.ts` 里强制 `format: 'cjs'` + `[name].js`。
 *
 * 这个文件断言：
 *   1. 构建产物是 `out/preload/index.js`(CJS,不是 `.mjs`)。
 *   2. `out/preload/` 里**不**写 `package.json`——它对 preload 无效,
 *      留着只会误导。
 *   3. 编译后的内容确实是 CJS:无顶层 `import` / `export`,有
 *      `require(`。这是廉价的"防回归"检查——如果有人把
 *      `format: 'cjs'` 删了 / 改回 `format: 'es'`,构建会重新 emit
 *      `.mjs` 顶层 `import`,这条断言立即失败。不需要真启 Electron。
 *   4. `src/main/index.ts` 的 `resolvePreload` dev / prod 两条分支
 *      basename 一致,且产物文件存在——保证运行时找得到。
 *
 * `beforeAll` 跑一次 `electron-vite build`——约 3 秒,作为整个测试套
 * 的一部分成本可接受。CI 流水线本身也会跑 `npm run build`,这里只是把
 * "build 产物必须满足这条契约"提前到 vitest 失败时立刻可见。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const PRELOAD_DIR = path.resolve(import.meta.dirname, "../../out/preload");
const INDEX_JS = path.join(PRELOAD_DIR, "index.js");
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

describe("preload build output (ticket #76)", () => {
  it("emits index.js (CJS) as the preload entry, not index.mjs", () => {
    expect(existsSync(INDEX_JS)).toBe(true);
    expect(existsSync(INDEX_MJS)).toBe(false);
  });

  it("does NOT emit a package.json into out/preload/ — preload scripts ignore type:module per official Electron docs, so the #75 hint is a no-op", () => {
    expect(existsSync(PACKAGE_JSON)).toBe(false);
  });

  it("compiled preload is CommonJS (no top-level import/export; contains require()) — guards against re-introducing format: 'es' in electron.vite.config.ts", () => {
    const content = readFileSync(INDEX_JS, "utf-8");
    expect(content).not.toMatch(/^\s*import\s/m);
    expect(content).not.toMatch(/^\s*export\s/m);
    expect(content).toMatch(/require\(/);
  });

  it("src/main/index.ts resolvePreload agrees on the preload filename in dev and prod, and that filename exists in out/preload/", () => {
    // 把运行时可达性也挡住：单看构建产物不能保证运行时找得到文件。
    // 如果有人把 prod 分支改回 `.mjs`(而 electron-vite 还在出 `.js`),
    // 前三个测试仍会全绿,但 prod preload 在 runtime 会「file not found」。
    // 这个测试通过扫 `resolvePreload` 函数体,断言 dev / prod 两条分支
    // 解析到的 basename 一致,以及那个文件确实在 `out/preload/` 里。
    const src = readFileSync(
      path.resolve(import.meta.dirname, "./index.ts"),
      "utf-8",
    );
    const fnMatch = src.match(
      /function\s+resolvePreload\s*\([^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/,
    );
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![1] ?? "";

    const fileNameRegex = /path\.join\([^,]+,\s*["']([^"']+)["']\s*\)/g;
    const fileNames = new Set<string>();
    for (const match of body.matchAll(fileNameRegex)) {
      const inner = match[1] ?? "";
      if (inner.length > 0) fileNames.add(path.basename(inner));
    }

    expect(fileNames.size).toBe(1);
    const [chosen] = [...fileNames];
    expect(chosen).toBeDefined();
    expect(existsSync(path.join(PRELOAD_DIR, chosen ?? ""))).toBe(true);
  });
});
