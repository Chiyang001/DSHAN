<p align="center"><img src="docs/assets/readme-logos.svg" width="288" height="112" alt="Chiyang001 开发者 Logo | DSHAN APP Logo"></p>

<h1 align="center">DSHAN</h1>
<p align="center"><strong>Deepseek Harness for Android Native</strong></p>
<p align="center">在手机上运行 DeepSeek Harness，让 AI 调用 Android 设备工具。</p>

<p align="center">
  <img src="https://img.shields.io/badge/Android-11%2B-3DDC84?logo=android&amp;logoColor=white" alt="Android 11+">
  <img src="https://img.shields.io/badge/ABI-arm64--v8a-64748B" alt="arm64-v8a">
  <img src="https://img.shields.io/badge/Status-开发原型-F59E0B" alt="开发原型">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#内核更新">内核更新</a> ·
  <a href="#从源码构建">从源码构建</a> ·
  <a href="ANDROID-VALIDATION.md">验证记录</a>
</p>

---

## 项目简介

DSHAN 是一个单 APK 原型：在 Android 应用进程内嵌 Node.js，启动官方 `@deepseek-ai/dsh` 的 Web profile，并把手机设备操作能力注册为 Harness 工具。**APK 不需要电脑在旁运行。**

| 能力 | 说明 |
| :--- | :--- |
| 手机端对话 | 在应用内使用官方 Harness Web UI，配置自己的 DeepSeek API Key |
| 设备操作 | 通过 Shizuku、无线 ADB 配对或 Root，向 Harness 提供 `android_*` 手机工具 |
| 屏幕与文件 | 截图、读取 UI 层级、文件读写、文件名搜索与文字搜索 |
| 内核更新 | 在设置中下载并切换 DSH 内核，保留会话与设置 |
| 手机与电脑互联 | 内置 DSH Peer 插件，经配对后双向调用已共享的 Harness 工具，支持配置跨网络 P2P/TURN |

手机与电脑互联的安装、配对及公网服务部署见 [DSH Peer 使用说明](runtime/dsh-peer/README.md)。电脑端使用同一份插件；跨网络需要自行部署信令及 STUN/TURN 服务。

> [!NOTE]
> 本仓库仅提供源码，不提供 Release 或预构建 APK。自行构建支持 **Android 11 及以上 / arm64-v8a**。首次运行会解包官方 npm 包，请预留数百 MB 可用存储。

## 快速开始

### 1. 安装与授权

