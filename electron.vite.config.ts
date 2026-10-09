import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * electron-vite 三段构建配置(ADR 0005 / 0008)。
 *
 * - main: Node 主进程,含 native 模块依赖,必须 externalize。
 * - preload: 沙箱内 preload,仅 import electron 暴露的
 *   contextBridge/ipcRenderer。
 * - renderer: 既有 Vite + React + Tailwind v4 配置原样平迁。
 *
 * ── preload 格式必须是 CJS,不能是 ESM ──
 *
 * 项目根 `package.json` 是 `"type": "module"`,electron-vite@5 的 preload
 * preset 据此默认 `format: 'es'` + `entryFileNames: '[name].mjs'`(见
 * `node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:390` 与
 * `:441`)。但 Electron 沙箱 preload loader(对应 `sandbox: true` 安全
 * 模型,ADR 0008)在加载 preload 时按 plain JavaScript / CommonJS 处理——
 * 任何 `import` 语句都会抛 `SyntaxError: Cannot use import statement
 * outside a module`。官方 ESM 教程明说:
 *
 *   > "Sandboxed preload scripts are run as plain JavaScript without
 *   >  an ESM context. Loading the `electron` API is still done via
 *   >  `require('electron')`."
 *   >  —— https://www.electronjs.org/docs/latest/tutorial/esm
 *
 *   > "Preload scripts will ignore `type: 'module'` fields"
 *   >  —— https://github.com/electron/electron/blob/main/docs/tutorial/esm.md
 *
 * 所以 #75 那个"在产物目录写 package.json#type=module"的修法方向就
 * 错了——官方明说 preload 忽略 `package.json#type`,无论是不是 module。
 * 唯一正确的修法是**改 build 格式**:让 rollup 把源里的 `import` 编译成
 * `require`,产物 emit 为 `.js`。这里显式 `format: 'cjs'` + `[name].js`,
 * 覆盖 electron-vite 的默认 ESM 推断。
 *
 * 主进程(main)不受此影响——主进程是 Node 侧,不是 sandboxed preload。
 */
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
    plugins: [externalizeDepsPlugin()],
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
        output: {
          // 强制 CJS(参考顶部注释)。
          // 源里 `import { ... } from "electron"` 会被 rollup 编译成
          // `const { ... } = require("electron")`——`externalizeDepsPlugin`
          // 把 `electron` 留在外部,所以运行时仍走 `require("electron")`。
          format: "cjs",
          entryFileNames: "[name].js",
          chunkFileNames: "[name]-[hash].js",
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