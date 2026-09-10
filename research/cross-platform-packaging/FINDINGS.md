# 跨平台打包与分发工具链

**调查范围**: Tauri 2.x 在 Linux/Windows/macOS 上的打包工具链与 CI 方案
**调查日期**: 2026-09-10
**目标项目**: 科室任务管理桌面 app（.deb / .msi / .dmg 三个目标产物，v1 不签名 / 不公证）

---

## 0. TL;DR（执行摘要）

- **打包工具链**：Tauri 2.x（`cargo tauri build`）原生支持 `.deb` / `.AppImage` / `.rpm` / `.msi` / `.exe`（NSIS）/ `.app` / `.dmg`，**不需要额外的第三方打包器**，只要目标机器装好系统依赖。
- **推荐 CI 平台**：**GitHub Actions**。理由见 §4。Gitee Go 的公共构建机目前以 Linux 为主，无法一次性跑完整三平台矩阵。
- **不签名 / 不公证路径在 Tauri 2.x 下完全顺畅**：Linux 完全不需要签名；Windows 不签名也能产出 `.msi` / `.exe`（运行时会显示「未知发布者」，用户可以点「仍要运行」）；macOS 走 ad-hoc 签名（`signingIdentity: "-"`）可避免「损坏」误报，但仍需用户在「系统设置 → 隐私与安全性」里手动放行。
- **关键坑**：GNOME 默认不显示系统托盘图标（需要 `libayatana-appindicator3-1` + GNOME AppIndicator 扩展）；Windows 7 上 MSI 必须 `embedBootstrapper` 否则 TLS 1.2 会下载失败；macOS DMG 图标位置 / 大小在 CI 上无效。

---

## 1. 平台打包工具链

### 1.1 Linux

**推荐**：`.deb`（主要分发物）+ `AppImage`（备选）。`.rpm` 不建议在 v1 投入精力（科室主力机大概率 Debian / Ubuntu，且 RPM 对 glibc 版本要求严格）。

`cargo tauri build` 原生支持，在 Linux 上直接产出三种格式，无需额外打包器。配置键在 `tauri.conf.json > bundle > linux`：

```json
{
  "bundle": {
    "targets": ["deb", "appimage"],
    "linux": {
      "deb": { "files": { "/usr/share/README.md": "../README.md" }, "depends": [] },
      "appimage": { "files": { "/usr/share/README.md": "../README.md" } }
    }
  }
}
```

**构建依赖（CI runner / 开发机必装）**：

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

（Tauri 2 官方现在主推 `libayatana-appindicator3-dev`，比老的 `libappindicator3-dev` 在新版 GNOME 上兼容更好。）

**运行时依赖**：生成的 `.deb` 会自动声明 `libwebkit2gtk-4.1-0`、`libgtk-3-0`，用了 tray 时还会自动加 `libappindicator3-1`。

**已知坑**：

1. **GNOME 不显示托盘图标**：GNOME 3.26+ 移除了核心托盘支持。用户需装 GNOME AppIndicator 扩展；KDE / XFCE / Cinnamon 默认就好。
2. **glibc 版本基线**：RPM / AppImage 在新 glibc 上构建会在老系统上跑不起来。建议 CI 用 `ubuntu-22.04` / `debian-12`（官方推荐）。
3. **AppImage 体积**：70+ MB（自带 webkit / gtk 运行时）；Linux 上不签名无副作用，且运行时**不验证签名**（Tauri 官方明说）。

### 1.2 Windows

**推荐**：`.msi`（主分发）+ 可选 `.exe`（NSIS，`installMode: currentUser` 免管理员）。

- **WiX 3.x** → `.msi`（Windows-only 构建，需 VBSCRIPT）
- **NSIS 3.x** → `-setup.exe`（跨平台友好）

GitHub Actions 的 `windows-latest` / `windows-2022` 都**预装** WiX 和 NSIS，无需手动装。

**系统托盘**：`TrayIconBuilder` 在 Windows 下原生工作，**不依赖额外运行时**（不像 Linux 需要 libappindicator）。

