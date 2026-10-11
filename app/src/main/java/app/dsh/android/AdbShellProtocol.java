package app.dsh.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** Decode shell v2 frames; EXIT, rather than socket EOF, ends a command. */
final class AdbShellProtocol {
    static byte[] read(InputStream input, int maxBytes) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] header = new byte[5];
        byte[] buffer = new byte[8192];
        while (true) {
            readFully(input, header, 5);
            int channel = header[0] & 255;
            long length = 0;
            for (int i = 0; i < 4; i++) length |= (long) (header[i + 1] & 255) << (8 * i);
            if (channel == 3) {
                if (length != 1) throw new IOException("ADB 命令退出帧无效");
                readFully(input, buffer, 1);
                return output.toByteArray();
            }
            if (channel != 1 && channel != 2) throw new IOException("ADB 命令输出帧无效");
            if (length > maxBytes - output.size()) throw new IOException("ADB 输出过大");
            while (length > 0) {
                int count = (int) Math.min(length, buffer.length);
                readFully(input, buffer, count);
                output.write(buffer, 0, count);
                length -= count;
            }
        }
    }

    private static void readFully(InputStream input, byte[] bytes, int length) throws IOException {
        int offset = 0;
        while (offset < length) {
            int count = input.read(bytes, offset, length - offset);
            if (count < 0) throw new IOException("COMMAND_OUTCOME_UNKNOWN: ADB 输出在退出帧之前中断，请检查设备，不要重复操作");
            if (count == 0) throw new IOException("ADB 输出读取未取得数据");
            offset += count;
        }
    }
}
