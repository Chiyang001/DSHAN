package app.dsh.android;

import android.content.Context;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.math.BigInteger;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Date;
import java.util.concurrent.TimeUnit;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import io.github.muntashirakon.adb.AbsAdbConnectionManager;
import io.github.muntashirakon.adb.AdbStream;

final class AdbClient extends AbsAdbConnectionManager {
    private static AdbClient instance;
    static synchronized AdbClient get(Context context) throws Exception {
        if (instance == null) instance = new AdbClient(context);
        return instance;
    }
    static volatile String pairingStatus = "尚未连接无线 ADB";
    private final PrivateKey key;
    private final Certificate certificate;
    private final Context context;

    AdbClient(Context context) throws Exception {
        this.context = context.getApplicationContext();
        setApi(Build.VERSION.SDK_INT);
        setTimeout(15, TimeUnit.SECONDS);
        File dir = this.context.getNoBackupFilesDir();
        File keyFile = new File(dir, "adb-private.pk8");
        File certFile = new File(dir, "adb-cert.der");
        if (!keyFile.exists() || !certFile.exists()) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048, new SecureRandom());
            KeyPair pair = generator.generateKeyPair();
            X500Name subject = new X500Name("CN=Deepseek Harness for Android Native");
            Date from = new Date(System.currentTimeMillis() - 60000);
            Date to = new Date(System.currentTimeMillis() + 20L * 365 * 86400000);
            JcaX509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(
                subject, BigInteger.valueOf(System.currentTimeMillis()), from, to,
                subject, pair.getPublic());
            Certificate generated = new JcaX509CertificateConverter().getCertificate(
                builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(pair.getPrivate())));
            try (FileOutputStream out = new FileOutputStream(keyFile)) { out.write(pair.getPrivate().getEncoded()); }
            try (FileOutputStream out = new FileOutputStream(certFile)) { out.write(generated.getEncoded()); }
        }
        try (FileInputStream in = new FileInputStream(keyFile)) {
            byte[] data = readAll(in, 8192);
            key = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(data));
        }
        try (FileInputStream in = new FileInputStream(certFile)) {
            certificate = CertificateFactory.getInstance("X.509").generateCertificate(in);
        }
    }

    @Override protected PrivateKey getPrivateKey() { return key; }
    @Override protected Certificate getCertificate() { return certificate; }
    @Override protected String getDeviceName() { return "Deepseek Harness for Android Native"; }

    byte[] execute(String command, int maxBytes) throws Exception {
        if (!isConnected()) throw new IllegalStateException("无线 ADB 尚未连接");
        AdbStream stream = openStream("shell,v2,raw:" + command);
        // libadb 3.1.1's InputStream can discard buffered bytes after CLSE;
        // its raw stream can also wait/throw on EOF. Read raw buffered data
        // until the shell v2 EXIT frame, never until transport closure.
        try {
            return AdbShellProtocol.read(new InputStream() {
                @Override public int read() throws java.io.IOException {
                    byte[] value = new byte[1];
                    int count = read(value, 0, 1);
                    return count < 0 ? -1 : value[0] & 255;
                }
                @Override public int read(byte[] bytes, int offset, int length) throws java.io.IOException {
                    return stream.read(bytes, offset, length);
                }
            }, maxBytes);
        } finally {
            stream.close();
        }
    }

    static byte[] readAll(InputStream in, int maxBytes) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = in.read(buffer)) != -1) {
            if (out.size() + count > maxBytes) throw new IllegalStateException("ADB 输出过大");
            out.write(buffer, 0, count);
        }
        return out.toByteArray();
    }
}
