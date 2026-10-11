package app.dsh.android;

import java.nio.file.Files;
import java.nio.file.Path;

public final class ScreenshotCaptureTest {
    public static void main(String[] args) throws Exception {
        byte[] header = new byte[33];
        byte[] signature = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10};
        System.arraycopy(signature, 0, header, 0, signature.length);
        header[11] = 13;
        System.arraycopy(new byte[] {'I', 'H', 'D', 'R'}, 0, header, 12, 4);
        check(ScreenshotCapture.isPng(header));
        header[5] = 13;
        check(!ScreenshotCapture.isPng(header));
        check(!ScreenshotCapture.isPng(new byte[0]));
        try { ScreenshotCapture.command("bad;id"); throw new AssertionError(); }
        catch (IllegalArgumentException expected) { }
        if (args.length == 1) {
            // Force the same OEM stdout/stderr pollution that breaks direct captures.
            String fixture = "screencap() { printf 'OEM stdout diagnostic\\n'; printf 'OEM stderr diagnostic\\n' >&2; /system/bin/screencap \"$@\"; }\n";
            Files.writeString(Path.of(args[0]), fixture + ScreenshotCapture.command("compat-test") + "\n");
        }
        System.out.println("Screenshot header validation passed");
    }
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
}
