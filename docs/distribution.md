# 分发与安装

本科（kewutong / 科室任务管理）app 的安装包由 GitHub Actions 矩阵构建产物落到 [GitHub Releases](https://github.com/raawaa/kewutong/releases) draft 中。Reviewer 点 "Publish release" 后，普通用户即可下载。

ticket #32 落地决策：4-runner 矩阵 → `cargo tauri build` 原生产出 4 种格式 → draft release → 人工 publish。详见 `docs/adr/0004-distribution-pipeline.md`。

## 安装包格式与下载入口

| 平台      | 产物                       | 体积（参考） |
| --------- | -------------------------- | ------------ |
| Linux     | `.deb`（apt 装）+ `.AppImage`（单文件运行） | .deb 几 MB；AppImage 70+ MB（含 GTK/WebKit 运行时） |
| Windows   | `.msi`（WiX 打包）        | MSI 几 MB + 首次启动联网下 WebView2（~120MB） |
| macOS     | `.dmg`（Intel + Apple Silicon 两份） | 几 MB |

下载页 → <https://github.com/raawaa/kewutong/releases/latest>

## Linux

`.deb` 与 `.AppImage` 二选一即可，不要同时装。

### `.deb`（推荐，Debian / Ubuntu 22.04+）

```bash
sudo apt install ./kewutong_<version>_amd64.deb
kewutong
```

依赖项（`apt install ./...deb` 时自动检测并提示缺失包）：`libwebkit2gtk-4.1-0`、`libgtk-3-0`、`libayatana-appindicator3-1`（用了托盘）。

> GNOME 默认不显示托盘图标。装 [AppIndicator 扩展](https://extensions.gnome.org/extension/615/appindicator-support/) 后即可看到菜单栏图标；KDE / XFCE / Cinnamon 默认就支持。

### `.AppImage`（其它发行版或不想走包管理器）

```bash
chmod +x kewutong_<version>_amd64.AppImage
./kewutong_<version>_amd64.AppImage
```

AppImage 自带 GTK / WebKit 运行时，体积大但无系统依赖。

## Windows

双击 `kewutong_<version>_x64_en-US.msi`，按 WiX 安装器提示走。

首次启动会联网下 WebView2 运行时（科长的 Win10/11 默认已自带；如果装的是 Win7，install bootstrapper 已内嵌，会自动联网拉一次 TLS 1.2 兼容版本）。

**未签名提示**：`Windows SmartScreen` 会弹「Windows protected your PC」（未知发布者），点 **More info → Run anyway** 即可。**不会**自动上报给 Microsoft、不会**远程阻止**——只是本机提醒。

> 如果公司组策略禁用了未知 `.msi` 安装，请联系 IT 把发布者 hash（每个版本都不同）加进白名单，或者改成从源码走 `npm run tauri build`。

## macOS

下载对应的 `.dmg`：
- Apple Silicon（M1/M2/M3/M4）：`kewutong_<version>_aarch64.dmg`
- Intel Mac：    `kewutong_<version>_x86_64.dmg`

打开 `.dmg`，把 `kewutong.app` 拖进「应用程序」。

### Gatekeeper 放行（**首次启动必须**）

app 没经过 Apple 公证，**第一次**双击会弹：

> “kewutong” cannot be opened because the developer cannot be verified.

ad-hoc 签名保证了「不是损坏的」——但 Gatekeeper 仍要求手工放行一次。三种方法选一种：

**方法 1（最快）：右键打开**
1. 在「应用程序」里找到 `kewutong`
2. **右键** → 「打开」
3. 弹同样的提示，但这次多了「打开」按钮 — 点它

**方法 2：系统设置**
1. 试着双击一次触发拦截
2. 打开 「系统设置 → 隐私与安全性」
3. 滚到页面底部，会有一行 “kewutong” was blocked… — 点 **仍要打开**
4. 再输一次账号密码确认

**方法 3：清掉隔离属性**（如果你信任本机的下载来源）
```bash
xattr -dr com.apple.quarantine /Applications/kewutong.app
```

每次新版本（重新 ad-hoc 签名后）**都需要重新放行一次**——这是 Apple 的设计，不是一次性 allowlist。v1 不打算花 Apple ID 走正式签名/公证流程。

> 如果出现 “kewutong.app is damaged”，那是没有 ad-hoc 签名；本项目走 ad-hoc (`signingIdentity: "-"`) 应**不会**出现这条。如果出现了，先 `xattr -dr com.apple.quarantine /Applications/kewutong.app` 再试。

## 首次发版的实际安装验证（AC #7）

ticket #32 的最后一条 acceptance criteria：**四个 runner 的产物都至少实际安装一次**。CI 只能保证 build 通过；install 路径上的运行时依赖、托盘显示、放行弹窗等必须在真实机器上确认一次。

首次发版（reviewer 准备 publish draft 之前）的 check-list：

1. **Linux (.deb)**
   - 在 ubuntu-22.04 容器 / VM：`sudo apt install ./kewutong_<ver>_amd64.deb`，跑 `kewutong` 命令
   - 看到主窗口 → 走「今日 / 本周」流程，确认任务能建
   - 关窗确认最小化到托盘

2. **Linux (.AppImage)**
   - 同环境：`chmod +x ... && ./...AppImage`，确认直接跑起来（不需要安装）

3. **Windows (.msi)**
   - 在 Win10/11 VM：双击安装，按提示走完
   - 首次启动联网下 WebView2（看 SmartScreen → More info → Run anyway 能否放行）
   - 看到主窗口 → 走「人员矩阵」流程

4. **macOS Apple Silicon (.dmg)**
   - 在 M-series Mac：拖入「应用程序」
   - **首次双击**触发 “cannot be opened” → 用本文档「方法 1」或「方法 2」放行
   - 看到主窗口 → 走「项目看板」流程

5. **macOS Intel (.dmg)**
   - 在 Intel Mac 上重做第 4 步

如果任何一步失败：在 draft release 上 comment 说明 + 关 issue 之前不开 v1 publish。验证记录可附在 draft release 的 description 里。

## 第二阶段：Gitee Release 镜像（已记录，未启用）

## 第二阶段：Gitee Release 镜像（已记录，未启用）

issue #32 acceptance criteria 要求把"镜像 Gitee Release 的路径"记下来，但**不**实现——Gitee Go 的公共构建机对 Windows / macOS runner 不开放（[free tier 主要是 Linux](https://help.gitee.com/enterprise/pipeline/billing)），自费 CI 不划算。

后续若启用，方案是 GitHub Release **published** 时由 Gitee 端 webhook / GitHub Action 拉产物重传。详细方案草稿见 `docs/adr/0004-distribution-pipeline.md` §7。