**WebView2 处理**（由 `bundle.windows.webviewInstallMode` 控制）：

| 模式 | 联网 | 体积 | 备注 |
|------|------|------|------|
| `downloadBootstrapper`（默认） | 首次联网 | 0 MB | |
| `embedBootstrapper`（**推荐**） | 首次联网 | ~1.8 MB | Win7 兼容 |
| `offlineInstaller` | 不需要 | ~127 MB | |
| `fixedRuntime` | 不需要 | ~180 MB | |
| `skip` | — | 0 MB | **不推荐** |

**已知坑**：VBSCRIPT 必需（否则 `light.exe` 失败，CI runner 已自动启用）；不签名时 Windows SmartScreen 显示「未知发布者」，用户点「仍要运行」即可。

### 1.3 macOS

**推荐**：`.dmg`（决策已定）。`cargo tauri build` 默认产 `.app` + `.dmg`。

**tray 行为**：macOS 上表现为屏幕右上角的菜单栏图标，不是 Windows 的「系统托盘」。左键默认弹出菜单，可用 `menuOnLeftClick: false` 关掉。

**不签名 / 不公证（v1 决策）**：Tauri 2.x 下完全顺畅，但需要：

1. **ad-hoc 签名**（否则 Apple Silicon 直接报「已损坏」）：

   ```json
   { "bundle": { "macOS": { "signingIdentity": "-" } } }
   ```
2. **首次启动用户必须手动放行**：右键 → 打开，或系统设置 → 隐私与安全性 → 仍要打开，或 `xattr -dr com.apple.quarantine`。

Gatekeeper 警告**不需要 Apple ID**，免费账号就能 ad-hoc。但每次新 build 都得重新放行一次。

**已知坑**：DMG 图标位置 / 大小在 CI 上**不生效**，本地能控制；macOS GUI 不读 `.zshrc` PATH，需要 `fix-path-env-rs`；macOS runner 配额紧，矩阵打 tag 时再跑。

---

## 2. CI 方案对比

### 2.1 GitHub Actions

**Runner 矩阵**：

| Runner | Tauri target | 用途 |
|--------|--------------|------|
| `ubuntu-22.04` / `ubuntu-24.04` | `x86_64-unknown-linux-gnu` | `.deb` + `.AppImage` |
| `windows-latest` / `windows-2022` | `x86_64-pc-windows-msvc` | `.msi` |
| `macos-latest` / `macos-14` / `macos-15` | `aarch64-apple-darwin` | `.dmg`（ARM） |
| `macos-15-intel` | `x86_64-apple-darwin` | `.dmg`（Intel） |

**预装软件确认**（`actions/runner-images` README）：

- Ubuntu 24.04：`patchelf`、Node 22、Rust 1.98 已预装；但 GTK 依赖需手动 `apt-get install`。
- Windows 2022：WiX 3.14.1、NSIS 3.10、Visual Studio 2022 已预装。
- macOS：Xcode 已预装。

**tauri-action**（`tauri-apps/tauri-action@v0`）是官方 action，核心能力：

1. 跑 `tauri build`（bundle 内置）
2. 可选创建 GitHub Release（`tagName` + `releaseDraft: true`）
3. 上传 bundle 到 release assets
4. 可选生成 `latest.json`（供 tauri-plugin-updater 用）

需要 `permissions: contents: write` 和 `GITHUB_TOKEN`。

### 2.2 Gitee Go

**结论：不完整，公共构建机对 Tauri 三平台矩阵支持不足**。

- 免费公共构建机**以 Linux 为主**
- macOS / Windows 公共 runner 是否对免费用户开放，**官方文档不透明**，社区普遍认为需付费 / 企业版 / 自托管
- 免费额度：每月约 1000 核分；永久 200 分钟 / 仓库免费额度
- 计费改为「核分制」

因此 Linux 构建可用 Gitee Go，Windows / macOS 用 GitHub Actions。

---

## 3. 产物存放与分发

**推荐**：GitHub Releases 为主，Gitee Release 为镜像（可选第二阶段）。

