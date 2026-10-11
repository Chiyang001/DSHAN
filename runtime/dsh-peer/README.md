# DSH Peer 0.1.2

DeepSeek Harness 的双向工具插件，开发者：炽阳001。手机 DSHAN 和电脑 DSH 使用同一份 JavaScript 插件，优先通过 WebRTC 直连；连接未成功时，通过配对服务加密中继，调用对方明确共享的工具。没有额外安装桌面 ADB 的要求；手机操作仍走 DSHAN 本机的 ADB/Shizuku 桥接。

## 安装

需要 Node.js 22 或更新版本，已验证手机内核 `0.1.7-rc.2` 和桌面端 `0.2.0-rc.2`。DSHAN 的内置运行环境已集成插件。电脑端复制本目录到固定位置，在该目录执行 `npm ci --ignore-scripts`，通过 Harness 插件配置添加：

```yaml
- id: dsh-peer
  name: 'C:/your/path/dsh-peer/index.js'
  config:
    iceServers:
      - urls: 'stun:turn.example.com:3478'
      - urls: 'turn:turn.example.com:3478?transport=tcp'
        username: 'dsh-peer'
        credential: 'your-turn-password'
```

使用 Harness 的 **native 或 both 工具模式**。纯 PTC 模式不允许本插件直接调用工具；插件也不会共享 `run_code` 来绕过工具白名单。电脑可以在独立的共享会话/预设中启用需要的工具。

## 配对与使用

1. 两端各打开一个会话。手机选择 Android 模式，启用本机设备连接和控制权限。
2. 在任一端要求创建配对，例如：“通过 `wss://pair.example.com` 创建配对，只共享 android_status、android_screenshot、android_tap、android_swipe、android_text、android_key。”会调用 `peer_host`，返回 `dsh-peer:` 开头的完整配对码。两分钟内复制给另一端。
3. 在另一端要求使用该码连接，并明确提供该端要共享的工具名。`tools` 传空字符串表示该端不接受远端调用。配对码包含连接秘密，应只交给想要控制设备的另一端。
4. `peer_status` 显示 connected 后，调用 `peer_tools` 获取对方工具及参数，再通过 `peer_call` 调用。电脑端拿到手机截图、snapshot_id 后，继续调用手机点击/滑动；手机端也可调用电脑端共享的文件、终端或其他 Harness 工具。
5. `peer_disconnect` 立即断开并撤销共享。关闭共享会话或退出应用也会撤销。连接只属于创建它的本机会话，不会自动恢复或迁移到其他会话。

手机端无需编辑配置文件，也可在创建/加入配对时给 `ice_servers_json` 参数传上述 STUN/TURN 设置的 JSON 数组。配置 STUN/TURN 可以增加 WebRTC 直连/中继的可用性；新版配对服务还提供加密 WebSocket 中继，因此没有 TURN 时仍可跨网络通信。

已有 HTTP 类型 FRP 入口时，在 Windows 上运行 `deploy/start-frp.ps1 -FrpConfig '你的 frpc.ini 完整路径'`。脚本启动该配置的本地信令/加密中继服务及 frpc，并识别已运行的新版服务；默认读取 `DSHAN_P2P` 段，可用 `-Section` 更改。需要 Node.js 22 或更新版本，找不到 Node 时传 `-NodePath`。

使用 `ws://域名`，两端的配对工具参数都传 `allow_http_signaling: true`。默认仍要求公网 WSS。HTTP 信令会暴露连接元数据，SDP 仍经过 HMAC 验证；直连数据使用 DTLS，中继数据使用 AES-256-GCM 端到端加密，服务器没有解密密钥。

`peer_host` 的 `connection_mode` 默认为 `auto`：直连优先，约 8 秒未连接后协商加密中继；`relay` 强制使用加密中继；`p2p` 禁用该回退。模式包含在配对码中，两端自动一致。已有连接断线或工具调用失败不会切换通道重试，以免重复执行操作。两端插件及配对服务器都必须更新到 0.1.2；仅升级手机无法使旧服务器提供中继。

