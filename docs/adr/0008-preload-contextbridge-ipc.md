# IPC 形状：preload + contextBridge + ipcMain.handle

**Status**: accepted

承接 spec #37 与 ADR 0005（Electron 壳）/ ADR 0006（Node + better-sqlite3），把现有 Tauri 的 `invoke/emit` IPC 切到 Electron 的 `ipcMain.handle` + `contextBridge` 暴露 typed API。

## 决策

### 渲染进程 ↔ 主进程

- **请求-响应**：渲染进程 `await window.api.<command>(args)` → preload `ipcRenderer.invoke('cmd', args)` → 主进程 `ipcMain.handle('cmd', async (_event, args) => command(state, args))`。
- **事件推送**：主进程 `webContents.send('event-name', payload)` → preload 暴露 `window.api.on<Name>(handler: (payload) => void)` 注册 `ipcRenderer.on('event-name', (_, payload) => handler(payload))`。

### preload（`src/preload/index.ts`）

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`。
- `contextBridge.exposeInMainWorld('api', api)`，暴露的对象是手写的 typed wrapper——与现有 `src/lib/ipc.ts` 的 typed wrapper **同形态**。
- 不暴露 `ipcRenderer` 原对象；预导入的 `electron` 模块在 sandbox 下仅暴露 `contextBridge` / `ipcRenderer` 两个子集。

### 主进程注册（`src/main/ipc/register.ts`）

- 每个 domain 一个 `registerPersonnel(state, ipcMain)` / `registerTask(state, ipcMain)` / ... 的纯函数模块，命令名 'personnel.list_sub_teams' 用点号分（不是下划线）；channel 名与命令名一一对应，便于追踪。
- 错误统一收敛成 `AppError` shape（`{ code, message, detail }`）；非抛 `Throwable` 也用 `error.code === 'UNKNOWN'` 兜底。

### 渲染进程 seam（`src/lib/api.ts`）

- **重命名** `src/lib/ipc.ts` → `src/lib/api.ts`；导出所有 typed wrapper，函数体换成 `return window.api.<command>(args)`；TS 类型完全沿用。
- 事件订阅也走 `src/lib/api.ts`，组件用 `useEffect(() => api.onTrayChange(...), [])`；不再持有 `invoke` 直接调用。
- `toAppError(thrown)` helper 继续生效，shape 与 reducer 一致。
- renderer 0 业务逻辑纪律继续遵守——所有计算、筛选、日期运算仍在主进程命令层；renderer 只调 wrapper、显示 DTO。

### CSP（renderer `<meta>`）

- 替换 `tauri.conf.json security.csp: null` 为真实 CSP：
  ```
  default-src 'self';
  script-src  'self';
  style-src   'self' 'unsafe-inline';   /* Tailwind v4 注入需要 */
  img-src     'self' data:;
  connect-src 'self';
  font-src    'self' data:;
  ```
  注：`'unsafe-inline'` 仅 style；script 不开放。

## 上下文

- 现有 Tauri 2.x IPC：`invoke<T>("name", { args })` + `emit/listen`（事件）。前端 `src/lib/ipc.ts` 是 typed wrapper 的唯一 seam，30+ 命令已在此登记。
- 现有 IPC 行为契约：DTO 是契约、`AppError` 是错误唯一 contract、`state`、`clock` 注入。
- 切换后 renderer 侧 import 由 `@tauri-apps/api/core` 改为 `window.api`——但调用语法 / DTO / 错误 shape 都不变。

## 不做的事

- **不开 `nodeIntegration: true`**：renderer 直接 `require('better-sqlite3')` 是安全漏洞。
- **不开 `contextIsolation: false`**：让 renderer 与 preload 共享全局是安全漏洞。
- **不暴露 `ipcRenderer` 原对象到 renderer**：所有通道都走 preload typed wrapper。
- **不引 `electron-trpc` / `electron-rpc` 等 RPC 框架**：手写 typed wrapper ≈ 60 个函数可控。
- **不引 WebSocket / HTTP server 给 renderer 调**：本项目 renderer 是单进程内调用，无跨进程需求。
- **不写沙箱内 `electron` API 白名单外的能力**：preload 只 `import { contextBridge, ipcRenderer } from 'electron'`。

## 备选方案（已 reject）

- **socket / HTTP / ws** —— 主进程开 localhost server，renderer fetch；多一道端口 / 权限 / CORS 防护，且沙箱内 fetch 同源策略又要自管。不值。
- **`nodeIntegration: true`** —— renderer 能直接 `require` Node 模块，但任意 XSS 都能调任意 IPC；安全模型破坏。
- **`contextIsolation: false`** —— preload 与 renderer 共享全局，破坏 sandbox 调试 / 性能 / 安全。
- **`@electron/remote`** —— 官方已 deprecated（v14 起），不走。
- **`electron-trpc` / `electron-rpc`** —— 装饰器 + zod schema 重复本项目既有 typed wrapper 工作量，IPC 边界本就薄。

## 后果

### `src/lib/api.ts` 形态（示例）

```typescript
// src/lib/api.ts
import type {
  AppError, PingReply, SubTeam, ListPeopleArgs, Person,
  // ... 与 src/lib/ipc.ts 完全相同
} from './api-types';

