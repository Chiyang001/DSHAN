@echo off
chcp 65001 >nul 2>nul
rem ===========================================================================
rem  DSHAN 公共中转服务器 Windows 启动脚本
rem  纯批处理实现，不依赖 PowerShell。开发者：炽阳001
rem  用法：start.bat /?     部署说明：Server\README.md
rem ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
for %%i in ("%~dp0.") do set "ROOT=%%~fi"
title DSHAN 中转服务器

rem ---------------------------------------------------------------------------
rem 默认配置（可被 .env 与命令行参数覆盖）
rem ---------------------------------------------------------------------------
set "HOST=127.0.0.1"
set "PORT="
set "MAX_CLIENTS=96"
set "FRPC_EXE=%ROOT%\frp\frpc.exe"
set "FRPC_INI=%ROOT%\frp\frpc.ini"
set "VENV_DIR=%ROOT%\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
set "BOOT=%ROOT%\bootstrap.py"
set "LOGFILE="
set "MODE=start"
set "USE_FRP=1"
set "MIRROR=0"
set "PY_LAUNCHER="

rem ---------------------------------------------------------------------------
rem 可选配置文件 .env：每行 KEY=VALUE，可用 # 注释
rem 支持 HOST、PORT、MAX_CLIENTS、FRPC_INI、FRPC_EXE、NO_FRP
rem ---------------------------------------------------------------------------
if exist "%ROOT%\.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%ROOT%\.env") do (
        set "KEY=%%a"
        set "VAL=%%b"
        if /i "!KEY!"=="HOST" set "HOST=!VAL!"
        if /i "!KEY!"=="PORT" set "PORT=!VAL!"
        if /i "!KEY!"=="MAX_CLIENTS" set "MAX_CLIENTS=!VAL!"
        if /i "!KEY!"=="FRPC_INI" set "FRPC_INI=!VAL!"
        if /i "!KEY!"=="FRPC_EXE" set "FRPC_EXE=!VAL!"
        if /i "!KEY!"=="NO_FRP" if not "!VAL!"=="0" set "USE_FRP=0"
    )
    echo 已读取配置文件：%ROOT%\.env
)

rem ---------------------------------------------------------------------------
rem 参数解析
rem ---------------------------------------------------------------------------
:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /i "!ARG!"=="/?" goto usage
if /i "!ARG!"=="-h" goto usage
if /i "!ARG!"=="--help" goto usage
if /i "!ARG!"=="help" goto usage
if /i "!ARG!"=="/help" goto usage
if /i "!ARG!"=="/setup" (
    set "MODE=setup"
    shift
    goto parse_args
)
if /i "!ARG!"=="/check" (
    set "MODE=check"
    shift
    goto parse_args
)
if /i "!ARG!"=="/nofrp" (
    set "USE_FRP=0"
    shift
    goto parse_args
)
if /i "!ARG!"=="/mirror" (
    set "MIRROR=1"
    shift
    goto parse_args
)
if /i "!ARG!"=="/log" (
    set "LOGFILE=%ROOT%\logs\relay.log"
    shift
    goto parse_args
)
if /i "!ARG!"=="/port" (
    if "%~2"=="" goto usage_err
    set "PORT=%~2"
    shift
    shift
    goto parse_args
)
if /i "!ARG!"=="/host" (
    if "%~2"=="" goto usage_err
    set "HOST=%~2"
    shift
    shift
    goto parse_args
)
echo [错误] 无法识别的参数：!ARG!
echo.
goto usage_err
:args_done

rem ---------------------------------------------------------------------------
rem 端口：/port 或 .env 优先，其次读 frpc.ini 的 local_port，最后 16580
rem ---------------------------------------------------------------------------
if not defined PORT call :read_frp_port
if not defined PORT set "PORT=16580"
call :valid_port "%PORT%"
if errorlevel 1 (
    echo [错误] 端口无效：%PORT%（应为 1-65535 的整数）
    exit /b 1
)

