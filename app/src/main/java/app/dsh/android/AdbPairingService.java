package app.dsh.android;

import android.app.*;
import android.content.Intent;
import android.os.*;
import io.github.muntashirakon.adb.android.AdbMdns;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Inline replies never launch an Activity, keeping the system pairing dialog alive. */
public final class AdbPairingService extends Service {
    static final String CHANNEL = "adb-pairing";
    static final String START = "app.dsh.android.ADB_PAIR_START";
    private static final String REPLY = "app.dsh.android.ADB_PAIR_REPLY";
    private static final String CANCEL = "app.dsh.android.ADB_PAIR_CANCEL";
    private static final String INPUT = "adb-input";
    private static final int NOTIFICATION = 19;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private AdbMdns pairingDiscovery, connectDiscovery;
    private AdbClient adb;
    private int pairingPort = -1, connectPort = -1;
    private boolean paired, busy, destroyed;
    private boolean started;
    private final Runnable timeout = () -> finish("ADB 配对连接等待超时，请在应用中重新开始");

    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, "无线 ADB 配对", NotificationManager.IMPORTANCE_DEFAULT));
    }

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        // Every foreground start must be promoted immediately, before key generation.
        if (!started) {
            started = true;
            startForeground(NOTIFICATION, notification("准备配对通知…", false));
            main.postDelayed(timeout, 300000);
            worker.execute(() -> {
                try {
                    AdbClient client = AdbClient.get(this);
                    main.post(() -> { if (!destroyed) { adb = client; discover(); } });
                } catch (Exception error) { main.post(() -> finish("ADB 初始化失败，请重新开始")); }
            });
        }
        if (intent == null || CANCEL.equals(intent.getAction())) {
            finish("已取消 ADB 配对");
            return START_NOT_STICKY;
        }
        if (REPLY.equals(intent.getAction())) {
            Bundle results = RemoteInput.getResultsFromIntent(intent);
            CharSequence input = results == null ? null : results.getCharSequence(INPUT);
            if (input != null && !busy) submit(input.toString());
        }
        return START_NOT_STICKY;
    }

    private void discover() {
        pairingDiscovery = new AdbMdns(this, AdbMdns.SERVICE_TYPE_TLS_PAIRING, (host, port) -> main.post(() -> {
            if (destroyed) return;
            pairingPort = port;
            if (!busy && !paired) publish(port > 0 ? "发现配对端口，在通知中输入六位配对码" : instructions(), true);
        }));
        connectDiscovery = new AdbMdns(this, AdbMdns.SERVICE_TYPE_TLS_CONNECT, (host, port) -> main.post(() -> {
            if (destroyed) return;
            connectPort = port;
            if (paired && !busy && port > 0) connect(port);
        }));
        try { pairingDiscovery.start(); connectDiscovery.start(); }
        catch (RuntimeException error) { /* Manual local port input remains available. */ }
        publish(instructions(), true);
    }

    private String instructions() {
        return "开启无线调试 → 使用配对码配对设备；保持窗口打开，在此输入六位码。未发现端口时输入“配对端口 六位码”。";
    }

    private void submit(String text) {
        if (adb == null) { publish("正在初始化，请稍后重新输入", true); return; }
        try {
            if (paired) { connect(AdbPairingInput.port(text.trim())); return; }
            String[] input = AdbPairingInput.pairing(text);
            final int port = input.length == 2 ? AdbPairingInput.port(input[0]) : pairingPort;
            if (port <= 0) throw new IllegalArgumentException("未发现配对端口，请输入“配对端口 六位配对码”，用空格分隔");
            final String code = input[input.length - 1];
            busy = true;
            publish("正在配对，请保持系统配对窗口打开…", false);
            worker.execute(() -> {
                try {
                    if (!adb.pair("127.0.0.1", port, code)) throw new IllegalStateException();
                    main.post(() -> {
                        if (destroyed) return;
                        busy = false;
                        paired = true;
                        if (connectPort > 0) connect(connectPort);
                        else publish("配对成功，正在寻找连接端口。也可输入无线调试主页的连接端口（不是配对端口）。", true);
                    });
                } catch (Exception error) {
                    main.post(() -> { if (!destroyed) { busy = false; publish("配对失败，请检查当前配对码和配对端口，再次输入", true); } });
                }
            });
        } catch (IllegalArgumentException error) { publish(error.getMessage(), true); }
    }

    private void connect(int port) {
        busy = true;
        publish("配对成功，正在连接无线 ADB…", false);
        worker.execute(() -> {
            try {
                if (!adb.connect("127.0.0.1", port)) throw new IllegalStateException();
                // Report a usable shell, rather than only a completed TLS handshake.
                String uid = new String(adb.execute("id -u", 1024), java.nio.charset.StandardCharsets.UTF_8).trim();
                if (!uid.equals("2000")) throw new IllegalStateException("ADB shell probe failed");
                main.post(() -> finish("无线 ADB 已连接，可以返回 DSHAN 开启设备控制"));
            } catch (Exception error) {
                try { adb.disconnect(); } catch (Exception ignored) { }
                main.post(() -> { if (!destroyed) { busy = false; publish("配对已完成，连接失败。请输入无线调试主页的连接端口重试。", true); } });
            }
        });
    }

    private Notification notification(String text, boolean input) {
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("DSHAN · 无线 ADB 配对").setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text)).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setOngoing(true);
        if (input) {
            Intent reply = new Intent(this, AdbPairingService.class).setAction(REPLY);
            int mutable = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
            PendingIntent submit = PendingIntent.getService(this, 19, reply, PendingIntent.FLAG_UPDATE_CURRENT | mutable);
            RemoteInput field = new RemoteInput.Builder(INPUT).setLabel(paired ? "连接端口" : "六位配对码").build();
            builder.addAction(new Notification.Action.Builder(null, paired ? "输入连接端口" : "输入配对码", submit)
                .addRemoteInput(field).setAllowGeneratedReplies(false).build());
        }
        PendingIntent cancel = PendingIntent.getService(this, 20, new Intent(this, AdbPairingService.class).setAction(CANCEL),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        builder.addAction(new Notification.Action.Builder(null, "取消", cancel).build());
        return builder.build();
    }

    private void publish(String text, boolean input) {
        if (destroyed) return;
        AdbClient.pairingStatus = text;
        getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(text, input));
    }

    private void finish(String text) {
        if (destroyed) return;
        destroyed = true;
        AdbClient.pairingStatus = text;
        stopForeground(STOP_FOREGROUND_REMOVE);
        getSystemService(NotificationManager.class).notify(NOTIFICATION,
            new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle("DSHAN · 无线 ADB").setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true).build());
        stopSelf();
    }

    @Override public void onDestroy() {
        destroyed = true;
        main.removeCallbacksAndMessages(null);
        try { if (pairingDiscovery != null) pairingDiscovery.stop(); } catch (RuntimeException ignored) { }
        try { if (connectDiscovery != null) connectDiscovery.stop(); } catch (RuntimeException ignored) { }
        worker.shutdownNow();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