export const api = {
  ping: (echo?: string): Promise<PingReply> =>
    window.api.ping(echo ?? null),
  listSubTeams: (): Promise<SubTeam[]> =>
    window.api.list_sub_teams(),
  listPeople: (args: ListPeopleArgs): Promise<Person[]> =>
    window.api.list_people(args),
  // ... 与 src/lib/ipc.ts 同形态
};

export function toAppError(thrown: unknown): AppError { /* 沿用现有 */ }
```

注：`src/lib/ipc.ts` 的函数体原本是 `invoke<T>("list_sub_teams")`，新版本是 `window.api.list_sub_teams()`——同样的 wrapper 函数形态，只是调用方式不同。组件代码 0 改动（仍 `import { xxx } from '@/lib/api'`）。

### `src/preload/index.ts` 形态（示例）

```typescript
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  ping: (echo: string | null): Promise<{ message: string; now: string; schemaVersion: number | null; echo: string | null }> =>
    ipcRenderer.invoke('ping', echo),
  list_sub_teams: (): Promise<SubTeam[]> => ipcRenderer.invoke('personnel.list_sub_teams'),
  list_people: (args: ListPeopleArgs): Promise<Person[]> => ipcRenderer.invoke('personnel.list_people', args),
  // ...
};

contextBridge.exposeInMainWorld('api', api);
```

### 主进程注册形态（示例）

```typescript
// src/main/ipc/register.ts
import { ipcMain } from 'electron';
import type { AppState } from '../state';
import { registerPersonnel } from './personnel';
import { registerTask } from './task';
// ...

export function registerAllIpc(state: AppState): void {
  registerPersonnel(state, ipcMain);
  registerTask(state, ipcMain);
  // ...
}
```

### `BrowserWindow` 配置

```typescript
new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
  },
});
```

### 事件总线

- 主进程 `webContents.send('tray.status', { available, reason })` → preload `window.api.onTrayStatus(handler)` → renderer `useEffect(() => api.onTrayStatus(({ available, reason }) => setBanner(...)), [])`。
- `tray.status` 等事件名统一定义在 `src/main/events.ts` 与 `src/preload/events.ts`，避免主 / 副进程字符串漂移。

## ADR 衔接链

- 上游：[ADR 0005](./0005-electron-as-shell.md) Electron 壳
- 上游：[ADR 0006](./0006-node-better-sqlite3.md) Node + better-sqlite3
- 下游：[spec #37](https://github.com/raawaa/kewutong/issues/37) M1（壳 + IPC scaffold + ping + data file location + integrity_check）