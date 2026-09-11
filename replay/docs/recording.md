# Record and replay a session

Replay records inputs, not the meaning of an action. A replay needs
the same starting save, checkpoint, camera, and controller mapping. A changed
enemy position, loading delay, or menu can change the outcome.

## Keyboard and mouse (0.2.0 source snapshot)

For the complete setup, save/reset procedure, Minecraft example and recovery
steps, use the [keyboard/mouse walkthrough](keyboard-mouse.md).
The easiest entry is **Start Replay.cmd** in the downloaded source folder: choose
the game, click Record, then select a saved session to replay. The panel handles
process IDs, output paths and one-time video setup. The commands below are the
CLI alternative.

Use `node bin/rig.js` from the source checkout; npm 0.1.0 does not have this mode.
Open a disposable game save at the desired start. Find the actual game PID,
then run `node bin/rig.js record --input keyboard-mouse --pid <pid> --out session.kbmscript.json --video human.mp4`.
The Start button waits until you use it or cancel with F8; it has no idle timeout.
Click **Start recording** to prepare video and begin the visible five-second
countdown once the first video frame is ready. Idle waiting produces no video.
The `--max-minutes` budget counts active input time only. F9 is
an optional shortcut with the game focused. Release controls during the
countdown, then play freely when **REC** and its timer appear. F8 stops.
If the game locks your mouse, pause it before clicking Start and resume after
REC appears. Changing focus ends recording. No input from other applications
is retained.

Restore the full starting state, then run
`node bin/rig.js play "<game-directory>" --exe "<game.exe>" --pid <pid> --script session.kbmscript.json`.
Click **Start replay** at the restored state, including the same pause/menu
state. Watch the countdown; F8 aborts and releases held inputs. Update the
PID after restarting the game. Attachment validates the executable and leaves
the game running. Without `--pid`, Replay launches it and waits for Start.

Use windowed or borderless mode to see the status panel. It remains visible in
desktop video and passes mouse clicks through once the countdown begins.
`--countdown <seconds>` changes the countdown (0–30); `--no-status` hides it.
Only `--start-delay <seconds>` opts into starting automatically (0–120).

Raw camera deltas are replayed through SendInput. New recordings also retain
client-area pixel positions while the Windows menu cursor is visible, including
the position of each click. Those menu events use absolute positioning during
replay, so they do not depend on the pointer's starting position. Keep the same
window size, UI scale and menu state; a resized or covered menu point stops replay.
Older traces have no menu positions to restore and display a warning. Games with
a custom cursor that Windows reports as hidden still require a compatibility check.
Preserve mouse DPI, pointer settings, resolution and sensitivity. Verify camera
movement in the actual game; input replay does not guarantee the same outcome.
The mode needs no Python or controller driver. Video still needs ffmpeg.
See the README for supported input types and limitations. Controller overlays
cannot be used on a keyboard/mouse trace.

## Controller

1. Run `npx @qaping/rig doctor` on Windows and resolve the reported requirements.
2. Open your game normally and put it at the starting point you want to record.
3. Run `npx @qaping/rig record --out session.padscript.json`, return focus to the
   game, and play. Press Ctrl+C in the terminal when finished.
4. Restore the game's starting state and close the game. Disconnect the physical
   controller before replay so the virtual controller can take its slot.
5. Run `npx @qaping/rig play "<game-directory>" --exe "<game.exe>" --script session.padscript.json`.

The default replay delay is eight seconds after launch. Edit
`start.wait_for.ms` in the script to match your starting point. Time spent
switching from the recording terminal to the game is part of the trace.

For a game that produces an appropriate log, recording with `--start-log "ready"`
sets a log-based replay start. Supply `--game-log "<log-file>"` on replay and
configure the game to write that file. Replay does not add logging to the game.

## Steam games

Keep Steam running and signed in. Use the installed game directory and choose
the actual game executable with `--exe`. Some games relaunch through Steam or
another launcher; Replay currently follows the executable it launches, so check
that input and telemetry reach the game before relying on a recording. Check
Steam Input mapping and controller slots if the game ignores replayed input.

A comparison of two sessions on the same installed version is a same-build
comparison. A difference by itself does not establish a regression. Save the
version and starting conditions alongside your trace.

The example script in `examples/` is a short authored input sequence for learning
the format. It was not recorded from a person and is not a test of any particular
game.

## What the run tells you

`overlay` draws controller input over the captured video; `report` summarizes
recorded telemetry, crashes, and warnings. A receipt's `pass` describes the
observed run and does not certify the game. Missing coverage and ambiguous
results still need a person to investigate.

[Get a human playtest through Qaping](https://qaping.dev/?utm_source=github&utm_medium=docs&utm_campaign=rig-launch).
