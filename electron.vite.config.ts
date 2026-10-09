import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { NormalizedOutputOptions } from "rollup";

/**
 * electron-vite 三段构建配置（ADR 0005 / 0008）。
 *
 * - main: Node 主进程，含 native 模块依赖，必须 externalize。
 * - preload: 沙箱内 preload，仅 import electron 暴露的 contextBridge/ipcRenderer。
 * - renderer: 既有 Vite + React + Tailwind v4 配置原样平迁。
 *
 * ticket #75 修复：electron-vite@5 对 `format: "es"` 的 preload 输出
 * 会强制写 `[name].mjs`(见 `node_modules/electron-vite/dist/chunks/lib-
 * q6ns0vZr.js` 的 preset 插件)，无法在 `rollupOptions.output.entryFile
 * Names` 覆盖。所以 prod / dev 两边都用 `.mjs`,在产物目录旁写一个
 * `package.json` `{"type":"module"}`——Chromium 在 `sandbox: true`
 * 下加载 preload 时按相邻 package.json 的 `type` 决定 ESM / script,
 * 缺这个 hint 时 V8 解析 `import` 直接抛 `SyntaxError`。
 */
const writePreloadPackageJson = {
  name: "write-preload-package-json",
  writeBundle(options: NormalizedOutputOptions): void {
    if (!options.dir) return;
    writeFileSync(
      path.join(options.dir, "package.json"),
      JSON.stringify({ type: "module" }, null, 2),
    );
  },
};
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(import.meta.dirname, "src/main/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(), writePreloadPackageJson],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(import.meta.dirname, "src/preload/index.ts"),
        },
      },
    },
  },
  renderer: {
    root: path.resolve(import.meta.dirname, "src"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(import.meta.dirname, "src/index.html"),
        },
      },
    },
  },
});