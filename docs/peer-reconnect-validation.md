# 手机与电脑自动重连部署验收

日期：2026-10-21（Asia/Shanghai）。开发者：炽阳001。

## 部署与安装

- 电脑的 `~/.dsh/plugins/dsh-peer`、`~/.dsh/profiles/desktop/node_modules/dsh-peer` 已同步至 0.1.7，依赖安装成功；使用真实桌面 Harness 和真实工具注册表完成测试。
- 手机为 USB 实机 OPPO PKQ110、Android 16。Debug 与正式签名 Release APK 构建成功，最终安装 DSHAN 1.2.6、versionCode 9 的非 debuggable Release；保留原有数据与内核选择。
- 验证准备期间用同签名 Debug APK 读取运行时，确认手机 `peer.js`、`index.js`、`package.json`、`client.js` 与源码逐字节一致；随后安装正式 Release APK，再进行下面的公网切网测试。
- 正式 APK 内插件为 0.1.7，关键文件与最终源码一致；APK 不包含临时 live-test 驱动。8 个 ARM64 原生库通过 ELF、RELRO 与 ZIP 布局检查。
- 服务器 `Desktop/在线网站/DSHAN_P2P/app.py` 已更新。自动审批拦截远程停止服务命令后，用户在原服务窗口完成重启，保留原 FRP。公网握手返回新版 `nonces`，服务器健康检查返回 200。
- 服务器旧代码备份：同目录 `app.py.before-reconnect-20261021-215056.bak`。部署文件 SHA-256 与本地源码一致：`6a54ce8c9eb124b1077f430b0ebeb708fac112e3dccf1a68c68cc30a8ba4c653`。

## 正式 Release APK 公网实测

两轮分别使用 `auto` 和 `relay`，经过公网地址 `ws://dshanp2p.chiyang001.top/peer`。每轮只创建、加入配对一次，切网和断线期间不重新生成码或加入配对。

通过 USB 转发的只是本机验证控制接口；手机与电脑间的信令、工具数据经过真实网络，没有使用 ADB reverse 代替公网流量。不调用模型对话 API。

| 场景 | auto 模式 | relay 模式 |
|---|---|---|
| Wi-Fi 初次连接 | 12.2 秒，P2P | 11.5 秒，加密中继 |
| 关闭 Wi-Fi，使用移动流量 | 46.2 秒恢复，转为加密中继 | 33.2 秒恢复 |
| 重新启用 Wi-Fi | 10.7 秒后调用通过，移动数据仍开启 | 关闭移动数据以隔离 Wi-Fi 路径，49.0 秒恢复 |
| Wi-Fi 和移动数据同时关闭 45 秒，再仅恢复 Wi-Fi | 检测到断线；30.2 秒恢复为 P2P | 检测到断线；21.4 秒恢复加密中继 |
| 手动断开 | 对端停止重连，通过 | 对端停止重连，通过 |

表中时间包含轮询和双向工具调用校验，不是单独的握手时间；受心跳、退避、公网入口及运营商网络影响，不保证所有网络立即恢复。auto 的“重新启用 Wi-Fi”一项保留移动数据，不能单凭该项断言旧连接已迁移至 Wi-Fi；relay 的隔离测试和两轮完全断线后仅恢复 Wi-Fi 的测试验证了实际 Wi-Fi 恢复路径。

每个检查点都验证两端共享工具目录，并通过连接调用手机 `android_status`、读取电脑专用验收目录内的 `peer-test.txt`。额外检查远端工具结果的 `isError === false` 和非空内容，确认不只是状态字段显示 connected。

先行网络预检也确认 Wi-Fi、移动流量、切回 Wi-Fi 时，手机 Node 运行时访问公网 `/health` 均返回 200 / `ok`。

## 回归与收尾

- 插件 34 项测试、Python 服务端 14 项测试通过。
- 修正原有插件测试的等待窗口：旧测试仅等 5 秒，短于实际自动模式的 8 秒中继回退；改为 15 秒期限后完整回归通过。
- 两轮结束均恢复 Wi-Fi 开启、移动数据关闭，并撤销测试共享。
- 验收后恢复两端原 profile、移除手机私有目录中的临时驱动和 USB 转发，再覆盖安装最终正式 APK。
- 临时脚本和机器可读结果保留在被 Git 忽略的 `build/peer-reconnect`：`auto-result.json`、`relay-result.json`、`remote-tool-success.json`、`phone-network-preflight.json`。

## APK

路径：`app/build/outputs/apk/release/app-release.apk`，209156862 字节。

SHA-256：`759ff78ce13e3d818195120228c4cb23565a15aad22c577819d7322b1e53a289`。
