package app.dsh.android;

import android.content.Context;
import android.os.Build;
import android.os.Environment;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.view.WindowManager;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

final class BridgeServer {
    private final Context context;
    private final AdbClient adb;
    private final ShizukuClient shizuku;
    final RootClient root = new RootClient();
    volatile boolean rootEnabled;
    private static final String VIRTUAL_SCREEN = "720x1280/240,own_content_only,should_show_system_decorations";
    private final String token;
    volatile boolean controlEnabled = false;
    volatile boolean shellEnabled = false;

    BridgeServer(Context context, AdbClient adb, ShizukuClient shizuku, String token) {
        this.context = context.getApplicationContext();
        this.adb = adb;
        this.shizuku = shizuku;
        this.token = token;
    }

    void start() {
        new Thread(() -> {
            try (ServerSocket server = new ServerSocket(3981, 16, InetAddress.getByName("127.0.0.1"))) {
                while (true) {
                    Socket socket = server.accept();
                    new Thread(() -> handle(socket), "dsh-bridge-call").start();
                }
            } catch (Exception error) {
                android.util.Log.e("DSHAndroid", "Bridge failed", error);
            }
        }, "dsh-bridge").start();
    }

    private void handle(Socket socket) {
        try {
            Socket connection = socket;
            connection.setSoTimeout(30000);
            InputStream in = connection.getInputStream();
            ByteArrayOutputStream headers = new ByteArrayOutputStream();
            int b;
            while ((b = in.read()) != -1) {
                headers.write(b);
                if (headers.size() > 8192) throw new IllegalArgumentException("请求头过大");
                byte[] bytes = headers.toByteArray();
                int length = bytes.length;
                if (length >= 4 && bytes[length - 4] == '\r' && bytes[length - 3] == '\n'
                    && bytes[length - 2] == '\r' && bytes[length - 1] == '\n') break;
            }
            String head = headers.toString("UTF-8");
            if (!head.startsWith("POST /rpc HTTP/1.")) {
                reply(connection, 404, new JSONObject().put("error", "not_found"));
                return;
            }
            int length = -1;
            boolean authorized = false;
            for (String line : head.split("\r\n")) {
                String lower = line.toLowerCase(java.util.Locale.ROOT);
                if (lower.startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                if (lower.startsWith("x-bridge-token:")) authorized = token.equals(line.substring(15).trim());
            }
            if (!authorized) {
                reply(connection, 403, new JSONObject().put("error", "unauthorized"));
                return;
            }
            if (length < 0 || length > 65536) throw new IllegalArgumentException("请求体大小无效");
            byte[] body = new byte[length];
            int offset = 0;
            while (offset < length) {
                int count = in.read(body, offset, length - offset);
                if (count < 0) throw new IllegalArgumentException("请求体不完整");
                offset += count;
            }
            JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
            JSONObject result = dispatch(request);
            reply(connection, 200, result);
        } catch (Exception error) {
            android.util.Log.e("DSHAndroid", "Bridge request failed", error);
            try {
                reply(socket, 400, new JSONObject().put("error", error.getMessage() == null ? "unknown" : error.getMessage()));
            } catch (Exception ignored) { }
        } finally {
            try { socket.close(); } catch (Exception ignored) { }
        }
    }

    private JSONObject dispatch(JSONObject request) throws Exception {
        String method = request.optString("method", "");
        if ("progress".equals(method)) {
            String session = request.optString("session", "runtime");
            String text = request.optString("text", "处理中");
            if (session.length() > 128 || text.length() > 240) throw new IllegalArgumentException("状态过长");
            HarnessMonitorService.progress(session, text, request.optBoolean("active", true));
            return new JSONObject().put("ok", true);
        }
        if ("status".equals(method)) return new JSONObject()
            .put("connected", deviceConnected())
            .put("transport", transport())
            .put("secondaryCaptureAvailable", shizuku.isReady() && Build.VERSION.SDK_INT >= 34)
            .put("rootEnabled", rootEnabled).put("rootAvailable", root.isReady())
            .put("controlEnabled", controlEnabled)
            .put("shellEnabled", shellEnabled)
            .put("device", Build.MANUFACTURER + " " + Build.MODEL)
            .put("android", Build.VERSION.RELEASE);
        if ("storageStatus".equals(method)) return storageStatus();
        if ("resolveHost".equals(method)) {
            String host = request.getString("hostname");
            if (!host.matches("[A-Za-z0-9.-]{1,253}")) throw new IllegalArgumentException("无效主机名");
            android.net.ConnectivityManager connectivity = (android.net.ConnectivityManager)
                context.getSystemService(Context.CONNECTIVITY_SERVICE);
            android.net.Network network = connectivity.getActiveNetwork();
            java.net.InetAddress[] resolved = network == null
                ? java.net.InetAddress.getAllByName(host) : network.getAllByName(host);
            JSONArray addresses = new JSONArray();
            for (java.net.InetAddress address : resolved) addresses.put(new JSONObject()
                .put("address", address.getHostAddress())
                .put("family", address instanceof java.net.Inet6Address ? 6 : 4));
            return new JSONObject().put("addresses", addresses);
        }
        if ("activateKernel".equals(method)) {
            NodeRuntime.activateKernel(context, request.getString("path"));
            return new JSONObject().put("restarting", true);
        }
        if ("androidSettings".equals(method)) return androidSettings();
        if ("openDisplaySettings".equals(method)) {
            runOnMain(() -> context.startActivity(new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)));
            return androidSettings();
        }
        if ("createVirtualDisplay".equals(method) || "closeVirtualDisplay".equals(method)) {
            configureVirtualDisplay("createVirtualDisplay".equals(method));
            return androidSettings();
        }
        if ("virtualDisplay".equals(method)) {
            if (!controlEnabled) throw new IllegalStateException("设备控制未授权");
            if (!context.getSharedPreferences("dsh_setup", 0).getBoolean("virtualDisplayAllowed", false))
                throw new IllegalStateException("请先在 Android 设置中允许 DeepSeek 管理虚拟副屏");
            configureVirtualDisplay(request.getBoolean("enabled"));
            return androidSettings();
        }
        if ("requestRoot".equals(method)) { root.request(); return androidSettings(); }
        if ("openOverlaySettings".equals(method)) {
            runOnMain(() -> {
                android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:" + context.getPackageName()))
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                try { context.startActivity(intent); }
                catch (android.content.ActivityNotFoundException ignored) {
                    context.startActivity(new android.content.Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
                        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
                }
            });
            return androidSettings();
        }
        if ("updateAndroidSettings".equals(method)) {
            synchronized (this) {
                boolean control = request.has("controlEnabled") ? request.getBoolean("controlEnabled") : controlEnabled;
                boolean shell = request.has("shellEnabled") ? request.getBoolean("shellEnabled") : shellEnabled;
                boolean useRoot = request.has("rootEnabled") ? request.getBoolean("rootEnabled") : rootEnabled;
                if (useRoot && !root.isReady()) throw new IllegalStateException("请先检测并授权 Root，再开启 Root 模式");
                if (!context.getSharedPreferences("dsh_setup", 0).edit()
                    .putBoolean("control", control).putBoolean("shell", shell).putBoolean("root", useRoot).commit())
                    throw new IllegalStateException("设置保存失败，请重试");
                controlEnabled = control;
                shellEnabled = shell;
                rootEnabled = useRoot;
                if (request.has("virtualDisplayAllowed")) context.getSharedPreferences("dsh_setup", 0).edit()
                    .putBoolean("virtualDisplayAllowed", request.getBoolean("virtualDisplayAllowed")).apply();
            }
            return androidSettings();
        }
        if ("requestShizuku".equals(method)) {
            runOnMain(() -> shizuku.request());
            return androidSettings();
        }
        if ("requestAdbPairing".equals(method)) {
            runOnMain(() -> context.startActivity(new android.content.Intent(context, MainActivity.class)
                .putExtra("adbPair", true).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                    | android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP | android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)));
            return androidSettings();
        }
        if ("openStorageSettings".equals(method)) {
            runOnMain(() -> {
                android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    android.net.Uri.parse("package:" + context.getPackageName()));
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                try { context.startActivity(intent); }
                catch (android.content.ActivityNotFoundException ignored) {
                    context.startActivity(new android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
                }
            });
            return androidSettings();
        }
        if ("openTextFile".equals(method)) {
            String path = request.getString("path");
            if (path.isEmpty() || path.length() > 4096) throw new IllegalArgumentException("路径无效");
            runOnMain(() -> openTextFile(path));
            return new JSONObject().put("ok", true);
        }
        if ("openFile".equals(method) || "fileApplications".equals(method)) {
            File source = authorizedDocument(request.getString("path"));
            String mime = documentMime(source);
            android.content.Intent probe = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            probe.setDataAndType(android.net.Uri.parse("content://" + context.getPackageName() + ".files/document"), mime);
            java.util.List<android.content.pm.ResolveInfo> handlers = context.getPackageManager()
                .queryIntentActivities(probe, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY);
            if ("fileApplications".equals(method)) {
                JSONArray applications = new JSONArray();
                android.content.pm.ResolveInfo preferred = context.getPackageManager()
                    .resolveActivity(probe, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY);
                for (android.content.pm.ResolveInfo handler : handlers) {
                    android.content.ComponentName component = new android.content.ComponentName(handler.activityInfo.packageName, handler.activityInfo.name);
                    applications.put(new JSONObject().put("id", component.flattenToString())
                        .put("name", handler.loadLabel(context.getPackageManager()).toString())
                        .put("default", preferred != null && preferred.activityInfo != null
                            && component.getPackageName().equals(preferred.activityInfo.packageName)
                            && component.getClassName().equals(preferred.activityInfo.name))
                        .put("icon", JSONObject.NULL));
                }
                return new JSONObject().put("applications", applications);
            }
            String application = request.optString("application", "");
            android.content.ComponentName selected = null;
            if (!application.isEmpty()) {
                for (android.content.pm.ResolveInfo handler : handlers) {
                    android.content.ComponentName candidate = new android.content.ComponentName(handler.activityInfo.packageName, handler.activityInfo.name);
                    if (candidate.flattenToString().equals(application)) selected = candidate;
                }
                if (selected == null) throw new IllegalArgumentException("应用未注册为此文件的打开方式");
            }
            final android.content.ComponentName target = selected;
            runOnMain(() -> openDocument(source.getPath(), mime, target));
            return new JSONObject().put("ok", true);
        }
        if ("listDirectory".equals(method)) return listDirectory(request);
        if (!deviceConnected())
            throw new IllegalStateException(rootEnabled ? "Root 模式不可用，请重新检测授权或关闭 Root 模式" : "请先授权 Shizuku、连接无线 ADB 或启用 Root 模式");
        if (!controlEnabled) throw new IllegalStateException("请在应用内开启“允许 Harness 控制手机”");
        if ("displays".equals(method)) return new JSONObject().put("displays", displays());
        int displayId = request.has("displayId") ? bounded(request, "displayId", 0, Integer.MAX_VALUE) : 0;
        if (displayId != 0) displayInfo(displayId); // Never fall back to the main display.
        if (request.has("expectedRotation") && request.getInt("expectedRotation") != screenRotation(displayId))
            throw new IllegalStateException("SCREEN_ROTATED: 请重新截图，未发送操作");
        String command;
        switch (method) {
            case "tap":
                command = "input -d " + displayId + " tap " + coordinate(request, "x") + " " + coordinate(request, "y");
                break;
            case "swipe":
                command = "input -d " + displayId + " swipe " + coordinate(request, "x1") + " " + coordinate(request, "y1")
                    + " " + coordinate(request, "x2") + " " + coordinate(request, "y2")
                    + " " + bounded(request, "duration", 1, 5000);
                break;
            case "key":
                if (displayId != 0 && (request.getInt("keycode") == 3 || request.getInt("keycode") == 26
                        || request.getInt("keycode") == 187))
                    throw new IllegalArgumentException("副屏模式不发送 Home、电源或最近任务键，避免切回主屏");
                command = "input -d " + displayId + " keyevent " + bounded(request, "keycode", 0, 300);
                break;
            case "text":
                String value = request.getString("text");
                if (value.isEmpty() || value.length() > 4096 || value.indexOf('\0') >= 0)
                    throw new IllegalArgumentException("文字必须为 1 至 4096 个字符，不能包含 NUL");
                if (displayId != 0 || !value.matches("[\\x20-\\x7E]*") || value.contains("%s") || value.length() > 128)
                    return inputUnicode(value, displayId);
                command = "input -d " + displayId + " text " + quote(value.replace(" ", "%s"));
                break;
            case "ui":
                if (displayId != 0) throw new IllegalStateException("副屏请使用截图操作，uiautomator 无法保证目标屏幕");
                command = "uiautomator dump /data/local/tmp/dsh-ui.xml >/dev/null && cat /data/local/tmp/dsh-ui.xml";
                break;
            case "screenshot":
                return captureScreenshot(request);
            case "screen":
                if (displayId != 0) throw new IllegalStateException("副屏请使用 android_screenshot，避免读取主屏 UI");
                return captureScreenAnalysis();
            case "launch":
                String packageName = request.getString("package");
                if (!packageName.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+"))
                    throw new IllegalArgumentException("无效应用包名");
                return launchApplication(packageName, displayId);
            case "shell":
                if (displayId != 0) throw new IllegalStateException("副屏模式禁止任意 shell，避免未指定屏幕的命令操作主屏；请用 android_launch_app 和专用操作工具");
                if (!shellEnabled) throw new IllegalStateException("任意 shell 命令未获应用内授权");
                command = request.getString("command");
                if (command.length() > 2048 || command.isEmpty()) throw new IllegalArgumentException("命令长度无效");
                break;
            default:
                throw new IllegalArgumentException("未知方法：" + method);
        }
        long started = android.os.SystemClock.elapsedRealtime();
        String marker = "\n__DSH_EXIT_" + java.util.UUID.randomUUID().toString() + ":";
        String checked = "/system/bin/sh -c " + quote(command) + "; dsh_result=$?; printf "
            + quote(marker + "%s\\n") + " \"$dsh_result\"";
        byte[] output = execute(checked, method.equals("ui") ? 2 * 1024 * 1024 : 256 * 1024);
        String text = new String(output, StandardCharsets.UTF_8);
        int end = text.lastIndexOf(marker);
        if (end < 0) throw new IllegalStateException("COMMAND_OUTCOME_UNKNOWN: 未收到命令退出状态，请先检查手机，不要重复操作");
        int exitCode = Integer.parseInt(text.substring(end + marker.length()).trim());
        return new JSONObject().put("ok", exitCode == 0).put("exitCode", exitCode)
            .put("output", text.substring(0, end))
            .put("displayId", displayId)
            .put("transport", transport())
            .put("durationMs", android.os.SystemClock.elapsedRealtime() - started);
    }

    private int screenRotation() {
        return context.getSystemService(WindowManager.class).getDefaultDisplay().getRotation();
    }

    private JSONObject launchApplication(String packageName, int displayId) throws Exception {
        long started = android.os.SystemClock.elapsedRealtime();
        String resolution = new String(execute("cmd package resolve-activity --brief --user current"
            + " -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p " + quote(packageName), 16384), StandardCharsets.UTF_8);
        android.content.ComponentName component = null;
        for (String line : resolution.split("\\r?\\n")) {
            String candidate = line.trim();
            if (!candidate.matches("[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+")) continue;
            android.content.ComponentName parsed = android.content.ComponentName.unflattenFromString(candidate);
            if (parsed != null && packageName.equals(parsed.getPackageName())) component = parsed;
        }
        if (component == null) throw new IllegalStateException("APP_LAUNCHER_UNAVAILABLE: 未找到该应用的启动 Activity，请确认应用已安装且可启动");
        String output = new String(execute("am start -W --user current --display " + displayId
            + (displayId == 0 ? "" : " -f 0x18000000")
            + " -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n " + quote(component.flattenToString()), 256 * 1024), StandardCharsets.UTF_8);
        if (output.contains("Error:") || output.contains("Exception") || output.contains("Status: timeout"))
            throw new IllegalStateException("APP_LAUNCH_FAILED: " + output.trim());
        if (displayId != 0) {
            boolean verified = false;
            for (int attempt = 0; attempt < 6; attempt++) {
                displayInfo(displayId); // Reject a vanished display without touching main.
                String activities = new String(execute("dumpsys activity activities", 1024 * 1024), StandardCharsets.UTF_8);
                if (isPackageResumedOnDisplay(activities, packageName, displayId)) { verified = true; break; }
                Thread.sleep(300);
            }
            if (!verified) throw new IllegalStateException("APP_DISPLAY_NOT_VERIFIED: 系统未确认应用在指定副屏前台运行，可能存在单实例或多屏限制；未执行主屏回退，请检查副屏截图");
        }
        return new JSONObject().put("ok", true).put("exitCode", 0).put("output", output.trim())
            .put("component", component.flattenToString()).put("displayId", displayId)
            .put("displayVerified", displayId != 0).put("transport", transport())
            .put("durationMs", android.os.SystemClock.elapsedRealtime() - started);
    }

    static boolean isPackageResumedOnDisplay(String activities, String packageName, int displayId) {
        int current = -1;
        java.util.regex.Pattern header = java.util.regex.Pattern.compile("^Display #(\\d+).*");
        java.util.regex.Pattern activity = java.util.regex.Pattern.compile("(?:topResumedActivity|mResumedActivity)\\s*[=:].*\\s"
            + java.util.regex.Pattern.quote(packageName) + "/[A-Za-z0-9_.$]+");
        for (String line : activities.split("\\r?\\n")) {
            java.util.regex.Matcher match = header.matcher(line.trim());
            if (match.matches()) current = Integer.parseInt(match.group(1));
            else if (current == displayId && activity.matcher(line).find()) return true;
        }
        return false;
    }

    private JSONObject displayInfo(int id) throws Exception {
        JSONArray displays = displays();
        for (int i = 0; i < displays.length(); i++) {
            JSONObject display = displays.getJSONObject(i);
            if (display.getInt("displayId") == id) return display;
        }
        throw new IllegalStateException("DISPLAY_UNAVAILABLE: 指定副屏已关闭或不存在，未操作主屏");
    }

    private JSONArray displays() throws Exception {
        if (shizuku.isReady()) return shizuku.displays();
        JSONArray result = new JSONArray();
        android.hardware.display.DisplayManager manager = context.getSystemService(android.hardware.display.DisplayManager.class);
        for (android.view.Display display : manager.getDisplays()) {
            android.graphics.Point size = new android.graphics.Point();
            display.getRealSize(size);
            result.put(new JSONObject().put("displayId", display.getDisplayId()).put("name", display.getName())
                .put("width", size.x).put("height", size.y).put("rotation", display.getRotation()));
        }
        return result;
    }

    private int screenRotation(int id) throws Exception {
        return id == 0 ? screenRotation() : displayInfo(id).getInt("rotation");
    }

    private JSONObject captureScreenshot(JSONObject request) throws Exception {
        int displayId = request.has("displayId") ? bounded(request, "displayId", 0, Integer.MAX_VALUE) : 0;
        if (displayId != 0 && !shizuku.isReady())
            throw new IllegalStateException("SECONDARY_CAPTURE_UNAVAILABLE: 当前 ADB 连接支持主屏截图；副屏截图需要 Shizuku，未切换到主屏");
        final JSONObject[] result = new JSONObject[1];
        HarnessMonitorService.runWithoutOverlay(() -> {
            result[0] = writeScreenshotPng(displayId == 0 ? captureMainPng()
                : shizuku.captureDisplay(displayId));
            result[0].put("displayId", displayId).put("rotation", screenRotation(displayId));
            if (request.optBoolean("fast", false)) prepareFastScreenshot(result[0], request);
        });
        return result[0];
    }

    private void prepareFastScreenshot(JSONObject result, JSONObject request) throws Exception {
        Bitmap original = BitmapFactory.decodeFile(result.getString("path"));
        if (original == null) throw new IllegalStateException("截图解码失败");
        Bitmap sample = null, crop = null, preview = null;
        try {
            int width = original.getWidth(), height = original.getHeight();
            sample = Bitmap.createScaledBitmap(original, 24, 48, true);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            // Ignore status/navigation strips; quantize colors to reduce noise.
            for (int y = 3; y < 45; y++) for (int x = 0; x < 24; x++) {
                int color = sample.getPixel(x, y);
                digest.update((byte) ((color >> 19) & 31));
                digest.update((byte) ((color >> 11) & 31));
                digest.update((byte) ((color >> 3) & 31));
            }
            StringBuilder hash = new StringBuilder();
            for (byte value : digest.digest()) hash.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            int left = request.optInt("crop_x", 0), top = request.optInt("crop_y", 0);
            int cw = request.optInt("crop_width", width), ch = request.optInt("crop_height", height);
            if (left < 0 || top < 0 || cw <= 0 || ch <= 0 || (long) left + cw > width || (long) top + ch > height)
                throw new IllegalArgumentException("裁剪区域超出截图边界");
            crop = Bitmap.createBitmap(original, left, top, cw, ch);
            // <=30x30 visual cells (42 px each), within the current image budget.
            double scale = 1260.0 / Math.max(cw, ch);
            int vw = Math.max(1, (int) Math.round(cw * scale)), vh = Math.max(1, (int) Math.round(ch * scale));
            // Full screens are never enlarged; requested crops can be enlarged.
            if (cw == width && ch == height && scale > 1) { vw = cw; vh = ch; }
            preview = Bitmap.createScaledBitmap(crop, vw, vh, true);
            String path = result.getString("path").replace(".png", "-view.png");
            try (FileOutputStream out = new FileOutputStream(path)) {
                if (!preview.compress(Bitmap.CompressFormat.PNG, 100, out)) throw new IllegalStateException("截图编码失败");
            }
            result.put("viewPath", path).put("viewWidth", vw).put("viewHeight", vh)
                .put("cropLeft", left).put("cropTop", top).put("cropWidth", cw).put("cropHeight", ch)
                .put("fingerprint", hash.toString());
        } finally {
            if (preview != null && preview != crop && preview != original) preview.recycle();
            if (crop != null && crop != original) crop.recycle();
            if (sample != null && sample != original) sample.recycle();
            original.recycle();
        }
    }

    private JSONObject captureScreenAnalysis() throws Exception {
        final JSONObject[] result = new JSONObject[1];
        HarnessMonitorService.runWithoutOverlay(() -> {
            try {
                byte[] png = captureMainPng();
                JSONObject screenshot = writeScreenshotPng(png);
                String uiXml;
                try {
                    uiXml = new String(execute(
                        "uiautomator dump /data/local/tmp/dsh-ui.xml >/dev/null && cat /data/local/tmp/dsh-ui.xml",
                        2 * 1024 * 1024), StandardCharsets.UTF_8);
                } catch (Exception error) {
                    android.util.Log.w("DSHAndroid", "UI dump failed during screen analysis", error);
                    uiXml = "";
                }
                JSONArray ocr;
                try {
                    ocr = ScreenOcr.recognizeLines(png);
                } catch (Exception error) {
                    android.util.Log.w("DSHAndroid", "OCR failed during screen analysis", error);
                    ocr = new JSONArray();
                }
                result[0] = screenshot.put("uiXml", uiXml).put("ocr", ocr);
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        });
        return result[0];
    }

    private byte[] captureMainPng() throws Exception {
        return execute(ScreenshotCapture.command(java.util.UUID.randomUUID().toString()), 12 * 1024 * 1024);
    }

    private JSONObject writeScreenshotPng(byte[] png) throws Exception {
        if (!ScreenshotCapture.isPng(png)) {
            String detail = new String(png, 0, Math.min(png.length, 240), StandardCharsets.UTF_8)
                .replaceAll("[\\p{Cntrl}&&[^\\n\\t]]", " ").trim();
            throw new IllegalStateException("截图失败（" + transport() + "）："
                + (detail.isEmpty() ? "系统截图命令未输出图像，请检查设备连接与截图权限" : detail));
        }
        int width = pngDimension(png, 16);
        int height = pngDimension(png, 20);
        if (width <= 0 || height <= 0) throw new IllegalStateException("截图尺寸无效");
        File shots = new File(context.getNoBackupFilesDir(), "screenshots");
        if (!shots.exists() && !shots.mkdirs()) throw new IllegalStateException("无法创建截图目录");
        File file = new File(shots, "dsh-screen-" + System.currentTimeMillis() + "-" + System.nanoTime() + ".png");
        try (FileOutputStream out = new FileOutputStream(file)) { out.write(png); }
        return new JSONObject()
            .put("path", file.getAbsolutePath())
            .put("rotation", screenRotation())
            .put("width", width)
            .put("height", height);
    }

    private static int pngDimension(byte[] png, int offset) {
        return ((png[offset] & 0xff) << 24) | ((png[offset + 1] & 0xff) << 16)
            | ((png[offset + 2] & 0xff) << 8) | (png[offset + 3] & 0xff);
    }

    private JSONObject storageStatus() throws Exception {
        return new JSONObject()
            .put("granted", Build.VERSION.SDK_INT < Build.VERSION_CODES.R
                || Environment.isExternalStorageManager())
            .put("storageRoot", Environment.getExternalStorageDirectory().getAbsolutePath());
    }

    private JSONObject androidSettings() throws Exception {
        return storageStatus()
            .put("shizukuConnected", shizuku.isReady())
            .put("shizukuStatus", shizuku.statusMessage())
            .put("adbConnected", adb.isConnected())
            .put("adbStatus", adb.isConnected() ? "无线 ADB 已连接" : AdbClient.pairingStatus)
            .put("rootAvailable", root.isReady()).put("rootStatus", root.statusMessage())
            .put("rootEnabled", rootEnabled)
            .put("overlayGranted", android.provider.Settings.canDrawOverlays(context))
            .put("virtualDisplayAllowed", context.getSharedPreferences("dsh_setup", 0).getBoolean("virtualDisplayAllowed", false))
            .put("virtualDisplayEnabled", !virtualDisplaySetting().isEmpty())
            .put("virtualDisplayManaged", VIRTUAL_SCREEN.equals(virtualDisplaySetting()))
            .put("virtualDisplayStatus", virtualDisplaySetting().isEmpty() ? "尚未开启模拟辅助显示设备" : "已开启：" + virtualDisplaySetting())
            .put("virtualDisplayCanManage", deviceConnected())
            .put("controlEnabled", controlEnabled)
            .put("shellEnabled", shellEnabled);
    }

    private String virtualDisplaySetting() {
        String value = android.provider.Settings.Global.getString(context.getContentResolver(), "overlay_display_devices");
        return value == null || value.equals("null") ? "" : value;
    }

    private synchronized JSONObject inputUnicode(String text, int displayId) throws Exception {
        String ime = context.getPackageName() + "/.UnicodeInputService";
        String previous = android.provider.Settings.Secure.getString(context.getContentResolver(), "default_input_method");
        String enabled = new String(execute("settings get secure enabled_input_methods", 16384), StandardCharsets.UTF_8).trim();
        boolean wasEnabled = enabled != null && java.util.Arrays.stream(enabled.split(":")).anyMatch(row -> row.split(";", 2)[0].equals(ime));
        if (previous == null || previous.isEmpty()) throw new IllegalStateException("无法读取原输入法，未执行输入");
        long started = android.os.SystemClock.elapsedRealtime();
        try {
            execute("ime enable " + quote(ime) + " && ime set " + quote(ime), 16384);
            String selected = android.provider.Settings.Secure.getString(context.getContentResolver(), "default_input_method");
            if (!ime.equals(selected)) throw new IllegalStateException("无法切换 Unicode 输入法，请检查 Shizuku 或 Root 授权");
            UnicodeInputService.Target inputTarget = null;
            for (int attempt = 0; attempt < 30; attempt++) {
                UnicodeInputService.Target target = UnicodeInputService.target();
                if (target != null) {
                    String state = new String(execute("dumpsys input_method", 1024 * 1024), StandardCharsets.UTF_8);
                    if (isInputTargetOnDisplay(state, target.uid, target.pid, displayId)) { inputTarget = target; break; }
                }
                Thread.sleep(100);
            }
            if (inputTarget == null) throw new IllegalStateException("INPUT_DISPLAY_MISMATCH: 系统未确认输入连接属于指定屏幕，请先点击该屏的输入框；键盘窗口在主屏并不表示副屏不能输入");
            UnicodeInputService.commit(text, inputTarget);
            return new JSONObject().put("ok", true).put("exitCode", 0).put("output", "Unicode 文字已提交，请检查输入框内容")
                .put("displayId", displayId).put("transport", transport()).put("inputMethod", "unicode-ime")
                .put("durationMs", android.os.SystemClock.elapsedRealtime() - started);
        } finally {
            try {
                execute("ime set " + quote(previous) + (wasEnabled ? "" : "; ime disable " + quote(ime)), 16384);
            } catch (Exception error) { android.util.Log.e("DSHAndroid", "恢复输入法失败，请在系统设置中手动切换", error); }
        }
    }

    static boolean isInputTargetOnDisplay(String state, int uid, int pid, int displayId) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("mCurClient=ClientState\\{[^}]*mUid=(\\d+)\\s+mPid=(\\d+)\\s+mSelfReportedDisplayId=(\\d+)[^}]*\\}").matcher(state);
        boolean found = false;
        while (matcher.find()) {
            if (Integer.parseInt(matcher.group(1)) != uid || Integer.parseInt(matcher.group(2)) != pid
                    || Integer.parseInt(matcher.group(3)) != displayId) return false;
            found = true;
        }
        return found;
    }

    synchronized void configureVirtualDisplay(boolean enabled) throws Exception {
        if (!deviceConnected()) throw new IllegalStateException("请先连接 Shizuku、无线 ADB 或授权 Root；也可在开发者选项中手动设置");
        String current = virtualDisplaySetting();
        android.content.SharedPreferences prefs = context.getSharedPreferences("dsh_setup", 0);
        if (enabled) {
            if (!current.isEmpty() && !current.equals(VIRTUAL_SCREEN)) throw new IllegalStateException("已有其他模拟副屏，请先在开发者选项中关闭，避免覆盖现有配置");
            execute("settings put global overlay_display_devices " + quote(VIRTUAL_SCREEN), 16384);
        } else {
            if (!current.equals(VIRTUAL_SCREEN)) throw new IllegalStateException("当前副屏不是 DSHAN 创建的，请在开发者选项中管理");
            execute("settings delete global overlay_display_devices", 16384);
        }
        if (!virtualDisplaySetting().equals(enabled ? VIRTUAL_SCREEN : "")) throw new IllegalStateException("系统未接受虚拟副屏设置，请检查授权或开发者选项");
        if (enabled) prefs.edit().putBoolean("virtualDisplayAllowed", true).apply();
    }

    private void runOnMain(Runnable action) throws Exception {
        java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<RuntimeException> failure = new java.util.concurrent.atomic.AtomicReference<>();
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try { action.run(); } catch (RuntimeException error) { failure.set(error); }
            finally { done.countDown(); }
        });
        if (!done.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new IllegalStateException("设置操作超时，请重试");
        if (failure.get() != null) throw failure.get();
    }

