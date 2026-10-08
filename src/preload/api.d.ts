/**
 * Window 上 `api` 对象的类型声明（与 `src/preload/index.ts` 一一对应）。
 *
 * 渲染进程 `import { api } from '@/lib/api'` 时 `window.api` 由这份
 * declaration 提供类型；不要在 renderer 业务代码里手写 `declare global`。
 */

import type { KewutongApi } from "./index";

declare global {
  interface Window {
    api: KewutongApi;
  }
}

export {};