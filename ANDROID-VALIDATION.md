# Android 兼容性修复与验证

## 2026-10-11 虚拟副屏文字输入（1.2.4）

- 修复副屏所有文字都强制进入 Unicode 输入法的问题。可通过键盘事件表示的可打印 ASCII 文字直接执行带明确 `-d displayId` 的输入命令；长文本不再因超过 128 字符而强制切换输入法。设备连接、控制授权、屏幕存在及旋转检查仍生效，副屏任意 shell 仍被禁用。
- 中文、表情、换行和字面 `%s` 保留经过目标校验的 Unicode 输入法，避免 `input text` 丢字或将 `%s` 改为空格。当前 IME 客户端解析兼容带/不带 `m` 前缀的 Android 字段，只接受当前绑定客户端，不把注册客户端列表或主屏键盘窗口当作输入目标。
- OPPO PKQ110 / Android 16 的临时模拟副屏（本次逻辑 ID 26）实测：中文、混合文字、标点、`%s`、表情、换行、原输入法恢复均通过；英文搜索、带空格和引号等标点的长文本直接输入后与测试编辑框内容完全一致。指定主屏而输入连接在副屏时，Unicode 请求被拒绝，编辑框内容不变且原输入法恢复。
- 结果：`UNICODE_INPUT_SMOKE_OK`。本次设备连接通过 DSHAN 内置 ADB；没有把 Shizuku 实机授权标记为本次通过。临时模拟屏、测试安装包和 ADB TCP 模式在验收后恢复。
- 系统不提供有效 Unicode 输入连接时仍会停止，不会绕过屏幕校验或把文字改投主屏；英文/数字定向输入不依赖该连接。

## 2026-10-06 Shizuku 副屏路由

- 原有截图、输入均未绑定 display；提示词无法改变底层默认屏幕。新增 `android_displays`、`android_select_display` 和 `android_launch_app`，按会话保存逻辑 display ID，截图和后续输入/启动统一路由，同一会话更换 agent 仍保留选择，其他会话互不影响。
- 输入统一 `input -d ID`；启动统一 `am start --display ID`，副屏加 NEW_TASK/MULTIPLE_TASK 避免普通任务复用。副屏禁止任意 shell、主屏 uiautomator、Home/Power/Recents。截图显示 display_id；切屏清理快照，不存在/截图不匹配/不支持的副屏明确失败，不回退主屏。
- Shizuku UserService 升为 version 2，枚举屏幕包括私有虚拟屏；Android 14+ 经 WindowManager.captureDisplay 按逻辑 ID 截图，不把逻辑 ID 误当作 screencap 的 SurfaceFlinger ID。旧系统或厂商不支持时停止并返回错误。应用自身或厂商多屏策略仍可能拒绝在副屏打开，模型需按截图验证，不能宣称启动命令成功等同于副屏成功。
- `node --test runtime/android-display.test.js runtime/android-tools-loop.test.js runtime/android-fast-screen.test.js`：6 项通过，包含副屏各输入/启动路由、消失屏幕不回退、截图不匹配、快照清理、跨会话隔离及显式返回主屏。Debug 和 AndroidTest APK 构建通过。当前 ADB 无连接设备，未验证真实虚拟副屏、反射截图接口及第三方应用启动。
- 参考：[AOSP input 的 display 参数](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/android-30/+/refs/heads/androidx-main-release/com/android/commands/input/Input.java)、[WindowManager 按逻辑 ID 截图](https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/wm/WindowManagerService.java)。

## 2026-10-06 旧版 WebView 会话与消息流兼容

- 会话引用、消息流及取消操作直接依赖 `Promise.withResolvers()`、`AbortSignal.any()`；旧版设备 WebView 缺失这些 API 时可在会话打开或订阅时抛异常。截图本身不足以确认故障设备的具体异常，仍需设备型号、WebView 版本或日志复验。
- Android 宿主在 head 最前面注入按能力检测的兼容脚本，早于内核模块加载和 boot-ready。补齐上述接口、`throwIfAborted()`、`Array.toSorted()` 和 dispose symbols；保留已有原生实现，合并取消保留首个取消原因并清理来源监听。
- `node --test runtime/android-webview-compat.test.js runtime/android-host.test.js runtime/android-preset-default.test.cjs`：12 项通过，含缺失接口故障、异步结果/失败、取消与监听清理、非原地排序、原生实现保留及注入顺序。Debug APK 和 AndroidTest APK 构建通过。
- 已在连接设备的真实 WebView 中禁用相关新接口，再加载 APK asset 中的兼容脚本，验证 Promise 完成、组合取消、排序与 DOM 点击，结果 `WEBVIEW_COMPAT_SMOKE_OK`。这不是故障平板上的真实会话/模型回复端到端验证。APK 已覆盖安装，修复同时通过独立宿主 asset 提供给已下载内核。