    private JSONObject listDirectory(JSONObject request) throws Exception {
        String dirPath = request.getString("path");
        if (dirPath.isEmpty() || dirPath.length() > 4096) throw new IllegalArgumentException("路径无效");
        File dir = new File(dirPath).getCanonicalFile();
        if (!dir.exists()) throw new IllegalStateException("目录不存在：" + dirPath);
        if (!dir.isDirectory()) throw new IllegalStateException("不是目录：" + dirPath);
        JSONArray entries = listEntriesViaJava(dir);
        if ((entries == null || (entries.length() == 0 && isSharedStorage(dir.getAbsolutePath())))
            && deviceConnected()) {
            JSONArray shellEntries = listEntriesViaShell(dir);
            if (shellEntries != null && shellEntries.length() > 0) entries = shellEntries;
        }
        if (entries == null) {
            if (isSharedStorage(dir.getAbsolutePath())
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                && !Environment.isExternalStorageManager()) {
                throw new IllegalStateException("需要授予“所有文件访问”权限才能浏览内部存储");
            }
            throw new IllegalStateException("无法读取目录：" + dir.getAbsolutePath());
        }
        return new JSONObject()
            .put("path", dir.getAbsolutePath())
            .put("entries", entries)
            .put("truncated", entries.length() >= 1000);
    }

