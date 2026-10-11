package app.dsh.android;

public final class AdbPairingInputTest {
    public static void main(String[] args) {
        check(AdbPairingInput.pairing(" 001234 ")[0].equals("001234"));
        String[] manual = AdbPairingInput.pairing("37123 001234");
        check(manual[0].equals("37123") && manual[1].equals("001234"));
        check(AdbPairingInput.port("65535") == 65535);
        for (String input : new String[] {"", "12345", "1234567", "abcdef", "0 123456", "65536 123456", "123 456 789", "127.0.0.1:123 123456"}) {
            try { AdbPairingInput.pairing(input); throw new AssertionError("Accepted invalid input"); }
            catch (IllegalArgumentException expected) { }
        }
        for (String input : new String[] {"0", "65536", "-1", "1.2", "1 2"}) {
            try { AdbPairingInput.port(input); throw new AssertionError("Accepted invalid port"); }
            catch (IllegalArgumentException expected) { }
        }
        System.out.println("ADB reply validation passed");
    }
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
}