如用户提供了 FRP 服务器的实际 IP，可选填 `peer_host.signaling_address` 或插件配置 `signalingAddress`。它只指定连接地址，保留原域名的 HTTP Host、TLS SNI 和证书验证，可用于 DNS 异常场景。普通使用不需要此参数。

跨网络要求两端都有可用外网。手机关闭 Wi-Fi 前应开启移动数据；VPN 显示已连接并不说明底层移动网络可用。

```json
[{"urls":"stun:turn.example.com:3478"},{"urls":"turn:turn.example.com:3478?transport=tcp","username":"dsh-peer","credential":"your-turn-password"}]
```

示例远端调用：`peer_call({"name":"android_screenshot","arguments_json":"{}"})`。图片会传输到调用端的 Harness 附件库，不引用对方设备的文件路径。

## 跨网络服务部署

本项目提供可自部署服务，没有预设公共服务器。部署需要一台 Linux 公网服务器、两个指向它的域名和可用 HTTPS 证书申请条件。

在 `deploy` 目录复制 `.env.example` 为 `.env`，填写真实域名、公网 IP 和强随机 TURN 密码，再执行 `docker compose up -d --build`。开放 TCP 80/443（HTTPS 信令）、TCP/UDP 3478（TURN）、UDP 49160–49200（中继）。TURN 示例要求服务器使用公网网卡；处于额外 NAT 后的服务器需要根据其网络调整 external-ip/listening-ip。`network_mode: host` 配置面向 Linux 服务器。

配对地址为 `wss://你的信令域名`。检查 `https://你的信令域名/health` 返回 ok。数据优先通过 ICE 直连，必要时使用 TURN。可在插件配置设置 `relayOnly: true` 强制中继进行验收。TURN/TCP 帮助部分 UDP 受限网络，但本示例没有 TURN/TLS；只允许 HTTPS 出站的严格网络需要另外配置带证书的 TURN/TLS 监听及相应 `turns:` 地址。

当前 WebRTC 依赖只使用列表中的第一个 STUN 和第一个 TURN 地址，不会依次尝试多个 TURN 地址。示例选择 TURN/TCP；如需改成 UDP，请明确将该 URL 改为 `?transport=udp` 后重新配对。

配对服务器交换经过配对秘密 HMAC 验证的 SDP 和中继协商信息；必要时转发加密的数据分片。中继使用配对秘密派生的双向独立密钥、会话随机值、递增 nonce 和消息认证，拒绝篡改、反射和重放。服务器看不到工具内容。配对房间最多两端、不复用旧码；服务重启/中继断线后重新配对。已配对房间不再因配对等待期限而结束，服务使用心跳清理失联连接。

## 权限与限制

- 本机工具白名单、会话工具可见性、Harness 原有工具权限管线同时生效。调用通过 `ctx.tools.execute`，没有直接绕过工具实现。需要本机审批的操作仍在本机审批；审批未获准时不会执行。
- 不共享 `peer_*`、`run_code` 或通配符。共享 shell/terminal 类工具本身意味着授予其执行能力，请按实际需要选择。
- 每次工具结果最多 16 MiB，分片传输；同一设备的远端工具调用按顺序执行。当前仅传输文本和图片，其他附件返回不支持提示。
- 超时/取消/断线不自动重试。工具可能已经改变设备状态，必须先观察再决定后续操作。取消会传给本机工具，但已完成的点击等无法撤回。
- 安卓应用处于后台被系统终止时连接会断开；保持 DSHAN 服务运行并按系统要求允许后台运行。本版不添加录屏串流或系统级桌面控制；电脑能力取决于电脑端启用和共享的 Harness 工具。

## 验证

在本目录执行 `npm test`。测试覆盖真实 WebRTC 双向数据通道、自动/强制加密中继、较大结果分片、认证与重放拒绝、工具限制、取消、断线及 UDP 握手乱序/重传。手机和电脑的实际验收及限制见 [LIVE-VALIDATION.md](LIVE-VALIDATION.md)。
