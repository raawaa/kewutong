/**
 * Vitest 配置。
 *
 * - 默认环境 `node`（与命令层测试一致，better-sqlite3 native 模块需要）。
 * - view 层 `.test.tsx` 文件首行加 `// @vitest-environment jsdom` 注
 *   解切换到 jsdom——React + DOM 测试需要 window / document / userEvent。
 *   vitest 5 移除了 `environmentMatchGlobs` 的 TS 类型,改用文件级 pragma。
 *
 * `pool: "forks"` + `fileParallelism: false` 是 ticket #37 的遗产——
 *   better-sqlite3 v13 的 `:memory:` 连接在多进程并行下偶尔撞见同一
 *   地址，串行跑更稳。本期 view 层测试不需要这条，但保留不动避免回归。
 */
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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/main/**/*.test.ts"],
    exclude: ["node_modules/**"],
    // Vitest 4+ 移除了 `poolOptions.forks.singleFork`——改用
    // `fileParallelism: false` 让多文件串行跑；better-sqlite3 的
    // `:memory:` 在每个 test 文件里都是独立的 in-memory 连接,无需
    // 同一进程内的 fork 隔离。
    pool: "forks",
    fileParallelism: false,
    setupFiles: ["src/test/setup.ts"],
  },
});