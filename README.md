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

### 第 3 步：改开关并重启酒馆

> ⚠️ **SillyTavern 1.19 起 `enableServerPlugins` 的默认值是 `false`，不是 `true`。**
> 不改这一项，插件永远加载不到，面板会一直停在「未启用」，所有接口返回 **404**。

打开酒馆根目录的 `config.yaml`，把这一行改成 `true`：

```yaml
enableServerPlugins: true
```

然后重启酒馆。面板状态变成 **运行中** 即成功。

如果面板显示「未启用 / 404」，先确认上面这一项；确认无误后仍然 404，再检查 `plugins/st-mobile` 是否存在（第 2 步脚本是否真的跑成功）。

### 第 4 步：装手机 App

**改装版（推荐）**：[直接下载 APK](https://cdn.jsdelivr.net/gh/fangwen9527/sillytavern-mobile@main/dist/stmobile-0.1.5.apk)（jsDelivr CDN，国内较快）

> 备用原链：`https://github.com/fangwen9527/sillytavern-mobile/raw/main/dist/stmobile-0.1.5.apk`
> SHA-256：`ec3c94c92654795938f47ff5ac7d05cbe75c5228a03ecaf223b9edf74528459b`

- 包名 `io.github.fangwen9527.stmobile`，可与官方 App 共存
- **默认图标是酒馆（SillyTavern）官方标识**，可在设置里切换（鲸鱼娘 / DeepSeek 鲸鱼 ×6）
- 启动永远进「已配对设备」/「选择连接方式」，不提供「直接进入酒馆」（否则没有回到列表的入口）
- 扫码页支持**从相册选择二维码图片**
- 连接方式页只保留「局域网」+「iroh」两条；右上角齿轮是设置入口
- 支持粘贴配对链接，不扫码也能配对
- **后台保持**：切到其他应用后页面不重载，时长可选 1 / 5 / 10 / 30 分钟或自定义（默认 10 分钟）
- 设置面板每项都显示当前值，不用点进去才知道现在是什么状态

**官方版**：[DSH Mobile iroh 完整版](https://github.com/saya-ch/dsh-mobile/releases/tag/android-v0.7.1) 同样可以连本插件。

## 使用

1. 打开酒馆 → 设置 → 扩展 → **酒馆远程**
2. 点「生成配对二维码」，会同时给出两个码，以及两条可复制的**配对链接**：
   - **iroh 直连**：外网可用，需要 App
   - **局域网**：同一 Wi-Fi，App 或浏览器都行
3. 手机扫码 → 直接进入酒馆；扫不了码就点「复制配对链接」，粘到 App 的「iroh 连接 → 配对信息」输入框里点「连接」

二维码 / 配对链接 10 分钟有效，重新生成会让旧码立即作废。

### 手机连不上局域网？

先看酒馆面板**第 6 步的「最近局域网请求」**，它直接决定问题在哪一侧：

**A. 显示「还没有收到任何局域网请求」** → 请求根本没到电脑，按顺序查：

1. **Windows 防火墙**（最常见）。把网络改成「专用」只是改配置文件，入站规则仍然可能不存在。

   **面板第 6 步「局域网排障」里直接给了一条可复制的命令**（已按你机器上 node 的真实路径生成），
   复制后到**管理员 PowerShell** 里跑一次即可。它按**程序**放行，端口变化不受影响：

   ```powershell
   netsh advfirewall firewall add rule name="SillyTavern Remote" dir=in action=allow program="<你的 node.exe 路径>" profile=private enable=yes
   ```
   网络是「公用」时把 `profile=private` 换成 `profile=any`。
2. **是否真的同网段**：面板显示的局域网地址（如 `192.168.1.130:8443`）前三段要和手机 Wi-Fi 里的 IP 一致。
3. **路由器 AP 隔离 / 访客网络**：开启时同一个 Wi-Fi 也互不相通。

**B. 有记录，但手机仍超时** → 请求到了电脑，问题在证书或鉴权：

- 配对码 10 分钟过期，重新生成再扫；
- App 里如果还留着旧设备（旧的 IP / 旧端点），先删掉再扫。

### 更新插件

`manifest.json` 的 `auto_update` 已设为 `false`：用复制方式安装时 git pull 必然失败，每次启动刷 `GitError` 会误导排查。
更新方式：重新执行第 1 步的安装命令；如果是用 git clone 装的，在扩展目录 `git pull` 后重启酒馆。

### 局域网二维码生成不出来？

面板第 4 步会直接写出原因。常见两种，插件都会自动处理：

- **npm 装依赖被本机策略拦下**：报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 之类时，用独立缓存目录重来：
  `npm install --cache .npm-cache --registry https://registry.npmmirror.com`。
- **端口被系统保留**：Windows 常把某段端口整段留给 Hyper-V/WSL（`netsh interface ipv4 show excludedportrange protocol=tcp` 可查）。
  8443 正好落在常见保留段（8403–8502）里，所以插件**默认改用 18443**，并把选定的端口**记进 `settings.json`**，
  之后每次启动优先复用——端口若每次都漂，你建好的防火墙规则就白费了。
  只有在被占用时才会回退到 28443 / 8443 等，面板第 6 步能看到当前实际端口。
- **网卡地址变了**：换网络后 IP 可能从 192.168.124.12 变成 .6，旧证书的 SAN 就不覆盖了。
  插件会用 node 原生解析证书发现这点并自动重签——这一步以前依赖系统 openssl，现在只在**真的需要重签**时才找它（找不到会明确告诉你装 Git for Windows 或用 `ST_MOBILE_OPENSSL` 指定路径）。

### 手机中途退出，回复也不会丢（实验，默认关闭）

> 开关位置：酒馆 → 扩展 → 酒馆远程 → **第 7 步「高级（实验功能）」→ 断线代跑**。
> 默认关闭，打开后**立即生效，不用重启酒馆**。


酒馆本身是「浏览器生成」：客户端一断，服务端会立刻 abort 掉上游 LLM 请求，已经生成的部分也不会存盘。
本插件的网关在中间多管了一段：手机在生成途中断开时，**网关不掐断上游**，继续把回复跑完，
再按酒馆自己的 `chat.jsonl` 结构写回聊天文件（第 1 行 `chat_metadata` 一个字节不动，避免破坏 integrity 校验）。

- 覆盖普通发送、继续写、重刷（swipe）
- 写回前先把原文件备份到 `~/.st-mobile/chat-backups/`
- 面板状态接口的 `recovered` 字段能看到最近 10 次代跑记录
- 只在「确实是手机断开」时接管；手机在线时行为与原生完全一致

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
