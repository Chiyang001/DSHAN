param(
    [Parameter(Mandatory = $true)][string]$FrpConfig,
    [string]$Section = 'DSHAN_P2P',
    [string]$NodePath
)
$ErrorActionPreference = 'Stop'
$resolvedConfig = (Resolve-Path -LiteralPath $FrpConfig).Path
$frpDirectory = Split-Path -Parent $resolvedConfig
$frpcPath = Join-Path $frpDirectory 'frpc.exe'
if (-not (Test-Path -LiteralPath $frpcPath)) { throw '找不到配置文件旁边的 frpc.exe' }
$peerDirectory = Split-Path -Parent $PSScriptRoot
$signalScript = Join-Path $peerDirectory 'signal-server.js'
$sectionText = ''
$inSection = $false
foreach ($line in Get-Content -LiteralPath $resolvedConfig) {
    if ($line -match '^\s*\[([^]]+)\]\s*$') { $inSection = $Matches[1] -eq $Section }
    elseif ($inSection) { $sectionText += $line + "`n" }
}
if ($sectionText -notmatch '(?m)^\s*local_port\s*=\s*(\d+)\s*$') { throw "找不到 $Section 的本地端口" }
$signalPort = [int]$Matches[1]
if ($signalPort -lt 1 -or $signalPort -gt 65535) { throw '本地端口无效' }
if (-not $NodePath) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodePath = $nodeCommand.Source }
    else { $NodePath = 'C:\Program Files\nodejs\node.exe' }
}
if (-not (Test-Path -LiteralPath $NodePath)) { throw '请通过 -NodePath 指定 Node.js 22 或更新版本的路径' }
$listener = Get-NetTCPConnection -State Listen -LocalPort $signalPort -ErrorAction SilentlyContinue
if (-not $listener) {
    $taskStartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $taskStartInfo.FileName = $NodePath
    $taskStartInfo.Arguments = '"' + $signalScript + '"'
    $taskStartInfo.UseShellExecute = $false
    $taskStartInfo.CreateNoWindow = $true
    $taskStartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $taskStartInfo.EnvironmentVariables['PORT'] = [string]$signalPort
    $taskStartInfo.EnvironmentVariables['HOST'] = '127.0.0.1'
    $signalProcess = [System.Diagnostics.Process]::Start($taskStartInfo)
}
$serviceReady = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
        $health = Invoke-WebRequest -Uri "http://127.0.0.1:$signalPort/health" -UseBasicParsing -TimeoutSec 2
        $healthText = [System.Text.Encoding]::UTF8.GetString($health.RawContentStream.ToArray())
        if ($healthText -eq 'ok' -and @($health.Headers['X-DSH-Peer-Relay']) -contains '1') { $serviceReady = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 250
}
if (-not $serviceReady) { throw '本地端口未运行新版 DSH Peer 服务；请关闭旧版服务后重新运行。不会停止占用端口的其他程序。' }
$existingFrpc = Get-CimInstance Win32_Process -Filter "Name = 'frpc.exe'" | Where-Object {
    $_.ExecutablePath -eq $frpcPath -and $_.CommandLine -match [regex]::Escape((Split-Path -Leaf $resolvedConfig))
}
if (-not $existingFrpc) {
    Start-Process -FilePath $frpcPath -ArgumentList @('-c', ('"' + $resolvedConfig + '"')) -WorkingDirectory $frpDirectory -WindowStyle Hidden | Out-Null
}
Write-Output 'DSH Peer 信令、加密中继和 FRP 已启动。保持电脑运行即可使用。'
