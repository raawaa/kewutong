# 分发流水线：electron-builder + 4-runner 矩阵沿用

**Status**: accepted

承接 spec #37 与 ADR 0005（Electron 壳），把 ADR 0004 的 4-runner 矩阵从 `tauri-apps/tauri-action@v1` 切到 `electron-builder`，产物格式与三平台签名策略保留。

## 决策

### 1. CI 平台：GitHub Actions 4-runner 矩阵（沿用 ADR 0004 §1）

| Runner            | 产物                       | 备注                          |
| ---------------- | -------------------------- | ----------------------------- |
| `ubuntu-22.04`   | `.deb` + `.AppImage`       | LTS 基线；glibc 与科长旧机对齐 |
| `windows-latest` | `.msi`（NSIS 备选）        |                              |
| `macos-latest`   | `.dmg`（aarch64）          | Apple Silicon                 |
| `macos-15-intel` | `.dmg`（x86_64）           | 官方 Intel runner，2027-08 前可用 |

矩阵构建由 `electron-builder` 驱动，`build` 步骤调 `npx electron-builder --linux deb AppImage` / `--win nsis` / `--mac dmg --x64 --arm64`。

### 2. 触发与发布：`push.tags` → draft release → 人工 publish（沿用 ADR 0004 §2）

- 触发：推送 `app-v<semver>` 形 tag。
- 4 个 job 跑完产出 1 个 draft GitHub Release，附 4 个产物。
- 不在 CI 里自动 publish：v1 没有自动发布的安全门槛，dmg / msi 未签名。

### 3. 产物格式：仅 4 种（沿用 ADR 0004 §3）

```
.deb       — Debian/Ubuntu（apt 装）
.AppImage  — 其它发行版（单文件运行）
.msi       — Windows（NSIS 备选；electron-builder 默认 msi 用 WiX 3.x）
.dmg       — macOS（intel + apple silicon 两份）
```

`electron-builder.yml` 显式写 `mac.target: dmg`、`win.target: nsis`、`linux.target: [deb, AppImage]`——避免后续加新 target 时悄悄出意外产物。

### 4. macOS：ad-hoc 签名，不公证（沿用 ADR 0004 §4）

```yaml
# electron-builder.yml
mac:
  identity: "-"           # ad-hoc
  notarize: false         # v1 不公证
  target: dmg
  artifactName: ${productName}-${version}-${arch}.${ext}
```

- 走 ad-hoc 的原因：免 Apple ID、零成本。
- ad-hoc **仍需**用户首次启动手工放行（Gatekeeper）。详见 `docs/distribution.md` 三种放行方法。

### 5. Windows：NSIS + 沿用 ad-hoc（沿用 ADR 0004 §5）

```yaml
# electron-builder.yml
win:
  target: nsis           # electron-builder 默认；不打包给 .msi（NSIS 体验在 v1 等价）
  sign: null             # v1 不签 Authenticode
```

注：Tauri 端是 `.msi`（WiX 3.x），本项目 Electron-builder 默认 NSIS——单文件安装器，对科长用户的移动 / 双机安装等价；v1 切到 NSIS 决策记录在 ADR 0004 备选段。

### 6. 全程 electron-builder，无第三方打包器

- `npx electron-builder` 原生产出全部格式（沿用 ADR 0004 §6 精神）。
- 不引 `nfpm` / 手写脚本。
- `extraResources` 把 `holidays/cn-<year>.json` 拷到 app Resources，与 `tauri.conf.json bundle.resources: ["../holidays/*"]` 等价。

### 7. 第二阶段：Gitee Release 镜像，**不实现**（沿用 ADR 0004 §7）

- Gitee Go 公共构建机对 Windows / macOS runner 不开放；方案草稿保留在 `docs/distribution.md` 末尾。

## 上下文

- ADR 0004 把 Tauri 端的 4-runner 矩阵 + 签名策略写死。
- 切到 Electron 后，4-runner 矩阵与产物格式不变；打包工具从 `cargo tauri build` 切到 `npx electron-builder`。
- native 模块（better-sqlite3）需要 prebuilt 或 rebuild：electron-builder 的 `npmRebuild: true`（默认）在 build 时跑 `electron-rebuild` 对应 ABI，无需手动。

## 不做的事

- **不在 release workflow 里跑 `npm test` / `npm run typecheck`**：tag 触发是出货，不是重新测。这些门已在 push-to-master / PR 阶段跑过。
- **不做自动 changelog 生成**（沿用 ADR 0004）：issue tracker 已有规范工单模式。
- **不做 `electron-updater`**：v1 更新靠「下载新版手动装」。
- **不做 Gitee Release 镜像**：Gitee Go 公共构建机对 Windows / macOS runner 不开放。

## 备选方案（已 reject）

- **electron-forge** —— 官方支持，但 maker-deb / maker-snap 等插件更碎，要拼多个 maker。4-runner 矩阵平移阻力大于 electron-builder。
- **vite-plugin-electron** —— 自维护 packager；4 个 native target 都要自写。本项目不走。
- **手写脚本 + electron-packager** —— 跨平台打包脚本全自维护；不如 electron-builder 一站式。

## 后果

### `electron-builder.yml`

```yaml
appId: com.raawaa.kewutong
productName: kewutong
directories:
  output: release/${version}
  buildResources: resources
files:
  - dist/**/*
  - package.json
  - "!**/*.map"
asarUnpack:
  - "**/node_modules/better-sqlite3/**/*"
extraResources:
  - from: "../holidays/*"
    to: "holidays"
mac:
  identity: "-"
  notarize: false
  target:
    - target: dmg
      arch:
        - arm64
        - x64
  artifactName: ${productName}-${version}-${arch}.${ext}
  category: public.app-category.productivity
win:
  target:
    - target: nsis
      arch:
        - x64
  artifactName: ${productName}-${version}-${arch}.${ext}
linux:
  target:
    - target: deb
      arch:
        - amd64
    - target: AppImage
      arch:
        - amd64
  artifactName: ${productName}-${version}-${arch}.${ext}
  desktop:
      entry: 'Name=kewutong\n Comment=程序;Exec=/opt/kewutong/kewutong\n Icon=kewutong\n Type=Application\n Terminal=false\n Categories=Office;\n'
npmRebuild: true
```

### GitHub Actions（`.github/workflows/release.yml` 沿用 ADR 4 风格）

```
on push:
  tags: ['app-v*']

jobs:
  release:
    strategy:
      matrix:
        runner: [ubuntu-22.04, windows-latest, macos-latest, macos-15-intel]
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build
      - run: npx electron-builder --publish never
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
      - uses: softprops/action-gh-release@v2
        with:
          files: release/${{...}}
          draft: true
```

注：macOS 双 arch（arm64 + x64）在同一 runner 跑 2 次 build（与 ADR 4 §4 一致）。

### native 模块重建

- `electron-builder` 默认 `npmRebuild: true`：build 阶段调 `electron-rebuild` 重编 `better-sqlite3` 等原生模块为 Electron 内嵌 Node ABI。
- 4-runner 各自 rebuild；不依赖 prebuilt（如有 Linux + Mac + Windows 三平台 prebuilt，可关掉 `npmRebuild`，但 v1 不优化这条）。

## ADR 衔接链

- 上游：[ADR 0005](./0005-electron-as-shell.md) Electron 壳
- 上游：[ADR 0004](./0004-distribution-pipeline.md) Tauri 端 4-runner 矩阵（沿用）
- 下游：[spec #37](https://github.com/raawaa/kewutong/issues/37) M4（切发布 + 撤 Tauri）