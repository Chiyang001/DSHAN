# Android NPM 插件安装兼容性

2026-10-23

## 问题与修复

Android 内嵌 Node 没有 `git` 可执行文件。此前即使 pnpm 能下载公开仓库的归档，仍会先执行 `git ls-remote` 解析 HEAD，导致 `spawn git ENOENT`。

新增 `runtime/android-package-manager.cjs`，由 Android profile 的 package manager 配置启动，适用于内置和已下载的内核。保持内核使用的 pnpm 11.1.2，不修改其磁盘文件，在模块加载时替换 Git 引用读取及公开仓库访问逻辑：

- 按照 [Git HTTP 协议](https://git-scm.com/docs/http-protocol)读取公开仓库的 smart HTTP 引用，不调用 Git，也不依赖 GitHub REST API 的匿名请求额度。
- 继续使用 pnpm 自带的托管地址解析、分支/标签/semver 选择、tarball 下载、完整性校验和锁文件逻辑。既适用于直接安装，也适用于依赖树中的仓库依赖。
- GitHub HTTPS、`github:owner/repo`、`owner/repo` 和公开仓库 SSH 简写统一采用公开 HTTPS 归档。GitLab、Bitbucket 使用各自的归档模板。
- 已存在的 tarball 锁定可离线复用；旧锁文件中 `type: git` 的公开托管依赖，按原有 commit 下载归档，不改变锁定提交。
- 引用请求提供 20 秒超时、最多三次尝试、重试日志和 16 MiB 响应上限。沿用 pnpm 的代理/TLS 设置；Android 子进程显式启用 DNS 适配并传递 DNS 桥接所需环境。
- 使用 pnpm 的 `updateConfig` hook 设置数值参数，避免 pnpm 11 把 `--config.network-concurrency=4` 当作字符串而使安装队列报错。

安装默认跳过生命周期脚本，以复制方式导入包，下载并发 4、构建并发 1，下载重试 3 次、单次超时 60 秒。保持平台和引擎检查；不强制安装不兼容的原生依赖。不支持的 Git 来源会提示使用 npm 包或 HTTPS `.tgz`。

## 兼容范围

公开仓库必须包含可直接使用的发布文件。跳过构建脚本不会让源码自动生成 `dist`，也不能让桌面原生模块在 Android 上运行。私有 SSH 认证、Git 子模块及依赖完整 Git checkout 的构建流程不在此适配范围内。

此适配依赖固定 pnpm 包中的函数签名。签名不匹配时明确报告适配版本错误，避免悄悄恢复到依赖手机 Git 的流程。内核更新安装器继续固定 pnpm 11.1.2。

## 验证

自动回归：

```powershell
node --test runtime/android-package-manager.test.cjs runtime/android-bootstrap.test.cjs runtime/android-network.test.cjs runtime/android-preset-default.test.cjs runtime/android-search.test.js runtime/android-settings/kernel-updater.test.js
```

26 项通过。覆盖 HTTPS 引用格式、Unicode 分支、annotated tag、semver、固定提交、子目录、旧锁定及缓存隔离、GitLab/Bitbucket 模板、临时错误重试、永久错误、响应体上限、profile 启动接入，以及真实 pnpm 安装本地插件时复制文件、跳过脚本和不适用的可选依赖。

公开网络安装冒烟（隔离临时目录，主动清空 PATH 中的 Git，不读写应用 profile）：

```powershell
node scripts/android-package-manager-smoke.cjs
```

Windows Node 24.18.0 上已通过：

- 原始问题地址 `https://github.com/Chiyang001/dsh-codsh-theme.git` 安装成功，版本 0.3.51，commit `a8bf051c92a69d192d6e752bf08f63cae0d172b6`，包含 `dist/client.js`。
- 删除隔离目录中的 `node_modules` 后，使用 `--offline --frozen-lockfile` 从缓存重装成功。
- 从 npmmirror 安装 `is-number@7.0.0` 成功。
- 含不存在的 install 命令的本地测试包安装成功，确认构建脚本被跳过。

`:app:assembleDebug :app:assembleRelease :app:lintDebug :app:lintRelease` 构建检查通过。真机曾连接且确认 APK 的 Node 启动器可运行（Node 24.21.0）；随后 ADB 设备断开，未完成真机安装冒烟。不得将上述桌面隔离测试视为安卓端端到端验证。

最终 Debug/Release APK 均确认包含与源码逐字节一致的安装适配和 bootstrap，以及 Java 启动覆盖逻辑。Release Lint 为 0 errors / 41 warnings；APK v2 签名验证通过，9 个原生库的 ELF/RELRO/ZIP 16 KB 兼容检查通过。

真机脚本可放在临时运行目录中，目录需包含安装适配、DNS 适配和 `node_modules/pnpm`，再用 APK 的 `libdshnode.so` 启动并把该运行目录作为脚本参数。脚本只创建和清理自己的临时 profile，不操作真实插件配置。
