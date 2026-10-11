package app.dsh.android;

/** Notification replies accept a code, or an optional local port plus code. */
final class AdbPairingInput {
    static String[] pairing(String text) {
        String[] parts = text.trim().split("\\s+");
        if (parts.length < 1 || parts.length > 2 || !parts[parts.length - 1].matches("[0-9]{6}"))
            throw new IllegalArgumentException("请输入六位配对码；未发现端口时输入“配对端口 六位配对码”");
        if (parts.length == 2) port(parts[0]);
        return parts;
    }
    static int port(String text) {
        if (!text.matches("[0-9]{1,5}")) throw new IllegalArgumentException("请输入有效端口（1–65535）");
        int value = Integer.parseInt(text);
        if (value < 1 || value > 65535) throw new IllegalArgumentException("请输入有效端口（1–65535）");
        return value;
    }
}
