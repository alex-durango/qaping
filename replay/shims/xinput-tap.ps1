# shims/xinput-tap.ps1 -- poll the PHYSICAL XInput pad and emit state deltas as
# JSON-lines on stdout. `rig record` turns the stream into a padscript.
#
# XInput's dwPacketNumber increments only when the pad state changes -- free delta
# compression: we poll at ~120Hz but emit a line only on a new packet number.
# Line shape matches the padscript timeline entry pad object plus t_ms:
#   {"t_ms":1234,"buttons":["A"],"lx":0.5,"ly":0.0,"rx":0,"ry":0,"lt":0,"rt":0}
# A {"event":"tap_ready","slot":n} line precedes the stream; Ctrl+C (or closed
# stdin on the parent side) ends it.
param(
  [int]$RateHz = 120,
  [int]$Slot = -1   # -1 = first connected slot
)

$src = @"
using System;
using System.Runtime.InteropServices;

public static class XInputTap {
  [StructLayout(LayoutKind.Sequential)]
  public struct XINPUT_GAMEPAD {
    public ushort wButtons;
    public byte bLeftTrigger;
    public byte bRightTrigger;
    public short sThumbLX;
    public short sThumbLY;
    public short sThumbRX;
    public short sThumbRY;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct XINPUT_STATE {
    public uint dwPacketNumber;
    public XINPUT_GAMEPAD Gamepad;
  }
  [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")]
  public static extern uint GetState(uint dwUserIndex, ref XINPUT_STATE pState);
}
"@
Add-Type -TypeDefinition $src -Language CSharp

$BTN = [ordered]@{
  0x1000 = "A"; 0x2000 = "B"; 0x4000 = "X"; 0x8000 = "Y";
  0x0100 = "LB"; 0x0200 = "RB"; 0x0020 = "BACK"; 0x0010 = "START";
  0x0040 = "LS"; 0x0080 = "RS";
  0x0001 = "DPAD_UP"; 0x0002 = "DPAD_DOWN"; 0x0004 = "DPAD_LEFT"; 0x0008 = "DPAD_RIGHT";
}

function Find-Slot {
  for ($i = 0; $i -lt 4; $i++) {
    $s = New-Object XInputTap+XINPUT_STATE
    if ([XInputTap]::GetState($i, [ref]$s) -eq 0) { return $i }
  }
  return -1
}

if ($Slot -lt 0) { $Slot = Find-Slot }
if ($Slot -lt 0) {
  Write-Output '{"event":"error","message":"no XInput controller connected"}'
  exit 1
}
Write-Output ('{"event":"tap_ready","slot":' + $Slot + '}')

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$periodMs = [math]::Max(1, [int](1000 / $RateHz))
$lastPacket = [uint32]::MaxValue
$deadzone = 0.05

function Axis([int16]$v) {
  $f = [math]::Round([math]::Max(-1.0, $v / 32767.0), 3)
  if ([math]::Abs($f) -lt $deadzone) { return 0 } else { return $f }
}

while ($true) {
  $s = New-Object XInputTap+XINPUT_STATE
  $r = [XInputTap]::GetState($Slot, [ref]$s)
  if ($r -ne 0) {
    Write-Output ('{"event":"error","message":"controller disconnected (slot ' + $Slot + ')"}')
    exit 1
  }
  if ($s.dwPacketNumber -ne $lastPacket) {
    $lastPacket = $s.dwPacketNumber
    $names = @()
    # GetEnumerator, not $BTN[$k]: indexing an OrderedDictionary with an int means
    # POSITION, not key — $BTN[0x1000] is element #4096 (null), so every button
    # decoded to "" and replay traces lost all presses (live 2026-08-27).
    foreach ($e in $BTN.GetEnumerator()) { if ($s.Gamepad.wButtons -band $e.Key) { $names += ('"' + $e.Value + '"') } }
    $line = '{"t_ms":' + $sw.ElapsedMilliseconds +
      ',"buttons":[' + ($names -join ",") + ']' +
      ',"lx":' + (Axis $s.Gamepad.sThumbLX) + ',"ly":' + (Axis $s.Gamepad.sThumbLY) +
      ',"rx":' + (Axis $s.Gamepad.sThumbRX) + ',"ry":' + (Axis $s.Gamepad.sThumbRY) +
      ',"lt":' + ([math]::Round($s.Gamepad.bLeftTrigger / 255.0, 3)) +
      ',"rt":' + ([math]::Round($s.Gamepad.bRightTrigger / 255.0, 3)) + '}'
    Write-Output $line
  }
  Start-Sleep -Milliseconds $periodMs
}
