package app.dsh.android;

import java.io.*;
import java.util.Arrays;

public final class AdbShellProtocolTest {
    public static void main(String[] args) throws Exception {
        byte[] png = new byte[20000];
        for (int i = 0; i < png.length; i++) png[i] = (byte) i;
        ByteArrayOutputStream frames = new ByteArrayOutputStream();
        frame(frames, 1, Arrays.copyOfRange(png, 0, 9000));
        frame(frames, 1, Arrays.copyOfRange(png, 9000, png.length));
        frame(frames, 3, new byte[] {0});
        InputStream fragmented = new ByteArrayInputStream(frames.toByteArray()) {
            @Override public synchronized int read(byte[] b, int off, int len) {
                if (available() == 0) throw new AssertionError("Command must finish without reading EOF");
                return super.read(b, off, Math.min(7, len));
            }
        };
        check(Arrays.equals(png, AdbShellProtocol.read(fragmented, png.length)), "Binary output and fragmented frames survive");
        frames.reset();
        frame(frames, 2, "error\n".getBytes());
        frame(frames, 1, "__DSH_EXIT:1\n".getBytes());
        frame(frames, 3, new byte[] {0});
        check(new String(AdbShellProtocol.read(new ByteArrayInputStream(frames.toByteArray()), 100)).equals("error\n__DSH_EXIT:1\n"), "stderr and command receipt retained");
        for (byte[] invalid : new byte[][] {
                {1, 4, 0, 0, 0, 1}, // Incomplete output.
                {1, 0, 0, 0, 0}, // Missing exit frame.
                {1, -1, -1, -1, -1}, // Unsigned oversized length.
                {3, 0, 0, 0, 0}, // Invalid exit length.
                {9, 0, 0, 0, 0}}) {
            try { AdbShellProtocol.read(new ByteArrayInputStream(invalid), 100); throw new AssertionError("Accepted broken frame"); }
            catch (IOException expected) { }
        }
        System.out.println("ADB shell v2 framing passed");
    }
    private static void frame(OutputStream out, int type, byte[] payload) throws IOException {
        out.write(type);
        for (int i = 0; i < 4; i++) out.write(payload.length >>> (8 * i) & 255);
        out.write(payload);
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