    private JSONArray listEntriesViaJava(File dir) throws Exception {
        String[] names = dir.list();
        if (names == null) return null;
        java.util.Arrays.sort(names, String::compareToIgnoreCase);
        JSONArray entries = new JSONArray();
        for (String name : names) {
            File child = new File(dir, name);
            if (!child.isDirectory()) continue;
            if (entries.length() >= 1000) break;
            String childPath;
            try {
                childPath = child.getCanonicalPath();
            } catch (Exception ignored) {
                childPath = child.getAbsolutePath();
            }
            entries.put(new JSONObject()
                .put("name", name)
                .put("path", childPath)
                .put("hidden", name.startsWith(".")));
        }
        return entries;
    }

    private JSONArray listEntriesViaShell(File dir) throws Exception { // JSONException included
        if (!deviceConnected()) return null;
        String path = dir.getAbsolutePath();
        byte[] raw = execute("ls -1p " + shellQuote(path), 512 * 1024);
        String text = new String(raw, StandardCharsets.UTF_8).trim();
        if (text.isEmpty()) return new JSONArray();
        JSONArray entries = new JSONArray();
        for (String line : text.split("\n")) {
            line = line.trim();
            if (line.isEmpty() || !line.endsWith("/")) continue;
            String name = line.substring(0, line.length() - 1);
            if (name.equals(".") || name.equals("..")) continue;
            if (entries.length() >= 1000) break;
            File child = new File(dir, name);
            entries.put(new JSONObject()
                .put("name", name)
                .put("path", child.getAbsolutePath())
                .put("hidden", name.startsWith(".")));
        }
        return entries;
    }