rem ---------------------------------------------------------------------------
rem /log：把整个服务的输出重定向到日志文件（重新调用本脚本，控制台只提示）
rem ---------------------------------------------------------------------------
if /i not "%MODE%"=="start" set "LOGFILE="
if defined LOGFILE if not defined DSHAN_LOGMODE (
    set "DSHAN_LOGMODE=1"
    if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
    if exist "%LOGFILE%" move /y "%LOGFILE%" "%LOGFILE%.prev" >nul
    set "FWD=/host %HOST% /port %PORT%"
    if "!USE_FRP!"=="0" set "FWD=!FWD! /nofrp"
    echo 日志模式：服务输出写入 %LOGFILE%
    call "%~f0" !FWD! >> "%LOGFILE%" 2>&1
    set "RC=!errorlevel!"
    echo 服务已退出，退出码 !RC!。日志：%LOGFILE%
    exit /b !RC!
)

rem ---------------------------------------------------------------------------
rem 定位 Python 3
rem ---------------------------------------------------------------------------
set "PY="
if exist "%VENV_PY%" (
    set "PY=%VENV_PY%"
) else (
    call :find_system_python
)
if not defined PY (
    echo [错误] 未找到 Python 3，或它无法执行。
    echo        请安装 Python 3.13 并在安装时勾选 Add python.exe to PATH：
    echo        https://www.python.org/downloads/windows/
    echo        也可先执行 start.bat /setup 自动创建虚拟环境。
    exit /b 1
)
if defined PY_LAUNCHER (
    "%PY%" -3 "%BOOT%" require-39 >nul 2>nul
) else (
    "%PY%" "%BOOT%" require-39 >nul 2>nul
)
if errorlevel 1 (
    echo [错误] Python 无法执行 %BOOT%，或版本低于 3.9。
    exit /b 1
)
set "PYVER="
for /f "tokens=2" %%v in ('"%PY%" --version 2^>^&1') do set "PYVER=%%v"
if not defined PYVER set "PYVER=未知"

if /i "%MODE%"=="setup" goto mode_setup
if /i "%MODE%"=="check" goto mode_check
goto mode_start

rem ===========================================================================
rem /setup：创建或更新虚拟环境并安装依赖
rem ===========================================================================
:mode_setup
if not exist "%VENV_PY%" (
    echo 正在创建虚拟环境：%VENV_DIR%
    if defined PY_LAUNCHER ("%PY%" -3 -m venv "%VENV_DIR%") else ("%PY%" -m venv "%VENV_DIR%")
    if not exist "%VENV_PY%" (
        echo [错误] 创建虚拟环境失败。
        exit /b 1
    )
    set "PY=%VENV_PY%"
    set "PY_LAUNCHER="
)
call :install_deps
if errorlevel 1 exit /b 1
echo 环境已就绪：%VENV_PY%
echo 启动服务：start.bat
exit /b 0

rem ===========================================================================
rem /check：只做自检，不改动环境、不启动服务
rem ===========================================================================
:mode_check
set "CHECK_RC=0"
echo ===== DSHAN 中转服务器自检 =====
echo 目录        : %ROOT%
echo Python      : %PY%
echo Python 版本 : !PYVER!
echo 监听地址    : %HOST%:%PORT%
if exist "%VENV_PY%" (
    echo 虚拟环境    : 已就绪
) else (
    echo 虚拟环境    : 未创建（运行 start.bat /setup）
    set "CHECK_RC=1"
)
if exist "%VENV_PY%" (
    "%VENV_PY%" "%BOOT%" deps >nul 2>nul
    if errorlevel 1 (
        echo 服务依赖    : 缺失（运行 start.bat /setup）
        set "CHECK_RC=1"
    ) else (
        echo 服务依赖    : 已安装（Flask、flask-sock、simple-websocket）
    )
)
if "!USE_FRP!"=="0" (
    echo FRP 隧道    : 已按要求跳过（/nofrp 或 NO_FRP）
) else (
    if exist "%FRPC_EXE%" (echo frpc 程序   : %FRPC_EXE%) else (echo frpc 程序   : 缺失 %FRPC_EXE%& set "CHECK_RC=1")
    if exist "%FRPC_INI%" (echo frpc 配置   : %FRPC_INI%) else (echo frpc 配置   : 缺失 %FRPC_INI%& set "CHECK_RC=1")
)
call :listener_pid "%PORT%"
if defined LPID (
    call :probe_ours "%PORT%"
    call :probe_health "%PORT%"
    if "!OURS!"=="1" (
        echo 端口状态    : 本中转服务正在运行，PID !LPID!，健康检查 !HEALTHY!
    ) else if "!HEALTHY!"=="1" (
        echo 端口状态    : 被其他 DSH 配对服务占用，PID !LPID!，可能是旧版 Node 服务
        set "CHECK_RC=1"
    ) else (
        echo 端口状态    : 被其他程序占用，PID !LPID!
        set "CHECK_RC=1"
    )
) else (
    echo 端口状态    : 空闲
)
if "!CHECK_RC!"=="0" (echo 自检结论    : 通过) else (echo 自检结论    : 未通过，请处理上面的提示)
exit /b !CHECK_RC!

