# 酒馆远程（SillyTavern Remote）

把本地跑的 SillyTavern 安全地送到手机：**扫码一次即可进入**，不需要域名、公网 IP、端口映射或 VPN。

- **iroh 通道**：QUIC 加密 P2P 直连，打不通自动走中继。手机在任何网络（5G、公司网、校园网）都能连回家里的酒馆。
- **局域网通道**：同一 Wi-Fi 下走本机 HTTPS（默认 8443），零延迟。
- **设备配对**：一次性配对码换长期设备令牌，撤销即失效；酒馆的 Basic Auth 由网关自动注入，手机上不用再输密码。

> 本项目的 iroh 传输层复用了 [dsh-mobile](https://github.com/saya-ch/dsh-mobile) 的预编译组件与线协议（Apache-2.0），没有修改它的二进制。

## 安装

仓库同时包含两层：

```
.                        ← 前端扩展（装进酒馆 UI）
├── manifest.json
├── index.js
├── settings.html
├── style.css
├── install.ps1 / install.mjs   ← 服务端组件安装器
└── plugins/st-mobile/          ← 服务端插件（网关 + iroh 隧道）
```

### 第 1 步：在酒馆里装扩展

酒馆 → 设置 → 扩展 → **安装扩展** → 粘贴本仓库地址：

```
https://github.com/fangwen9527/sillytavern-mobile
```

刷新页面后，设置里会出现 **酒馆远程** 面板。

### 第 2 步：装服务端组件

酒馆的扩展安装器只能装前端扩展，服务端插件必须落到 `plugins/`。面板里会给出**已经算好路径**的命令，复制到酒馆根目录执行即可：

```powershell
# Windows（在酒馆根目录打开 PowerShell）
powershell -ExecutionPolicy Bypass -File ".\public\scripts\extensions\third-party\sillytavern-mobile\install.ps1"
```

```bash
# Linux / macOS / Termux（在酒馆根目录）
node "public/scripts/extensions/third-party/sillytavern-mobile/install.mjs"
```

脚本会：定位酒馆目录 → 备份旧版本到 `plugin-backups/` → 复制 `plugins/st-mobile` → `npm install`。

### 第 3 步：重启酒馆

`config.yaml` 里确认 `enableServerPlugins: true`（默认就是），然后重启。

面板状态变成 **运行中** 即成功。

### 第 4 步：装手机 App

**改装版（推荐）**：[直接下载 APK](https://cdn.jsdelivr.net/gh/fangwen9527/sillytavern-mobile@main/dist/stmobile-0.1.0.apk)（jsDelivr CDN，国内较快）

> 备用原链：`https://github.com/fangwen9527/sillytavern-mobile/raw/main/dist/stmobile-0.1.0.apk`
> SHA-256：`f293ce8fb7592bc7b5c3b9b276fa101988a6404d4de239adc277a8c94a0a727a`

- 包名 `io.github.fangwen9527.stmobile`，可与官方 App 共存
- 启动即进「已配对设备」列表
- 扫码页支持**从相册选择二维码图片**
- 酒红底白鲸图标

**官方版**：[DSH Mobile iroh 完整版](https://github.com/saya-ch/dsh-mobile/releases/tag/android-v0.7.1) 同样可以连本插件。

## 使用

1. 打开酒馆 → 设置 → 扩展 → **酒馆远程**
2. 点「生成配对二维码」，会同时给出两个码：
   - **iroh 直连**：外网可用，需要 App
   - **局域网**：同一 Wi-Fi，App 或浏览器都行
3. 手机扫码 → 直接进入酒馆

二维码 10 分钟有效，重新生成会让旧码立即作废。

## 它做了什么

```
手机 App ──(iroh QUIC 或局域网 TLS)──> 本机 HTTPS 网关(回环随机端口 / 8443)
                                        │  /mobile-access/*  配对与设备令牌
                                        └─ 其余全部反向代理 ──> 127.0.0.1:8000 酒馆
```

- **传输层**：iroh sidecar 只做「回环字节管道」，TLS 端到端；局域网则用插件自己的 CA 签叶子证书。
- **配对**：App 先做传输层握手（iroh 用 6 位码），再走 `/mobile-access/auth/native-pair` 核销一次性令牌，拿到设备令牌。
- **鉴权**：设备没配对时网关直接 401，请求不会到达酒馆；App 注入的 `dsh_ma_session` 与浏览器用的 `st_mobile_device` 都认。
- **状态目录**：`~/.st-mobile`（iroh 身份、CA 与叶子证书、局域网证书、设备令牌）。删掉等于重置所有配对。

## 安全边界

- 酒馆端口从不直接暴露；网关只监听回环（iroh）与可配置的局域网端口。
- 局域网证书由插件自己的 CA 签发，App 首次配对按二维码里的指纹固定，之后换证书会被拒绝。
- 设备令牌 180 天有效，面板可随时撤销。
- iroh 只在传输层做字节转发，**没有**路径级过滤；配对成功即可访问该网关能访问的全部路径。

## 常见问题

| 现象 | 处理 |
|---|---|
| 面板一直「启动中」 | 首次会下载约 15 MB 的 iroh 组件；网络慢时耐心等，或看「运行日志」。 |
| 状态「启动失败」 | 日志会写原因。最常见：`~/.st-mobile` 目录权限不满足 iroh 的私有目录要求（要放在用户 profile 下）。 |
| 局域网连不上 | 手机和电脑不在同一网段；或防火墙拦了 8443。 |
| iroh 连不上 | 全局 VPN/TUN 会接管 UDP；把 App 加入分应用绕过试试。 |
| 端口 8443 被占 | 设置环境变量 `ST_MOBILE_LAN_PORT=9443` 后重启酒馆。 |

## 许可

MIT。第三方组件与许可声明见 [NOTICE.md](NOTICE.md)。
