package app.dsh.android;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

final class NodeRuntime {
    static {
        System.loadLibrary("node");
        System.loadLibrary("dshbridge");
    }

    private static boolean started;
    private static volatile boolean awaitingKernelHealth;
    private static native int start(String home, String cache, String dshHome,
                                    String token, String script, String patch, String storageRoot, String flockLibrary);

    static synchronized void launch(Context context, String token, Status callback) {
        if (started) return;
        started = true;
        new Thread(() -> {
            try {
                File home = context.getNoBackupFilesDir();
                File bundledRuntime = new File(home, "runtime");
                File runtime = bundledRuntime;
                File marker = new File(runtime, ".ready");
                String revision = Long.toString(context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).lastUpdateTime);
                String ready = marker.exists() ? new String(java.nio.file.Files.readAllBytes(marker.toPath()),
                    java.nio.charset.StandardCharsets.UTF_8) : "";
                if (!revision.equals(ready)) {
                    callback.update("正在解包官方 Harness 运行环境…");
                    extract(context, runtime);
                    java.nio.file.Files.write(marker.toPath(), revision.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                File selection = new File(home, "kernel-selection.json");
                if (selection.exists()) {
                    try {
                        org.json.JSONObject selected = readJson(selection);
                        runtime = validatedKernel(home, selected.getString("active"));
                        awaitingKernelHealth = selected.optBoolean("pending", false);
                    } catch (Exception invalid) {
                        callback.update("更新内核不可用，正在恢复内置内核…");
                        writeJson(selection, new org.json.JSONObject().put("active", bundledRuntime.getAbsolutePath()).put("pending", false));
                        runtime = bundledRuntime;
                    }
                }
                overlayAsset(context, "android-host.js", new File(runtime, "android-host.js"));
                // Older downloaded kernels skipped sharp's WASM fallback as an
                // optional dependency. Supply it without replacing their core.
                if (!runtime.equals(bundledRuntime)) {
                    for (String pkg : new String[] {"@img/sharp-wasm32", "@emnapi/runtime", "tslib"}) {
                        File destination = new File(runtime, "node_modules/" + pkg);
                        if (!new File(destination, "package.json").exists())
                            copyTree(new File(bundledRuntime, "node_modules/" + pkg), destination);
                    }
                }
                // Existing downloaded kernels predate the upstream inventory's
                // requirement that named plugin owners declare a version.
                File runtimeManifest = new File(runtime, "package.json");
                org.json.JSONObject manifest = readJson(runtimeManifest);
                if (manifest.optString("version", "").isEmpty()) {
                    manifest.put("version", "0.1.0");
                    writeJson(runtimeManifest, manifest);
                }
                File androidSettings = new File(runtime, "android-settings");
                if (!androidSettings.exists() && !androidSettings.mkdirs()) throw new Exception("无法创建 Android 设置目录");
                for (String name : new String[] {"package.json", "index.js", "client.js", "kernel-updater.js", "kernel-worker.js"}) {
                    overlayAsset(context, "android-settings/" + name, new File(androidSettings, name));
                }
                overlayAsset(context, "android-tools.js", new File(runtime, "android-tools.js"));
                overlayAsset(context, "android-loop-guard.js", new File(runtime, "android-loop-guard.js"));
                overlayAsset(context, "android-fast-screen.js", new File(runtime, "android-fast-screen.js"));
                overlayAsset(context, "android-coordinate-scale.js", new File(runtime, "android-coordinate-scale.js"));
                overlayAsset(context, "android-ui-parse.js", new File(runtime, "android-ui-parse.js"));
                overlayAsset(context, "android-screen-targets.js", new File(runtime, "android-screen-targets.js"));
                overlayAsset(context, "android-screen-annotate.js", new File(runtime, "android-screen-annotate.js"));
                overlayAsset(context, "mobile-bootstrap.cjs", new File(runtime, "mobile-bootstrap.cjs"));
                overlayAsset(context, "android-flock.cjs", new File(runtime, "android-flock.cjs"));
                overlayAsset(context, "android-network.cjs", new File(runtime, "android-network.cjs"));
                overlayAsset(context, "android-native-command.cjs", new File(runtime, "android-native-command.cjs"));
                overlayAsset(context, "android-native-command-shim.mjs", new File(runtime, "android-native-command-shim.mjs"));
                overlayAsset(context, "android-fs-search.js", new File(runtime, "android-fs-search.js"));
                overlayAsset(context, "android-search.js", new File(runtime, "android-search.js"));
                overlayAsset(context, "android-plugin-policy.cjs", new File(runtime, "android-plugin-policy.cjs"));
                overlayAsset(context, "android-directory-picker.js",
                    new File(runtime, "android-directory-picker.js"));
                overlayAsset(context, "android-directory-picker-backend.js",
                    new File(runtime, "android-directory-picker-backend.js"));
                overlayAsset(context, "android.patch.template.yml",
                    new File(runtime, "android.patch.template.yml"));
                File dshHome = new File(home, "dsh-home");
                if (!dshHome.exists() && !dshHome.mkdirs()) throw new Exception("无法创建 Harness 数据目录");
                File patch = new File(runtime, "android.patch.yml");
                File urlFile = new File(home, "dsh-web-url");
                if (urlFile.exists()) urlFile.delete();
                String template = new String(java.nio.file.Files.readAllBytes(
                    new File(runtime, "android.patch.template.yml").toPath()), java.nio.charset.StandardCharsets.UTF_8);
                String pluginPath = new File(runtime, "android-tools.js").getAbsolutePath().replace('\\', '/');
                String hostPath = new File(runtime, "android-host.js").getAbsolutePath().replace('\\', '/');
                String pickerPath = new File(runtime, "android-directory-picker.js").getAbsolutePath().replace('\\', '/');
                java.nio.file.Files.write(patch.toPath(), template
                    .replace("__PLUGIN_PATH__", pluginPath)
                    .replace("__ANDROID_SEARCH_PATH__", new File(runtime, "android-fs-search.js").getAbsolutePath().replace('\\', '/'))
                    .replace("__ANDROID_HOST_PATH__", hostPath)
                    .replace("__ANDROID_SETTINGS_PATH__", new File(androidSettings, "index.js").getAbsolutePath().replace('\\', '/'))
                    .replace("__PEER_PLUGIN_PATH__", new File(bundledRuntime, "dsh-peer/index.js").getAbsolutePath().replace('\\', '/'))
                    .replace("__DIRECTORY_PICKER_PATH__", pickerPath)
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
                clearNodeCompileCache(context.getCacheDir());
                callback.update("正在启动官方 DeepSeek Harness…");
                if (awaitingKernelHealth) {
                    new Thread(() -> {
                        try { Thread.sleep(120000); } catch (InterruptedException ignored) { return; }
                        if (awaitingKernelHealth) rollbackKernel(context);
                    }, "dsh-kernel-watchdog").start();
                }
                File script = new File(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js");
                String storageRoot = android.os.Environment.getExternalStorageDirectory().getAbsolutePath();
                int code = start(home.getAbsolutePath(), context.getCacheDir().getAbsolutePath(),
                    dshHome.getAbsolutePath(), token, script.getAbsolutePath(), patch.getAbsolutePath(),
                    storageRoot, context.getApplicationInfo().nativeLibraryDir + "/libdshflock.so");
                callback.update("Harness 已退出，代码 " + code + ": " + recentLog(home));
                if (awaitingKernelHealth) rollbackKernel(context);
            } catch (Throwable error) {
                String detail = error.getMessage();
                if (error instanceof java.io.FileNotFoundException && "runtime.zip".equals(detail)) {
                    detail = "未找到 runtime.zip，请先运行 ./scripts/prepare-runtime.ps1 并重新安装 APK";
                }
                callback.update("Harness 启动失败：" + detail);
                android.util.Log.e("DSHAndroid", "Node runtime failed", error);
                if (awaitingKernelHealth) rollbackKernel(context);
            }
        }, "dsh-node").start();
    }

    private static org.json.JSONObject readJson(File file) throws Exception {
        return new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8));
    }

    private static void writeJson(File file, org.json.JSONObject value) throws Exception {
        android.util.AtomicFile atomic = new android.util.AtomicFile(file);
        FileOutputStream out = null;
        try {
            out = atomic.startWrite();
            out.write(value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            atomic.finishWrite(out);
        } catch (Exception error) { if (out != null) atomic.failWrite(out); throw error; }
    }

    private static File validatedKernel(File home, String path) throws Exception {
        File kernel = new File(path).getCanonicalFile();
        File bundled = new File(home, "runtime").getCanonicalFile();
        String kernels = new File(home, "kernels").getCanonicalPath() + File.separator;
        if (!kernel.equals(bundled) && !kernel.getCanonicalPath().startsWith(kernels)) throw new SecurityException("内核目录无效");
        if (!new File(kernel, "node_modules/@deepseek-ai/dsh/lib/bin.js").isFile()) throw new Exception("内核启动文件不存在");
        return kernel;
    }

    static synchronized void activateKernel(Context context, String path) throws Exception {
        File home = context.getNoBackupFilesDir();
        File kernel = validatedKernel(home, path);
        File readiness = new File(kernel, ".kernel-ready.json");
        if (!readiness.isFile()) throw new Exception("内核尚未完成校验");
        String expected = readJson(readiness).getString("version");
        if (!expected.equals(readJson(new File(kernel, "node_modules/@deepseek-ai/dsh/package.json")).getString("version"))) throw new Exception("内核版本校验失败");
        File selection = new File(home, "kernel-selection.json");
        org.json.JSONObject original = selection.exists() ? readJson(selection) : new org.json.JSONObject()
            .put("active", new File(home, "runtime").getAbsolutePath()).put("pending", false);
        String previous = original.getString("active");
        if (kernel.getAbsolutePath().equals(previous)) throw new Exception("该内核已经启用");
        writeJson(selection, new org.json.JSONObject().put("active", kernel.getAbsolutePath()).put("previous", previous).put("pending", true));
        try { restartApp(context); }
        catch (Exception error) { writeJson(selection, original); throw error; }
    }

    static synchronized void confirmKernelHealthy(Context context) {
        if (!awaitingKernelHealth) return;
        try {
            File selection = new File(context.getNoBackupFilesDir(), "kernel-selection.json");
            org.json.JSONObject selected = readJson(selection);
            selected.put("pending", false);
            writeJson(selection, selected);
            awaitingKernelHealth = false;
        } catch (Exception error) { android.util.Log.e("DSHAndroid", "Kernel health confirmation failed", error); }
    }

    private static synchronized void rollbackKernel(Context context) {
        if (!awaitingKernelHealth) return;
        try {
            File home = context.getNoBackupFilesDir();
            File selection = new File(home, "kernel-selection.json");
            org.json.JSONObject selected = readJson(selection);
            String previous = selected.optString("previous", new File(home, "runtime").getAbsolutePath());
            File restored;
            try { restored = validatedKernel(home, previous); }
            catch (Exception ignored) { restored = new File(home, "runtime"); }
            writeJson(selection, new org.json.JSONObject().put("active", restored.getAbsolutePath()).put("pending", false));
            awaitingKernelHealth = false;
            restartApp(context);
        } catch (Exception error) { android.util.Log.e("DSHAndroid", "Kernel rollback failed", error); }
    }

    private static void restartApp(Context context) throws Exception {
        context.startActivity(new android.content.Intent(context, RestartActivity.class)
            .putExtra("previousPid", android.os.Process.myPid())
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    static String recentLog(File home) {
        File file = new File(home, "dsh-node.log");
        if (!file.exists()) return "未生成运行日志";
        try (java.io.RandomAccessFile input = new java.io.RandomAccessFile(file, "r")) {
            long size = input.length();
            input.seek(Math.max(0, size - 1024));
            byte[] bytes = new byte[(int) Math.min(size, 1024)];
            input.readFully(bytes);
            String value = new String(bytes, java.nio.charset.StandardCharsets.UTF_8).trim();
            return value.length() > 280 ? value.substring(value.length() - 280) : value;
        } catch (Exception error) { return "无法读取运行日志"; }
    }

    private static void clearNodeCompileCache(File cacheDir) {
        File[] children = cacheDir.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (!child.isDirectory() || !child.getName().matches("v\\d+.*")) continue;
            deleteRecursive(child);
        }
    }

    private static void deleteRecursive(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteRecursive(child);
        }
        file.delete();
    }

    private static void overlayAsset(Context context, String name, File target) throws Exception {
        try (InputStream in = context.getAssets().open(name);
             FileOutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
        } catch (java.io.FileNotFoundException ignored) { }
    }

    private static void extract(Context context, File target) throws Exception {
        if (!target.exists() && !target.mkdirs()) throw new Exception("无法创建运行环境目录");
        String root = target.getCanonicalPath() + File.separator;
        try (InputStream asset = context.getAssets().open("runtime.zip");
             ZipInputStream zip = new ZipInputStream(asset)) {
            ZipEntry entry;
            byte[] buffer = new byte[65536];
            while ((entry = zip.getNextEntry()) != null) {
                File file = new File(target, entry.getName());
                if (!file.getCanonicalPath().startsWith(root)) throw new SecurityException("无效运行环境路径");
                if (entry.isDirectory()) {
                    if (!file.exists() && !file.mkdirs()) throw new Exception("创建目录失败：" + file);
                } else {
                    File parent = file.getParentFile();
                    if (!parent.exists() && !parent.mkdirs()) throw new Exception("创建目录失败：" + parent);
                    try (FileOutputStream out = new FileOutputStream(file)) {
                        int count;
                        while ((count = zip.read(buffer)) != -1) out.write(buffer, 0, count);
                    }
                }
                zip.closeEntry();
            }
        }
    }

    private static void copyTree(File source, File destination) throws Exception {
        if (source.isDirectory()) {
            if (!destination.exists() && !destination.mkdirs()) throw new Exception("创建目录失败：" + destination);
            File[] children = source.listFiles();
            if (children == null) throw new Exception("无法读取内置图片运行库");
            for (File child : children) copyTree(child, new File(destination, child.getName()));
        } else {
            java.nio.file.Files.copy(source.toPath(), destination.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
    }

    interface Status { void update(String message); }
}