    private static String shellQuote(String text) {
        return "'" + text.replace("'", "'\\''") + "'";
    }

    private static boolean isSharedStorage(String path) {
        return path.startsWith("/storage/") || path.startsWith("/sdcard");
    }

    private byte[] execute(String command, int maxBytes) throws Exception {
        if (rootEnabled) return root.execute(command, maxBytes);
        return shizuku.isReady() ? shizuku.execute(command, maxBytes) : adb.execute(command, maxBytes);
    }

    private boolean deviceConnected() { return rootEnabled ? root.isReady() : shizuku.isReady() || adb.isConnected(); }
    private String transport() { return rootEnabled ? (root.isReady() ? "root" : "none") : shizuku.isReady() ? "shizuku" : adb.isConnected() ? "wireless-adb" : "none"; }

    private static int coordinate(JSONObject data, String name) throws Exception {
        return bounded(data, name, 0, 10000);
    }

    private static int bounded(JSONObject data, String name, int min, int max) throws Exception {
        double value = data.getDouble(name);
        if (!Double.isFinite(value) || value != Math.rint(value) || value < min || value > max)
            throw new IllegalArgumentException(name + " 必须是范围内的整数");
        return (int) value;
    }

    private static String quote(String text) { return "'" + text.replace("'", "'\\''") + "'"; }