rem ===========================================================================
rem 默认：启动 frpc 与 Flask 中转服务
rem ===========================================================================
:mode_start
if not exist "%VENV_PY%" (
    echo 首次运行：正在创建虚拟环境 %VENV_DIR%
    if defined PY_LAUNCHER ("%PY%" -3 -m venv "%VENV_DIR%") else ("%PY%" -m venv "%VENV_DIR%")
    if not exist "%VENV_PY%" (
        echo [错误] 创建虚拟环境失败。
        exit /b 1
    )
    set "PY=%VENV_PY%"
    set "PY_LAUNCHER="
)
"%PY%" "%BOOT%" deps >nul 2>nul
if errorlevel 1 (
    call :install_deps
    if errorlevel 1 exit /b 1
)
"%PY%" "%BOOT%" deps >nul 2>nul
if errorlevel 1 (
    echo [错误] 依赖不可用，请执行 start.bat /setup 并检查网络或镜像设置。
    exit /b 1
)

rem ---- 端口占用检查：已在运行则直接复用，被别的程序占用则明确报错 ----
call :listener_pid "%PORT%"
if defined LPID (
    call :probe_ours "%PORT%"
    if "!OURS!"=="1" (
        echo 本中转服务已在运行，PID !LPID!，%HOST%:%PORT%，无需重复启动。
        call :ensure_frpc
        exit /b 0
    )
    call :probe_health "%PORT%"
    if "!HEALTHY!"=="1" (
        echo [错误] 端口 %PORT% 已被另一个 DSH 配对服务占用，PID !LPID!，可能是旧版 Node 服务。
    ) else (
        echo [错误] 端口 %PORT% 已被其他程序占用，PID !LPID!。
    )
    echo        本脚本不会结束不属于它的进程。请先停止该程序，或指定其他端口：
    echo            start.bat /port 16581
    exit /b 1
)

call :ensure_frpc

echo.
echo ===== DSHAN 中转服务器 =====
echo 本机监听   : http://%HOST%:%PORT%/peer
echo 健康检查   : http://127.0.0.1:%PORT%/health
if not "!USE_FRP!"=="0" echo FRP 隧道   : %FRPC_INI% 的 custom_domains 域名
echo 停止服务   : 在本窗口按 Ctrl+C 结束中转服务，再执行 stop.bat 结束 frpc
echo.
set "HOST=%HOST%"
set "PORT=%PORT%"
set "MAX_CLIENTS=%MAX_CLIENTS%"
"%PY%" "%ROOT%\app.py"
set "RC=!errorlevel!"
echo.
echo 中转服务已退出，退出码 !RC!。
if not "!USE_FRP!"=="0" echo 提示：frpc 仍在后台窗口运行，需要一并结束请执行 stop.bat。
exit /b !RC!

rem ===========================================================================
rem 子过程
rem ===========================================================================

:find_system_python
for /f "delims=" %%p in ('where python 2^>nul') do set "PY=%%p" & exit /b 0
if exist "%LocalAppData%\Programs\Python\Python313\python.exe" (
    set "PY=%LocalAppData%\Programs\Python\Python313\python.exe"
    exit /b 0
)
if exist "%LocalAppData%\Programs\Python\Python312\python.exe" (
    set "PY=%LocalAppData%\Programs\Python\Python312\python.exe"
    exit /b 0
)
where py >nul 2>nul
if not errorlevel 1 (
    set "PY=py"
    set "PY_LAUNCHER=1"
)
exit /b 0

:read_frp_port
if not exist "%FRPC_INI%" exit /b 0
for /f "usebackq tokens=1,2 delims== " %%a in ("%FRPC_INI%") do (
    if /i "%%a"=="local_port" set "PORT=%%b"
)
exit /b 0

:valid_port
set "VP=%~1"
echo !VP!| findstr /r "^[1-9][0-9]*$" >nul || exit /b 1
if !VP! GTR 65535 exit /b 1
exit /b 0

