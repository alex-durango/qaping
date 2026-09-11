// Command implementation shared by the CLI and in-process callers.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const padscript = require("../lib/padscript");
const { playEvents, hrtimeMs } = require("../lib/scheduler");
const { PadFeeder } = require("../lib/pad");
const receiptLib = require("../lib/receipt");
const presentmon = require("../lib/telemetry-presentmon");
const { fetchBuild, pickExe } = require("../lib/build-fetch");
const gameProc = require("../lib/game-proc");
const capture = require("../lib/capture");
const report = require("../lib/report");

const RIG_ROOT = path.join(__dirname, "..");
const FFMPEG = process.env.RIG_FFMPEG || "ffmpeg";
const PRESENTMON = process.env.RIG_PRESENTMON || "presentmon";

// Where runs land. From a checkout that stays `apps/rig/runs/` (gitignored, what
// every operator path already points at); from an INSTALL the package root is
// inside node_modules — an npx cache that gets swept — so runs go to the caller's
// own directory instead. RIG_RUNS_DIR overrides both.
const RUNS_ROOT = process.env.RIG_RUNS_DIR
  ? path.resolve(process.env.RIG_RUNS_DIR)
  : RIG_ROOT.split(path.sep).includes("node_modules")
    ? path.join(process.cwd(), "rig-runs")
    : path.join(RIG_ROOT, "runs");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function requireWindows(cmd) {
  if (process.platform !== "win32" && !process.env.RIG_ALLOW_NONWIN) {
    console.error(`rig ${cmd} runs on the Windows rig (set RIG_ALLOW_NONWIN=1 to force pieces that can run here).`);
    process.exit(2);
  }
}

function log(line) { console.log(line); }

// first hardware encoder whose test encode actually opens (null → gdigrab territory)
function probeEncoder() {
  for (const enc of capture.HW_ENCODERS) {
    const r = spawnSync(FFMPEG, capture.probeArgs(enc), { encoding: "utf8", timeout: 15_000 });
    if (r.status === 0) return enc;
  }
  return null;
}

// ── doctor ────────────────────────────────────────────────────────────────────

