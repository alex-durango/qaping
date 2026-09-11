# Qaping Replay

**Record your game actions. Replay them on demand.**

A person plays your game once, with a controller or keyboard and mouse. Replay records the
inputs. From then on it can replay that session against every new build through a
virtual XInput gamepad or native Windows keyboard/mouse input — recording the screen, measuring frame times, watching for
crashes — and write a receipt of what happened.

Replay sends recorded inputs to a packaged Windows game. It runs locally, with
no Qaping account required.

[Documentation](https://qaping.dev/docs/replay) ·
[Source](https://github.com/alex-durango/qaping/tree/main/replay) ·
[Keyboard/mouse walkthrough](https://github.com/alex-durango/qaping/blob/main/replay/docs/keyboard-mouse.md) ·
[Recording guide](https://github.com/alex-durango/qaping/blob/main/replay/docs/recording.md) ·
[Report a problem](https://github.com/alex-durango/qaping/issues)

**Release status:** this source tree is the 0.2.4 development snapshot; npm
currently serves 0.1.0. Keyboard/mouse input and `--game-log` are in the source snapshot.
For keyboard/mouse, use the desktop app below. CLI users can clone this repo,
open its `replay` folder, and use `node bin/rig.js` in place of `npx @qaping/rig`.

## Start here: Windows desktop app

1. **[Download the source ZIP](https://github.com/alex-durango/qaping/archive/refs/heads/main.zip)**
   and extract it. Open the **replay** folder.
2. Double-click **Start Replay.cmd**. First start finds Node.js or downloads a
   verified local copy. No terminal commands or system-wide installation needed.
3. Open your game, pause at the starting point, and choose it in the game list.
4. For a pointer-driven game, choose **Moving the mouse… → Moves a cursor on screen**. This also
   captures game-drawn cursors when they follow the Windows pointer. For mouse-look
   games, leave **Turns my view** selected. Click **Record new session**. Video is set up automatically on first use
   (a 161 MB verified ffmpeg download). Play after the visible countdown; **F8 stops**.
5. Restore the game's starting save, select the saved session, check the reset
   reminder and click **Replay selected**.

The controls return when a session finishes. **Watch video** opens the selected
session's latest capture, and **Open recordings** opens your files. Names and
folders are automatic; you never need to find a process ID or type a game path.
Recordings live in `Videos/Qaping Rig` under your user folder. **Import session**
accepts an existing keyboard/mouse trace without changing it.

Windows 10/11 x64 is required. The app handles setup and recording controls;
**you restore the game's save and starting view**. Compatibility varies by game.
See the [walkthrough](https://github.com/alex-durango/qaping/blob/main/replay/docs/keyboard-mouse.md)
for a Minecraft example and troubleshooting. The CLI remains available below.

The cursor choice (Pointer mode in the CLI) saves positions relative to the game area and scales them for a
proportional window resize. Window position and the initial pointer position can
change. Keep the same aspect ratio, UI scale/layout and starting game view. These
are viewport positions, not world coordinates or object identities. Old traces
without pointer positions need a fresh recording.

## What it is

- **`record`** — a human plays freely with a physical keyboard/mouse or an
  Xbox-compatible pad. Keyboard/mouse produces a `qaping-kbmscript/v1` file with
  timed keys, camera motion and menu positions; controller recording produces
  sparse full-state keyframes in the controller trace format.
- **`play`** — keyboard/mouse traces replay through native Windows input.
  Controller traces replay through a virtual pad (a kernel-level ViGEmBus
  device; the game sees a real Xbox 360 controller in `joy.cpl`) against a build
  you point at — a `.zip`, an unzipped directory, or a URL. While it plays, Replay
  records the screen with ffmpeg, samples frame times with PresentMon, notices if
  the game dies, sweeps up the Windows crash dump it left, and stops on its own
  time budget if the build hangs.
- **`overlay`** — burns a controller input trace onto the capture, so you can watch
  the footage and the stick/button state together. The graphic is drawn from the
  run's own `inputs.jsonl`, not from a live widget: what you see is what was sent.
- **`report`** — turns a receipt into readable findings, each stamped with the
  timestamp to seek to in the recording: every 2–10 s gap with no frame presented
  (a load screen, or a hitch the player experiences as waiting), every frame that
  ran 4× the median and at least 50 ms (a stutter), the crash if there was one, and
  every warning the run raised. Alongside them: average fps, p95, p99, 1% low.
- Every run writes a **run receipt** — the build source (and a
  sha256 for zip builds), the
  script's sha256, every input event, the frame-time summary, the exit reason. A
  receipt identifies the run; keep the original build and input script to replay it.

Controller replay promises **input determinism**: the same bytes go to the pad at the same
offsets on every run. `inputs.jsonl` is a pure function of the script and comes out
byte-identical run after run — that is the property the whole thing rests on.
Keyboard/mouse logs contain the events Windows acknowledged, with actual timing
recorded separately. Neither mode promises identical gameplay outcomes.

## Limits

- **It repeats recorded inputs.** It does not learn, explore new paths, or
  adapt to a moved enemy, a new menu, or a changed loading time.
- **Reports need interpretation.** Replay does not fail your build. A receipt
  marked `pass` describes the observed run, not complete game coverage. Replay
  does not promise *outcome* determinism — game RNG and load variance are real — so anything
  it flags, including a run that diverges from the last one, is a **warning for a
  person to adjudicate, never a verdict**.
- **It covers the recorded route.** New paths, confusing interactions, and
  whether the boss fight feels fair still need a person to investigate.
- **It needs your Windows machine.** See [Requirements](#requirements) and
  [Privacy](#privacy).
- **Compatibility varies by game.** Games can reject synthetic input, hide their
  custom cursor from Windows, or change input handling between menus and gameplay.
  Verify a short recording and replay in your game before relying on it.

## Requirements

| | |
|---|---|
| **Windows 10 or 11**, x64 | keyboard/mouse uses Windows PowerShell, Raw Input and SendInput; the virtual pad uses a Windows driver |
| **Node.js 20+** | the desktop launcher downloads a local copy if needed; CLI users install it themselves |
| **ViGEmBus driver** *(controller replay only)* | the virtual gamepad's kernel device — installed for you by `vgamepad` below |
| **Python 3 + `vgamepad`** *(controller replay only)* | the pad feeder: `python -m pip install "vgamepad==0.*"` (accept the driver prompt the first time) |
| a physical Xbox-compatible controller | for controller `record` only |
| **ffmpeg** *(optional)* | screen capture and `overlay`. Without it, `play --no-capture` still runs and still measures |
| **PresentMon** *(optional)* | frame times. Without it you get a run and a recording, but no fps numbers |

Two things about the session, both learned the hard way:

- **PresentMon needs an elevated terminal.** Keyboard/mouse without telemetry
  can run normally; use `--no-telemetry` and match the game's privilege level.
- **Do not RDP into the machine mid-run.** RDP takes over the console session and
  breaks screen capture. Use a remote-desktop tool that leaves the physical session
  alone.

`doctor` checks all of it and tells you what is missing:

```
npx @qaping/rig doctor
```

There is also a one-shot provisioner for the full controller setup, shipped with
the package. Keyboard/mouse users can install ffmpeg separately and skip it. Install it first
(`npm i @qaping/rig`, or `npm i -g @qaping/rig` for a `qaping-rig` on your PATH),
then run the script **elevated**, once: it installs Python, `vgamepad`, ffmpeg and
PresentMon, pins each download's sha256 on first run, and enables Windows crash
dumps.

```powershell
powershell -ExecutionPolicy Bypass -File .\node_modules\@qaping\rig\scripts\provision.ps1 -Trust
```

Already have the tools somewhere else? Point at them: `RIG_FFMPEG`,
`RIG_PRESENTMON`.

## Quick start

### Keyboard and mouse (source snapshot)

Get this source version first; these commands need no npm dependencies:

```powershell
git clone https://github.com/alex-durango/qaping.git
cd qaping/replay
node bin/rig.js version
```

Install [ffmpeg for Windows](https://ffmpeg.org/download.html#build-windows) for
video and put it on PATH, or set `RIG_FFMPEG` to its executable. Open the game in
windowed or borderless mode, back up the starting save with the game closed,
then reopen it at the same camera, inventory and pause/menu state. Find its
actual process ID in Task Manager's Details tab. From this source checkout:

```powershell
node bin/rig.js doctor --input keyboard-mouse
node bin/rig.js record --input keyboard-mouse --pid 1234 --out sessions/take-01.kbmscript.json --video sessions/take-01.mp4
# Click Start recording, watch the countdown, play when REC appears. F8 stops.
# Restore the same starting state. Update --pid if you restarted the game.
node bin/rig.js play "C:\Games\YourGame" --exe game.exe --pid 1234 --script sessions/take-01.kbmscript.json --no-telemetry
# Click Start replay at the same starting point. F8 aborts.
```

Replace `1234` and the game path with actual values. Omit `--pid` on `play` to
launch the selected executable; Start still gates input until the game is ready.
Attachment verifies the executable path and never closes the operator's game.
The walkthrough covers [backup, recording, replay, verification and recovery](https://github.com/alex-durango/qaping/blob/main/replay/docs/keyboard-mouse.md),
including a Minecraft example. `doctor` also checks optional PresentMon and
hardware encoding, so a missing optional tool can make it exit nonzero; read
the individual checks. The command above explicitly skips telemetry.

A visible **Start recording** / **Start replay** button begins a five-second
countdown. The button stays available until you start, cancel with F8, or close
the game or recorder. With video enabled, Start briefly shows **Preparing video**;
the full countdown begins after the first encoded frame. F9 is an optional
shortcut while the game has focus. The panel then
shows **REC** / **REPLAY** and an elapsed timer; F8 stops. Pause the game first
if it locks your mouse, click Start, then resume once REC appears. Preserve that
same pause/menu state for replay. Play freely: jumps, exploration, interaction,
building and breaking blocks all become timed input events.

The status panel supports windowed/borderless games and appears in desktop video;
exclusive fullscreen may hide it. It accepts clicks only before the countdown,
then lets clicks pass to the game. The Start click requests game focus once;
focus loss during an active session still stops it. Release controls during the
countdown. `--countdown <seconds>` changes its length (0–30); `--no-status` hides
the panel. `--start-delay <seconds>` explicitly selects automatic start (0–120),
overriding the button and normal countdown. The game must have focus and all
keys/buttons must be released when either countdown expires.
The panel closes when the command finishes. After F8, wait for the terminal's
saved-file message; to bring recording controls back, run `record` again with
fresh output names. Closing the panel after a completed take does not delete it.

This mode uses stock Windows PowerShell, Raw Input and SendInput; **no Python,
ViGEmBus or physical controller is needed**. ffmpeg is needed for `--video` and
replay video; `--no-capture --no-telemetry` permits input-only replay.
Recording without `--video` writes just the trace. Output files are never overwritten.

The trace preserves scan-code key events, five mouse buttons, both wheel axes,
and relative mouse deltas. When Windows shows a menu pointer, new recordings
also save its position inside the game window for movement, clicks and scrolling.
Replay uses those pixels for menus and raw relative deltas for the hidden camera
cursor. Restore the same window size, UI scale and menu state; replay stops if
a recorded menu point is covered by another window or the client size differs.
Older traces lack these positions and cannot recover them during replay.
Keep mouse DPI, Windows pointer settings, game sensitivity and camera the same. Games may
handle synthetic mouse movement differently; verify your game's response before
relying on a trace. Absolute pointing devices and E1 keys (such as Pause) are
unsupported. Games drawing their own pointer while hiding the Windows cursor
still need a compatibility check. F8/F9 are reserved for transport. This is not text-entry automation.

Recording captures physical Raw Input only while the selected process has
focus. Switching away stops the recording. Replay also stops on focus loss,
F8, target exit or the time budget, and releases the keys/buttons it pressed.
It does not force game focus back. Run Replay and game at the same privilege
level; Windows may refuse input to an elevated game. Never use it to enter
credentials or private chat text. Video starts after Start, so idle waiting is
not captured. `--max-minutes` limits active input time, excluding time waiting
for Start and the countdown. A video startup failure cancels the session.

Keyboard/mouse traces use `qaping-kbmscript/v1`; controller traces retain their
existing schema. Only native-acknowledged replay events enter the input logs,
with separate measured timing. An interrupted replay produces an error receipt,
not a completed-run claim. `overlay` currently supports controller recordings
only; keep the original keyboard/mouse video and logs.

### Controller

```bash
# 1. one human session, on the physical controller
npx @qaping/rig record --out first-pass.padscript.json
#    play; Ctrl+C stops the recording and writes the file

# 2. replay it against a build (elevated terminal)
#    UNPLUG the physical pad first — the virtual one wants the first slot
npx @qaping/rig play ./build-1042.zip --script first-pass.padscript.json --label 1042

# 3. watch the inputs on the footage
npx @qaping/rig overlay rig-runs/run-20260904-1132-a1b2c3

# 4. read what came back
npx @qaping/rig report rig-runs/run-20260904-1132-a1b2c3
```

Then, for every build after that, step 2 again. The script is a plain JSON file:
commit it next to the build it was recorded against and it stays replayable.

Games that write their own logs can use `--game-log "<path>"` for a script
with a log-based start or `wait_log` barriers. Configure the game to write that
file; Replay does not instrument the game. For Steam games, keep Steam running
and follow the [recording guide](https://github.com/alex-durango/qaping/blob/main/replay/docs/recording.md).

Useful flags on `play`: `--exe <relative-path>` when the zip holds more than one
executable, `--exe-args "…"`, `--max-minutes <n>` (default 35), `--no-capture` (no
ffmpeg — worth it on a thin GPU, where capture itself costs frames), `--no-telemetry`,
`--expect-sha256 <hex>` to refuse a build whose bytes are not the ones you meant (it
needs a `.zip` or a URL — an already-unzipped directory has no digest, and the run is
refused rather than quietly unchecked).

Replay starts a fixed delay after launch — 8 seconds, recorded into the script as
`start.wait_for.ms`. If your game takes longer to reach a playable state, edit that
one number in the JSON, or your first inputs land on a loading screen.

## Where files land

Everything is written under the directory you ran the command from:

```
rig-runs/<run-id>/
  receipt.json            the run's durable record (JSON)
  inputs.jsonl            pad states or acknowledged keyboard/mouse events
  inputs-timing.jsonl     when each one actually went out (wall clock)
  presentmon.csv          raw frame times, if PresentMon was there
  recording.mp4           the capture, if ffmpeg was there
  recording-overlay.mp4   written by `overlay`
  annotations.json        written by `report`
  <name>.dmp              the crash dump, if it crashed
```

`record` writes the trace to `--out` (default: a timestamped `.padscript.json`
or `.kbmscript.json` in the current directory). Keyboard/mouse also writes a
`.capture.json` sidecar with hashes, stop reason and video warnings. Set
`RIG_RUNS_DIR` to put replay runs somewhere else. `sessions/` is ignored by Git
in this source checkout; keep original traces and footage together there.

## Privacy

**Everything stays on your machine.** No account, no sign-in, no key: none of the
rig's commands authenticate against anything. Your build, your recording, your
frame times and your receipts are files on your disk, and nothing uploads them.

Network requests download a build when you hand `play` a URL, fetch tools when
you run `provision.ps1`, or set up the desktop app's missing Node.js/ffmpeg tools.
Desktop downloads are pinned by version and SHA-256, stored in a per-user cache,
and include their license notices. Nothing from your play session is uploaded.

## Get a human playtest

When you need someone to explore the parts your replay misses, Qaping connects
your coding agent to real playtesters. They play the build, report what they
found, and can check claimed fixes in later rounds. Your agent can turn checks
that can be reliably automated into code tests with your agreement.

**[Get your build playtested](https://qaping.dev/?utm_source=github&utm_medium=readme&utm_campaign=rig-launch#pricing)** —
see the paid plans and credit options before starting a round. The local rig
remains free and needs no account.

We are also developing an AI playtester that learns from human sessions and can
adapt when the game changes. That player is in development; this package is the
record-and-replay tool described above.

## Develop from source

```sh
git clone https://github.com/alex-durango/qaping.git
cd qaping/replay
npm test
node bin/rig.js version
```

The portable tests use Node's built-in test runner and require no installed game
or controller. Recording, playback, and telemetry need the Windows requirements
above. See [Contributing](https://github.com/alex-durango/qaping/blob/main/replay/CONTRIBUTING.md).

MIT licensed.