## 2026-10-06 Agent 预设配置覆盖修复

- 移除 Android 命令行 patch 对 `agent-preset-registry.config.default` 的强制覆盖，避免设置页面保存预设时触发 `Configuration ... is overridden by a home patch or command-line overlay`。
- Android 启动前在 web profile 的可编辑 `cordis.patch.yml` 中按需初始化 `default: android`；已有默认模式、`selectedDefault` 与其他配置保留，重复启动不重复写入。内置和下载内核均使用 APK 提供的 bootstrap 与 patch 模板。
- `node --test runtime/android-preset-default.test.cjs` 通过，覆盖首次启动、已有用户选择、旧配置迁移与重复启动。`:app:assembleDebug` 通过；已覆盖安装至连接设备并重启，确认 Android 默认值写入 profile，启动 patch 不再覆盖预设。尚未完成设置页面切换预设的端到端验证。

## 2026-10-04 欢迎向导连接与平板点击修复

- 欢迎向导视觉更新：保留动态深色背景，增加鲸鱼品牌标识、蓝色四段进度与步骤文字；浅色卡片增加边框与阴影，并按实际可用宽度限制为最多 520 dp；说明与权限选项采用独立圆角块，选中权限高亮；主次按钮增加触摸波纹与至少 52 dp 的高度。保留跳过及权限草稿逻辑。构建通过，当前无设备或本地 AVD，未验证真实渲染与横竖屏效果。
- Shizuku 步骤未连接时可点击“跳过，稍后授权”继续配置，连接后按钮为“下一步”。操作权限复选框的选择即时存为独立草稿，从存储设置返回、步骤重建或 Activity 重建后仍恢复选择；点击该步骤下一步后才提交为有效权限并清理草稿。此追加改动 `assembleDebug` 通过，尚未真机复验。
- 进入 Shizuku 步骤、返回应用前台时重新检查服务与授权，并恢复绑定；注册状态回调时立即回放已有状态。界面状态和下一步按钮统一在主线程更新。
- UserService 绑定增加 10 秒超时，超时释放当前连接注册并允许重试。连接提示先于绑定调用，避免快速回调成功后被“正在连接”覆盖。下一步仍要求实际 shell Binder 可用。
- 侧栏收起监听仅在宽度不超过 768 CSS px 且点到中心列的抽屉遮罩时触发。宽屏平板、中心内容按钮、独立弹窗和菜单的点击不再触发该监听。
- `node --test runtime/android-host.test.js`：9 项通过；`gradlew.bat assembleDebug`：成功。宿主脚本已同步至独立 APK asset，启动时会覆盖内置及已下载内核中的同名文件。
- 当前 ADB 无已连接设备，未完成这些改动的 Shizuku 或平板真机复验。需检查服务预先启动并授权、外部授权后返回、绑定超时后重试，以及平板横竖屏下的按钮和弹窗操作。

验证日期：2026-10-03。实体设备：OPPO PKQ110，Android 16，arm64，Shizuku 已授权；设备使用的已下载 DSH 内核为 0.2.0-rc.2。APK 内置内核仍为 0.1.7-rc.2。

## 修复

