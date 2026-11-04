package app.dsh.android;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import android.view.Choreographer;
import java.util.LinkedHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Keeps the embedded runtime eligible for background execution and shows actual session events. */
public class HarnessMonitorService extends Service {
    @FunctionalInterface
    public interface CaptureWork {
        void run() throws Exception;
    }

    private static HarnessMonitorService instance;
    private static boolean background;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final LinkedHashMap<String, String> tasks = new LinkedHashMap<>();
    private WindowManager windows;
    private LinearLayout panel;
    private ShimmerTextView label;
    private WhaleTaskGlyph indicator;
    private LinearLayout actions;
    private boolean expanded;
    private int savedX = -1, savedY;
    private boolean dismissed;
    private String latest = "等待任务";
    private int captureHideDepth;
    private boolean foregroundReady;
    static void visibility(boolean hidden) {
        background = hidden;
        if (instance != null) instance.main.post(() -> { if (!hidden) instance.dismissed = false; instance.render(); });
    }
    static void progress(String session, String text, boolean active) {
        HarnessMonitorService current = instance;
        if (current == null) return;
        current.main.post(() -> {
            if (active) current.tasks.put(session, text); else current.tasks.remove(session);
            current.latest = text;
            current.render();
        });
    }
    /** Hide the floating label while the bridge captures the screen so screencap stays unobstructed. */
    static void runWithoutOverlay(CaptureWork work) throws Exception {
        HarnessMonitorService service = instance;
        if (service == null) {
            work.run();
            return;
        }
        CountDownLatch hidden = new CountDownLatch(1);
        service.main.post(() -> {
            service.captureHideDepth++;
            service.syncCaptureHidden();
            hidden.countDown();
        });
        if (!hidden.await(2, TimeUnit.SECONDS)) throw new IllegalStateException("无法隐藏任务标签");
        awaitCompositorFrame(service);
        try {
            work.run();
        } finally {
            CountDownLatch restored = new CountDownLatch(1);
            service.main.post(() -> {
                service.captureHideDepth = Math.max(0, service.captureHideDepth - 1);
                service.syncCaptureHidden();
                service.render();
                restored.countDown();
            });
            restored.await(2, TimeUnit.SECONDS);
        }
    }
    private static void awaitCompositorFrame(HarnessMonitorService service) throws InterruptedException {
        CountDownLatch frame = new CountDownLatch(1);
        service.main.post(() -> Choreographer.getInstance().postFrameCallback(timeNanos -> frame.countDown()));
        frame.await(300, TimeUnit.MILLISECONDS);
    }
    private void syncCaptureHidden() {
        if (panel != null) panel.setVisibility(captureHideDepth > 0 ? View.GONE : View.VISIBLE);
    }
    @Override public void onCreate() {
        super.onCreate(); instance = this;
        windows = (WindowManager) getSystemService(WINDOW_SERVICE);
        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel("harness", "DeepSeek 后台任务", NotificationManager.IMPORTANCE_LOW));
            startForeground(18, notification("后台运行保护已开启"));
            foregroundReady = true;
        } catch (RuntimeException error) {
            android.util.Log.w("DSHAndroid", "Cannot promote background service", error);
            Toast.makeText(this, "后台运行保护不可用，切到后台后任务可能停止", Toast.LENGTH_LONG).show();
            stopSelf();
        }
    }
    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, "harness").setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("DSHAN").setContentText(text).setContentIntent(open).setOngoing(true).build();
    }
    private void render() {
        if (!foregroundReady) return;
        String text = tasks.isEmpty() ? latest : tasks.values().stream().reduce((a,b) -> b).orElse(latest);
        getSystemService(NotificationManager.class).notify(18, notification(text));
        if (!background || dismissed || tasks.isEmpty() || !Settings.canDrawOverlays(this)) { removePanel(); return; }
        if (panel == null) {
            panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(14),dp(10),dp(14),dp(10));
            android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
            bg.setColors(new int[]{Color.rgb(24,28,38),Color.rgb(10,12,18)}); bg.setOrientation(android.graphics.drawable.GradientDrawable.Orientation.TL_BR);
            bg.setCornerRadius(dp(24)); bg.setStroke(dp(1),Color.rgb(47,54,68)); panel.setBackground(bg);
            panel.setElevation(dp(6));
            LinearLayout capsule = new LinearLayout(this); capsule.setGravity(Gravity.CENTER_VERTICAL);
            indicator = new WhaleTaskGlyph(this);
            capsule.addView(indicator,new LinearLayout.LayoutParams(dp(24),dp(24)));
            label = new ShimmerTextView(this); label.setTextSize(12);
            label.setTypeface(android.graphics.Typeface.create("sans-serif-medium",android.graphics.Typeface.NORMAL)); label.setIncludeFontPadding(false);
            label.setSingleLine(true); label.setEllipsize(android.text.TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams content = new LinearLayout.LayoutParams(0,dp(24),1); content.leftMargin=dp(8);
            label.setGravity(Gravity.CENTER_VERTICAL); capsule.addView(label,content);
            View chevron = new View(this) {
                final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
                @Override protected void onDraw(android.graphics.Canvas canvas) {
                    paint.setColor(Color.rgb(118,130,153));
                    float density=getResources().getDisplayMetrics().density;
                    for(int i=-1;i<=1;i++)canvas.drawCircle(getWidth()/2f+i*4*density,getHeight()/2f,1*density,paint);
                }
            };
            capsule.addView(chevron,new LinearLayout.LayoutParams(dp(20),dp(24))); panel.addView(capsule);
            actions = new LinearLayout(this); actions.setGravity(Gravity.CENTER); actions.setPadding(0,dp(10),0,0);
            TextView open = action("打开对话",Color.rgb(145,180,255)); open.setOnClickListener(v -> startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)));
            TextView close = action("隐藏",Color.rgb(167,175,193)); close.setOnClickListener(v -> { dismissed = true; removePanel(); });
            actions.addView(open,new LinearLayout.LayoutParams(0,dp(40),1)); actions.addView(close,new LinearLayout.LayoutParams(0,dp(40),1)); panel.addView(actions);
            actions.setVisibility(View.GONE); expanded=false;
            WindowManager.LayoutParams params = new WindowManager.LayoutParams(dp(208), WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, android.graphics.PixelFormat.TRANSLUCENT);
            params.gravity = Gravity.TOP | Gravity.LEFT;
            params.x = savedX < 0 ? Math.max(0, getResources().getDisplayMetrics().widthPixels - dp(208) - dp(12)) : savedX;
            params.y = savedX < 0 ? dp(12) : savedY;
            capsule.setContentDescription("DeepSeek 当前动作，点击展开，拖动移动");
            capsule.setOnClickListener(v -> {
                expanded=!expanded; actions.setVisibility(expanded?View.VISIBLE:View.GONE);
                label.setSingleLine(!expanded); label.setMaxLines(expanded?3:1);
                content.height=expanded?LinearLayout.LayoutParams.WRAP_CONTENT:dp(24); label.setLayoutParams(content);
                windows.updateViewLayout(panel,params);
            });
            capsule.setOnTouchListener(new View.OnTouchListener() {
                float x,y; int startX,startY; boolean moved;
                public boolean onTouch(View v, android.view.MotionEvent e) {
                    if(e.getAction()==0){x=e.getRawX();y=e.getRawY();startX=params.x;startY=params.y;moved=false;return true;}
                    if(e.getAction()==2){
                        if(Math.hypot(e.getRawX()-x,e.getRawY()-y)>ViewConfiguration.get(HarnessMonitorService.this).getScaledTouchSlop())moved=true;
                        if(moved){params.x=Math.max(0,Math.min(getResources().getDisplayMetrics().widthPixels-params.width,startX+(int)(e.getRawX()-x)));
                            params.y=Math.max(0,Math.min(getResources().getDisplayMetrics().heightPixels-panel.getHeight()-dp(48),startY+(int)(e.getRawY()-y)));windows.updateViewLayout(panel,params);}
                        return true;
                    }
                    if(e.getAction()==1){if(!moved)v.performClick();savedX=params.x;savedY=params.y;return true;}
                    return true;
                }
            });
            try { windows.addView(panel, params); } catch (RuntimeException error) { panel = null; return; }
        }
        indicator.setRunning(!tasks.isEmpty());
        label.setRunning(!tasks.isEmpty());
        label.setText(displayText(text));
        syncCaptureHidden();
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private TextView action(String text,int color){TextView v=new TextView(this);v.setText(text);v.setTextSize(12);v.setTextColor(color);v.setGravity(Gravity.CENTER);return v;}
    private String displayText(String text){
        if(text.equals("任务结束（completed）"))return "任务已完成";
        if(text.equals("任务结束（error）"))return "运行失败 · 打开对话查看";
        if(text.equals("任务结束（aborted）"))return "任务已停止";
        return text.replace("android_screen","分析屏幕").replace("android_screenshot","截图").replace("android_ui","读取界面").replace("android_tap_element","点按元素").replace("android_tap_cell","点按网格").replace("android_scroll","滚动界面").replace("android_shell","手机命令").replace("android_key","按键").replace("android_status","检查连接");
    }
    private void removePanel(){ if(panel!=null){ try{windows.removeView(panel);}catch(RuntimeException ignored){} panel=null; } }
    @Override public int onStartCommand(Intent intent,int flags,int id){render();return START_NOT_STICKY;}
    @Override public void onDestroy(){foregroundReady=false;main.removeCallbacksAndMessages(null);removePanel();instance=null;super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
