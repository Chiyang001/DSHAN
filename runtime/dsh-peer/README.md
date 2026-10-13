# DSH Peer 0.1.5

DeepSeek Harness 的双向工具插件，开发者：炽阳001。手机 DSHAN 和电脑 DSH 使用同一份 JavaScript 插件，优先通过 WebRTC 直连；连接未成功时，通过配对服务加密中继，调用对方明确共享的工具。没有额外安装桌面 ADB 的要求；手机操作仍走 DSHAN 本机的 ADB/Shizuku 桥接。

## 安装

需要 Node.js 22 或更新版本，已验证手机内核 `0.1.7-rc.2` 和桌面端 `0.2.0-rc.2`。DSHAN 的内置运行环境已集成插件。

在 DSHAN 仓库根目录修改插件后，运行 `./scripts/sync-desktop-peer.ps1` 可自动同步到本机 DeepSeek Harness 插件目录（默认 `%USERPROFILE%\.dsh\plugins\dsh-peer`），并执行 `npm ci`。也可设置环境变量 `DSH_PEER_DESKTOP_PATH` 指向其他安装位置。

电脑端也可手动复制本目录，执行 `npm ci --ignore-scripts`，通过 Harness 插件配置添加：

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

手机可以直接在 **设置 → 连接** 配对。电脑在 **设置 → 连接** 点击“创建配对码”，或在会话中调用 `peer_host`；两端都会得到 **8 位配对码** 和二维码。手机扫码或逐位输入 8 位码后 **自动连接**，无需再点确认按钮。设备当前可用工具默认共享；HTTP 配对服务默认开启。连接成功后可查看连接方式和共享工具，点击“断开连接”撤销共享。

插件配置可设置默认配对服务器：

```yaml
  config:
    signalingServer: 'wss://your-domain/peer'
```

1. 两端打开应用，在「设置 → 连接」配对；配对不要求先创建会话。手机选择 Android 模式，启用本机设备连接和控制权限。
2. 在电脑端 **设置 → 连接** 创建配对码，或要求模型调用 `peer_host`。会返回 8 位配对码和二维码，两分钟内有效。
3. 手机在 **设置 → 连接** 扫码或输入 8 位码即可自动连接。`tools` 传空字符串表示该端不接受远端调用。
4. `peer_status` 显示 connected 后，调用 `peer_tools` 获取对方工具及参数，再通过 `peer_call` 调用。电脑端拿到手机截图、snapshot_id 后，继续调用手机点击/滑动；手机端也可调用电脑端共享的文件、终端或其他 Harness 工具。
5. `peer_disconnect` 立即断开并撤销共享。连接由设备级插件维持，不绑定创建配对的会话。删除或切换会话不会断开。退出应用或网络中断仍会结束当前连接。

手机端无需编辑配置文件，也可在创建/加入配对时给 `ice_servers_json` 参数传上述 STUN/TURN 设置的 JSON 数组。配置 STUN/TURN 可以增加 WebRTC 直连/中继的可用性；新版配对服务还提供加密 WebSocket 中继，因此没有 TURN 时仍可跨网络通信。

配对服务和 FRP 部署在独立的公网服务器，见项目 [Server 部署说明](../../Server/README.md)。普通用户电脑只安装本插件、使用服务器提供的 `wss://域名/peer`，无需运行 FRP 或配对服务。`deploy/start-frp.ps1` 仅保留为 Windows 服务器上的旧 Node 服务兼容入口；新版服务使用 `Server` 内的 Python/Flask。

使用 `ws://域名`，两端的配对工具参数都传 `allow_http_signaling: true`。默认仍要求公网 WSS。HTTP 信令会暴露连接元数据，SDP 仍经过 HMAC 验证；直连数据使用 DTLS，中继数据使用 AES-256-GCM 端到端加密，服务器没有解密密钥。

`peer_host` 的 `connection_mode` 默认为 `auto`：直连优先，约 8 秒未连接后协商加密中继；`relay` 强制使用加密中继；`p2p` 禁用该回退。模式包含在配对码中，两端自动一致。已有连接断线或工具调用失败不会切换通道重试，以免重复执行操作。两端插件及配对服务器都必须更新到 0.1.2；仅升级手机无法使旧服务器提供中继。

如用户提供了 FRP 服务器的实际 IP，可选填 `peer_host.signaling_address` 或插件配置 `signalingAddress`。它只指定连接地址，保留原域名的 HTTP Host、TLS SNI 和证书验证，可用于 DNS 异常场景。普通使用不需要此参数。

跨网络要求两端都有可用外网。手机关闭 Wi-Fi 前应开启移动数据；VPN 显示已连接并不说明底层移动网络可用。

```json
[{"urls":"stun:turn.example.com:3478"},{"urls":"turn:turn.example.com:3478?transport=tcp","username":"dsh-peer","credential":"your-turn-password"}]
```

示例远端调用：`peer_call({"name":"android_screenshot","arguments_json":"{}"})`。图片会传输到调用端的 Harness 附件库，不引用对方设备的文件路径。

## 跨网络服务部署

正式服务位于项目根目录 `Server`，由 Python/Flask、服务器上的 frps/frpc 和 HTTPS 入口组成。部署需要一台公网服务器和指向该服务器的域名。按 [Server 部署说明](../../Server/README.md) 配置并启动后，两端插件使用 `wss://域名/peer`。服务器负责配对和加密转发；普通用户电脑不承担服务器职责。

`deploy` 目录原 Node/Caddy/coturn 示例作为兼容参考保留，新的独立服务以 `Server` 为准。需要 TURN 时可另外部署 coturn，在两端插件设置对应地址和凭据；缺少 TURN 时仍可通过服务器的加密 WebSocket 中继跨网络连接。

检查 `https://域名/health` 返回 `ok` 和 `X-DSH-Peer-Relay: 1`。数据优先通过 ICE 直连，失败时使用加密 WebSocket 中继。`connection_mode: relay` 可验收该服务；`relayOnly: true` 专指 TURN，不能替代 WebSocket 中继模式。

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

### 设备级连接（0.1.5）

配对、保持连接、列出远端工具与调用远端工具不再绑定某一个会话。删除全部会话时设备连接仍保持；没有可用执行上下文的工具暂时不可用。打开启用了工具的会话后可自动恢复，无需重新配对。每次执行仍使用当前有效上下文的本机权限流程；显式工具白名单仍生效，失败的操作不会自动重试。
