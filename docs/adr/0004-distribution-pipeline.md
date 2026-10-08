# 分发与安装流水线

**Status**: accepted

ticket #32 落地项。承 research #5 的 `research/cross-platform-packaging/FINDINGS.md`，把 Tauri 2.x 三平台原生安装包的构建 / 分发 / 信任路径写死成可执行流水线。

## 决策

### 1. CI 平台：GitHub Actions 4-runner 矩阵

四个 runner，覆盖全部原生格式：

| Runner            | 产物                          | 备注                              |
| ----------------- | ----------------------------- | --------------------------------- |
| `ubuntu-22.04`    | `.deb` + `.AppImage`         | LTS 基线，glibc 与科长的旧机对齐 |
| `windows-latest`  | `.msi`                       | WiX 3.x 已预装                    |
| `macos-latest`    | `.dmg`（aarch64）             | Apple Silicon                     |
| `macos-15-intel`  | `.dmg`（x86_64）             | 官方 Intel runner，2027-08 前可用 |

矩阵构建由 `tauri-apps/tauri-action@v1` 驱动，`args` 仅在 macOS 上传 `--target`；Linux/Windows 走 host default。

### 2. 触发与发布：`push.tags` → draft release → 人工 publish

- 触发：推送形如 `app-v<semver>` 的 tag。
- `releaseDraft: true`：4 个 job 都跑完后产出 1 个 draft GitHub Release，附 4 个产物。
- **不在 CI 里自动 publish**：v1 没有自动发布的安全门槛，dmg 未签名、msi 未签名，公开发布前必须人工确认产物完整、tag 与版本号对得上。

### 3. 产物格式：仅 4 种

```
.deb       — Debian/Ubuntu（apt 装）
.AppImage  — 其它发行版（单文件运行）
.msi       — Windows（WiX；webviewInstallMode = embedBootstrapper）
.dmg       — macOS（intel + apple silicon 两份）
```

**不做** `.rpm` / `.nsis` / `.app`：v1 目标用户群（科长）集中在 `.deb`/`.msi`/`.dmg`；扩展代价高，回报低。

`tauri.conf.json` 显式写 `bundle.targets = ["deb", "appimage", "msi", "dmg"]`，而不是 `"all"`——避免后续加新 target 时悄悄出意外产物。

### 4. macOS：ad-hoc 签名，不公证

```jsonc
// src-tauri/tauri.conf.json
"macOS": { "signingIdentity": "-" }
```

- 走 ad-hoc 的原因：免 Apple ID、零成本。否则 Apple Silicon 上首次启动会直接报 "kewutong.app is damaged"。
- ad-hoc **仍需**用户首次启动手工放行（Gatekeeper）。这是 Apple 的设计，不是 bug。详见 `docs/distribution.md` 三种放行方法。
- v1 **不做**公证（`notarytool` + Apple ID + 团队证书）：成本/收益不划算。延后到 v2 如果用户量够大、反馈够多再开。

### 5. Windows：MSI + embedBootstrapper

```jsonc
"windows": {
  "webviewInstallMode": { "type": "embedBootstrapper", "silent": false }
}
```

- `embedBootstrapper`：MSI 里嵌一个 ~1.8MB 的 WebView2 bootstrapper，首次安装时联网拉 WebView2 运行时。比 `offlineInstaller`（127MB）轻；比 `downloadBootstrapper` 对 Win7 友好（TLS 1.2 不再单独下载）。
- WiX 3.14.1 已由 `windows-latest` runner 镜像预装。
- **未签名**：SmartScreen 会弹"未知发布者"。Research #5 §1.2 确认运行链无影响。
- v1 **不**签 Authenticode：成本/收益同上。

### 6. 全程不引第三方打包器

`.deb` / `.AppImage` / `.msi` / `.dmg` 全部由 `cargo tauri build` 原生产出。**不**用 electron-builder / nfpm / 手写脚本。

理由：Tauri 2.x 的 bundle 链路已经覆盖所有目标；引第三方打包器要么与 Tauri 的资源声明 / icon / 签名重复配置，要么需要单独维护 workflow——不值得。

### 7. 第二阶段：Gitee Release 镜像，**不实现**

- Gitee Go 公共构建机目前以 Linux 为主，Windows/macOS runner 对免费用户**不开放**（[Gitee Go 计费说明](https://help.gitee.com/enterprise/pipeline/billing) 已改核分制）。
- 唯一现实的路径是 GitHub → Gitee 资产同步（webhook / GitHub Action 拉资产重传）。方案草稿写在 `docs/distribution.md` 末尾，**不在 v1 实施**。

## 不做的事

- **不在 release workflow 里跑 `cargo test` / `cargo clippy` / `npm test`**：tag 触发的目的是出货，不是重新测。这些门已在 push-to-master / PR 阶段跑过。Rust 编译失败 / 链接失败会让 `tauri build` 直接退出，等价一次"干跑"。
- **不做自动 changelog 生成**：`generateReleaseNotes: false`。当前 issue tracker 已经有规范的工单模式，release notes 由人工写一段中文说明更可控。
- **不做 tauri-plugin-updater 接入**：v1 更新靠"用户下载新版"——一上来就接入 updater 会引入签名 / `latest.json` / 回滚一整套，v1 用不上。
- **不做 Gitee Release 镜像**：Gitee Go 公共构建机对 Windows / macOS runner 不开放（[Gitee Go 计费说明](https://help.gitee.com/enterprise/pipeline/billing)）。方案草稿写在 `docs/distribution.md` 末尾，等真有用户反馈国内下载痛点再开。

## 工件

- `.github/workflows/release.yml`：CI 流水线。
- `src-tauri/tauri.conf.json`：`bundle.targets`、`bundle.macOS.signingIdentity`、`bundle.windows.wix.webviewInstallMode`。
- `docs/distribution.md`：三平台安装说明（中文，含 macOS Gatekeeper 放行三种方法）。

## 来源

- research #5 `research/cross-platform-packaging/FINDINGS.md` —— 平台打包工具链 + CI 选型（GitHub Actions vs Gitee Go）的所有结论。
- https://v2.tauri.app/distribute/windows-installer/ —— WebView2 五种 `webviewInstallMode` 对比表。
- https://v2.tauri.app/distribute/sign/macos/ —— ad-hoc 用法 + 公证流程。
- https://github.com/tauri-apps/tauri-action —— v1 输入契约。
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners —— `macos-15-intel` runner label 的官方定义（替代已弃用的 `macos-13`，可用至 2027-08）。
- https://docs.rs/tauri-utils/latest/tauri_utils/config/enum.WebviewInstallMode.html —— `WebviewInstallMode` 的 serde schema（`tag = "type"`, `rename_all = "camelCase"`），决定 `tauri.conf.json` 里写成 `{ "type": "embedBootstrapper", "silent": false }`。