1. 会话锁：上游 `node-addon-system/flock` 不支持 android-arm64。新增 Android Node-API 库，执行真正的非阻塞 `flock`，关闭文件或进程退出后由内核释放。
2. 原子提交：Android 禁止应用创建硬链接。会话和新文件用 `renameat2(RENAME_NOREPLACE)` 发布；附件需要保留源对象，先复制并同步私有临时文件，再原子发布。碰撞拒绝覆盖。
3. 插件清单：补充运行时版本号，并修复已有下载内核的缺失版本号，避免 DeepSeek 请求扩展准备失败。
4. 文件搜索：用基于 Harness 文件系统服务的 Android 文件名/文字搜索替代缺少 Android 二进制的 ripgrep 工具。搜索是区分大小写的文字包含匹配，不支持正则；有 100 条结果、5000 个条目、10 秒、8 MiB 总读取量等上限。文字搜索跳过二进制和超过 256 KiB 的文件，结果说明 skipped/truncated。
5. 图片：显式安装 sharp WASM 后端，为旧下载内核补齐缺失依赖；图片存储的目录同步以系统管理的应用私有目录为边界，避免尝试打开 `/data/user/0` 等受保护父目录。更新安装检查 sharp 与 WASM 版本一致。
6. DNS：真机出现 `getaddrinfo ENOTFOUND api.deepseek.com`，同时系统解析和连通正常。Node 解析失败时通过鉴权本地桥接调用 Android 原生网络解析，再把结果交回 Node；保留原有 TLS 校验，不更改手机 DNS/VPN 设置。
7. 打包脚本同步独立覆盖资源，确保 APK 和在线更新内核使用相同 Android 适配。

## 验证结果

| 功能 | 覆盖与结果 |
|---|---|
| 对话 | 真机成功回复“对话验证成功”；新消息保存与重启后继续已有会话通过；最终交付版 DNS 修复后再次成功回复“Android 对话验证成功。” |
| android_status | 模型实际调用通过；返回 Shizuku 已连接、控制开关与 shell 开关状态 |
| 文件锁 | 真机验证 ESM 导入、两描述符竞争拒绝、关闭后重新获取、无效描述符 EBADF |
| 原子文件发布 | 真机验证完整内容与 EEXIST 拒绝覆盖，失败时保留源文件 |
| 文件创建/读/编辑 | 使用实际 LocalFileSystem 服务，对唯一临时目录验证受保护创建、读取、版本保护编辑 |
| 文件与文字搜索 | 真机实际服务验证文件名、中文内容搜索；自动测试覆盖取消、循环目录、权限错误和截断 |
| android_ui | 实际桥接返回 UI hierarchy XML |
| android_screenshot | 实际桥接返回 PNG，校验文件签名 |
| 图片处理与存储 | 真机验证 WASM 解码/规范化、附件原子保存、完整性校验读取；不等于已验证所有模型的视觉能力 |
| android_shell | 实际桥接执行 `printf DSHAN_ANDROID_SMOKE`，返回符合预期 |
| tap/swipe/key | 真机验证上边缘无目标动作的指令派发；未据此宣称所有应用界面操作效果已验证 |
| android_text | 非 ASCII 输入拒绝已验证；实际 ASCII 输入效果未验证，中文输入仍不支持 |
| DNS 回退 | 真机 `dns.lookup` 解析 DeepSeek 域名通过；自动测试覆盖原生成功、family/all/order 和桥接失败保留原错误 |
| Android 设置/更新 | 自动测试覆盖鉴权、来源校验、开关、镜像版本查询、隔离安装、并发阻止与取消；未再执行一次完整在线升级 |

11 项自动测试通过，Gradle `assembleDebug` 成功。真机本地自检出现 `ANDROID_DNS_SMOKE_OK`、`ANDROID_NATIVE_SMOKE_OK`、`ANDROID_FS_SMOKE_OK`、`ANDROID_BRIDGE_SMOKE_OK`、`ANDROID_IMAGE_SMOKE_OK`、`ANDROID_SHELL_SMOKE_OK`、`ANDROID_INPUT_SMOKE_OK`。临时自检只使用测试目录并清理该目录；交付 APK 不包含自检和临时模型错误追踪代码。

最终回归时手机 Shizuku 连接已断开，模型调用 android_ui/android_shell 被授权前置检查拦截；普通对话仍成功。手机控制需要 Shizuku 服务运行、授权有效且对应功能开关打开。以上 UI/Shell 成功结果来自此前同机连接正常时的实际调用。

## 仍有边界

鲸鱼图标更新：胶囊左侧已替换为官方 `FishLogo` 矢量形状，使用官方 `HeroFish` 的 REST/UP/DOWN 曲线和 1.6 秒形变节奏，原生 Canvas 绘制。后台任务启动时播放，结束或视图移除时取消动画；关闭系统动画时保持静态。Gradle 构建、安装与实际 20 秒后台工具任务验证通过，活动状态及结束恢复静止的截图已保存。