1. 按[从源码构建](#从源码构建)生成并安装 APK，打开应用，按引导向导完成初次配置。
2. 在手机安装并启动 [Shizuku](https://shizuku.rikka.app/download/)。首次启动按 Shizuku 应用内指引开启系统无线调试并启动服务。
3. 回到本应用，在引导向导中点击 **使用 Shizuku 一键授权**，接受授权弹窗。
4. 在向导中开启 **允许 Harness 控制这台手机**。任意 shell 命令另有独立开关，默认关闭。

已 Root 的手机可在向导的“连接设备权限”页点击 **检测并授权 Root**，在 Root 管理器中允许本应用，检测取得 UID 0 后开启 **Root 模式**。也可以在 **设置 → Android 设置** 中检测、开启或关闭。Root 模式默认关闭，开启状态会保存；应用重启时重新检查授权。未 Root 或授权被拒绝时不能开启。

也可选择 **通过通知栏输入 ADB 配对码**，无需 Shizuku。后续入口在 **设置 → Android 设置 → 无线 ADB 配对**。允许通知后，在开发者选项开启 **无线调试 → 使用配对码配对设备**，保持系统配对窗口打开，下拉通知栏，在 DSHAN 配对通知中输入六位配对码并发送。配对完成后自动发现并连接本机 ADB；连接后仍需开启 **允许 Harness 控制这台手机**。

如果无法自动发现配对端口，在同一个通知输入框输入 `配对端口 六位配对码`（用空格分隔）。如果配对成功但连接失败，通知会改为接收无线调试主页的 **连接端口**；该端口与配对窗口的端口不同。配对通知可取消，等待五分钟后自动结束。无线调试关闭或应用进程重启后，可从上述入口重新连接。

首次配置向导包含欢迎、连接设备、操作权限、后台悬浮窗和完成配置五步。虚拟副屏只在 **设置 → Android 设置** 中按需配置，不在向导中提示。

Root 模式下，主屏点击、滑动、按键、截图和设备 shell 命令使用 `su`，无需连接 Shizuku；仍需开启设备控制，任意 shell 命令还需单独授权。Root 失效时不会自动切换权限方式，请重新授权或关闭 Root 模式。副屏枚举及副屏截图仍使用现有 Shizuku 服务。此模式不会为手机执行 Root，也不会扩大 Node 文件工具的访问权限。

### 2. 配置与对话

完成向导后进入 **DeepSeek Harness** 页面，在官方 Web UI 的模型设置中配置自己的 **DeepSeek API Key**，即可开始对话。例如：

> 先检查 android_status，再截屏，帮我打开设置中的蓝牙页面。

后续可在 **设置 → Android 设置** 中重新授权 Shizuku、管理存储访问权限或修改 Harness 控制开关。主界面按系统返回键会将应用退到后台。

> [!IMPORTANT]
> 模型执行操作时，应用进程必须保持运行。首版尚无后台常驻服务，部分厂商系统会在离开应用后回收进程。关闭 Shizuku 服务或在系统应用设置中强制停止本应用，即可中断设备操作。

## 内核更新

在设置面板顶部点击 **检查更新**（位于“打开配置文件”左侧），通过 `https://registry.npmmirror.com` 查询 `@deepseek-ai/dsh` 的 `latest` 版本。

1. 点击 **下载并安装更新**，查看依赖解析、镜像请求、下载校验、解包安装和最终验证的实时日志，以及包处理数量与耗时。
2. 等待安装完成；关闭窗口不会取消安装。
3. 点击 **重启并启用**，切换到新内核。重启会中断当前任务。

| 更新行为 | 说明 |
| :--- | :--- |
| 数据保留 | 更新安装在独立目录，不改动会话与设置 |
| 失败回退 | 旧内核保留；新内核启动后 120 秒内未加载界面则自动回退 |
| 更新范围 | 仅更新 DSH 内核及依赖，不升级 APK 内置 Node.js |
| 兼容性检查 | Node 不兼容时显示原因并禁止更新 |

## 从源码构建

### 环境要求

| 依赖 | 要求 |
| :--- | :--- |
| Java | JDK 17+ |
| Android | SDK API 34、NDK / CMake |
| Gradle | 8.13 |
| JavaScript | Node / npm |

构建脚本使用官方 npm 版本 `@deepseek-ai/dsh@0.1.7-rc.2`，以及 [nodejs-mobile](https://github.com/fogtape/nodejs-mobile) 的 Node 24 Android `libnode.so`。首次构建先运行下载脚本，它会校验运行时的 SHA-256。

### 构建命令

在项目根目录运行：

```powershell
npx --yes node@24 --version
./scripts/fetch-node.ps1
npm ci --prefix runtime --omit=dev --ignore-scripts --os=android --cpu=arm64 --libc=bionic
./scripts/prepare-runtime.ps1
./gradlew assembleDebug
```

生成的 APK 位于 `app/build/outputs/apk/debug/`。

## 适配与当前边界

这是开发原型。**2026-10-03** 已在 **OPPO PKQ110 / Android 16 / Shizuku** 上验证更新内核 `0.2.0-rc.2` 的对话、重启恢复会话、原生锁、文件读写与搜索、截图和 UI 层级读取。具体覆盖范围见 [Android 验证记录](ANDROID-VALIDATION.md)。

| 项目 | 当前说明 |
| :--- | :--- |
| 桌面插件 | 官方 Harness 的桌面终端、PowerShell、浏览器启动等插件不是针对 Android 开发的，部分能力在手机上可能不可用；`android_*` 工具用于手机操作 |
| 文件打开插件 | 使用官方 `dsh-native-command` 的 ESM / CommonJS 插件可通过 Android 打开文件、查询打开方式和指定应用；按扩展名识别 MIME，文本编辑接口保持文本方式打开 |
| 文字输入 | `android_text` 支持中文、Emoji、换行和混合文本；Unicode 输入通过内置输入法提交，需要已授权 Shizuku / Root，并在输入后恢复原键盘 |
| 截图查看 | `android_screenshot` 返回图片的本地路径；请让模型接着调用官方 `read_image` 工具查看 |
| 文件搜索 | `glob` / `grep` 已使用无需 Android 二进制的实现；`android_find_files` / `android_search_text` 保留为字面量搜索工具 |
| 搜索上限 | 搜索有数量、时间和文件大小上限，会明确报告跳过和截断 |

<details>
<summary><strong>运行时适配与本地通信</strong></summary>

- 官方 Harness 依赖的 `node-addon-require-builtin` 没有 Android 原生包；本项目在固定的 Node 24 移动构建上通过 `--expose-internals` 适配，升级 Node / Harness 时需要重新验证。
- APK 提供真正的 Android `flock`，并将会话 / 新文件发布适配为 `renameat2(RENAME_NOREPLACE)`，保留原子提交与并发保护。
- 图片使用 sharp 的 WASM 后端；附件通过临时副本原子发布，并将目录同步限制在应用私有数据目录。已有下载内核也会在启动时获得适配。
- Web UI 仅绑定 `127.0.0.1:3080`；原生桥接仅绑定 `127.0.0.1:3981`，并以每次进程启动随机产生的 token 鉴权。

</details>

### 插件兼容范围

DSHAN 保留 DSH 的 Cordis 插件接口，通过启动适配层接入 Android；内置和已下载内核均使用 APK 中的适配文件。

| 插件依赖 | Android 行为与限制 |
| :--- | :--- |
| `openNativePath` / `openNativeAssociatedPath` | 使用 Android 文件查看器打开图片、PDF 和其他文件；需要手机安装相应查看应用 |
| `openNativeTextFile` | 使用文本查看器打开配置或源码；共享的是只读副本，外部编辑不会写回原文件 |
| `nativeFileApplications` / `openNativeFileApplication` | 查询系统注册的处理应用，指定应用时重新验证文件关联；图标暂返回 `null` |
| 文件访问 | 仅允许应用私有目录，以及已取得所有文件访问权限的共享存储；共享副本按请求隔离，避免同名文件覆盖 |
| 终端、文件锁、图片处理 | 继续使用已有 Android PTY、原生 flock 和 sharp WASM 适配 |
| pnpm 插件安装器 | 在有效配置和安装器 UI 中禁用：APK 的内嵌 Node 不能直接作为外部 Node / pnpm 可执行程序使用 |
| 桌面原生模块、PowerShell、桌面应用枚举和文件管理器定位 | 仍需各自的 Android 实现，不能保证兼容；第三方原生模块需提供 Android 构建 |

文件打开兼容层已通过自动化桥接及 ESM / CommonJS 加载测试；Android 打开方式的实际展示和启动仍需真机验证。

### Android 工作区工具适配

所有预设（Android、标准、PTC、精简及自定义预设）在插件加载和配置更新时统一应用 Android 策略：保留文件读写工具，提供无需外部二进制的 `glob` / `grep`，并补齐手机工具。适配同样用于已下载内核；不需要逐个预设手动改配置。

- `glob` 支持 `**`、通配符、花括号和隐藏文件；没有路径分隔符的模式按文件名匹配任意深度。
- `grep` 使用 JavaScript Unicode 正则表达式，支持 `include` 文件过滤、中文、行号和单文件搜索。与 ripgrep 的正则方言存在差异，不支持的表达式会报错。
- 相对搜索路径以会话工作目录为基准，目录搜索不跟随指向搜索根之外的链接。搜索使用同一文件系统服务，权限错误不会通过 shell 绕过。
- 每次最多检查 5000 个条目、读取 8 MiB、返回 100 项，单文件上限 256 KiB；跳过二进制和无效 UTF-8。返回 `skipped` / `truncated`，正则在独立 Worker 中执行并限制时间。
- 无 Android 实现的桌面 Bash、PowerShell、Office 转换、依赖运行环境工具、tmux、SenseVoice，以及需要外部 Node / pnpm 的 PTC 工作流和插件安装器，从有效配置中禁用或移除。安装器 UI 同步禁用。文件系统、对话、网络工具和应用内的内核更新保留。

手机 shell 操作使用 `android_shell`，需要设备连接、设备控制和单独的任意 shell 授权；应用内普通终端不保证具备 Linux 桌面开发环境。

### 虚拟副屏

欢迎向导的“虚拟副屏”步骤可以跳过；设置 → Android 设置提供创建、关闭、AI 管理授权和开发者选项入口。创建采用系统“模拟辅助显示设备”，默认 720×1280 / 240 dpi，使用独立内容模式。需要连接 Shizuku 或已授权的 Root；已有其他模拟副屏时不会覆盖，仅关闭配置匹配 DSHAN 的副屏。

创建后允许 DeepSeek 使用 `android_virtual_display` 管理副屏；可随时关闭“允许 DeepSeek 管理虚拟副屏”。AI 仍需设备控制授权，并调用 `android_displays`、`android_select_display` 选择真实 ID。副屏截图需要 Android 14+ 和 Shizuku，部分应用不能在副屏启动；副屏不可用时不会自动操作主屏。关闭副屏会中断其中的应用任务。

`android_launch_app` 通过系统包管理器解析当前用户的 Launcher Activity，再使用显式组件和指定显示 ID 启动，兼容微信、B 站等无法通过隐式 Launcher Intent 启动的应用。副屏启动后核对前台任务所在显示器；无法确认时报告 `APP_DISPLAY_NOT_VERIFIED`，不会转到主屏重试。2026-10-06 已在 OPPO / Shizuku 的临时副屏验证设置、B 站、微信的显式启动及显示 ID 核对。

副屏文字输入统一使用 Unicode 输入法。Android 可能将键盘窗口显示在主屏，但输入连接仍属于副屏；DSHAN 核对系统输入客户端的 UID、PID、显示 ID，以及提交前的输入连接和焦点版本，不能用键盘窗口所在屏幕判断输入目标。焦点不属于指定副屏时拒绝输入，不转到主屏。2026-10-06 已在副屏 22 的独立测试输入框验证中文、混合文本、Emoji、换行和原键盘恢复。

权限预设依赖底层 `dsh-bash-sandbox` 服务，因此保留该服务，只移除桌面 Bash 工具入口。权限列表继续提供只读、工作区写入和完全访问；选择预设不会自动授予 Android、Shizuku 或 Root 权限。

## 上游与参考

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 官方 Harness 项目
- [Shizuku](https://shizuku.rikka.app/) — 手机设备操作授权
- [nodejs-mobile](https://github.com/fogtape/nodejs-mobile) — Android Node.js 运行时
- [Android ADB 文档](https://developer.android.com/tools/adb) — Android 调试与设备操作参考
