import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * electron-vite 三段构建配置（ADR 0005 / 0008）。
 *
 * - main: Node 主进程，含 better-sqlite3 native 模块，必须 externalize。
 * - preload: 沙箱内 preload，仅 import electron 暴露的 contextBridge/ipcRenderer。
 * - renderer: 既有 Vite + React + Tailwind v4 配置原样平迁。
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
          index: path.resolve(import.meta.dirname, "index.html"),
        },
      },
    },
  },
});