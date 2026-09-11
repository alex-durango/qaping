// lib/game-proc.js — launch the game exe, watch it, and pick up the pieces.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const CRASH_EXIT_HEX = /^0x?c0/i; // 0xC0000005 access violation and friends

function launch(exe, opts = {}) {
  const child = spawn(exe, opts.args || [], {
    cwd: opts.cwd || path.dirname(exe),
    stdio: opts.stdio || "ignore",
    detached: false,
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => resolve({ code: null, signal: null, error: err }));
  });
  if (process.platform === "win32" && opts.keepFocus !== false) {
    foregroundWhenReady(child.pid, exited);
    keepForeground(child.pid, exited);
  }
  return { child, exited };
}

// UE ignores gamepad input while its window is unfocused, and a game launched
// from a background shell (scheduled run, agent session) never gets focus on
// its own — found live 2026-08-26 as a statue run. Best-effort, retried while
// the window may still be appearing; failure is survivable (interactive
// launches focus naturally) so this never throws.
function foregroundWhenReady(pid, exited) {
  let done = false;
  exited.then(() => { done = true; });
  const tryOnce = (attempt) => {
    if (done || attempt > 6) return;
    const r = spawnSync("powershell", ["-NoProfile", "-Command",
      `(New-Object -ComObject WScript.Shell).AppActivate(${pid})`], { encoding: "utf8", timeout: 10_000 });
    if ((r.stdout || "").trim() !== "True") {
      setTimeout(() => tryOnce(attempt + 1), 2000).unref();
    }
  };
  setTimeout(() => tryOnce(1), 2500).unref();
}

function classifyExit({ code, signal, error }) {
  if (error) return { exit_reason: "crash", detail: String(error.message || error) };
  if (signal) return { exit_reason: "operator", detail: `killed by ${signal}` };
  if (code === 0 || code === null) return { exit_reason: "game_exit", detail: null };
  const hex = `0x${(code >>> 0).toString(16)}`;
  if (CRASH_EXIT_HEX.test(hex)) return { exit_reason: "crash", detail: `exit ${hex}` };
  return { exit_reason: "game_exit", detail: `exit ${code}` };
}

// Kill the whole tree — UE games spawn helpers; leaving one alive wedges the next run.
// Hold focus for the WHOLE run, not just at launch. UE drops every gamepad input
// while its window is unfocused, so anything that raises another window mid-run
// (the operator clicking a chat, a notification, a terminal) silently turns the
// replay into a statue for as long as focus is gone — found live 2026-09-02, when
// three replays of one trace "stalled" at the exact moments the operator was
// typing. One persistent PowerShell child polls the foreground window ~3x/s and
// re-activates the game when it is not in front. Killed with the game.
function keepForeground(pid, exited) {
  const script = `
$src = @'
using System; using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@
Add-Type -TypeDefinition $src
while ($true) {
  Start-Sleep -Milliseconds 300
  $g = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
  if (-not $g) { break }
  $fgPid = 0; [void][FG]::GetWindowThreadProcessId([FG]::GetForegroundWindow(), [ref]$fgPid)
  if ($fgPid -ne ${pid} -and $g.MainWindowHandle -ne 0) {
    # Windows refuses SetForegroundWindow from a background process while the user
    # is typing elsewhere (the foreground lock) — AppActivate just returns False.
    # A synthetic ALT tap makes this process the last-input owner, which is the
    # documented exception, and the switch then goes through.
    [FG]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [FG]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][FG]::SetForegroundWindow($g.MainWindowHandle)
  }
}`;
  const watchdog = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore", windowsHide: true });
  const stop = () => { try { watchdog.kill(); } catch { /* already gone */ } };
  exited.then(stop, stop);
  watchdog.unref();
  return watchdog;
}

function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

// WER LocalDumps (enabled by provision.ps1) drops .dmp files here on a crash.
function crashDumpDir() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CrashDumps");
}

function sweepCrashDumps(sinceMs) {
  const dir = crashDumpDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".dmp"))
    .map((f) => ({ file: path.join(dir, f), mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((d) => d.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

module.exports = { launch, classifyExit, killTree, sweepCrashDumps, crashDumpDir };
