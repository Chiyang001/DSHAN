package app.dsh.android;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Shader;
import android.view.animation.LinearInterpolator;
import android.widget.TextView;

/** Blue left-to-right text highlight while a background task is active. */
// Uses the platform Material theme, including in a Service overlay. AppCompat
// theme/tint support is intentionally not required for this API 30+ view.
@android.annotation.SuppressLint("AppCompatCustomView")
final class ShimmerTextView extends TextView {
    private static final int BASE = Color.rgb(230, 235, 246);
    private static final int BLUE = Color.rgb(105, 180, 255);
    private static final int BRIGHT = Color.rgb(195, 225, 255);

    private ValueAnimator animator;
    private float phase;
    private boolean running;

    ShimmerTextView(Context context) {
        super(context);
        setTextColor(BASE);
    }

    void setRunning(boolean value) {
        if (running == value) return;
        running = value;
        stopAnimation();
        if (value && isAttachedToWindow() && ValueAnimator.areAnimatorsEnabled()) {
            animator = ValueAnimator.ofFloat(0, 1);
            animator.setDuration(2400);
            animator.setInterpolator(new LinearInterpolator());
            animator.setRepeatCount(ValueAnimator.INFINITE);
            animator.addUpdateListener(a -> {
                phase = (float) a.getAnimatedValue();
                invalidate();
            });
            animator.start();
        }
        invalidate();
    }

    private void stopAnimation() {
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
        phase = 0;
        getPaint().setShader(null);
        setTextColor(BASE);
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (running) {
            running = false;
            setRunning(true);
        }
    }

    @Override protected void onDetachedFromWindow() {
        stopAnimation();
        super.onDetachedFromWindow();
    }

    @Override protected void onDraw(Canvas canvas) {
        if (!running || animator == null) {
            getPaint().setShader(null);
            super.onDraw(canvas);
            return;
        }
        CharSequence text = getText();
        float textWidth = text == null || text.length() == 0 ? getWidth() : getPaint().measureText(text, 0, text.length());
        float width = Math.max(getWidth(), textWidth);
        float travel = Math.min(1f, phase / 0.78f);
        float band = width * 0.48f;
        float center = -band + travel * (width + 2 * band);
        getPaint().setShader(new LinearGradient(
            center - band, 0, center + band, getHeight(),
            new int[] {BASE, BLUE, BRIGHT, BASE},
            new float[] {0f, 0.38f, 0.55f, 1f},
            Shader.TileMode.CLAMP));
        super.onDraw(canvas);
        getPaint().setShader(null);
    }
}
