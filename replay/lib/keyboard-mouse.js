"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const scripts = require("./kbmscript");
const receipts = require("./receipt");
const capture = require("./capture");
const telemetry = require("./telemetry-presentmon");
const gameProc = require("./game-proc");
const { fetchBuild, pickExe } = require("./build-fetch");
const { jitterStats } = require("./scheduler");
const SHIM = path.join(__dirname, "../shims/keyboard-mouse.ps1");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function options(args) {
  const maxSeconds = Number(args["max-minutes"] ?? 35) * 60;
  const startDelayMs = args["start-delay"] === undefined ? -1 : Number(args["start-delay"]) * 1000;
  const countdownMs = Number(args.countdown ?? 5) * 1000;
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 2100) throw new Error("--max-minutes must give 1..2100 whole seconds");
  if (!Number.isInteger(startDelayMs) || (args["start-delay"] !== undefined && startDelayMs < 0) || startDelayMs > 120000) throw new Error("--start-delay must give 0..120000 whole milliseconds");
  if (!Number.isInteger(countdownMs) || countdownMs < 0 || countdownMs > 30000) throw new Error("--countdown must give 0..30000 whole milliseconds");
  const pid = args.pid === undefined ? null : Number(args.pid);
  const mouseMode = args["mouse-mode"] || "auto";
  if (!["auto", "pointer"].includes(mouseMode)) throw new Error("--mouse-mode must be auto|pointer");
  if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) throw new Error("--pid requires a positive process id");
  return { maxSeconds, startDelayMs, countdownMs, showStatus: !args["no-status"], pid, mouseMode };
}

class DesktopInput extends EventEmitter {
  constructor(pid, mode, opts = {}) {
    super();
    this.failure = null;
    this.child = spawn(opts.command || "powershell", opts.argv || ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SHIM,
      "-TargetPid", String(pid), "-Mode", mode, "-MaxSeconds", String(opts.maxSeconds || 2100), "-StartDelayMs", String(opts.startDelayMs ?? -1),
      "-CountdownMs", String(opts.countdownMs ?? 5000), ...(opts.mouseMode === "pointer" ? ["-PointerMode"] : []), ...(opts.showStatus ? ["-ShowStatus"] : []), ...(opts.waitForCapture ? ["-WaitForCapture"] : [])],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.stderr = "";
    this.child.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-3000); });
    this.child.stdin.on("error", (e) => { this.failure ||= e.message; });
    this.ready = new Promise((resolve, reject) => {
      this.once("ready", resolve);
      this.once("failed", reject);
    });
    this.done = new Promise((resolve) => {
      this.child.once("close", () => {
        if (!this.result) this.failure ||= this.stderr || "input helper closed without a stop result";
        if (!this.info) this.emit("failed", new Error(this.failure || "input helper closed before ready"));
        resolve(this.result || { reason: "input_error", started: false, duration_ms: 0 });
      });
    });
    this.child.once("error", (e) => { this.failure = e.message; this.emit("failed", e); });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { this.failure ||= `invalid helper output: ${line.slice(0, 120)}`; this.stop(); return; }
      if (msg.event === "ready") { this.info = msg; this.emit("ready", msg); }
      if (msg.event === "error") { this.failure = msg.message; this.emit("failed", new Error(msg.message)); }
      if (msg.event === "stopped") this.result = msg;
      this.emit("message", msg);
    });
  }
  write(value) { this.child.stdin.write(JSON.stringify(value) + "\n"); }
  stop() { if (!this.child.stdin.destroyed) this.write({ op: "stop" }); }
  async close() {
    this.stop();
    this.child.stdin.end(); // native finally releases held keys/buttons on EOF
    let timer;
    await Promise.race([this.done, new Promise((resolve) => { timer = setTimeout(() => { this.child.kill(); resolve(); }, 5000); })]);
    clearTimeout(timer);
  }
}

function sameExe(actual, expected) {
  return path.resolve(actual).toLowerCase() === path.resolve(expected).toLowerCase();
}

