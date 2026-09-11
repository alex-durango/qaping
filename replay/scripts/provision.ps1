# scripts/provision.ps1 -- one-time rig preparation. Run ELEVATED on the Windows box.
#
# No binaries are ever vendored into the repo (CI fails tracked blobs >5MB); this
# script fetches pinned tools and records their sha256 into pins.local.json
# (gitignored) on first run -- trust-on-first-use, then enforced on every re-run.
#
# After this script: `node bin\rig.js doctor` should come up green.
param(
  [switch]$Trust   # required on FIRST run to record download hashes
)

$ErrorActionPreference = "Stop"
$RigRoot = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $RigRoot "tools"
$PinsFile = Join-Path $RigRoot "pins.local.json"
New-Item -ItemType Directory -Force -Path $Tools | Out-Null

# Pinned versions. VERIFY these URLs/versions at first provision (they were pinned
# 2026-08-19 from training knowledge; the trust-on-first-use hash makes later runs
# reproducible even if the pin was updated here).
$PresentMonVersion = "2.3.0"
$PresentMonUrl = "https://github.com/GameTechDev/PresentMon/releases/download/v$PresentMonVersion/PresentMon-$PresentMonVersion-x64.exe"

function Get-Pins {
  # stock Windows ships only PowerShell 5.1 -- ConvertFrom-Json has no -AsHashtable there
  $pins = @{}
  if (Test-Path $PinsFile) {
    $obj = Get-Content $PinsFile -Raw | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $pins[$p.Name] = $p.Value }
  }
  $pins
}
function Save-Pins($pins) { $pins | ConvertTo-Json | Set-Content $PinsFile }

function Fetch-Pinned($name, $url, $dest) {
  $pins = Get-Pins
  Write-Host ">> $name from $url"
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLower()
  if ($pins.ContainsKey($name)) {
    if ($pins[$name] -ne $hash) { throw "$name hash mismatch: pinned $($pins[$name]), got $hash -- refusing" }
    Write-Host "   sha256 ok ($hash)"
  } elseif ($Trust) {
    $pins[$name] = $hash
    Save-Pins $pins
    Write-Host "   sha256 recorded (trust-on-first-use): $hash"
  } else {
    Remove-Item $dest
    throw "$name has no recorded hash -- re-run with -Trust on the first provision"
  }
}

# 1. Python + vgamepad (pip pulls the ViGEmBus driver installer; the install may
#    prompt for the driver -- accept it, that's the virtual pad's kernel device).
Write-Host "== python + vgamepad"
function Find-Python {
  # the Microsoft Store alias stub under WindowsApps satisfies Get-Command but runs nothing
  foreach ($name in "python", "py") {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notlike "*\Microsoft\WindowsApps\*") { return $cmd.Source }
  }
  $null
}
$python = Find-Python
if (-not $python) {
  winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
  # winget edits the registry PATH; this process still has the old one
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  $python = Find-Python
  if (-not $python) { throw "python still not found after winget install -- re-run from a fresh elevated terminal" }
}
# PS 5.1 + redirected stderr turns pip's notices into terminating NativeCommandErrors
# under EAP=Stop; relax around the call and gate on the exit code instead
$eap = $ErrorActionPreference; $ErrorActionPreference = "Continue"
& $python -m pip install --upgrade "vgamepad==0.*" 2>&1 | ForEach-Object { $_.ToString() }
$ErrorActionPreference = $eap
if ($LASTEXITCODE -ne 0) { throw "pip install vgamepad failed (exit $LASTEXITCODE)" }
Write-Host "   if the ViGEmBus driver was just installed, joy.cpl gains an Xbox 360 pad when the feeder connects"

# 2. ffmpeg (winget/gyan.dev full build -- ships NVENC and AMF hardware encoders)
Write-Host "== ffmpeg"
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
}

# 3. PresentMon (single-exe CLI)
Write-Host "== PresentMon"
$pmDest = Join-Path $Tools "presentmon.exe"
if (-not (Test-Path $pmDest)) { Fetch-Pinned "presentmon" $PresentMonUrl $pmDest }
Write-Host "   set RIG_PRESENTMON=$pmDest (or add $Tools to PATH)"

# 4. WER LocalDumps -- crashes leave .dmp files the receipt sweeps up
Write-Host "== WER LocalDumps"
$wer = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps"
New-Item -Path $wer -Force | Out-Null
New-ItemProperty -Path $wer -Name DumpType -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $wer -Name DumpCount -Value 10 -PropertyType DWord -Force | Out-Null

# 5. Session doctrine reminders (manual, printed not enforced)
Write-Host ""
Write-Host "MANUAL steps (once):"
Write-Host "  - auto-logon + screen lock off + high-performance power plan"
Write-Host "  - remote ops via Sunshine/Moonlight or Parsec (NEVER RDP mid-run -- kills DXGI capture)"
Write-Host "  - run the operator terminal elevated (PresentMon ETW)"
Write-Host "  - plug in the physical Xbox pad only for 'rig record'; unplug before replays"
Write-Host ""
Write-Host "done -- now: node bin\rig.js doctor"
