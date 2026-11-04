# Android 工作区目录选择修复

日期：2026-10-23。

问题：停留在“存储位置”页直接点击“打开”时，官方浏览界面把虚拟目录标记 `__dsh_android_roots__` 当成工作区目录提交，导致 `workspace/invalid-path` / `Workspace path is not fully qualified`。

修复：

- “存储位置”页仅用于导航，未选中真实目录时禁用“打开”和“新建文件夹”。
- 选择内部存储、应用数据或其中的子目录后，提交实际绝对路径；真实目录仍支持直接打开当前层。
- 在存储位置页编辑路径时从 `/` 开始，不把虚拟标记写入路径输入框。
- 后端识别带尾斜杠的虚拟导航路径，并对在导航页新建文件夹返回明确提示。
- 在挂载浏览界面前适配当前运行内核的界面文件，覆盖内置内核和已下载内核；重复启动不重复修改。
- APK 中的两个目录选择适配资源与 `runtime/` 源文件同步，由现有启动覆盖流程加载。

验证命令：

```powershell
node --test runtime/android-directory-picker.test.js runtime/android-directory-picker-backend.test.js runtime/android-host.test.js runtime/android-webview-compat.test.js runtime/android-settings/index.test.js runtime/android-settings/kernel-updater.test.js
./gradlew.bat :app:assembleRelease :app:lintRelease
```

回归测试直接执行当前依赖中的浏览界面 bundle，使用受控的 React hook 状态检查按钮和提交回调；同时验证临时下载内核目录中的启动适配顺序、重复启动及资源同步。构建和 Lint 通过。

当前没有连接 Android 真机，尚未完成受影响机型上的安装与操作验证。真机复验应覆盖：导航页按钮禁用、内部存储和应用数据选择、子目录打开、返回导航页、手动输入绝对路径，以及缺少存储权限时的授权提示。