2026-10-03 后续验证：新增前台运行服务和真实 session/event 驱动的后台悬浮窗后，哔哩哔哩启动、截图读取、连续 UI 操作与 UP 主搜索完整通过（23 步，58 秒）。正确安装包搜索入口为 `bilibili://search?keyword=`。悬浮窗已改为默认 224×48 dp 深色胶囊，点击展开“打开对话/隐藏”，可拖动，真机折叠、展开和拖动通过，APK 构建安装成功。悬浮窗需系统上层显示授权，前台服务不能保证系统强制停止后继续运行。

- 官方桌面终端、PowerShell、浏览器自动化等插件没有在 Android 上获得支持保证；Android 模式使用手机专用工具。
- Android 文件权限仍由系统管理，其他应用私有文件不能直接读取；共享存储需要相应授权。
- 后台没有常驻服务，系统回收进程后任务会中断。
- 会话/文件/附件适配针对现有上游入口。未来内核改变这些实现时需要复验；图片依赖版本不匹配会拒绝启用该更新。
- 模型 API 连通性、账户限制和视觉支持仍取决于实际提供方。测试期间确实出现过原生 DNS 故障，不能把一次成功等同于所有网络环境长期无故障。

## 本地回归测试

```powershell
node --test runtime/android-network.test.cjs runtime/android-storage.test.cjs runtime/android-bootstrap.test.cjs runtime/android-fs-search.test.js runtime/android-directory-picker-backend.test.js runtime/android-host.test.js runtime/android-settings/index.test.js runtime/android-settings/client.test.js runtime/android-settings/kernel-updater.test.js
./scripts/prepare-runtime.ps1
./gradlew.bat assembleDebug
```

`scripts/android-native-smoke.cjs` 是开发自检片段，只有临时加入 debug bootstrap 时运行；不要加入交付资源。它包含无目标输入指令派发和临时模型错误追踪，且只在主线程运行。

## 2026-10-03 右侧终端 PTY 修复

APK 使用 NDK 编译 node-pty 的 Unix Node-API 源码，生成 Android arm64/bionic `libdshpty.so`。JNI 将库路径传给 bootstrap；CommonJS 加载和 ESM loader 均从 APK 原生库目录加载，不再复制 Linux/glibc prebuild。已下载内核同样使用启动时覆盖的 bootstrap。

实体设备当前 0.2.0-rc.2 内核验证：`pty.spawn('/system/bin/sh', ['-i'])`、输入命令、输出 `DSHAN_PTY_OK`、resize 和 exitCode=0 通过。临时自检已从最终 APK 移除。14 项回归测试通过，assembleDebug 成功，最终 APK 已安装。此验证覆盖终端原生运行层；未通过右侧面板 UI 完成一次端到端操作。Shell 运行于应用 UID，不等同于 Shizuku/ADB 的高权限 shell。

## 2026-10-04 侧栏折叠按钮：尝试后回退

曾尝试在手机端左侧栏加一对折叠/展开箭头（左箭头在设置按钮上方完全隐藏左侧栏，右箭头在左上角重新展开）。该改动已全部回退：插件不再注册 `sidebar.footer.action`，宿主端也不再有 `.dsh-android-nav-*` 样式与相关点击判定。窄屏行为与之前一致——左侧栏仍是抽屉，点击抽屉外收起，收起后保留官方 56px 图标栏。

回退过程中确认并修掉的两个真实缺陷保留在代码里：

- `scripts/prepare-runtime.ps1` 的 zip 文件列表里 `mobile-bootstrap.cjs` 后面漏了逗号，PowerShell 会把相邻字符串拼成一个不存在的文件名，导致 `android-host.js` 从未被打进 `runtime.zip`，手机上一直加载解包时写下的旧副本。逗号已补上，zip 现在包含 `android-host.js`。
- 注入脚本不再做任何启动期 DOM 操作（无观察器、无样式写入、无网络），只在点击时读取 DOM。启动期的 DOM 查询会与 React 首帧竞争，一旦抛错就会打崩整棵树。

另外记住一条约束：**不要改 `.pI_x6G_frame` 的 `grid-template-rows`**。框架是单行网格，把行高钉成 100% 会把中间列压成 0 高，主区域（对话、输入框）整块消失。`runtime/android-host.test.js` 现在会在实际执行注入脚本后断言：只注册一个 click 监听、不写类名或样式、不含未转义的 `querySelector(.`，并验证抽屉外点击仍能收起。