function prepareVideo(file, args, warnings) {
  const ffmpeg = process.env.RIG_FFMPEG || "ffmpeg";
  if (fs.existsSync(file)) throw new Error(`capture output exists: ${file}`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  let mode = args["capture-mode"] || "hw";
  let encoder = args.encoder;
  if (!["hw", "gdigrab"].includes(mode)) throw new Error("--capture-mode must be hw|gdigrab");
  if (encoder && !capture.HW_ENCODERS.includes(encoder)) throw new Error("unsupported hardware encoder");
  if (mode === "hw" && !encoder) {
    encoder = capture.HW_ENCODERS.find((e) => spawnSync(ffmpeg, capture.probeArgs(e), { timeout: 15000, stdio: "ignore" }).status === 0);
    if (!encoder) { mode = "gdigrab"; warnings.push("hardware encoder unavailable; software capture can affect performance"); }
  }
  return { file, ffmpeg, mode, encoder, maxMinutes: Number(args["max-minutes"] || 35) + 2 };
}

function startVideo({ file, ffmpeg, mode, encoder, maxMinutes }) {
  if (fs.existsSync(file)) throw new Error(`capture output exists: ${file}`);
  const argv = capture.recordingArgs({ output: file, mode, encoder, maxMinutes }).map(a => a === "-y" ? "-n" : a);
  const spawnedAt = Date.now();
  const child = spawn(ffmpeg, ["-nostats", "-stats_period", "0.1", "-progress", "pipe:1", ...argv],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const state = { child, mode, encoder: mode === "hw" ? encoder : "libx264", spawnedAt, failed: null, stopping: false };
  let stderr = "";
  let firstFrame, failedToStart, startupTimer;
  state.ready = new Promise((resolve, reject) => { firstFrame = resolve; failedToStart = reject; });
  // First encoded frame is the readiness signal, not successful process spawn.
  readline.createInterface({ input: child.stdout }).on("line", line => {
    if (/^frame=\s*[1-9]\d*\s*$/.test(line)) { clearTimeout(startupTimer); firstFrame(); }
  });
  startupTimer = setTimeout(() => {
    state.failed ||= "video capture produced no frame within 15 seconds";
    failedToStart(new Error(state.failed));
  }, 15000);
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
  child.stdin.on("error", () => {});
  child.once("error", (e) => { state.failed = e.message; clearTimeout(startupTimer); failedToStart(e); });
  state.closed = new Promise((resolve) => child.once("close", (code) => {
    clearTimeout(startupTimer);
    if (code !== 0 || !state.stopping) state.failed ||= `capture exited ${code}: ${stderr.slice(-500)}`;
    failedToStart(new Error(state.failed || "capture stopped before its first frame"));
    resolve();
  }));
  return state;
}

function captureOnStart(helper, createVideo, onSpawn = () => {}) {
  const session = { video: null, failure: null, requested: false };
  const tell = op => { if (!helper.result && !helper.child.stdin.destroyed) helper.write({ op }); };
  const failed = error => { session.failure ||= error.message; tell("capture_failed"); };
  helper.on("message", msg => {
    if (msg.event !== "prepare_capture" || session.requested || helper.result) return;
    session.requested = true;
    try {
      const video = session.video = createVideo();
      video.ready.then(() => tell("capture_ready"), failed);
      video.closed.then(() => { if (video.failed) failed(new Error(video.failed)); });
      onSpawn(video);
    } catch (error) { failed(error); }
  });
  return session;
}
async function stopVideo(video) {
  if (!video) return;
  video.stopping = true;
  if (!video.child.stdin.destroyed) video.child.stdin.end("q\n");
  let timer;
  await Promise.race([video.closed, new Promise((resolve) => { timer = setTimeout(() => { video.child.kill(); resolve(); }, 5000); })]);
  clearTimeout(timer);
}

async function record(args) {
  const opts = options(args);
  if (!opts.pid) throw new Error("keyboard/mouse record requires --pid <game-process-id>");
  const out = path.resolve(args.out || `session-${Date.now()}.kbmscript.json`);
  if (fs.existsSync(out)) throw new Error(`trace output exists: ${out}`);
  if (fs.existsSync(out + ".capture.json")) throw new Error(`capture sidecar exists: ${out}.capture.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const warnings = [], timeline = [];
  let helper, captureSession, started, result;
  const stop = () => helper?.stop();
  try {
    const videoPlan = args.video ? prepareVideo(path.resolve(args.video), args, warnings) : null;
    opts.waitForCapture = !!videoPlan;
    helper = new DesktopInput(opts.pid, "record", opts);
    if (videoPlan) captureSession = captureOnStart(helper, () => startVideo(videoPlan));
    helper.on("message", (msg) => {
      if (msg.event === "started") { started = msg.utc_ms; console.log("recording keyboard/mouse — F8 stops"); }
      if (msg.event === "countdown" && msg.seconds > 0) console.log(`recording starts in ${msg.seconds}…`);
      if (Number.isFinite(msg.t_ms)) timeline.push({ t_ms: msg.t_ms, input: msg.input });
    });
    const info = await helper.ready;
    console.log(`armed for ${path.basename(info.exe)} (pid ${opts.pid}); ${opts.startDelayMs >= 0 ? "automatic countdown" : opts.showStatus ? "click Start recording or press F9" : "F9 starts the countdown"}; play when REC appears, F8 stops`);
    process.once("SIGINT", stop);
    result = await helper.done;
    if (captureSession?.failure) warnings.push(captureSession.failure);
    if (helper.failure) throw new Error(helper.failure);
    if (!result.started || !timeline.length) throw new Error(`no physical input recorded (${result.reason}); nothing written`);
    const script = scripts.loadScript({ schema: scripts.SCHEMA, source: "recorded", created_at: new Date(started).toISOString(),
      duration_ms: result.duration_ms, game: { exe: path.basename(info.exe), title: args.title || null },
      meta: { recorded_from: "win32-rawinput", stopped_by: result.reason, mouse: "relative",
        cursor: opts.mouseMode === "pointer" ? "client-normalized/v1" : "visible-client-pixels/v1", mouse_mode: opts.mouseMode, notes: "F9/F8 transport keys excluded" }, timeline });
    fs.writeFileSync(out, JSON.stringify(script, null, 2) + "\n", { flag: "wx" });
    console.log(`trace: ${out} — ${timeline.length} physical events, ${(result.duration_ms / 1000).toFixed(1)}s (${result.reason})`);
  } finally {
    process.removeListener("SIGINT", stop);
    if (helper) await helper.close();
    const video = captureSession?.video;
    await stopVideo(video);
    if (video?.failed) warnings.push(video.failed);
    if (fs.existsSync(out) && started) fs.writeFileSync(out + ".capture.json", JSON.stringify({
      script: { file: out, sha256: sha256(out) }, input_start_utc_ms: started, stopped_by: result?.reason,
      video: args.video ? { file: path.resolve(args.video), mode: video?.mode, encoder: video?.encoder, failure: video?.failed,
        spawn_utc_ms: video?.spawnedAt,
        sha256: fs.existsSync(args.video) ? sha256(args.video) : null } : null, warnings,
    }, null, 2) + "\n", { flag: "wx" });
    for (const warning of warnings) console.warn(warning);
  }
}

async function play(args, script, runsRoot, reporter) {
  const opts = options(args), source = args._[1];
  const expected = args["expect-sha256"] ? String(args["expect-sha256"]).trim().toLowerCase() : null;
  const runId = receipts.newRunId(), runDir = path.join(runsRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const build = await fetchBuild(source, runDir, { expectSha256: expected });
  if (expected && !build.sha256) throw new Error("--expect-sha256 requires a zip build");
  const { exe, pick } = pickExe(build.dir, { exe: args.exe });
  const changes = scripts.changeEvents(script), sent = [], timing = [], events = [], warnings = [];
  if (changes.some(e => e.input.kind !== "key") && !changes.some(e => e.input.cursor)) {
    warnings.push("This trace has no recorded pointer positions; pointer-game clicks depend on the starting mouse position. For a custom cursor, make a new recording in Pointer mode. Relative camera input is unchanged.");
  }
  const start = Date.now(), sinceMs = start;
  let helper, captureSession, game, pm, stopResult, error, inputStart, gameExit;
  const stop = () => helper?.stop();
  try {
    if (!opts.pid) {
      const launched = gameProc.launch(exe, { args: args["exe-args"] ? String(args["exe-args"]).split(/\s+/) : [], keepFocus: false });
      game = launched.child;
      launched.exited.then((e) => { gameExit = e; });
      opts.pid = game.pid;
      if (!opts.pid) throw new Error("game did not launch");
    }
    const videoPlan = args["no-capture"] ? null : prepareVideo(path.join(runDir, "recording.mp4"), args, warnings);
    opts.waitForCapture = !!videoPlan;
    helper = new DesktopInput(opts.pid, "replay", opts);
    const info = await helper.ready;
    if (!sameExe(info.exe, exe)) throw new Error("--pid belongs to a different executable; refusing replay");
    if (videoPlan) captureSession = captureOnStart(helper, () => startVideo(videoPlan),
      video => events.push({ t_ms: video.spawnedAt - start, kind: "label", detail: "capture_spawn" }));
    const csv = path.join(runDir, "presentmon.csv");
    helper.on("message", (msg) => {
      if (msg.event === "countdown" && msg.seconds > 0) console.log(`replay starts in ${msg.seconds}…`);
      if (msg.event === "started") {
        if (!args["no-telemetry"]) {
          pm = spawn(process.env.RIG_PRESENTMON || "presentmon", telemetry.buildArgs({ pid: opts.pid, outputFile: csv }), { stdio: "ignore", windowsHide: true });
          pm.on("error", () => warnings.push("PresentMon unavailable; no frame telemetry"));
        }
        inputStart = msg.utc_ms - start;
        events.push({ t_ms: inputStart, kind: "label", detail: "input_start" });
        console.log("replaying keyboard/mouse — F8 stops");
      }
      if (msg.event === "sent") {
        sent.push(changes[msg.seq]);
        timing.push({ seq: msg.seq, at_ms: inputStart + msg.at_ms });
      }
    });
    process.once("SIGINT", stop);
    console.log(`run ${runId} → ${runDir}\n${path.basename(exe)} pid ${opts.pid}; focus the game, release controls; ${opts.startDelayMs >= 0 ? "automatic countdown" : opts.showStatus ? "click Start replay or press F9" : "F9 starts the countdown"}, F8 stops`);
    helper.write({ op: "play", timeline: changes, duration_ms: script.duration_ms });
    stopResult = await helper.done;
    if (helper.failure) throw new Error(helper.failure);
    if (stopResult.reason !== "script_end") throw new Error(`replay interrupted: ${stopResult.reason}`);
  } catch (e) { error = e; warnings.push(e.message); }
  finally {
    process.removeListener("SIGINT", stop);
    if (helper) await helper.close();
    if (pm && pm.exitCode === null) pm.kill("SIGINT");
    // An attached game belongs to the operator; never kill it or seize focus.
    if (game?.pid && !gameExit && !args["keep-game"]) gameProc.killTree(game.pid);
    if (game && args["keep-game"]) game.unref();
    const video = captureSession?.video;
    if (video) events.push({ t_ms: Date.now() - start, kind: "label", detail: "capture_stop" });
    await stopVideo(video);
  }
  const video = captureSession?.video;
  if (captureSession?.failure) { warnings.push(captureSession.failure); error ||= new Error(captureSession.failure); }
  if (video?.failed) { warnings.push(video.failed); error ||= new Error(video.failed); }
  fs.writeFileSync(path.join(runDir, "inputs.jsonl"), sent.map((e) => JSON.stringify(e) + "\n").join(""));
  fs.writeFileSync(path.join(runDir, "inputs-timing.jsonl"), timing.map((e) => JSON.stringify(e) + "\n").join(""));
  let performance = null;
  const csv = path.join(runDir, "presentmon.csv");
  if (fs.existsSync(csv)) {
    const summary = telemetry.summarize(telemetry.parseCsv(fs.readFileSync(csv, "utf8")).frames);
    if (summary) performance = { source: "presentmon", csv: "presentmon.csv", summary };
  }
  const dumps = gameProc.sweepCrashDumps(sinceMs);
  const ownDump = dumps.find((d) => path.basename(d.file).toLowerCase().startsWith(path.basename(exe).toLowerCase() + `.${opts.pid}.`));
  if (ownDump) fs.copyFileSync(ownDump.file, path.join(runDir, path.basename(ownDump.file)));
  const crashed = ownDump || (gameExit && gameProc.classifyExit(gameExit).exit_reason === "crash");
  const interrupted = error || stopResult?.reason !== "script_end";
  const receipt = receipts.createReceipt({ run_id: runId, at: new Date(start).toISOString(), duration_ms: Date.now() - start,
    ok: !interrupted && !crashed, result: crashed ? "fail" : interrupted ? "error" : "pass",
    failure_cause: crashed ? { kind: "crash", message: "game crash observed" } : interrupted ? { kind: "input", message: error?.message || "incomplete replay" } : null,
    rig: { host: os.hostname(), os: `${process.platform} ${os.release()}` },
    build: { url: /^https?:/.test(source) ? source : null, source: build.source, sha256: build.sha256, expected_sha256: expected,
      label: args.label || path.basename(build.dir), exe: path.basename(exe), exe_pick: pick, platform: "windows" },
    script: { file: path.basename(args.script), sha256: sha256(args.script), schema: scripts.SCHEMA, source: script.source },
    process: { pid: opts.pid, attached: !game, exit_code: gameExit?.code ?? null,
      exit_reason: crashed ? "crash" : stopResult?.reason === "script_end" ? "script_end" : stopResult?.reason === "game_exit" ? "game_exit" : stopResult?.reason === "budget" ? "budget" : "operator",
      crash_dump: ownDump ? path.basename(ownDump.file) : null },
    inputs: { device: "keyboard-mouse", backend: "win32-sendinput", events_sent: sent.length, stop_reason: stopResult?.reason || "input_error",
      log: "inputs.jsonl", timing_log: "inputs-timing.jsonl", jitter: jitterStats(timing.map((t, i) => t.at_ms - inputStart - sent[i].t_ms)) },
    media: { recording: video && fs.existsSync(path.join(runDir, "recording.mp4")) ? "recording.mp4" : null, screenshots: [],
      capture_mode: video?.mode ?? null, encoder: video?.encoder ?? null }, performance, events, warnings });
  receipts.writeReceipt(runDir, receipt);
  console.log(`receipt: ${path.join(runDir, "receipt.json")} (${receipt.result})`);
  if (args["to-studio"]) reporter.dropToStudio(runDir, String(args["to-studio"]), receipt);
  if (error) throw error;
}

module.exports = { DesktopInput, options, sameExe, prepareVideo, startVideo, captureOnStart, record, play };