:install_deps
if "%MIRROR%"=="1" if not defined PIP_INDEX_URL set "PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple"
echo 正在安装依赖（%ROOT%\requirements.txt）...
if defined PY_LAUNCHER (
    "%PY%" -3 -m pip install --disable-pip-version-check -r "%ROOT%\requirements.txt"
) else (
    "%PY%" -m pip install --disable-pip-version-check -r "%ROOT%\requirements.txt"
)
if errorlevel 1 (
    echo [错误] 依赖安装失败。可改用镜像重试：start.bat /setup /mirror
    exit /b 1
)
exit /b 0

:listener_pid
set "LPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%~1 " ^| findstr /i "LISTENING"') do set "LPID=%%p"
exit /b 0

:probe_ours
set "OURS=0"
set "BODY="
where curl >nul 2>nul || exit /b 0
for /f "usebackq delims=" %%r in (`curl -s -m 3 "http://127.0.0.1:%~1/"`) do set "BODY=%%r"
echo !BODY!| findstr /c:"DSHAN Server is online" >nul && set "OURS=1"
exit /b 0

:probe_health
set "HEALTHY=0"
where curl >nul 2>nul || exit /b 0
for /f "usebackq delims=" %%r in (`curl -s -m 3 "http://127.0.0.1:%~1/health"`) do if /i "%%r"=="ok" set "HEALTHY=1"
exit /b 0

:ensure_frpc
if "!USE_FRP!"=="0" (
    echo 已跳过 frpc（/nofrp 或 NO_FRP）：请自行保证公网入口指向 %HOST%:%PORT%。
    exit /b 0
)
if not exist "%FRPC_EXE%" (
    echo [警告] 未找到 %FRPC_EXE%，本次不启动 FRP 隧道。
    echo        可将原 frp 目录中的 frpc.exe 复制到 Server\frp，并参考 frpc.ini.example 创建 frpc.ini。
    exit /b 0
)
if not exist "%FRPC_INI%" (
    echo [警告] 未找到 %FRPC_INI%，本次不启动 FRP 隧道。
    echo        请复制 frp\frpc.ini.example 为 frpc.ini 并填入真实参数。
    exit /b 0
)
tasklist /FI "IMAGENAME eq frpc.exe" /NH 2>nul | findstr /i /c:"frpc.exe" >nul
if not errorlevel 1 (
    echo frpc 已在运行，跳过启动。
    exit /b 0
)
echo 正在启动 frpc，配置：%FRPC_INI%
start "DSHAN frpc" /min /d "%ROOT%\frp" "%FRPC_EXE%" -c "%FRPC_INI%"
ping -n 3 127.0.0.1 >nul
tasklist /FI "IMAGENAME eq frpc.exe" /NH 2>nul | findstr /i /c:"frpc.exe" >nul
if errorlevel 1 (
    echo [警告] frpc 启动后立即退出，请检查 server_addr、token 与代理名是否与其他机器冲突。
) else (
    echo frpc 已启动，最小化窗口标题：DSHAN frpc。
)
exit /b 0

:usage_err
echo.
echo 提示：参数缺失或无效，请查看用法。
echo.
:usage
echo DSHAN 中转服务器（Windows）启动脚本 —— 纯批处理
echo.
echo 用法：start.bat [选项]
echo.
echo   /port N     指定服务监听端口（默认取 frp\frpc.ini 的 local_port，再退回 16580）
echo   /host IP    指定监听地址（默认 127.0.0.1；本机与 frpc 同机时保持默认）
echo   /nofrp      只启动 Flask 中转服务，不启动 frpc
echo   /setup      创建或更新 .venv 并安装依赖，然后退出
echo   /check      只做环境与端口自检，不启动任何服务
echo   /mirror     安装依赖时使用清华 PyPI 镜像（设置 PIP_INDEX_URL 可覆盖）
echo   /log        服务日志写入 logs\relay.log（上一次保存为 relay.log.prev）
echo   /?          显示本帮助
echo.
echo 可选配置：在 %ROOT%\.env 中设置 PORT、HOST、MAX_CLIENTS、FRPC_INI、FRPC_EXE、NO_FRP
echo 停止服务：服务窗口按 Ctrl+C；frpc 由 stop.bat 结束
exit /b 0
