@echo off
chcp 65001 >nul 2>nul
rem DSHAN 中转服务器停止脚本 —— 纯批处理
setlocal EnableExtensions
cd /d "%~dp0"
title DSHAN 停止中转服务

echo ===== 停止 DSHAN 中转服务 =====
echo.
echo 正在结束 frpc...
taskkill /IM frpc.exe /F >nul 2>&1
if errorlevel 1 (
    echo 未发现运行中的 frpc。
) else (
    echo frpc 已结束。
)
echo.
echo Flask 中转服务由 start.bat 在前台运行；若仍在监听，请在该窗口按 Ctrl+C。
exit /b 0