    private void openTextFile(String pathStr) {
        openDocument(pathStr, "text/plain", null);
    }

    private File authorizedDocument(String path) throws Exception {
        if (path.isEmpty() || path.length() > 4096 || path.indexOf('\0') >= 0 || !new File(path).isAbsolute())
            throw new IllegalArgumentException("路径无效");
        File source = new File(path).getCanonicalFile();
        if (!isAllowedDocumentPath(source)) throw new SecurityException("不允许打开该路径：" + path);
        if (!source.isFile()) throw new IllegalStateException("文件不存在或不是普通文件");
        return source;
    }

    private static String documentMime(File source) {
        String name = source.getName();
        int dot = name.lastIndexOf('.');
        String extension = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        String mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        if (mime != null) return mime;
        if (java.util.Arrays.asList("yml", "yaml", "json", "md", "log", "js", "ts", "toml", "ini").contains(extension)) return "text/plain";
        return "application/octet-stream";
    }

    private void openDocument(String pathStr, String mime, android.content.ComponentName application) {
        try {
            File source = authorizedDocument(pathStr);
            File sharedDir = new File(context.getCacheDir(), "shared-documents");
            if (!sharedDir.exists() && !sharedDir.mkdirs()) throw new IllegalStateException("无法创建共享目录");
            File directory = new File(sharedDir, java.util.UUID.randomUUID().toString());
            if (!directory.mkdir()) throw new IllegalStateException("无法创建共享目录");
            File shared = new File(directory, source.getName());
            java.nio.file.Files.copy(source.toPath(), shared.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                context, context.getPackageName() + ".files", shared);
            if (application == null) launchDocumentViewer(uri, mime);
            else context.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW)
                .setDataAndType(uri, mime).setComponent(application)
                .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException error) {
            android.util.Log.e("DSHAndroid", "openTextFile failed for " + pathStr, error);
            throw error;
        } catch (Exception error) {
            android.util.Log.e("DSHAndroid", "openTextFile failed for " + pathStr, error);
            throw new IllegalStateException("无法打开配置文件：" + error.getMessage(), error);
        }
    }

    private void launchDocumentViewer(android.net.Uri uri, String mimeType) {
        android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
        intent.setDataAndType(uri, mimeType);
        intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
            | android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        android.content.Intent chooser = android.content.Intent.createChooser(intent, "打开文件");
        chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(chooser);
        } catch (android.content.ActivityNotFoundException error) {
            if ("*/*".equals(mimeType)) throw error;
            launchDocumentViewer(uri, "*/*");
        }
    }

    private boolean isAllowedDocumentPath(File file) throws Exception {
        String path = file.getCanonicalPath();
        String noBackup = context.getNoBackupFilesDir().getCanonicalPath();
        String files = context.getFilesDir().getCanonicalPath();
        String cache = context.getCacheDir().getCanonicalPath();
        if (withinPath(path, noBackup) || withinPath(path, files) || withinPath(path, cache)) return true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()) {
            String storage = Environment.getExternalStorageDirectory().getCanonicalPath();
            return withinPath(path, storage);
        }
        return false;
    }

    private static boolean withinPath(String path, String root) {
        return path.equals(root) || path.startsWith(root + File.separator);
    }

    private static void reply(Socket socket, int status, JSONObject json) throws Exception {
        byte[] body = json.toString().getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : " Error") + "\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
        OutputStream out = socket.getOutputStream();
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }
}
