package app.dsh.android;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.app.DownloadManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String PREFS = "dsh_setup";
    private static AdbClient adb;
    private static ShizukuClient shizuku;
    private static BridgeServer bridge;
    private static String token;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private FrameLayout root;
    private AnimatedBackgroundView ambientBackground;
    private WebView web;
    private SplashView splash;
    private FrameLayout wizardOverlay;
    private View currentScreen;

    private LinearLayout wizardCard;
    private LinearLayout wizardBody;
    private LinearLayout stepDots;
    private TextView wizardTitle;
    private TextView wizardSubtitle;
    private TextView wizardStatus;
    private TextView wizardProgress;
    private Button wizardPrimary;
    private Button wizardSecondary;
    private CheckBox wizardControl;
    private CheckBox wizardShell;


    private int wizardStep;
    private volatile boolean setupComplete;
    private volatile boolean webReady;
    private boolean harnessPageLoading;
    private int pageGeneration;
    private volatile String pendingLaunchUrl;
    private volatile String harnessAuthCookie;
    private int webAuthRetries;
    private volatile String harnessFailure;
    private volatile long harnessStartingAt;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        startForegroundService(new Intent(this, HarnessMonitorService.class));
        getWindow().setStatusBarColor(UiKit.BG);
        getWindow().setNavigationBarColor(UiKit.BG);
        setupComplete = getSharedPreferences(PREFS, 0).getBoolean("setup_complete", false);
        buildUi();
        if (shizuku == null) shizuku = new ShizukuClient(this);
        shizuku.setStatus(message -> {
            setWizardStatus(message);
        });
        worker.execute(() -> {
            try {
                if (adb == null) adb = AdbClient.get(this);
                if (bridge == null) {
                    byte[] random = new byte[32];
                    new SecureRandom().nextBytes(random);
                    StringBuilder hex = new StringBuilder();
                    for (byte b : random) hex.append(String.format("%02x", b));
                    token = hex.toString();
                    bridge = new BridgeServer(this, adb, shizuku, token);
                    bridge.start();
                }
                restoreBridgePrefs();
                NodeRuntime.launch(getApplicationContext(), token, message -> {
                    if (message.startsWith("正在启动官方")) harnessStartingAt = android.os.SystemClock.elapsedRealtime();
                    if (message.startsWith("Harness 启动失败") || message.startsWith("Harness 已退出")) harnessFailure = message;
                    setSplashStatus(message);
                });
            } catch (Throwable error) {
                harnessFailure = "初始化失败：" + error.getMessage();
                android.util.Log.e("DSHAndroid", "Initialization failed", error);
            }
        });
        pollWeb();
        if (!setupComplete) showWizard(false);
        else showSplash(false);
        if (getIntent().getBooleanExtra("adbPair", false)) requestAdbPairing();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent.getBooleanExtra("adbPair", false)) requestAdbPairing();
    }

    private void requestAdbPairing() {
        getIntent().removeExtra("adbPair");
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {android.Manifest.permission.POST_NOTIFICATIONS}, 73);
            return;
        }
        android.app.NotificationManager manager = getSystemService(android.app.NotificationManager.class);
        android.app.NotificationChannel channel = manager.getNotificationChannel(AdbPairingService.CHANNEL);
        if (!manager.areNotificationsEnabled() || (channel != null && channel.getImportance() == 0)) {
            android.widget.Toast.makeText(this, "请先允许 ADB 配对通知，再重新点击配对", android.widget.Toast.LENGTH_LONG).show();
            Intent settings = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(settings);
            return;
        }
        startForegroundService(new Intent(this, AdbPairingService.class).setAction(AdbPairingService.START));
        try { startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)); }
        catch (android.content.ActivityNotFoundException error) {
            android.widget.Toast.makeText(this, "请在系统设置中打开开发者选项 → 无线调试", android.widget.Toast.LENGTH_LONG).show();
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == 73) {
            if (results.length > 0 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) requestAdbPairing();
            else android.widget.Toast.makeText(this, "通知栏配对需要通知权限，请允许后重试", android.widget.Toast.LENGTH_LONG).show();
        }
    }

    private void buildUi() {
        root = new FrameLayout(this);
        setContentView(root);

        ambientBackground = new AnimatedBackgroundView(this);
        root.addView(ambientBackground, new FrameLayout.LayoutParams(-1, -1));

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        android.webkit.WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);
        web.addJavascriptInterface(new WebDownloadBridge(this), "DSHAndroid");
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            enqueueBrowserDownload(url, URLUtil.guessFileName(url, contentDisposition, mimeType));
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageGeneration++;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (url.startsWith("http://127.0.0.1:3080/")) verifyKernelUi(0);
            }
            @Override public void onReceivedError(WebView view, android.webkit.WebResourceRequest request,
                    android.webkit.WebResourceError error) {
                if (!request.isForMainFrame()) return;
                harnessPageLoading = false;
                pageGeneration++;
                setSplashStatus("Harness 页面加载失败，正在重试：" + error.getDescription());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("http://127.0.0.1:3080/")) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                return true;
            }
        });
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                android.util.Log.i("DSHWebView", message.message());
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        // INVISIBLE keeps layout metrics while splash covers the shell during boot.
        web.setVisibility(View.INVISIBLE);

        splash = new SplashView(this);
        root.addView(splash, new FrameLayout.LayoutParams(-1, -1));
        splash.setVisibility(View.GONE);

        buildWizardOverlay();
    }

    private FrameLayout fullScreenOverlay() {
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(Color.TRANSPARENT);
        overlay.setClickable(true);
        overlay.setFocusable(true);
        overlay.setVisibility(View.GONE);
        root.addView(overlay, new FrameLayout.LayoutParams(-1, -1));
        return overlay;
    }

    private ScrollView centeredCardScroll(FrameLayout overlay) {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        overlay.addView(scroll, new FrameLayout.LayoutParams(-1, -1));

        FrameLayout center = new FrameLayout(this);
        scroll.addView(center, new FrameLayout.LayoutParams(-1, -2));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        UiKit.styleCard(card, this);
        GradientDrawable surface = UiKit.roundedRect(0xFFFCFDFF, this, 28);
        surface.setStroke(dp(1), 0xFFE4EAF4);
        card.setBackground(surface);
        card.setElevation(dp(12));
        card.setPadding(dp(24), dp(24), dp(24), dp(24));
        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(-1, -2);
        cardParams.gravity = Gravity.CENTER;
        cardParams.setMargins(dp(24), dp(48), dp(24), dp(48));
        center.addView(card, cardParams);
        center.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            int width = Math.min(dp(520), Math.max(0, r - l - dp(32)));
            FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) card.getLayoutParams();
            if (params.width != width) {
                params.width = width;
                params.setMargins(dp(16), dp(24), dp(16), dp(24));
                card.setLayoutParams(params);
            }
        });
        return scroll;
    }

    private void buildWizardOverlay() {
        wizardOverlay = fullScreenOverlay();
        ScrollView scroll = centeredCardScroll(wizardOverlay);
        FrameLayout center = (FrameLayout) scroll.getChildAt(0);
        wizardCard = (LinearLayout) center.getChildAt(0);

        TextView brand = UiKit.label(this, "DEEPSEEK  /  HARNESS", 11, 0xFF62728D, Typeface.BOLD);
        brand.setLetterSpacing(.16f);
        brand.setGravity(Gravity.CENTER);
        wizardCard.addView(brand);

        FrameLayout emblem = new FrameLayout(this);
        emblem.setBackground(UiKit.roundedRect(0xFFEAF1FF, this, 24));
        LinearLayout.LayoutParams emblemParams = new LinearLayout.LayoutParams(dp(72), dp(72));
        emblemParams.gravity = Gravity.CENTER_HORIZONTAL;
        emblemParams.setMargins(0, dp(20), 0, dp(18));
        wizardCard.addView(emblem, emblemParams);
        WhaleTaskGlyph whale = new WhaleTaskGlyph(this);
        emblem.addView(whale, new FrameLayout.LayoutParams(dp(48), dp(48), Gravity.CENTER));

        stepDots = new LinearLayout(this);
        stepDots.setOrientation(LinearLayout.HORIZONTAL);
        stepDots.setGravity(Gravity.CENTER);
        wizardCard.addView(stepDots);

        wizardProgress = UiKit.label(this, "", 12, 0xFF62728D, Typeface.NORMAL);
        wizardProgress.setGravity(Gravity.CENTER);
        wizardProgress.setPadding(0, dp(10), 0, 0);
        wizardProgress.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        wizardCard.addView(wizardProgress);

        wizardTitle = UiKit.label(this, "", 26, 0xFF16233B, Typeface.BOLD);
        wizardTitle.setPadding(0, dp(16), 0, dp(8));
        wizardTitle.setAccessibilityHeading(true);
        wizardTitle.setGravity(Gravity.CENTER);
        wizardCard.addView(wizardTitle);

        wizardSubtitle = UiKit.label(this, "", 14, UiKit.TEXT_SECONDARY, Typeface.NORMAL);
        wizardSubtitle.setGravity(Gravity.CENTER);
        wizardSubtitle.setLineSpacing(0, 1.15f);
        wizardCard.addView(wizardSubtitle);

        wizardBody = new LinearLayout(this);
        wizardBody.setOrientation(LinearLayout.VERTICAL);
        wizardBody.setPadding(0, dp(20), 0, dp(4));
        wizardCard.addView(wizardBody);

        wizardStatus = UiKit.label(this, "", 13, UiKit.TEXT_SECONDARY, Typeface.NORMAL);
        wizardStatus.setPadding(0, dp(4), 0, dp(12));
        wizardStatus.setGravity(Gravity.CENTER);
        wizardStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        wizardCard.addView(wizardStatus);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(8), 0, 0);
        wizardCard.addView(actions);

        wizardSecondary = new Button(this);
        UiKit.styleSecondaryButtonOnLight(wizardSecondary, this);
        styleWizardButton(wizardSecondary, false);
        wizardSecondary.setText("上一步");
        wizardPrimary = new Button(this);
        UiKit.stylePrimaryButton(wizardPrimary, this);
        styleWizardButton(wizardPrimary, true);
        wizardPrimary.setText("下一步");

        LinearLayout.LayoutParams secondaryParams = new LinearLayout.LayoutParams(0, -2, 1);
        secondaryParams.setMargins(0, 0, dp(8), 0);
        LinearLayout.LayoutParams primaryParams = new LinearLayout.LayoutParams(0, -2, 1);
        actions.addView(wizardSecondary, secondaryParams);
        actions.addView(wizardPrimary, primaryParams);

        wizardSecondary.setOnClickListener(v -> goWizardStep(wizardStep - 1));
        wizardPrimary.setOnClickListener(v -> onWizardPrimary());
    }

    private void styleWizardButton(Button button, boolean primary) {
        GradientDrawable fill = UiKit.roundedRect(primary ? 0xFF3265DB : 0xFFF0F3F9, this, 14);
        button.setBackground(new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(primary ? 0x40FFFFFF : 0x203265DB), fill, null));
        button.setTextColor(new android.content.res.ColorStateList(
            new int[][] {new int[] {-android.R.attr.state_enabled}, new int[] {}},
            new int[] {0xFF8995AA, primary ? Color.WHITE : 0xFF45546F}));
        button.setTextSize(14);
        button.setMinHeight(dp(52));
        button.setMinimumHeight(dp(52));
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
    }

    private void resetViewTransform(View view) {
        view.setAlpha(1f);
        view.setScaleX(1f);
        view.setScaleY(1f);
        view.setTranslationX(0f);
        view.setTranslationY(0f);
    }

    private void hideAllScreens() {
        splash.setVisibility(View.GONE);
        wizardOverlay.setVisibility(View.GONE);
        resetViewTransform(splash);
        resetViewTransform(wizardOverlay);
        if (web.getVisibility() == View.VISIBLE) {
            web.setVisibility(View.INVISIBLE);
            resetViewTransform(web);
        }
    }

    private void transitionTo(View next, boolean animate, Runnable setup) {
        if (currentScreen == next && next.getVisibility() == View.VISIBLE) {
            if (setup != null) setup.run();
            return;
        }
        View previous = currentScreen;
        Runnable reveal = () -> {
            hideAllScreens();
            if (setup != null) setup.run();
            next.setVisibility(View.VISIBLE);
            ambientBackground.setVisibility(next == web ? View.GONE : View.VISIBLE);
            if (animate && next == web) {
                next.setAlpha(0f);
                next.animate().alpha(1f).setDuration(300)
                    .setInterpolator(new android.view.animation.DecelerateInterpolator())
                    .withEndAction(() -> next.setAlpha(1f))
                    .start();
            }
            else if (animate) MotionKit.reveal(next, 320);
            else resetViewTransform(next);
            currentScreen = next;
        };
        if (animate && previous != null && previous != next && previous.getVisibility() == View.VISIBLE) {
            MotionKit.dismiss(previous, 200, reveal);
        } else {
            reveal.run();
        }
    }

    private void showWizard(boolean animate) {
        transitionTo(wizardOverlay, animate, () -> goWizardStep(0, true));
    }

    private void showSplash(boolean animate) {
        transitionTo(splash, animate, null);
    }

    private void showWeb(boolean animate) {
        transitionTo(web, animate, () -> ui.post(() -> web.evaluateJavascript(
            "(function(){window.dispatchEvent(new Event('resize'));" +
            "var f=document.querySelector('.pI_x6G_frame');" +
            "if(f)f.dispatchEvent(new Event('transitionend'));})()",
            null)));
    }

    private void openStorageSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception ignored) {
            startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
        }
    }

    @Override protected void onResume() {
        super.onResume();
        if (shizuku != null) shizuku.refresh();
        HarnessMonitorService.visibility(false);
        if (wizardOverlay != null && wizardOverlay.getVisibility() == View.VISIBLE
                && (wizardStep == 2 || wizardStep == 3)) {
            applyWizardStepContent(wizardStep);
        }
    }

    @Override protected void onStop() {
        super.onStop();
        HarnessMonitorService.visibility(true);
    }

    private void goWizardStep(int step) {
        goWizardStep(step, false);
    }

    private void goWizardStep(int step, boolean instant) {
        int previous = wizardStep;
        wizardStep = Math.max(0, Math.min(4, step));
        boolean forward = wizardStep >= previous;
        Runnable apply = () -> applyWizardStepContent(wizardStep);
        if (instant || previous == wizardStep) {
            apply.run();
            return;
        }
        MotionKit.wizardStepChange(wizardCard, forward, apply);
    }

    private void applyWizardStepContent(int step) {
        wizardBody.removeAllViews();
        rebuildStepDots();
        switch (step) {
            case 0:
                wizardTitle.setText("欢迎使用");
                wizardSubtitle.setText("Deepseek Harness for Android Native\n官方 Harness 在本机运行，无需电脑");
                wizardStatus.setText("");
                bodyText(wizardBody, "本机运行\n让对话与工具在你的设备上协同工作。");
                bodyText(wizardBody, "按需授权\n由你决定是否开启设备控制与命令执行。");
                break;
            case 1:
                wizardTitle.setText("连接设备权限");
                wizardSubtitle.setText("选择 Shizuku、无线 ADB 配对或 Root 连接");
                bodyText(wizardBody, "Shizuku 会在系统层提供 shell 权限，无需手动配对无线调试。");
                bodyText(wizardBody, "也可以跳过，稍后在设置中授权；未连接时仍可使用对话功能。");
                Button auth = new Button(this);
                UiKit.stylePrimaryButton(auth, this);
                styleWizardButton(auth, true);
                auth.setText("使用 Shizuku 一键授权");
                wizardBody.addView(auth, fullButton());
                auth.setAlpha(0f);
                auth.setTranslationY(dp(12));
                auth.animate().alpha(1f).translationY(0f).setDuration(300).setStartDelay(80).start();
                auth.setOnClickListener(v -> {
                    try { shizuku.request(); }
                    catch (Exception error) { setWizardStatus("Shizuku 授权失败：" + error.getMessage()); }
                });
                Button pairAdb = new Button(this);
                UiKit.styleSecondaryButtonOnLight(pairAdb, this);
                pairAdb.setText("通过通知栏输入 ADB 配对码");
                wizardBody.addView(pairAdb, fullButton());
                pairAdb.setOnClickListener(v -> requestAdbPairing());
                bodyText(wizardBody, "开启无线调试后选择“使用配对码配对设备”，保持窗口打开，在通知栏输入六位配对码，无需 Shizuku。");
                shizuku.refresh();
                wizardStatus.setText(adb != null && adb.isConnected() ? "无线 ADB 已连接" : shizuku.statusMessage());
                bodyText(wizardBody, "已 Root 的手机也可以使用 Root 模式。开启后设备命令通过 su 执行，仍需下一步的设备控制授权。");
                Button rootAuth = new Button(this);
                UiKit.styleSecondaryButtonOnLight(rootAuth, this);
                rootAuth.setText("检测并授权 Root");
                wizardBody.addView(rootAuth, fullButton());
                CheckBox rootMode = check("开启 Root 模式");
                rootMode.setChecked(bridge != null && bridge.rootEnabled);
                rootMode.setEnabled(bridge != null && (bridge.root.isReady() || bridge.rootEnabled));
                wizardBody.addView(rootMode);
                TextView rootStatus = UiKit.label(this, bridge == null ? "正在初始化…" : bridge.root.statusMessage(), 13, UiKit.TEXT_SECONDARY, Typeface.NORMAL);
                wizardBody.addView(rootStatus);
                rootAuth.setOnClickListener(v -> {
                    rootAuth.setEnabled(false);
                    rootStatus.setText("正在请求 Root，请在 Root 管理器中授权…");
                    worker.execute(() -> {
                        boolean granted = bridge != null && bridge.root.request();
                        ui.post(() -> {
                            rootAuth.setEnabled(true);
                            rootMode.setEnabled(granted || (bridge != null && bridge.rootEnabled));
                            rootStatus.setText(bridge == null ? "尚未初始化，请重试" : bridge.root.statusMessage());
                        });
                    });
                });
                rootMode.setOnCheckedChangeListener((button, enabled) -> {
                    if (bridge == null || (enabled && !bridge.root.isReady())) {
                        if (enabled) button.setChecked(false);
                        return;
                    }
                    bridge.rootEnabled = enabled;
                    getSharedPreferences(PREFS, 0).edit().putBoolean("root", enabled).apply();
                    refreshWizardButtons();
                });
                break;
            case 2:
                wizardTitle.setText("授权 Harness 操作");
                wizardSubtitle.setText("选择模型可以执行的操作范围");
                wizardControl = check("允许 Harness 控制这台手机");
                wizardShell = check("允许任意 shell 命令（高级，默认关闭）");
                wizardBody.addView(wizardControl);
                wizardBody.addView(wizardShell);
                bodyText(wizardBody, "模型可使用点击、滑动、按键、UI 树和截图工具。");
                bodyText(wizardBody, "选择内部存储作为工作区需要授予“所有文件访问”权限。");
                Button wizardStorage = new Button(this);
                UiKit.styleSecondaryButtonOnLight(wizardStorage, this);
                styleWizardButton(wizardStorage, false);
                boolean storageGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.R
                    || Environment.isExternalStorageManager();
                wizardStorage.setText(storageGranted ? "存储权限已授予" : "授予存储访问权限");
                wizardStorage.setEnabled(!storageGranted);
                wizardBody.addView(wizardStorage, fullButton());
                wizardStorage.setOnClickListener(v -> openStorageSettings());
                MotionKit.staggerIn(new View[] {wizardControl, wizardShell, wizardStorage}, 60);
                android.content.SharedPreferences prefs = getSharedPreferences(PREFS, 0);
                wizardControl.setChecked(prefs.getBoolean("wizard_control_draft",
                    prefs.getBoolean("control", false)));
                wizardShell.setChecked(prefs.getBoolean("wizard_shell_draft",
                    prefs.getBoolean("shell", false)));
                // Persist selections separately from active permissions, including
                // when Settings causes this Activity to be recreated.
                wizardControl.setOnCheckedChangeListener((button, checked) ->
                    prefs.edit().putBoolean("wizard_control_draft", checked).apply());
                wizardShell.setOnCheckedChangeListener((button, checked) ->
                    prefs.edit().putBoolean("wizard_shell_draft", checked).apply());
                wizardStatus.setText("");
                break;
            case 3:
                wizardTitle.setText("后台动作悬浮窗");
                wizardSubtitle.setText("切换到其他应用时，也能看见 DeepSeek 正在做什么");
                bodyText(wizardBody, "查看当前动作\n任务在后台执行时，悬浮窗会显示当前动作，例如分析屏幕、点击或滚动，让你随时了解执行进度。");
                bodyText(wizardBody, "快速返回对话\n可拖动悬浮窗调整位置，点击展开后可打开对话或隐藏悬浮窗。");
                bodyText(wizardBody, "按需开启\n需要允许“显示在其他应用上层”。暂时跳过也可以继续使用，后台通知仍会显示任务状态。");
                boolean overlayGranted = Settings.canDrawOverlays(this);
                Button wizardOverlayPermission = new Button(this);
                UiKit.styleSecondaryButtonOnLight(wizardOverlayPermission, this);
                styleWizardButton(wizardOverlayPermission, false);
                wizardOverlayPermission.setText(overlayGranted ? "悬浮窗权限已授予" : "开启悬浮窗");
                wizardOverlayPermission.setEnabled(!overlayGranted);
                wizardBody.addView(wizardOverlayPermission, fullButton());
                wizardOverlayPermission.setOnClickListener(v -> startActivity(new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))));
                wizardStatus.setText(overlayGranted ? "已开启：后台执行任务时会自动显示" : "尚未开启，可暂时跳过");
                break;
            case 4:
                wizardTitle.setText("一切就绪");
                wizardSubtitle.setText("配置 DeepSeek API Key 后即可开始对话");
                bodyText(wizardBody, webReady
                    ? "Harness 已启动，点击完成即可进入。"
                    : "Harness 正在后台启动，完成后将自动进入主界面。");
                wizardStatus.setText("");
                break;
        }
        refreshWizardButtons();
    }

    private void onWizardPrimary() {
        if (wizardStep == 0) { goWizardStep(1); return; }
        if (wizardStep == 1) {
            goWizardStep(2);
            return;
        }
        if (wizardStep == 2) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
                setWizardStatus("请先授予存储访问权限");
                openStorageSettings();
                return;
            }
            if (bridge != null) {
                bridge.controlEnabled = wizardControl.isChecked();
                bridge.shellEnabled = wizardShell.isChecked();
            }
            getSharedPreferences(PREFS, 0).edit()
                .putBoolean("control", wizardControl.isChecked())
                .putBoolean("shell", wizardShell.isChecked())
                .remove("wizard_control_draft")
                .remove("wizard_shell_draft")
                .apply();
            goWizardStep(3);
            return;
        }
        if (wizardStep == 3) { goWizardStep(4); return; }
        finishSetup();
    }

    private void finishSetup() {
        getSharedPreferences(PREFS, 0).edit().putBoolean("setup_complete", true).apply();
        setupComplete = true;
        if (webReady) showWeb(true);
        else showSplash(true);
    }

    private void refreshWizardButtons() {
        if (wizardPrimary == null) return;
        wizardSecondary.setVisibility(wizardStep == 0 ? View.GONE : View.VISIBLE);
        LinearLayout.LayoutParams primaryParams = (LinearLayout.LayoutParams) wizardPrimary.getLayoutParams();
        primaryParams.setMargins(wizardStep == 0 ? 0 : dp(8), 0, 0, 0);
        wizardPrimary.setLayoutParams(primaryParams);
        switch (wizardStep) {
            case 0: wizardPrimary.setText("开始配置"); wizardPrimary.setEnabled(true); break;
            case 1:
                wizardPrimary.setText((adb != null && adb.isConnected()) || shizuku.isReady() || (bridge != null && bridge.rootEnabled && bridge.root.isReady()) ? "下一步" : "暂时跳过");
                wizardPrimary.setEnabled(true);
                break;
            case 2: wizardPrimary.setText("下一步"); wizardPrimary.setEnabled(true); break;
            case 3:
                wizardPrimary.setText(Settings.canDrawOverlays(this) ? "下一步" : "暂时跳过");
                wizardPrimary.setEnabled(true);
                break;
            case 4: wizardPrimary.setText("完成"); wizardPrimary.setEnabled(true); break;
        }
    }

    private void rebuildStepDots() {
        stepDots.removeAllViews();
        String[] steps = {"欢迎", "连接设备", "操作权限", "后台悬浮窗", "完成配置"};
        wizardProgress.setText("第" + (wizardStep + 1) + "/" + steps.length + "步 · " + steps[wizardStep]);
        for (int i = 0; i < steps.length; i++) {
            View dot = new View(this);
            GradientDrawable shape = new GradientDrawable();
            shape.setCornerRadius(dp(4));
            if (i == wizardStep) {
                shape.setColor(0xFF3265DB);
                dot.setLayoutParams(new LinearLayout.LayoutParams(0, dp(4), 1));
            } else if (i < wizardStep) {
                shape.setColor(0xFF9DB9F3);
                dot.setLayoutParams(new LinearLayout.LayoutParams(0, dp(4), 1));
            } else {
                shape.setColor(0xFFE5EAF3);
                dot.setLayoutParams(new LinearLayout.LayoutParams(0, dp(4), 1));
            }
            dot.setBackground(shape);
            dot.setAlpha(0f);
            LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) dot.getLayoutParams();
            params.setMargins(dp(4), 0, dp(4), 0);
            stepDots.addView(dot);
            dot.animate().alpha(1f).setDuration(220).setStartDelay(i * 50L).start();
        }
    }

    /** Exchange the one-time launch token for the signed browser cookie. */
    private String exchangeAuthCookie(String launchUrl) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(launchUrl).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setRequestMethod("GET");
        int code = connection.getResponseCode();
        java.io.InputStream body = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (body != null) {
            byte[] buffer = new byte[512];
            while (body.read(buffer) != -1) { }
            body.close();
        }
        String setCookie = connection.getHeaderField("Set-Cookie");
        connection.disconnect();
        if (code != 303 && code != 302) throw new IllegalStateException("Harness 鉴权失败，HTTP " + code);
        if (setCookie == null || setCookie.isEmpty()) throw new IllegalStateException("Harness 未返回登录 Cookie");
        return setCookie;
    }

    private static String cookieForWebView(String setCookie) {
        int end = setCookie.indexOf(';');
        String pair = (end >= 0 ? setCookie.substring(0, end) : setCookie).trim();
        return pair + "; path=/";
    }

    private static String cookieHeaderValue(String setCookie) {
        int end = setCookie.indexOf(';');
        return (end >= 0 ? setCookie.substring(0, end) : setCookie).trim();
    }

    private void applyAuthCookie(String setCookie) {
        harnessAuthCookie = cookieHeaderValue(setCookie);
        String base = "http://127.0.0.1:3080";
        CookieManager manager = CookieManager.getInstance();
        manager.setAcceptCookie(true);
        manager.setAcceptThirdPartyCookies(web, true);
        manager.setCookie(base, cookieForWebView(setCookie));
        manager.flush();
    }

    /** Let WebView follow the one-time token redirect and store the session cookie. */
    private void loadHarnessLaunchUrl(String launchUrl) {
        web.loadUrl(launchUrl);
    }

    private void loadHarnessPage(String setCookie) {
        applyAuthCookie(setCookie);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cookie", harnessAuthCookie);
        web.loadUrl("http://127.0.0.1:3080/", headers);
    }

    private void retryHarnessAuth() {
        String launchUrl = pendingLaunchUrl;
        if (launchUrl == null || webAuthRetries >= 5) {
            harnessFailure = "Harness 页面鉴权失败，请完全退出应用后重试";
            ui.post(() -> setSplashStatus(harnessFailure));
            return;
        }
        webAuthRetries++;
        worker.execute(() -> {
            try {
                String cookie = exchangeAuthCookie(launchUrl);
                ui.post(() -> loadHarnessPage(cookie));
            } catch (Exception error) {
                android.util.Log.e("DSHAndroid", "Harness auth retry failed", error);
                ui.post(() -> setSplashStatus("Harness 鉴权失败：" + error.getMessage()));
            }
        });
    }

    private void onHarnessUiReady() {
        if (webReady) return;
        webReady = true;
        harnessFailure = null;
        webAuthRetries = 0;
        refreshWizardButtons();
        NodeRuntime.confirmKernelHealthy(getApplicationContext());
        if (setupComplete && currentScreen != wizardOverlay) showWeb(true);
        ui.postDelayed(() -> captureLayoutDiagnostics("post-show-2s"), 2000);
        ui.postDelayed(() -> captureLayoutDiagnostics("post-show-8s"), 8000);
    }

    private void pollWeb() {
        worker.execute(() -> {
            try {
                File urlFile = new File(getNoBackupFilesDir(), "dsh-web-url");
                if (!urlFile.exists()) throw new IllegalStateException("Harness 尚未启动");
                String launchUrl = new String(Files.readAllBytes(urlFile.toPath()), StandardCharsets.UTF_8).trim();
                if (!launchUrl.startsWith("http://127.0.0.1:3080/?token="))
                    throw new IllegalStateException("Harness 启动地址无效");
                HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:3080/").openConnection();
                connection.setConnectTimeout(2000);
                connection.setReadTimeout(2000);
                int code = connection.getResponseCode();
                connection.disconnect();
                if (code >= 200 && code < 500) {
                    pendingLaunchUrl = launchUrl;
                    ui.post(() -> {
                        // A slow WebView must be allowed to finish loading its JS bundle.
                        // Reloading the token URL on every poll aborts that initialization.
                        if (!webReady && !harnessPageLoading) {
                            harnessPageLoading = true;
                            loadHarnessLaunchUrl(launchUrl);
                        }
                    });
                }
            } catch (Exception error) {
                android.util.Log.w("DSHAndroid", "Harness web poll failed", error);
            }
            if (!webReady && harnessFailure == null && harnessStartingAt > 0
                    && android.os.SystemClock.elapsedRealtime() - harnessStartingAt > 90000) {
                harnessFailure = pendingLaunchUrl == null
                    ? "Harness 启动超时：" + NodeRuntime.recentLog(getNoBackupFilesDir())
                    : "Harness 服务已启动，页面仍在加载。若长时间无响应，请更新 Android System WebView 后重启应用。";
                ui.post(() -> setSplashStatus(harnessFailure));
            }
            if (!webReady) ui.postDelayed(this::pollWeb, 3000);
        });
    }

    private void restoreBridgePrefs() {
        boolean control = getSharedPreferences(PREFS, 0).getBoolean("control", false);
        boolean shell = getSharedPreferences(PREFS, 0).getBoolean("shell", false);
        bridge.controlEnabled = control;
        bridge.shellEnabled = shell;
        bridge.rootEnabled = getSharedPreferences(PREFS, 0).getBoolean("root", false);
        if (bridge.rootEnabled) bridge.root.request();
    }

    private void saveBridgePrefs() {
        boolean control = bridge != null && bridge.controlEnabled;
        boolean shell = bridge != null && bridge.shellEnabled;
        getSharedPreferences(PREFS, 0).edit()
            .putBoolean("control", control)
            .putBoolean("shell", shell)
            .apply();
    }

    private void setWizardStatus(String message) {
        ui.post(() -> {
            if (wizardStatus != null && wizardOverlay.getVisibility() == View.VISIBLE && wizardStep == 1)
                wizardStatus.setText(adb != null && adb.isConnected() ? "无线 ADB 已连接" : message);
            refreshWizardButtons();
        });
    }


    private void setSplashStatus(String message) {
        ui.post(() -> {
            if (splash != null && message != null && !message.isEmpty()) splash.setStatus(message);
        });
    }

    private void bodyText(LinearLayout parent, String value) {
        TextView view = UiKit.label(this, value, 13, 0xFF596780, Typeface.NORMAL);
        view.setPadding(dp(14), dp(12), dp(14), dp(12));
        view.setBackground(UiKit.roundedRect(0xFFF0F3F9, this, 14));
        view.setLineSpacing(0, 1.2f);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(8);
        parent.addView(view, params);
    }

    private CheckBox check(String value) {
        CheckBox view = new CheckBox(this);
        view.setText(value);
        UiKit.styleCheck(view);
        view.setTextSize(14);
        view.setButtonTintList(android.content.res.ColorStateList.valueOf(0xFF3265DB));
        android.graphics.drawable.StateListDrawable background = new android.graphics.drawable.StateListDrawable();
        GradientDrawable selected = UiKit.roundedRect(0xFFECF2FF, this, 14);
        selected.setStroke(dp(1), 0xFF9DB9F3);
        background.addState(new int[] {android.R.attr.state_checked}, selected);
        background.addState(new int[] {}, UiKit.roundedRect(0xFFF0F3F9, this, 14));
        view.setBackground(new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(0x203265DB), background, null));
        view.setPadding(dp(12), dp(12), dp(14), dp(12));
        view.setMinHeight(dp(60));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(8);
        view.setLayoutParams(params);
        return view;
    }

    private LinearLayout.LayoutParams fullButton() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(0, dp(6), 0, dp(10));
        return params;
    }

    private int dp(int size) { return UiKit.dp(this, size); }

    private void verifyKernelUi(int attempt) {
        verifyKernelUi(attempt, pageGeneration);
    }

    private void verifyKernelUi(int attempt, int generation) {
        if (webReady || generation != pageGeneration) return;
        web.evaluateJavascript(
            "(function(){var text=document.body?(document.body.innerText||''):'';" +
            "if(text.indexOf('authentication required')>=0)return 'auth';" +
            "var main=document.querySelector('.wSkVaW_root,.pXSMma_root');" +
            "if(main&&main.getBoundingClientRect().height>0)return 'ok';" +
            "return 'wait';})()",
            result -> {
                if (webReady || generation != pageGeneration) return;
                if ("\"auth\"".equals(result)) {
                    retryHarnessAuth();
                    return;
                }
                if ("\"ok\"".equals(result)) {
                    captureLayoutDiagnostics("pre-ready");
                    onHarnessUiReady();
                    return;
                }
                if (attempt == 0 || attempt == 5 || attempt == 15 || attempt == 30)
                    captureLayoutDiagnostics("verify-" + attempt);
                if (attempt < 120) ui.postDelayed(() -> verifyKernelUi(attempt + 1, generation), 1000);
            });
    }

    private void captureLayoutDiagnostics(String runId) {
        web.evaluateJavascript(
            "(function(){var frame=document.querySelector('.pI_x6G_frame');" +
            "var center=frame?frame.querySelector('.pI_x6G_centerCol'):null;" +
            "var mask=center?getComputedStyle(center,':before').content:'none';" +
            "return JSON.stringify({" +
            "runId:'" + runId + "'," +
            "innerWidth:window.innerWidth," +
            "mobile:window.matchMedia('(max-width:768px)').matches," +
            "boot:document.documentElement.classList.contains('dsh-android-shell-boot')," +
            "collapsed:frame?frame.hasAttribute('data-sidebar-collapsed'):null," +
            "centerChildren:center?center.children.length:0," +
            "centerHeight:center?center.getBoundingClientRect().height:0," +
            "centerText:center?(center.innerText||'').length:0," +
            "centerOpacity:center?getComputedStyle(center).opacity:''," +
            "childHeight:center&&center.firstElementChild?center.firstElementChild.getBoundingClientRect().height:0," +
            "childClass:center&&center.firstElementChild?center.firstElementChild.className:''," +
            "chatHeight:(function(){var n=document.querySelector('.wSkVaW_root');" +
            "return n?n.getBoundingClientRect().height:0;})()," +
            "chatTop:(function(){var n=document.querySelector('.wSkVaW_root');" +
            "return n?n.getBoundingClientRect().top:0;})()," +
            "childOpacity:center&&center.firstElementChild?getComputedStyle(center.firstElementChild).opacity:''," +
            "sidebarVisible:(function(){var s=frame?frame.querySelector('.pI_x6G_sidebarCol'):null;" +
            "return s?getComputedStyle(s).visibility:'';})()," +
            "maskContent:mask," +
            "bodyTextLen:document.body?(document.body.innerText||'').length:0" +
            "});})()",
            value -> debugLog("layout", value, runId));
    }

    private void debugLog(String hypothesisId, String payload, String runId) {
        if (payload == null || "null".equals(payload)) return;
        String json = payload;
        if (json.startsWith("\"") && json.endsWith("\"")) {
            json = json.substring(1, json.length() - 1)
                .replace("\\\"", "\"")
                .replace("\\\\", "\\");
        }
        long timestamp = System.currentTimeMillis();
        String line = "{\"sessionId\":\"45344d\",\"hypothesisId\":\"" + hypothesisId
            + "\",\"runId\":\"" + runId + "\",\"location\":\"MainActivity.java\","
            + "\"message\":\"layout-diagnostics\",\"data\":" + json
            + ",\"timestamp\":" + timestamp + "}\n";
        android.util.Log.i("DSHDebug", line.trim());
        worker.execute(() -> {
            try {
                File logFile = new File(getFilesDir(), "debug-45344d.log");
                FileOutputStream out = new FileOutputStream(logFile, true);
                out.write(line.getBytes(StandardCharsets.UTF_8));
                out.close();
            } catch (Exception error) {
                android.util.Log.w("DSHDebug", "Failed to write debug log", error);
            }
        });
    }

    private void enqueueBrowserDownload(String url, String filename) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
            request.setMimeType("application/zip");
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) request.addRequestHeader("Cookie", cookie);
            DownloadManager manager = getSystemService(DownloadManager.class);
            if (manager != null) manager.enqueue(request);
        } catch (Exception error) {
            android.util.Log.e("DSHAndroid", "Browser download failed", error);
        }
    }

    /** Lets the Web UI start authenticated downloads through the system DownloadManager. */
    private static final class WebDownloadBridge {
        private final MainActivity activity;
        WebDownloadBridge(MainActivity activity) { this.activity = activity; }
        @JavascriptInterface
        public void scanPeerQr() {
            activity.runOnUiThread(() -> {
                com.google.zxing.integration.android.IntentIntegrator scan = new com.google.zxing.integration.android.IntentIntegrator(activity);
                scan.setDesiredBarcodeFormats(com.google.zxing.integration.android.IntentIntegrator.QR_CODE);
                scan.setPrompt("扫描电脑 DeepSeek Harness 连接插件的配对二维码");
                scan.setBeepEnabled(false);
                scan.setOrientationLocked(true);
                scan.initiateScan();
            });
        }
        @JavascriptInterface
        public void startDownload(String url, String filename) {
            activity.runOnUiThread(() -> activity.enqueueBrowserDownload(url, filename));
        }
        @JavascriptInterface
        public void debugLog(String json) {
            activity.debugLog("js", json, "webview");
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        com.google.zxing.integration.android.IntentResult result = com.google.zxing.integration.android.IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null) {
            String code = result.getContents();
            String error = code != null && (!code.startsWith("dsh-peer:") || code.length() > 8192) ? "这不是 DSH 连接插件的配对二维码" : null;
            String json = "{\"code\":" + (code == null || error != null ? "null" : org.json.JSONObject.quote(code)) + ",\"error\":" + (error == null ? "null" : org.json.JSONObject.quote(error)) + "}";
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('dsh-peer-scan',{detail:" + json + "}))", null);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override public void onBackPressed() {
        if (wizardOverlay.getVisibility() == View.VISIBLE) {
            if (wizardStep > 0) goWizardStep(wizardStep - 1);
            return;
        }
        if (web.getVisibility() == View.VISIBLE && setupComplete) {
            moveTaskToBack(true);
            return;
        }
        super.onBackPressed();
    }
}
