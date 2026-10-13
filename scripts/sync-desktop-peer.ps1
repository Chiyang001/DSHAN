$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'runtime/dsh-peer'
$target = if ($env:DSH_PEER_DESKTOP_PATH) { $env:DSH_PEER_DESKTOP_PATH } else { Join-Path $env:USERPROFILE '.dsh/plugins/dsh-peer' }

if (-not (Test-Path $source)) { throw "Missing plugin source: $source" }
if (-not (Test-Path $target)) { New-Item -ItemType Directory -Force -Path $target | Out-Null }

$files = @(
    'index.js', 'peer.js', 'protocol.js', 'network.js', 'relay.js', 'dtls-compat.js',
    'signal-server.js', 'package.json', 'package-lock.json', 'README.md',
    'LIVE-VALIDATION.md', 'cordis.patch.yml', '.gitignore'
)
foreach ($name in $files) {
    $from = Join-Path $source $name
    if (Test-Path $from) {
        Copy-Item -LiteralPath $from -Destination (Join-Path $target $name) -Force
    }
}
Copy-Item -LiteralPath (Join-Path $source 'settings-client.js') -Destination (Join-Path $target 'client.js') -Force
Copy-Item -LiteralPath (Join-Path $source 'settings-client.js') -Destination (Join-Path $source 'client.js') -Force

Push-Location $target
if (Test-Path 'package-lock.json') { npm ci --ignore-scripts } else { npm install --ignore-scripts }
Pop-Location

Write-Host "Synced dsh-peer to $target"
