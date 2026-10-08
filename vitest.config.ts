/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/main/**/*.test.ts"],
    exclude: ["src/**/*.test.tsx", "node_modules/**"],
    pool: "forks",
    poolOptions: {
      forks: {
        // 串行跑单测——better-sqlite3 native 模块 + in-memory 各测试隔离，
        // 并行会撞 :memory: 不共享的预期。
        singleFork: true,
      },
    },
  },
});