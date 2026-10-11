package app.dsh.android;

import android.os.ParcelFileDescriptor;
import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.Parcelable;
import android.os.RemoteException;
import java.io.InputStream;
import java.io.OutputStream;

public final class RemoteShellService extends Binder {
    private static final String DESCRIPTOR = "app.dsh.android.RemoteShellService";
    private static final int EXECUTE = IBinder.FIRST_CALL_TRANSACTION;
    private static final int CAPTURE = EXECUTE + 1;
    private static final int DISPLAYS = EXECUTE + 2;
    private static final int HEALTH = EXECUTE + 3;
    public RemoteShellService() { }

    @Override protected boolean onTransact(int code, Parcel data, Parcel reply, int flags)
            throws RemoteException {
        // Shizuku uses this transaction to retire a stale UserService.
        if (code == 16777115) {
            System.exit(0);
            return true;
        }
        if (code == HEALTH) {
            data.enforceInterface(DESCRIPTOR);
            reply.writeNoException();
            reply.writeInt(android.os.Process.myUid());
            return true;
        }
        if (code == EXECUTE) {
            data.enforceInterface(DESCRIPTOR);
            ParcelFileDescriptor fd = execute(data.readString());
            reply.writeNoException();
            reply.writeTypedObject(fd, Parcelable.PARCELABLE_WRITE_RETURN_VALUE);
            return true;
        }
        if (code == CAPTURE) {
            data.enforceInterface(DESCRIPTOR);
            int displayId = data.readInt();
            try {
                if (android.os.Build.VERSION.SDK_INT < 34)
                    throw new IllegalStateException("副屏截图需要 Android 14 或更高版本");
                // WindowManager accepts logical display IDs, unlike screencap's
                // SurfaceFlinger IDs. This also captures private virtual displays.
                Class<?> capture = Class.forName("android.window.ScreenCapture");
                Object listener = capture.getMethod("createSyncCaptureListener").invoke(null);
                Class<?> service = Class.forName("android.os.ServiceManager");
                IBinder window = (IBinder) service.getMethod("getService", String.class).invoke(null, "window");
                Class<?> stub = Class.forName("android.view.IWindowManager$Stub");
                Object manager = stub.getMethod("asInterface", IBinder.class).invoke(null, window);
                Class<?> api = Class.forName("android.view.IWindowManager");
                api.getMethod("captureDisplay", int.class,
                    Class.forName("android.window.ScreenCapture$CaptureArgs"),
                    Class.forName("android.window.ScreenCapture$ScreenCaptureListener"))
                    .invoke(manager, displayId, null, listener);
                Object buffer = listener.getClass().getMethod("getBuffer").invoke(listener);
                if (buffer == null) throw new IllegalStateException("副屏截图未返回图像");
                android.graphics.Bitmap bitmap = (android.graphics.Bitmap) buffer.getClass().getMethod("asBitmap").invoke(buffer);
                android.hardware.HardwareBuffer hardware = (android.hardware.HardwareBuffer)
                    buffer.getClass().getMethod("getHardwareBuffer").invoke(buffer);
                if (hardware != null) hardware.close();
                if (bitmap == null) throw new IllegalStateException("副屏截图为空");
                ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
                new Thread(() -> {
                    try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
                    } catch (Exception ignored) { }
                    finally { bitmap.recycle(); }
                }, "dsh-display-capture").start();
                reply.writeNoException();
                reply.writeTypedObject(pipe[0], Parcelable.PARCELABLE_WRITE_RETURN_VALUE);
            } catch (Exception error) {
                reply.writeException(new IllegalStateException("DISPLAY_CAPTURE_UNAVAILABLE: 无法截图指定副屏；不会回退主屏。" + error));
            }
            return true;
        }
        if (code == DISPLAYS) {
            data.enforceInterface(DESCRIPTOR);
            try {
                Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
                Object manager = global.getMethod("getInstance").invoke(null);
                int[] ids;
                try { ids = (int[]) global.getMethod("getDisplayIds").invoke(manager); }
                catch (NoSuchMethodException newer) {
                    ids = (int[]) global.getMethod("getDisplayIds", boolean.class).invoke(manager, false);
                }
                org.json.JSONArray displays = new org.json.JSONArray();
                for (int id : ids) {
                    Object info = global.getMethod("getDisplayInfo", int.class).invoke(manager, id);
                    if (info == null) continue;
                    Class<?> type = info.getClass();
                    displays.put(new org.json.JSONObject().put("displayId", id)
                        .put("name", type.getField("name").get(info))
                        .put("width", type.getField("logicalWidth").getInt(info))
                        .put("height", type.getField("logicalHeight").getInt(info))
                        .put("rotation", type.getField("rotation").getInt(info)));
                }
                reply.writeNoException();
                reply.writeString(displays.toString());
            } catch (Exception error) { reply.writeException(new IllegalStateException("无法枚举屏幕：" + error)); }
            return true;
        }
        return super.onTransact(code, data, reply, flags);
    }

    static ParcelFileDescriptor captureOn(IBinder binder, int displayId) throws RemoteException {
        Parcel data = Parcel.obtain(), reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(DESCRIPTOR);
            data.writeInt(displayId);
            if (!binder.transact(CAPTURE, data, reply, 0)) throw new RemoteException("请重新连接 Shizuku 服务以支持副屏截图");
            reply.readException();
            return reply.readTypedObject(ParcelFileDescriptor.CREATOR);
        } finally { data.recycle(); reply.recycle(); }
    }

    static String displaysOn(IBinder binder) throws RemoteException {
        Parcel data = Parcel.obtain(), reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(DESCRIPTOR);
            if (!binder.transact(DISPLAYS, data, reply, 0)) throw new RemoteException("请重新连接 Shizuku 服务以支持副屏");
            reply.readException();
            return reply.readString();
        } finally { data.recycle(); reply.recycle(); }
    }

    static ParcelFileDescriptor executeOn(IBinder binder, String command) throws RemoteException {
        Parcel data = Parcel.obtain();
        Parcel reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(DESCRIPTOR);
            data.writeString(command);
            if (!binder.transact(EXECUTE, data, reply, 0)) throw new RemoteException("Shizuku 服务未响应");
            reply.readException();
            return reply.readTypedObject(ParcelFileDescriptor.CREATOR);
        } finally {
            data.recycle();
            reply.recycle();
        }
    }

    static void verifyOn(IBinder binder) throws RemoteException {
        Parcel data = Parcel.obtain(), reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(DESCRIPTOR);
            if (!binder.transact(HEALTH, data, reply, 0)) throw new RemoteException("设备服务版本过旧");
            reply.readException();
            int uid = reply.readInt();
            if (uid != 0 && uid != 2000) throw new RemoteException("设备服务未取得 shell 或 Root 权限");
        } finally { data.recycle(); reply.recycle(); }
    }

    private ParcelFileDescriptor execute(String command) throws RemoteException {
        if (command == null || command.length() > 4096) throw new IllegalArgumentException("无效命令");
        try {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            new Thread(() -> {
                try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                    Process process = new ProcessBuilder("/system/bin/sh", "-c", command)
                        .redirectErrorStream(true).start();
                    try (InputStream in = process.getInputStream()) {
                        byte[] bytes = new byte[8192];
                        int count;
                        while ((count = in.read(bytes)) != -1) out.write(bytes, 0, count);
                    } finally {
                        process.waitFor();
                    }
                } catch (Exception ignored) { }
            }, "dsh-shizuku-shell").start();
            return pipe[0];
        } catch (Exception error) {
            throw new RemoteException(error.toString());
        }
    }
}
