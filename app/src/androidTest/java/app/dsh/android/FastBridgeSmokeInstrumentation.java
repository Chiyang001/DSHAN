package app.dsh.android;

import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import org.json.JSONObject;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/** No model API calls or user text. Uses the user's existing control toggles. */
public final class FastBridgeSmokeInstrumentation extends Instrumentation {
    private BridgeServer bridge;
    private Method dispatch;
    private boolean webviewCompatOnly;
    private boolean nonRootCheck;
    private boolean unicodeInputCheck;
    private boolean adbPairingCheck;
    private boolean adbStreamCheck;
    private boolean captureOnly;
    private boolean shizukuLifecycleCheck;
    private int launchDisplay = -1;
    private int unicodeDisplay;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        webviewCompatOnly = arguments != null && "true".equals(arguments.getString("webviewCompat"));
        nonRootCheck = arguments != null && "true".equals(arguments.getString("nonRootCheck"));
        unicodeInputCheck = arguments != null && "true".equals(arguments.getString("unicodeInputCheck"));
        adbPairingCheck = arguments != null && "true".equals(arguments.getString("adbPairingCheck"));
        adbStreamCheck = arguments != null && "true".equals(arguments.getString("adbStreamCheck"));
        captureOnly = arguments != null && "true".equals(arguments.getString("captureOnly"));
        shizukuLifecycleCheck = arguments != null && "true".equals(arguments.getString("shizukuLifecycleCheck"));
        if (arguments != null && arguments.containsKey("launchDisplay")) launchDisplay = Integer.parseInt(arguments.getString("launchDisplay"));
        if (arguments != null && arguments.containsKey("unicodeDisplay")) unicodeDisplay = Integer.parseInt(arguments.getString("unicodeDisplay"));
        start();
    }

    private void verifyWebviewCompatibility(Bundle report) throws Exception {
        String host;
        try (java.io.InputStream input = getTargetContext().getAssets().open("android-host.js")) {
            host = new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
        String marker = "const ANDROID_COMPAT_SCRIPT = `";
        int begin = host.indexOf(marker);
        check(begin >= 0, "Compatibility script asset exists");
        begin += marker.length();
        String script = host.substring(begin, host.indexOf('`', begin));
        java.util.concurrent.CountDownLatch finished = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<String> result = new java.util.concurrent.atomic.AtomicReference<>();
        android.webkit.WebView[] view = new android.webkit.WebView[1];
        runOnMainSync(() -> {
            view[0] = new android.webkit.WebView(getTargetContext());
            view[0].getSettings().setJavaScriptEnabled(true);
            view[0].evaluateJavascript(
                "(function(){Promise.withResolvers=undefined;AbortSignal.any=undefined;" +
                "Array.prototype.toSorted=undefined;" + script +
                "var opening=Promise.withResolvers();opening.resolve('ready');" +
                "var a=new AbortController(),b=new AbortController();" +
                "var combined=AbortSignal.any([a.signal,b.signal]);b.abort('stopped');" +
                "var clicks=0;var button=document.createElement('button');" +
                "button.onclick=function(){clicks++};button.click();" +
                "window.__compatResult='pending';opening.promise.then(function(value){" +
                "window.__compatResult=(value==='ready'&&combined.aborted&&" +
                "combined.reason==='stopped'&&clicks===1&&[2,1].toSorted()[0]===1)?'ok':'failed'});" +
                "return 'started'})()", ignored -> view[0].evaluateJavascript(
                    "window.__compatResult", value -> { result.set(value); finished.countDown(); }));
        });
        try {
            check(finished.await(15, java.util.concurrent.TimeUnit.SECONDS), "WebView compatibility deadline");
            check("\"ok\"".equals(result.get()), "WebView compatibility result: " + result.get());
            report.putString("result", "WEBVIEW_COMPAT_SMOKE_OK");
        } finally {
            runOnMainSync(() -> view[0].destroy());
        }
    }

    private JSONObject call(JSONObject request) throws Exception {
        try { return (JSONObject) dispatch.invoke(bridge, request); }
        catch (InvocationTargetException error) {
            if (error.getCause() instanceof Exception) throw (Exception) error.getCause();
            throw error;
        }
    }
    private void check(boolean condition, String description) {
        if (!condition) throw new AssertionError(description);
    }

    @Override public void onStart() {
        Bundle report = new Bundle();
        try {
            if (shizukuLifecycleCheck) {
                verifyShizukuLifecycle(report);
                finish(-1, report);
                return;
            }
            if (adbStreamCheck) {
                verifyAdbCommandStream(report);
                finish(-1, report);
                return;
            }
            if (adbPairingCheck) {
                verifyAdbPairingNotification(report);
                finish(-1, report);
                return;
            }
            if (unicodeInputCheck) {
                verifyUnicodeInput(report);
                finish(-1, report);
                return;
            }
            if (webviewCompatOnly) {
                verifyWebviewCompatibility(report);
                finish(-1, report);
                return;
            }
            startActivitySync(new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            Field bridgeField = MainActivity.class.getDeclaredField("bridge");
            bridgeField.setAccessible(true);
            dispatch = BridgeServer.class.getDeclaredMethod("dispatch", JSONObject.class);
            dispatch.setAccessible(true);
            JSONObject status = null;
            for (int i = 0; i < 100; i++) {
                bridge = (BridgeServer) bridgeField.get(null);
                if (bridge != null) {
                    status = call(new JSONObject().put("method", "status"));
                    if (status.optBoolean("connected")) break;
                }
                Thread.sleep(100);
            }
            if (nonRootCheck) {
                check(bridge != null, "Bridge initialized");
                JSONObject settings = call(new JSONObject().put("method", "requestRoot"));
                check(!settings.getBoolean("rootAvailable"), "Non-root phone must not acquire Root");
                check(!settings.getBoolean("rootEnabled"), "Root mode remains disabled");
                try {
                    call(new JSONObject().put("method", "updateAndroidSettings").put("rootEnabled", true));
                    throw new AssertionError("Unavailable Root was enabled");
                } catch (IllegalStateException expected) { }
                report.putString("rootCheck", "NON_ROOT_REJECTION_OK");
                report.putString("rootStatus", settings.getString("rootStatus"));
            }
            check(status != null && status.optBoolean("connected"), "Existing Shizuku/ADB authorization required");
            check(status.optBoolean("controlEnabled"), "Existing phone-control toggle required");
            report.putString("transport", status.getString("transport"));
            if (launchDisplay > 0) {
                check(BridgeServer.isPackageResumedOnDisplay("Display #0 (activities):\n topResumedActivity=ActivityRecord{x u0 tv.danmaku.bili/.MainActivity t1}\nDisplay #19 (activities):\n topResumedActivity=ActivityRecord{x u0 com.android.settings/.Settings t2}", "com.android.settings", 19), "Display parser accepts target");
                check(!BridgeServer.isPackageResumedOnDisplay("Display #0 (activities):\n topResumedActivity=ActivityRecord{x u0 tv.danmaku.bili/.MainActivity t1}\nDisplay #19 (activities):", "tv.danmaku.bili", 19), "Display parser rejects main-screen activity");
                for (String pkg : new String[] { "com.android.settings", "tv.danmaku.bili", "com.tencent.mm" }) {
                    JSONObject receipt = call(new JSONObject().put("method", "launch").put("package", pkg).put("displayId", launchDisplay));
                    check(receipt.getBoolean("ok") && receipt.getBoolean("displayVerified"), "Verified launch " + pkg);
                    report.putString(pkg, receipt.getString("component") + " on display " + launchDisplay);
                }
                report.putString("result", "SECONDARY_EXPLICIT_LAUNCH_SMOKE_OK");
                finish(-1, report);
                return;
            }

            long started = android.os.SystemClock.elapsedRealtime();
            JSONObject shot = call(new JSONObject().put("method", "screenshot").put("fast", true));
            report.putLong("fastScreenshotMs", android.os.SystemClock.elapsedRealtime() - started);
            check(shot.getString("fingerprint").length() == 64, "Screenshot fingerprint");
            Bitmap preview = BitmapFactory.decodeFile(shot.getString("viewPath"));
            check(preview != null && preview.getWidth() == shot.getInt("viewWidth") && preview.getHeight() == shot.getInt("viewHeight"), "Preview dimensions");
            check(Math.max(preview.getWidth(), preview.getHeight()) <= 1260, "Image vision budget");
            preview.recycle();
            report.putString("preview", shot.getInt("viewWidth") + "x" + shot.getInt("viewHeight"));
            report.putString("device", shot.getInt("width") + "x" + shot.getInt("height"));
            if (captureOnly) {
                JSONObject screen = call(new JSONObject().put("method", "screen"));
                check(screen.getInt("width") > 0 && screen.has("uiXml"), "Screen analysis screenshot succeeds");
                report.putString("result", "CAPTURE_AND_SCREEN_OK");
                finish(-1, report);
                return;
            }

            JSONObject crop = call(new JSONObject().put("method", "screenshot").put("fast", true)
                .put("crop_x", 100).put("crop_y", 200).put("crop_width", 300).put("crop_height", 150));
            check(crop.getInt("cropLeft") == 100 && crop.getInt("cropTop") == 200 && crop.getInt("viewWidth") == 1260 && crop.getInt("viewHeight") == 630, "Crop and zoom geometry");

            JSONObject tap = call(new JSONObject().put("method", "tap").put("x", 0).put("y", 0).put("expectedRotation", shot.getInt("rotation")));
            check(tap.getBoolean("ok") && tap.getInt("exitCode") == 0, "Corner input command receipt");
            report.putLong("tapCommandMs", tap.getLong("durationMs"));
            check(tap.has("output"), "Empty stdout must have an explicit exit status");
            try {
                call(new JSONObject().put("method", "tap").put("x", 0).put("y", 0).put("expectedRotation", -1));
                throw new AssertionError("Invalid orientation was accepted");
            } catch (IllegalStateException expected) { check(expected.getMessage().contains("SCREEN_ROTATED"), "Orientation rejection"); }

            if (status.optBoolean("shellEnabled")) {
                JSONObject empty = call(new JSONObject().put("method", "shell").put("command", "true"));
                check(empty.getBoolean("ok") && empty.getInt("exitCode") == 0 && empty.getString("output").isEmpty(), "Successful empty command");
                JSONObject failed = call(new JSONObject().put("method", "shell").put("command", "false"));
                check(!failed.getBoolean("ok") && failed.getInt("exitCode") == 1, "Failed empty command must not report success");
                JSONObject quoted = call(new JSONObject().put("method", "shell").put("command", "printf '%s' \"DSHAN 'quoted'\""));
                check(quoted.getBoolean("ok") && quoted.getString("output").equals("DSHAN 'quoted'"), "Command quoting preserves output");
                report.putString("commandReceipts", "empty-success, nonzero-failure, quoting: passed");
            } else report.putString("commandReceipts", "shell tests skipped: advanced shell toggle disabled");
            report.putString("result", "FAST_BRIDGE_SMOKE_OK");
            finish(-1, report);
        } catch (Throwable error) {
            report.putString("result", "FAST_BRIDGE_SMOKE_FAILED");
            report.putString("error", error.getClass().getSimpleName() + ": " + error.getMessage());
            if (adbStreamCheck) report.putString("stack", android.util.Log.getStackTraceString(error));
            finish(0, report);
        }
    }

    private void verifyAdbPairingNotification(Bundle report) throws Exception {
        android.content.Context context = getTargetContext();
        android.app.NotificationManager manager = context.getSystemService(android.app.NotificationManager.class);
        context.startForegroundService(new Intent(context, AdbPairingService.class).setAction(AdbPairingService.START));
        try {
            android.app.Notification notification = null;
            for (int attempt = 0; attempt < 100; attempt++) {
                for (android.service.notification.StatusBarNotification entry : manager.getActiveNotifications()) {
                    if (entry.getId() == 19 && entry.getNotification().actions != null
                            && entry.getNotification().actions[0].getRemoteInputs() != null) notification = entry.getNotification();
                }
                if (notification != null) break;
                Thread.sleep(100);
            }
            check(notification != null, "Pairing notification exposes inline input");
            android.app.Notification.Action input = notification.actions[0];
            check(input.actionIntent.isService(), "Reply goes to Service without launching Activity");
            check(!input.actionIntent.isImmutable(), "RemoteInput PendingIntent accepts reply fill-in");
            Bundle result = new Bundle();
            result.putCharSequence(input.getRemoteInputs()[0].getResultKey(), "123");
            Intent reply = new Intent();
            android.app.RemoteInput.addResultsToIntent(input.getRemoteInputs(), reply, result);
            input.actionIntent.send(context, 0, reply);
            for (int attempt = 0; attempt < 50 && !AdbClient.pairingStatus.contains("请输入六位"); attempt++) Thread.sleep(100);
            check(AdbClient.pairingStatus.contains("请输入六位"), "Invalid reply is rejected without pairing");
            boolean retry = false;
            for (android.service.notification.StatusBarNotification entry : manager.getActiveNotifications()) {
                if (entry.getId() == 19) retry = entry.getNotification().actions[0].getRemoteInputs() != null;
            }
            check(retry, "Input remains available after invalid reply");
            report.putString("adbPairing", "INLINE_SERVICE_REPLY_VALIDATION_OK");
        } finally {
            context.startService(new Intent(context, AdbPairingService.class).setAction("app.dsh.android.ADB_PAIR_CANCEL"));
            for (int attempt = 0; attempt < 30 && !AdbClient.pairingStatus.equals("已取消 ADB 配对"); attempt++) Thread.sleep(100);
            check(AdbClient.pairingStatus.equals("已取消 ADB 配对"), "Pairing can be cancelled");
            manager.cancel(19);
        }
    }

    /** Exercise the packaged libadb against a local daemon that closes immediately after output. */
    private void verifyAdbCommandStream(Bundle report) throws Exception {
        byte[] expected = new byte[20000];
        for (int i = 0; i < expected.length; i++) expected[i] = (byte) i;
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        try (java.net.ServerSocket server = new java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"));
             AdbClient client = new AdbClient(getTargetContext())) {
            server.setSoTimeout(5000);
            Thread daemon = new Thread(() -> {
                try (java.net.Socket socket = server.accept()) {
                    socket.setSoTimeout(5000);
                    java.io.InputStream in = socket.getInputStream();
                    java.io.OutputStream out = socket.getOutputStream();
                    int[] hello = readAdbPacket(in);
                    check(hello[0] == 0x4e584e43, "ADB handshake");
                    sendAdbPacket(out, 0x4e584e43, 0x01000001, 65536, "device::features=shell_v2;\0".getBytes());
                    int[] open = readAdbPacket(in);
                    check(open[0] == 0x4e45504f, "ADB stream opens");
                    check(new String(lastAdbPayload).startsWith("shell,v2,raw:"), "Uses shell v2 raw service");
                    sendAdbPacket(out, 0x59414b4f, 1, open[1], new byte[0]);
                    java.io.ByteArrayOutputStream frames = new java.io.ByteArrayOutputStream();
                    frames.write(1);
                    for (int i = 0; i < 4; i++) frames.write(expected.length >>> (8 * i) & 255);
                    frames.write(expected);
                    frames.write(new byte[] {3, 1, 0, 0, 0, 0});
                    sendAdbPacket(out, 0x45545257, 1, open[1], frames.toByteArray());
                    sendAdbPacket(out, 0x45534c43, 1, open[1], new byte[0]);
                    // Keep the transport open; a command cannot depend on socket EOF.
                    Thread.sleep(1000);
                } catch (Throwable error) { failure.set(error); }
            }, "dsh-test-adbd");
            daemon.start();
            report.putString("stage", "connect");
            check(client.connect("127.0.0.1", server.getLocalPort()), "Local ADB handshake connects");
            report.putString("stage", "execute");
            check(java.util.Arrays.equals(expected, client.execute("test-command", expected.length)),
                "Full binary output survives immediate CLSE without waiting for EOF");
            daemon.join(5000);
            if (failure.get() != null) throw new AssertionError(failure.get());
            report.putString("adbStream", "PACKAGED_LIBADB_BINARY_CLSE_OK");
        }
    }

    private byte[] lastAdbPayload;

    private void verifyShizukuLifecycle(Bundle report) throws Exception {
        runOnMainSync(() -> {
            try {
                ShizukuClient client = new ShizukuClient(getTargetContext());
                Method factory = ShizukuClient.class.getDeclaredMethod("newConnection");
                factory.setAccessible(true);
                Field active = ShizukuClient.class.getDeclaredField("connection");
                active.setAccessible(true);
                Field binding = ShizukuClient.class.getDeclaredField("binding");
                binding.setAccessible(true);
                android.content.ServiceConnection stale = (android.content.ServiceConnection) factory.invoke(client);
                android.content.ServiceConnection current = (android.content.ServiceConnection) factory.invoke(client);
                active.set(client, current);
                binding.setBoolean(client, true);
                android.content.ComponentName name = new android.content.ComponentName(getTargetContext(), RemoteShellService.class);
                android.os.Binder privileged = fakeServiceUid(2000);
                stale.onServiceConnected(name, privileged);
                check(!client.isReady(), "Late callback from replaced binding cannot mark connected");
                current.onServiceConnected(name, privileged);
                check(client.isReady(), "Verified shell service marks connected");
                current.onServiceDisconnected(name);
                check(!client.isReady(), "Disconnected service clears ready state");
                try { RemoteShellService.verifyOn(fakeServiceUid(12345)); throw new AssertionError("App UID accepted"); }
                catch (android.os.RemoteException expected) { }
                try { RemoteShellService.verifyOn(new android.os.Binder()); throw new AssertionError("Obsolete service accepted"); }
                catch (android.os.RemoteException expected) { }
                report.putString("shizukuLifecycle", "STALE_CALLBACK_AND_SERVICE_HEALTH_OK");
            } catch (Exception error) { throw new RuntimeException(error); }
        });
    }

    private android.os.Binder fakeServiceUid(int uid) {
        return new android.os.Binder() {
            @Override protected boolean onTransact(int code, android.os.Parcel data, android.os.Parcel reply, int flags) {
                reply.writeNoException();
                reply.writeInt(uid);
                return true;
            }
        };
    }
    private int[] readAdbPacket(java.io.InputStream in) throws Exception {
        byte[] header = in.readNBytes(24);
        check(header.length == 24, "Complete ADB header");
        java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(header).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        int command = buffer.getInt(), arg0 = buffer.getInt(), arg1 = buffer.getInt(), size = buffer.getInt();
        check(size >= 0 && size <= 65536, "Bounded ADB test packet");
        lastAdbPayload = in.readNBytes(size);
        check(lastAdbPayload.length == size, "Complete ADB payload");
        return new int[] {command, arg0, arg1};
    }
    private void sendAdbPacket(java.io.OutputStream out, int command, int arg0, int arg1, byte[] data) throws Exception {
        int checksum = 0;
        for (byte value : data) checksum += value & 255;
        java.nio.ByteBuffer header = java.nio.ByteBuffer.allocate(24).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        header.putInt(command).putInt(arg0).putInt(arg1).putInt(data.length).putInt(checksum).putInt(command ^ -1);
        out.write(header.array()); out.write(data); out.flush();
    }

    private void shell(String command) throws Exception {
        try (java.io.InputStream input = new android.os.ParcelFileDescriptor.AutoCloseInputStream(getUiAutomation().executeShellCommand(command))) {
            input.readAllBytes();
        }
    }

    private void verifyUnicodeInput(Bundle report) throws Exception {
        startActivitySync(new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Field bridgeField = MainActivity.class.getDeclaredField("bridge");
        bridgeField.setAccessible(true);
        dispatch = BridgeServer.class.getDeclaredMethod("dispatch", JSONObject.class);
        dispatch.setAccessible(true);
        for (int i = 0; i < 100; i++) {
            bridge = (BridgeServer) bridgeField.get(null);
            if (bridge != null && call(new JSONObject().put("method", "status")).optBoolean("connected")) break;
            Thread.sleep(100);
        }
        String previous = android.provider.Settings.Secure.getString(getTargetContext().getContentResolver(), "default_input_method");
        String ime = getTargetContext().getPackageName() + "/.UnicodeInputService";
        android.app.ActivityOptions options = android.app.ActivityOptions.makeBasic();
        options.setLaunchDisplayId(unicodeDisplay);
        android.app.Activity activity = startActivitySync(new Intent().setClassName(getTargetContext(), "app.dsh.android.UnicodeInputTestActivity")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_MULTIPLE_TASK), options.toBundle());
        try {
            String expected = "中文输入，测试！Hello 123 %s 😀\n第二行";
            check(activity.getDisplay().getDisplayId() == unicodeDisplay, "Editor stays on requested screen");
            check(BridgeServer.isInputTargetOnDisplay("mCurClient=ClientState{x mUid=123 mPid=456 mSelfReportedDisplayId=22}", 123, 456, 22), "Target parser accepts secondary editor");
            check(!BridgeServer.isInputTargetOnDisplay("mCurClient=ClientState{x mUid=123 mPid=456 mSelfReportedDisplayId=0}", 123, 456, 22), "Target parser rejects main-screen editor");
            JSONObject receipt = call(new JSONObject().put("method", "text").put("text", expected).put("displayId", unicodeDisplay));
            check(receipt.getBoolean("ok") && receipt.getString("inputMethod").equals("unicode-ime"), "Unicode bridge receipt");
            check(previous.equals(android.provider.Settings.Secure.getString(getTargetContext().getContentResolver(), "default_input_method")), "Previous keyboard restored");
            Thread.sleep(500);
            Field field = activity.getClass().getDeclaredField("editor");
            field.setAccessible(true);
            java.util.concurrent.atomic.AtomicReference<String> value = new java.util.concurrent.atomic.AtomicReference<>();
            runOnMainSync(() -> {
                try { value.set(((android.widget.EditText) field.get(activity)).getText().toString()); }
                catch (Exception error) { throw new RuntimeException(error); }
            });
            check(expected.equals(value.get()), "Unicode text round-trip");
            report.putString("result", "UNICODE_INPUT_SMOKE_OK: Shizuku bridge, Chinese, mixed text, punctuation, percent-s, emoji, newline, keyboard restoration");
            report.putInt("editorDisplay", unicodeDisplay);
        } finally {
            if (previous != null && previous.matches("[A-Za-z0-9_./]+")) shell("ime set " + previous);
            shell("ime disable " + ime);
            runOnMainSync(activity::finish);
        }
    }
}
