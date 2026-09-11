param([int]$TargetPid, [ValidateSet('record','replay','probe')][string]$Mode = 'probe', [int]$MaxSeconds = 2100, [int]$StartDelayMs = -1, [int]$CountdownMs = 5000, [switch]$ShowStatus, [switch]$WaitForCapture, [switch]$PointerMode)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'keyboard-mouse.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
[QapingDesktopInput]::Run($TargetPid, $Mode, $MaxSeconds, $StartDelayMs, $CountdownMs, $ShowStatus.IsPresent, $WaitForCapture.IsPresent, $PointerMode.IsPresent)
