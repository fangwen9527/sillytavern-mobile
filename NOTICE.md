本仓库包含或依赖以下第三方作品：

1. dsh-mobile-iroh（https://github.com/saya-ch/dsh-mobile）
   - 许可：Apache License 2.0
   - 用途：iroh 主机端预编译组件（dsh-mobile-iroh-host-*），运行时按 SHA-256 校验后复用，不做修改。
   - 本仓库实现的 HTTP 配对协议（/mobile-access/*、配对描述符字段）与其 Android 客户端约定兼容。

2. iroh（https://github.com/n0-computer/iroh）
   - 许可：MIT / Apache-2.0
   - 用途：QUIC 加密直连与中继（通过上述组件间接使用）。

3. QRCode（https://github.com/soldair/node-qrcode）
   - 许可：MIT
   - 用途：生成配对二维码。
