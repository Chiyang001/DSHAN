$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'runtime'
$outputDir = Join-Path $projectRoot 'app/src/main/assets'
$output = Join-Path $outputDir 'runtime.zip'
if (-not (Test-Path (Join-Path $runtimeDir 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
    throw '请先执行 npm ci --prefix runtime --omit=dev --ignore-scripts --os=android --cpu=arm64 --libc=bionic'
}
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
foreach ($name in @('android-host.js', 'android-tools.js', 'android-loop-guard.js', 'android-fast-screen.js',
    'android-coordinate-scale.js', 'android-ui-parse.js', 'android-screen-targets.js', 'android-screen-annotate.js', 'mobile-bootstrap.cjs',
    'android-flock.cjs', 'android-network.cjs', 'android-native-command.cjs', 'android-native-command-shim.mjs', 'android-fs-search.js', 'android-directory-picker.js',
    'android-directory-picker-backend.js', 'android-search.js', 'android-plugin-policy.cjs', 'android.patch.template.yml')) {
    Copy-Item -LiteralPath (Join-Path $runtimeDir $name) -Destination (Join-Path $outputDir $name) -Force
}
foreach ($name in @('package.json', 'index.js', 'client.js', 'kernel-updater.js', 'kernel-worker.js')) {
    Copy-Item -LiteralPath (Join-Path $runtimeDir "android-settings/$name") -Destination (Join-Path $outputDir "android-settings/$name") -Force
}
if (Test-Path $output) { Remove-Item -LiteralPath $output }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$runtimeRoot = (Resolve-Path $runtimeDir).Path.TrimEnd('\')
$archive = [System.IO.Compression.ZipFile]::Open($output, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $files = @(
        'package.json',
        'package-lock.json',
        'android.patch.template.yml',
        'android-host.js',
        'android-tools.js',
        'android-loop-guard.js',
        'android-fast-screen.js',
        'android-coordinate-scale.js',
        'android-ui-parse.js',
        'android-screen-targets.js',
        'android-screen-annotate.js',
        'mobile-bootstrap.cjs',
        'android-flock.cjs',
        'android-network.cjs',
        'android-native-command.cjs',
        'android-native-command-shim.mjs',
        'android-fs-search.js'
        'android-search.js'
        'android-plugin-policy.cjs'
    ) | ForEach-Object { Get-Item (Join-Path $runtimeDir $_) }
    $files += Get-ChildItem (Join-Path $runtimeDir 'node_modules') -Recurse -File
    $files += Get-ChildItem (Join-Path $runtimeDir 'dsh-peer') -File
    foreach ($file in $files) {
        $relative = ($file.FullName.Substring($runtimeRoot.Length + 1)).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $archive.Dispose()
}
Get-Item $output | Select-Object FullName,Length
