/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  // 下面几项是 Tauri 开发时的固定要求
  //
  // 1. 不要让 Vite 清屏盖掉 Rust 端的报错
  clearScreen: false,
  // 2. Tauri 认死 1420 端口，被占用就直接失败
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. src-tauri 交给 cargo 监听，Vite 不管
      ignored: ["**/src-tauri/**"],
    },
  },

  // 前端只做少量组件级验证（spec #15 §前端与 E2E）：chip 行的选值、
  // `@` autocomplete 的候选渲染。业务逻辑的测试缝在 Rust 命令层，不在这里。
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