- tauri-action 在打 tag 时自动创建 draft release，上传四个产物
- 人工 review draft 后 publish
- 第二阶段：写 `mirror-to-gitee.yml` 监听 release `published`，同步到 Gitee

---

## 4. 推荐 CI 配置

**GitHub Actions 4-runner 矩阵**：ubuntu-22.04 + windows-latest + macos-latest（aarch64）+ macos-15-intel（x86_64）。

**推荐 workflow 片段**（`/.github/workflows/release.yml`）：

```yaml
name: release
on:
  push:
    tags: [ 'app-v*' ]
jobs:
  build:
    permissions: { contents: write }
    fail-fast: false
    strategy:
      matrix:
        include:
          - { platform: ubuntu-22.04, args: '' }
          - { platform: windows-latest,   args: '' }
          - { platform: macos-latest,     args: '--target aarch64-apple-darwin' }
          - { platform: macos-15-intel,   args: '--target x86_64-apple-darwin' }
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: lts/* }
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin' || (matrix.platform == 'macos-15-intel' && 'x86_64-apple-darwin' || '') }}
      - name: Install Linux deps
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update && sudo apt-get install -y \
            libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
            libxdo-dev libssl-dev build-essential curl wget file
      - name: Install frontend deps
        run: pnpm install --frozen-lockfile
      - uses: tauri-apps/tauri-action@v0
        env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        with:
          tagName: app-v__VERSION__
          releaseName: '科室任务管理 v__VERSION__'
          releaseDraft: true
          prerelease: false
          args: ${{ matrix.args }}
```

**配套 tauri.conf.json**：`bundle.macOS.signingIdentity: "-"`；`bundle.windows.webviewInstallMode.type: "embedBootstrapper"`；`bundle.targets: ["deb", "appimage"]`。

---

## 5. 来源清单（Primary Sources）

1. https://v2.tauri.app/distribute/ — 2026-09-10 — 各平台支持的 bundle 格式、版本字段
2. https://v2.tauri.app/distribute/debian/ — `.deb` 配置键（`depends`、`files`）、自动运行时依赖
3. https://v2.tauri.app/distribute/appimage/ — AppImage 配置、体积、linuxdeploy 限制
4. https://v2.tauri.app/distribute/rpm/ — RPM 配置键、glibc 基线警告
5. https://v2.tauri.app/distribute/sign/linux/ — 「artifact signing is not required」官方原文
6. https://v2.tauri.app/distribute/windows-installer/ — WiX vs NSIS、WebView2 五种模式
7. https://v2.tauri.app/distribute/dmg/ — DMG 配置键、CI 上图标位置不生效的已知问题
8. https://v2.tauri.app/distribute/sign/macos/ — ad-hoc 用法、Intel vs Apple Silicon 差异
9. https://v2.tauri.app/learn/system-tray/ — tray-icon feature、跨平台 API 名
10. https://v2.tauri.app/start/prerequisites/ — 官方 apt / dnf 依赖清单
11. https://github.com/tauri-apps/tauri-action — action 输入 / 输出、跨平台矩阵示例
12. https://docs.github.com/en/actions/using-github-hosted-runners/about-github-hosted-runners/about-github-hosted-runners — runner 镜像来自 actions/runner-images
13. https://docs.github.com/en/actions/reference/runners/github-hosted-runners — runner 标签枚举
14. https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md — patchelf、Node、Rust 预装
15. https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md — WiX 3.14.1、NSIS 3.10、VS2022 预装
16. https://gitee.com/features/gitee-go — Gitee Go 产品定位
17. https://help.gitee.com/enterprise/pipeline/billing — 核分制计费
18. WebSearch 综合：Gitee Go 文档对 runner 镜像列表不透明，普遍认知为 Linux 主导

---

## 6. 下一步行动建议

1. 写 `.github/workflows/release.yml`（模板见 §4）
2. 在 `tauri.conf.json` 设 `signingIdentity: "-"`，本地确认 `.dmg` 在 M-series Mac 上能启动
3. 第一次 Windows build 验证 VBSCRIPT 已启用
4. v1 不做 AppImage / NSIS / Gitee 镜像，等用户反馈再追加