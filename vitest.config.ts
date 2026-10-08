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
    // Vitest 4+ 移除了 `poolOptions.forks.singleFork`——改用
    // `fileParallelism: false` 让多文件串行跑；better-sqlite3 的
    // `:memory:` 在每个 test 文件里都是独立的 in-memory 连接,无需
    // 同一进程内的 fork 隔离。
    pool: "forks",
    fileParallelism: false,
  },
});