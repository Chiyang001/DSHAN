#include <jni.h>
#include <node.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <unistd.h>
#include <fcntl.h>

static std::string utf(JNIEnv* env, jstring value) {
    const char* chars = env->GetStringUTFChars(value, nullptr);
    std::string result(chars);
    env->ReleaseStringUTFChars(value, chars);
    return result;
}

extern "C" JNIEXPORT jint JNICALL
Java_app_dsh_android_NodeRuntime_start(JNIEnv* env, jclass,
        jstring home, jstring cache, jstring dshHome, jstring token,
        jstring script, jstring patch, jstring storageRoot, jstring flockLibrary) {
    std::string homePath = utf(env, home);
    std::string cachePath = utf(env, cache);
    std::string dshHomePath = utf(env, dshHome);
    std::string bridgeToken = utf(env, token);
    std::string scriptPath = utf(env, script);
    std::string patchPath = utf(env, patch);
    std::string storageRootPath = utf(env, storageRoot);
    std::string flockLibraryPath = utf(env, flockLibrary);
    setenv("DSH_ANDROID_FLOCK_LIBRARY", flockLibraryPath.c_str(), 1);
    std::string ptyLibraryPath = flockLibraryPath.substr(0, flockLibraryPath.find_last_of('/') + 1) + "libdshpty.so";
    setenv("DSH_ANDROID_PTY_LIBRARY", ptyLibraryPath.c_str(), 1);
    std::string nodeExecutable = flockLibraryPath.substr(0, flockLibraryPath.find_last_of('/') + 1) + "libdshnode.so";
    setenv("DSH_ANDROID_NODE", nodeExecutable.c_str(), 1);
    setenv("HOME", homePath.c_str(), 1);
    setenv("TMPDIR", cachePath.c_str(), 1);
    setenv("DSH_HOME", dshHomePath.c_str(), 1);
    setenv("DSH_ANDROID_STORAGE_ROOT", storageRootPath.c_str(), 1);
    setenv("DSH_ANDROID_BRIDGE_TOKEN", bridgeToken.c_str(), 1);
    std::string urlFile = homePath + "/dsh-web-url";
    setenv("DSH_ANDROID_URL_FILE", urlFile.c_str(), 1);
    setenv("NODE_COMPILE_CACHE", cachePath.c_str(), 1);
    setenv("NODE_OPTIONS", "--max-old-space-size=512", 1);
    setenv("PATH", "/system/bin:/system/xbin", 1);
    setenv("SHELL", "/system/bin/sh", 1);
    setenv("TERM", "xterm-256color", 1);
    chdir(homePath.c_str());
    std::string logPath = homePath + "/dsh-node.log";
    int logFd = open(logPath.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (logFd >= 0) {
        dup2(logFd, STDOUT_FILENO);
        dup2(logFd, STDERR_FILENO);
        close(logFd);
    }

    std::string preloadPath = scriptPath.substr(0, scriptPath.find("/node_modules/")) + "/mobile-bootstrap.cjs";
    std::vector<std::string> args = {"node", "--expose-internals", "--require", preloadPath,
        scriptPath, "--profile", "web",
        "--patch", patchPath, "--no-open", "--host", "127.0.0.1", "--port", "3080"};
    size_t bytes = 0;
    for (const auto& arg : args) bytes += arg.size() + 1;
    std::vector<char> buffer(bytes);
    std::vector<char*> argv;
    char* cursor = buffer.data();
    for (const auto& arg : args) {
        memcpy(cursor, arg.c_str(), arg.size() + 1);
        argv.push_back(cursor);
        cursor += arg.size() + 1;
    }
    return node::Start(static_cast<int>(argv.size()), argv.data());
}