async function cmdDoctor(args = {}) {
  requireWindows("doctor");
  let bad = 0;
  const check = (okay, name, detail) => {
    log(`  ${okay ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!okay) bad++;
  };

  if (args.input === "keyboard-mouse") {
    const probe = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(RIG_ROOT, "shims/keyboard-mouse.ps1"), "-Mode", "probe"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    check(probe.status === 0 && /win32-rawinput-sendinput/.test(probe.stdout || ""), "keyboard/mouse backend", (probe.stderr || "native shim compiled; game input still needs verification").trim());
  } else {
  const py = spawnSync(process.platform === "win32" ? "python" : "python3", ["--version"], { encoding: "utf8" });
  check(py.status === 0, "python", (py.stdout || py.stderr || "").trim() || "not found");

  if (py.status === 0) {
    const feeder = new PadFeeder();
    try {
      await feeder.connect();
      check(true, "virtual pad (vgamepad → ViGEmBus)", "created; check joy.cpl shows an Xbox 360 pad");
      await feeder.sendStateAcked({ buttons: ["A"] }, 1);
      await feeder.close();
    } catch (e) {
      check(false, "virtual pad (vgamepad → ViGEmBus)", e.message.split("\n")[0]);
      try { await feeder.close(); } catch { /* noop */ }
    }
  }

  }
  const ff = spawnSync(FFMPEG, ["-hide_banner", "-version"], { encoding: "utf8" });
  check(ff.status === 0, "ffmpeg", ff.status === 0 ? null : "not found (set RIG_FFMPEG)");
  if (ff.status === 0) {
    const enc = probeEncoder();
    check(!!enc, "ffmpeg hardware encoder", enc
      ? `${enc} (test encode passed)`
      : `none of ${capture.HW_ENCODERS.join("/")} can open — capture falls back to gdigrab+libx264`);
  }

  const pm = spawnSync(PRESENTMON, ["--help"], { encoding: "utf8" });
  const pmOk = pm.status === 0 || /present/i.test((pm.stdout || "") + (pm.stderr || ""));
  check(pmOk, "PresentMon", pmOk ? null : "not found (set RIG_PRESENTMON); frame telemetry disabled");
  if (process.platform === "win32") {
    check(!!process.env.LOCALAPPDATA, "WER crash-dump path", gameProc.crashDumpDir());
    log("  ℹ run the operator terminal elevated — PresentMon's ETW session needs it");
    log("  ℹ never RDP into the rig mid-run (breaks DXGI capture); use Sunshine/Parsec");
  }
  log(bad === 0 ? "\n✓ rig doctor: ready" : `\n✗ rig doctor: ${bad} check(s) failed`);
  process.exit(bad === 0 ? 0 : 1);
}

// ── pad-test ──────────────────────────────────────────────────────────────────

async function cmdPadTest(args) {
  requireWindows("pad-test");
  const seconds = Number(args.seconds || 10);
  const feeder = new PadFeeder();
  await feeder.connect();
  log(`virtual pad connected — open joy.cpl (Game Controllers) and watch it move for ${seconds}s`);
  const moves = [];
  for (let i = 0; i < seconds; i++) {
    moves.push({ op: "stick", stick: "L", x: Math.sin(i), y: Math.cos(i), ms: 400 });
    moves.push({ op: "press", btn: padscript.BUTTONS[i % 4], ms: 150 });
    moves.push({ op: "trigger", trigger: i % 2 ? "LT" : "RT", v: 1, ms: 250 });
    moves.push({ op: "neutral", ms: 200 });
  }
  const events = padscript.changeEvents({ schema: padscript.SCHEMA, moves });
  await playEvents(events, { send: (e) => feeder.sendState(e.pad) });
  await feeder.close();
  log("✓ pad-test done");
}

// ── play ──────────────────────────────────────────────────────────────────────

async function cmdPlay(args, hooks = {}, reporter = report) {
  requireWindows("play");
  const source = args._[1];
  if (!source || !args.script) {
    console.error("usage: rig play <build-url|zip|dir> --script <padscript.json> [--exe <rel>] [--exe-args \"...\"] [--label <build-label>] [--game-log <path>] [--max-minutes 35] [--capture-mode hw|gdigrab] [--encoder h264_nvenc|h264_amf] [--no-capture] [--no-telemetry] [--to-studio <workdir>]");
    process.exit(2);
  }
  // --expect-sha256: refuse a build that is not the one the caller meant. The
  // shape is checked HERE, before a run dir exists or anything is fetched, so a
  // typo costs nothing. (A wrong-but-well-formed digest cannot be caught until
  // the bytes are in hand — that arm is below.)
  const expectSha = args["expect-sha256"] === undefined
    ? null
    : String(args["expect-sha256"]).trim().toLowerCase();
  if (expectSha !== null && !/^[0-9a-f]{64}$/.test(expectSha)) {
    console.error(`rig play: --expect-sha256 wants a 64-character sha256 hex digest, got "${args["expect-sha256"]}"`);
    process.exit(2);
  }
  const rawScript = JSON.parse(fs.readFileSync(args.script, "utf8"));
  const kbmscript = require("./kbmscript");
  if (rawScript.schema === kbmscript.SCHEMA) {
    if (hooks.prepareGame || hooks.finalizeReceipt) throw new Error("keyboard/mouse replay does not support private game adapters");
    return require("./keyboard-mouse").play(args, kbmscript.loadScript(rawScript), RUNS_ROOT, reporter);
  }
  if (args.pid) throw new Error("--pid attachment is currently available for keyboard/mouse traces only");
  const script = padscript.loadScript(JSON.stringify(rawScript));
  const runId = receiptLib.newRunId();
  const runDir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const warnings = [];
  const events = [];
  const startedAt = new Date();
  const t0 = hrtimeMs();
  const sinceMs = Date.now();
  log(`run ${runId} → ${runDir}`);

  // 1. build. fetchBuild digests the bytes and refuses BEFORE it unzips, so a
  // wrong build is never even unpacked; the catch turns that into a named
  // exit 2 with one line, rather than the generic exit 1 every throw here gets.
  // Nothing has been launched at this point — no capture, no pad, no game.
  let build;
  try {
    build = await fetchBuild(source, runDir, { expectSha256: expectSha });
  } catch (e) {
    if (expectSha && /sha256 mismatch/.test(e.message)) {
      console.error(`rig play: ${e.message} — refusing to launch`);
      process.exit(2);
    }
    throw e;
  }
  // An already-unzipped directory has no digest, so the expectation could not be
  // checked at all. Silently proceeding would make --expect-sha256 a flag that
  // sometimes means nothing, which is worse than not having it.
  if (expectSha && !build.sha256) {
    console.error("rig play: --expect-sha256 needs a build file (a .zip or a URL) — an unzipped directory has no digest to check, refusing to launch");
    process.exit(2);
  }
  const { exe, pick } = pickExe(build.dir, { exe: args.exe });
  log(`exe: ${exe} (${pick})`);

  // 2. capture (before the game so the recording includes the first frame)
  let ffmpeg = null;
  const recordingPath = path.join(runDir, "recording.mp4");
  if (!args["no-capture"]) {
    let mode = args["capture-mode"] || "hw";
    if (mode === "ddagrab") mode = "hw"; // pre-AMD name for the hardware path
    let encoder = null;
    if (mode === "hw") {
      encoder = args.encoder || probeEncoder();
      if (!encoder) {
        warnings.push(`no working hardware encoder (tried ${capture.HW_ENCODERS.join(", ")}) — falling back to gdigrab+libx264`);
        mode = "gdigrab";
      }
    }
    ffmpeg = spawn(FFMPEG, capture.recordingArgs({ output: recordingPath, mode, encoder, maxMinutes: Number(args["max-minutes"] || 35) }), { stdio: ["pipe", "ignore", "pipe"] });
    events.push({ t_ms: Math.round(hrtimeMs() - t0), kind: "label", detail: "capture_spawn" });
    let ffErr = "";
    ffmpeg.stderr.on("data", (d) => { ffErr = (ffErr + d.toString()).slice(-2000); });
    ffmpeg.on("exit", (code) => { if (code !== 0 && code !== null && ffmpeg.wanted !== false) warnings.push(`ffmpeg exited ${code}: ${ffErr.split("\n").slice(-2).join(" ")}`); });
  }

  // 3. virtual pad BEFORE the game launches, so controller enumeration finds it
  const feeder = new PadFeeder();
  await feeder.connect();
  log("virtual pad connected");

  // 4. game
  const exeArgs = args["exe-args"] ? String(args["exe-args"]).split(/\s+/) : [];
  const gameLog = args["game-log"] ? path.resolve(String(args["game-log"])) : path.join(runDir, "game.log");
  const context = { args, exe, build, runDir, exeArgs, gameLog };
  if (hooks.prepareGame) await hooks.prepareGame(context);
  let previousLog = "";
  try { previousLog = fs.readFileSync(gameLog, "utf8"); } catch { /* first run */ }
  const { child: game, exited } = gameProc.launch(exe, { args: exeArgs, cwd: path.dirname(exe) });
  log(`game pid ${game.pid}`);
  let gameExit = null;
  exited.then((r) => { gameExit = r; });

  // 5. start condition
  const wait = (script.start && script.start.wait_for) || { kind: "fixed_delay", ms: 8000 };
  if (wait.kind === "fixed_delay") {
    await new Promise((r) => setTimeout(r, wait.ms));
  } else if (wait.kind === "log_line") {
    const ok = await waitForLogLine(gameLog, wait.match, Number(wait.timeout_ms || 60000), () => gameExit !== null, previousLog);
    if (!ok) warnings.push(`start.wait_for log_line "${wait.match}" not seen — started after timeout`);
  }
  events.push({ t_ms: Math.round(hrtimeMs() - t0), kind: "label", detail: "input_start" });

  // 6. telemetry (attach by pid after the game is up)
  let pmProc = null;
  const pmCsv = path.join(runDir, "presentmon.csv");
  let pmSpawnWallMs = null;
  if (!args["no-telemetry"] && gameExit === null) {
    pmSpawnWallMs = Date.now();
    pmProc = spawn(PRESENTMON, presentmon.buildArgs({ pid: game.pid, outputFile: pmCsv }), { stdio: "ignore" });
    pmProc.on("error", () => warnings.push("PresentMon failed to start — no frame telemetry"));
  }

  // 7. drive
  const changeStream = padscript.changeEvents(script);
  const inputsPath = path.join(runDir, "inputs.jsonl");
  const inputsFd = fs.openSync(inputsPath, "w");
  // Measured send times go in a SIBLING file: inputs.jsonl stays a pure function
  // of the script (byte-identical across runs — the determinism proof), while
  // inputs-timing.jsonl carries the wall-clock truth `rig overlay` syncs against.
  const timingFd = fs.openSync(path.join(runDir, "inputs-timing.jsonl"), "w");
  const budgetMs = Number(args["max-minutes"] || 35) * 60000;
  let exitReason = "script_end";
  const logWaiter = makeLogWaiter(gameLog, () => gameExit !== null);
  const playRes = await playEvents(changeStream, {
    send: (e) => {
      feeder.sendState(e.pad);
      fs.writeSync(inputsFd, JSON.stringify({ seq: e.seq, t_ms: e.t_ms, pad: e.pad }) + "\n");
      fs.writeSync(timingFd, JSON.stringify({ seq: e.seq, at_ms: Math.round(hrtimeMs() - t0) }) + "\n");
    },
    waitLog: async (e) => {
      const waitStart = hrtimeMs();
      const ok = await logWaiter(e.wait_log.match, Number(e.wait_log.timeout_ms || 15000));
      const waitedMs = Math.round(hrtimeMs() - waitStart);
      events.push({ t_ms: Math.round(hrtimeMs() - t0), kind: "sync",
        detail: `wait_log "${e.wait_log.match}" ${ok ? "matched" : "TIMEOUT"} after ${waitedMs}ms` });
      if (!ok) warnings.push(`wait_log "${e.wait_log.match}" not seen in ${e.wait_log.timeout_ms || 15000}ms — continued`);
    },
    shouldStop: () => {
      if (gameExit !== null) { exitReason = "game_exit"; return true; }
      if (hrtimeMs() - t0 > budgetMs) { exitReason = "budget"; return true; }
      return false;
    },
  });
  fs.closeSync(inputsFd);
  fs.closeSync(timingFd);
  if (playRes.stopped && exitReason === "script_end") exitReason = "operator";

  // 8. teardown in reverse
  feeder.sendState({});
  await feeder.close();
  if (pmProc && pmProc.exitCode === null) pmProc.kill("SIGINT");
  if (gameExit === null && !args["keep-game"]) {
    gameProc.killTree(game.pid);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  if (ffmpeg) {
    ffmpeg.wanted = false;
    // The overlay's sync anchor: the recording's last frame lands ~here, so
    // capture_start = capture_stop - video_duration regardless of spawn latency.
    events.push({ t_ms: Math.round(hrtimeMs() - t0), kind: "label", detail: "capture_stop" });
    try { ffmpeg.stdin.write("q"); } catch { /* already gone */ }
    await new Promise((r) => { ffmpeg.on("exit", r); setTimeout(r, 5000); });
  }
  const durationMs = Math.round(hrtimeMs() - t0);

  // 9. digest
  const exitInfo = gameExit ? gameProc.classifyExit(gameExit) : { exit_reason: exitReason, detail: null };
  const dumps = gameProc.sweepCrashDumps(sinceMs);
  if (dumps.length) {
    fs.copyFileSync(dumps[0].file, path.join(runDir, path.basename(dumps[0].file)));
    events.push({ t_ms: durationMs, kind: "crash", detail: path.basename(dumps[0].file) });
  }
  let perf = null;
  if (fs.existsSync(pmCsv)) {
    const parsed = presentmon.parseCsv(fs.readFileSync(pmCsv, "utf8"));
    const summary = presentmon.summarize(parsed.frames);
    if (summary) {
      perf = { source: "presentmon", csv: "presentmon.csv", summary };
      for (const s of summary.load_stalls) events.push({ t_ms: s.t_ms, kind: "load_stall", detail: `${s.gap_ms}ms` });
    } else warnings.push("PresentMon CSV had no frames");
  }

  const crashed = exitInfo.exit_reason === "crash" || dumps.length > 0;
  const receipt = receiptLib.createReceipt({
    run_id: runId,
    at: startedAt.toISOString(),
    duration_ms: durationMs,
    ok: true,
    result: crashed ? "fail" : "pass",
    failure_cause: crashed
      ? { kind: "crash", message: exitInfo.detail || "crash dump found", at_ms: durationMs }
      : null,
    rig: { host: require("os").hostname(), os: `${process.platform} ${require("os").release()}` },
    build: {
      url: /^https?:/.test(source) ? source : null,
      sha256: build.sha256,
      // What the caller SAID it should be. A receipt that carries the
      // expectation as well as the digest is checkable by someone who was not
      // at the terminal; null means the run made no such claim.
      expected_sha256: expectSha,
      filename: build.zip ? path.basename(build.zip) : null,
      label: args.label || (build.zip ? path.basename(build.zip, ".zip") : path.basename(build.dir)),
      exe: path.basename(exe),
      exe_pick: pick,
      platform: "windows",
      source: /^https?:/.test(source) ? source : "local",
    },
    mode: "replay",
    script: {
      file: path.basename(args.script),
      schema: padscript.SCHEMA,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(args.script)).digest("hex"),
      source: script.source || "authored",
    },
    process: { pid: game.pid, exit_code: gameExit ? gameExit.code : null, exit_reason: exitInfo.exit_reason, crash_dump: dumps.length ? path.basename(dumps[0].file) : null },
    inputs: { events_sent: playRes.sent, log: "inputs.jsonl", timing_log: "inputs-timing.jsonl", jitter: playRes.jitter },
    performance: perf,
    media: { recording: fs.existsSync(recordingPath) ? "recording.mp4" : null, screenshots: [] },
    events,
    warnings,
  });
  if (hooks.finalizeReceipt) await hooks.finalizeReceipt({
    ...context, pmSpawnWallMs, perf, warnings, events, receipt,
  });
  receiptLib.writeReceipt(runDir, receipt);
  log(`\n✓ receipt: ${path.join(runDir, "receipt.json")}`);
  log(`  result: ${receipt.result}${receipt.failure_cause ? ` (${receipt.failure_cause.kind}: ${receipt.failure_cause.message})` : ""}`);
  if (perf) log(`  perf: avg ${perf.summary.avg_fps} fps · p95 ${perf.summary.p95_ms}ms · 1% low ${perf.summary.one_percent_low_fps} fps · ${perf.summary.stutters.length} stutters`);
  if (warnings.length) for (const w of warnings) log(`  ⚠ ${w}`);

  if (args["to-studio"]) {
    const dest = reporter.dropToStudio(runDir, String(args["to-studio"]), receipt);
    log(`  studio: ${dest}`);
  }
}

// Stateful tail cursor for mid-script wait_log barriers: each match consumes log
// content, so a repeated match string needs a NEW occurrence (a second "event=fall"
// barrier cannot be satisfied by the first fall).
function makeLogWaiter(file, gameGone) {
  // consumed: hard floor — a matched occurrence can never match again.
  // highWater: soft floor for scan efficiency; the search backs off match.length
  // below it to catch lines that straddle a partial write, but NEVER below consumed
  // (backing below consumed re-matched the same "event=death" four times, live).
  let consumed = 0;
  try { consumed = fs.readFileSync(file, "utf8").length; } catch { /* not written yet */ }
  let highWater = consumed;
  return async function waitFor(match, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (gameGone()) return false;
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, "utf8");
        const from = Math.max(consumed, highWater - match.length);
        const i = text.indexOf(match, from);
        if (i >= 0) { consumed = i + match.length; highWater = consumed; return true; }
        highWater = Math.max(highWater, text.length);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  };
}

async function waitForLogLine(file, match, timeoutMs, gameGone, previousLog = "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gameGone()) return false;
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      // A supplied game log may append across launches. Only new content can
      // start this run; a truncated/replaced log starts at its new beginning.
      const offset = previousLog && text.startsWith(previousLog) ? previousLog.length : 0;
      if (text.slice(offset).includes(match)) return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ── record ────────────────────────────────────────────────────────────────────

async function cmdRecord(args) {
  requireWindows("record");
  if (args.input === "keyboard-mouse") return require("./keyboard-mouse").record(args);
  if (args.input && args.input !== "controller") throw new Error("--input must be controller|keyboard-mouse");
  const out = args.out || `session-${Date.now()}.padscript.json`;
  const rate = Number(args.rate || 120);
  log("recording the PHYSICAL pad — play now; Ctrl+C to stop and write the padscript");
  log("(unplug this pad before replaying, so the virtual pad takes slot 0)");
  if (args["start-log"]) log(`start gated on game-log line: "${args["start-log"]}"`);
  else log("tip: --start-log \"event=ready\" gates replay start on a log line, not a blind 8s delay");

  const tap = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(RIG_ROOT, "shims", "xinput-tap.ps1"), "-RateHz", String(rate), ...(args.slot ? ["-Slot", String(args.slot)] : [])],
    { stdio: ["ignore", "pipe", "inherit"] });

  const timeline = [];
  let lastSampleWallMs = null;
  const rl = readline.createInterface({ input: tap.stdout });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === "tap_ready") { log(`tap ready on slot ${msg.slot}`); return; }
    if (msg.event === "error") { console.error(`tap: ${msg.message}`); return; }
    if (Number.isFinite(msg.t_ms)) {
      timeline.push({ t_ms: msg.t_ms, pad: padscript.normalizePad(msg) });
      lastSampleWallMs = Date.now();
    }
  });

  await new Promise((resolve) => {
    const finish = () => { tap.kill(); resolve(); };
    process.once("SIGINT", finish);
    tap.on("exit", resolve);
    if (args["max-minutes"]) setTimeout(finish, Number(args["max-minutes"]) * 60000);
  });

  if (timeline.length === 0) { console.error("no input captured — nothing written"); process.exit(1); }
  // The tap emits CHANGES, so a session that ends on a constant held stick has
  // no trailing sample — stamp one at stop time or the held tail vanishes from
  // the timeline (a full-street sprint recorded as 0.9s, live 2026-08-27).
  const heldMs = lastSampleWallMs !== null ? Math.max(0, Date.now() - lastSampleWallMs) : 0;
  if (heldMs > 250) {
    const last = timeline[timeline.length - 1];
    timeline.push({ t_ms: last.t_ms + heldMs, pad: last.pad });
  }
  const rebased = timeline.map((e) => ({ t_ms: e.t_ms - timeline[0].t_ms, pad: e.pad }));
  const script = {
    schema: padscript.SCHEMA,
    created_at: new Date().toISOString(),
    source: "recorded",
    game: { build_sha256: args["build-sha"] || null, exe: args.exe || null, title: args.title || null },
    meta: { author: "rig record", notes: `captured at ${rate}Hz from the physical pad`, duration_ms: rebased[rebased.length - 1].t_ms, recorded_from: "xinput" },
    rate_hz: rate,
    // A recorded session replayed against TWO builds has to start at the same point
    // in each: --start-log gates it on a game-log line (for example, a ready event)
    // instead of a blind delay, so a slower-loading build cannot masquerade as a
    // world-state divergence.
    start: args["start-log"]
      ? { wait_for: { kind: "log_line", match: String(args["start-log"]), timeout_ms: 60000 } }
      : { wait_for: { kind: "fixed_delay", ms: 8000 } },
    timeline: rebased,
    labels: [],
  };
  const v = padscript.validateScript(script);
  if (!v.ok) { console.error(`recorded script failed validation: ${v.errors.join("; ")}`); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify(script, null, 2) + "\n");
  log(`\n✓ ${out} — ${rebased.length} state changes over ${(script.meta.duration_ms / 1000).toFixed(1)}s`);
}

// ── overlay ──────────────────────────────────────────────────────────────────

// Post-processing only — reads the run's own artifacts, never touches the game.
// The pad graphic is rendered FROM inputs.jsonl (+ measured send times when the
// run wrote inputs-timing.jsonl), so the overlay IS the receipt's input trace.
async function cmdOverlay(args) {
  const overlay = require("./overlay");
  const runDir = args._[1];
  if (!runDir) {
    console.error("usage: rig overlay <run-dir> [--out <file>] [--fps 30] [--offset-ms 0] [--corner br|bl|tr|tl] [--keep-frames]");
    process.exit(2);
  }
  const receipt = receiptLib.readReceipt(runDir);
  if (receipt.script?.schema === require("./kbmscript").SCHEMA) throw new Error("keyboard/mouse overlay is not implemented; use the original recording and input logs");
  const video = path.join(runDir, (receipt.media && receipt.media.recording) || "recording.mp4");
  const inputsFile = path.join(runDir, "inputs.jsonl");
  if (!fs.existsSync(video)) { console.error(`no recording in ${runDir} (was the run --no-capture?)`); process.exit(1); }
  if (!fs.existsSync(inputsFile)) { console.error(`no inputs.jsonl in ${runDir}`); process.exit(1); }

  const probe = spawnSync(FFMPEG, ["-hide_banner", "-i", video], { encoding: "utf8" });
  const videoDurationS = overlay.parseFfmpegDuration(probe.stderr);
  if (!videoDurationS) { console.error("could not read the recording's duration via ffmpeg"); process.exit(1); }

  const inputs = fs.readFileSync(inputsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const timingBySeq = new Map();
  const timingFile = path.join(runDir, "inputs-timing.jsonl");
  if (fs.existsSync(timingFile)) {
    for (const l of fs.readFileSync(timingFile, "utf8").split("\n").filter(Boolean)) {
      const t = JSON.parse(l);
      timingBySeq.set(t.seq, t.at_ms);
    }
  }

  const tb = overlay.makeTimebase({ receipt, videoDurationS, timingBySeq, offsetMs: Number(args["offset-ms"] || 0) });
  const fps = Number(args.fps || 30);
  const plan = overlay.planFrames({ inputs, toVideoS: tb.toVideoS, videoDurationS, fps });

  const framesDir = path.join(runDir, "overlay-frames");
  fs.mkdirSync(framesDir, { recursive: true });
  const fileByKey = new Map();
  let n = 0;
  for (const [key, state] of plan.states) {
    const name = `pad-${String(n++).padStart(4, "0")}.png`;
    fs.writeFileSync(path.join(framesDir, name), overlay.encodePng(overlay.drawPad(state)));
    fileByKey.set(key, name);
  }
  const concatFile = path.join(framesDir, "frames.ffconcat");
  fs.writeFileSync(concatFile, overlay.ffconcatText(plan.segments, (k) => fileByKey.get(k), fps));

  const output = args.out ? String(args.out) : path.join(runDir, "recording-overlay.mp4");
  log(`overlay: ${plan.frameCount} frames @ ${fps}fps, ${plan.states.size} unique pad states`);
  log(`  sync: ${tb.usingTiming ? "measured send times" : "script times"}, anchored on ${tb.anchor}`);
  const ff = spawnSync(FFMPEG, overlay.composeArgs({ video, concatFile, output, corner: args.corner }), { encoding: "utf8" });
  if (ff.status !== 0) {
    console.error(`ffmpeg compose failed:\n${(ff.stderr || "").split("\n").slice(-6).join("\n")}`);
    process.exit(1);
  }
  if (!args["keep-frames"]) fs.rmSync(framesDir, { recursive: true, force: true });
  log(`✓ ${output}`);
}

// Read findings from a receipt without loading game-specific code.
function cmdReport(args, reporter = report) {
  const runDir = args._[1];
  if (!runDir) { console.error("usage: rig report <run-dir> [--to-studio <workdir>]"); process.exit(2); }
  const receipt = receiptLib.readReceipt(runDir);
  const annotations = reporter.receiptToAnnotations(receipt);
  fs.writeFileSync(path.join(runDir, "annotations.json"), JSON.stringify(annotations, null, 2) + "\n");
  log(`${annotations.summary}\n`);
  for (const f of annotations.findings) {
    log(`  [${f.sentiment}] ${f.title}${f.evidence[0] ? ` @ ${report.mmss(f.evidence[0].time_ms)}` : ""}`);
    log(`      ${f.body}`);
  }
  if (args["to-studio"]) {
    const dest = reporter.dropToStudio(runDir, String(args["to-studio"]), receipt);
    log(`\n✓ dropped into studio cache: ${dest}`);
  }
}

const PUBLIC_COMMANDS = ["start", "doctor", "pad-test", "play", "record", "overlay", "report", "version"];

async function main(argv = process.argv.slice(2), extensions = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const commands = extensions.commands || {};
  const reporter = extensions.reporter || report;
  if (Object.hasOwn(commands, cmd)) return commands[cmd](args);
  switch (cmd) {
    case "start": {
      const desktop = require("./desktop");
      try { return await desktop.start(args); }
      catch (error) { desktop.showError(error.message); throw error; }
    }
    case "doctor": return cmdDoctor(args);
    case "pad-test": return cmdPadTest(args);
    case "play": return cmdPlay(args, extensions.play, reporter);
    case "record": return cmdRecord(args);
    case "overlay": return cmdOverlay(args);
    case "report": return cmdReport(args, reporter);
    case "version": return log(require("../package.json").version);
    default:
      if (cmd) console.error(`rig: unsupported command "${cmd}"`);
      console.error(`usage: rig ${[...PUBLIC_COMMANDS, ...Object.keys(commands)].join(" | ")}`);
      process.exitCode = cmd ? 2 : 0;
  }
}

module.exports = { main, parseArgs, makeLogWaiter, waitForLogLine, PUBLIC_COMMANDS };
