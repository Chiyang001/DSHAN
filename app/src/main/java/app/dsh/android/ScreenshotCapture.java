package app.dsh.android;

/** OEM screencap messages must never share the image output stream. */
final class ScreenshotCapture {
    static String command(String id) {
        if (!id.matches("[a-zA-Z0-9-]+")) throw new IllegalArgumentException("无效截图标识");
        String image = "/data/local/tmp/dsh-capture-" + id + ".png";
        String errors = image + ".err";
        return "screencap -p " + image + " >/dev/null 2>" + errors
            + "; dsh_capture_status=$?; if [ \"$dsh_capture_status\" -eq 0 ]; then cat " + image
            + "; dsh_capture_status=$?; else cat " + errors + " >&2; fi; rm -f " + image + " " + errors
            + "; exit \"$dsh_capture_status\"";
    }
    static boolean isPng(byte[] bytes) {
        byte[] signature = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10};
        if (bytes.length < 33) return false;
        for (int i = 0; i < signature.length; i++) if (bytes[i] != signature[i]) return false;
        return bytes[8] == 0 && bytes[9] == 0 && bytes[10] == 0 && bytes[11] == 13
            && bytes[12] == 'I' && bytes[13] == 'H' && bytes[14] == 'D' && bytes[15] == 'R';
    }
}
