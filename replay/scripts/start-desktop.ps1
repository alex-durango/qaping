$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rigRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if ($nodeExecutable) {
    $major = & $nodeExecutable -p 'process.versions.node.split(String.fromCharCode(46))[0]'
    if ($LASTEXITCODE -ne 0 -or [int]$major -lt 20) { $nodeExecutable = $null }
}
if (-not $nodeExecutable) {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Qaping Replay requires 64-bit Windows.' }
    $cacheRoot = Join-Path $env:LOCALAPPDATA 'QapingRig\tools\node-24.19.0'
    $archivePath = Join-Path $cacheRoot 'node.zip'
    $nodeExecutable = Join-Path $cacheRoot 'node.exe'
    $expectedHash = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
    New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
    if ((Get-Item -LiteralPath $cacheRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Tool cache must be a regular directory.' }
    if (-not (Test-Path -LiteralPath $archivePath) -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        Write-Host 'First start: downloading a verified Node.js runtime from nodejs.org. No system install is needed.'
        $downloadPath = Join-Path $cacheRoot ('download-' + [guid]::NewGuid().ToString('N') + '.zip')
        Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip' -OutFile $downloadPath
        if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Node.js download failed verification. Please retry.' }
        Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force
    }
    # Extract only the two named entries from the verified archive, never arbitrary paths.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        foreach ($name in @('node.exe','LICENSE')) {
            $entry = $archive.GetEntry('node-v24.19.0-win-x64/' + $name)
            if (-not $entry) { throw ('Node.js archive is missing ' + $name) }
            $targetFile = Join-Path $cacheRoot $name
            if (Test-Path -LiteralPath $targetFile) {
                $stream = $entry.Open()
                $hasher = [Security.Cryptography.SHA256]::Create()
                try { $entryHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
                finally { $stream.Dispose(); $hasher.Dispose() }
                if ((Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entryHash) { throw ('Cached runtime verification failed: ' + $targetFile) }
            } else { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetFile, $false) }
        }
    } finally { $archive.Dispose() }
}
$startInfo = New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodeExecutable
$startInfo.Arguments = '"' + (Join-Path $rigRoot 'bin\rig.js') + '" start'
$startInfo.WorkingDirectory = $rigRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$null = [Diagnostics.Process]::Start($startInfo)
