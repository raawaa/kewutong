/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * 两套 test:
 * - `main`: 主进程 + 视图纯逻辑——`environment: "node"`,跑 `.test.ts`
 *   (`*.tsx` 自动忽略)。
 * - `renderer`: 渲染进程组件级——`environment: "jsdom"`,跑
 *   `.test.tsx`。本套是 #22 之后补的;ticket #62 把 `.test.tsx` 拉进
 *   `npm test` 的同一节奏。
 *
 * Vitest 4+ 移除了 `poolOptions.forks.singleFork`——改用
 * `fileParallelism: false` 让多文件串行跑；better-sqlite3 的 `:memory:`
 * 在每个 test 文件里都是独立的 in-memory 连接,无需同一进程内的 fork
 * 隔离。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "main",
          environment: "node",
          include: ["src/**/*.test.ts", "src/main/**/*.test.ts"],
          exclude: ["src/**/*.test.tsx", "node_modules/**"],
          pool: "forks",
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          exclude: ["node_modules/**"],
          setupFiles: ["./src/test/setup.ts"],
          globals: true,
        },
      },
    ],
  },
});