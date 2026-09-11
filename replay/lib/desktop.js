"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { spawn, spawnSync, fork } = require("node:child_process");
const scripts = require("./kbmscript");
const videoTool = require("./video-tool");
const ROOT = path.resolve(__dirname, "..");
const SESSION = /^session-[a-z0-9-]+$/;

function sessionPath(root, id) {
  if (typeof id !== "string" || !SESSION.test(id)) throw new Error("Choose a saved session");
  const directory = path.join(root, id);
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error("Session folders cannot be links");
  return directory;
}
function sessionList(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(id => SESSION.test(id)).sort().reverse().flatMap(id => {
    try {
      const directory = sessionPath(root, id);
      const meta = JSON.parse(fs.readFileSync(path.join(directory, "session.json"), "utf8"));
      if (!fs.existsSync(path.join(directory, "input.kbmscript.json"))) return [];
      return [{ ...meta, id, hasVideo: !!sessionVideo(root, id), label: `${meta.title || meta.game || "Game"} — ${Number(meta.seconds).toFixed(1)}s — ${meta.created}` }];
    } catch { return []; }
  }).slice(0, 100);
}
function sessionVideo(root, id) {
  const directory = sessionPath(root, id);
  const meta = JSON.parse(fs.readFileSync(path.join(directory, "session.json"), "utf8"));
  if (!meta.lastVideo) return null;
  const video = path.resolve(directory, meta.lastVideo);
  if (!video.startsWith(directory + path.sep) || path.extname(video).toLowerCase() !== ".mp4") return null;
  return fs.existsSync(video) ? video : null;
}
function planSession(root, request) {
  if (!["record", "replay"].includes(request.mode)) throw new Error("Choose Record or Replay");
  if (!Number.isInteger(request.pid) || request.pid < 1 || typeof request.exe !== "string" || !path.isAbsolute(request.exe) || !/\.exe$/i.test(request.exe)) throw new Error("Refresh the game list and choose the running game");
  if (request.mode === "replay") {
    if (request.restored !== true) throw new Error("Restore the starting save, camera and menus before replay");
    const directory = sessionPath(root, request.session);
    const trace = path.join(directory, "input.kbmscript.json");
    const script = scripts.loadScript(fs.readFileSync(trace, "utf8"));
    if (script.game?.exe && path.basename(script.game.exe).toLowerCase() !== path.basename(request.exe).toLowerCase()) throw new Error(`This session was recorded in ${path.basename(script.game.exe)}. Choose that game.`);
    return { directory, trace, script, args: ["play", path.dirname(request.exe), "--exe", path.basename(request.exe), "--pid", String(request.pid), "--script", trace, "--no-telemetry", "--start-delay", "5", ...(request.video ? [] : ["--no-capture"])] };
  }
  const mouseMode = request.mouseMode || "auto";
  if (!["auto", "pointer"].includes(mouseMode)) throw new Error("Choose Automatic or Pointer mouse input");
  const id = `session-${new Date().toISOString().replace(/[^0-9]/g, "")}-${crypto.randomBytes(3).toString("hex")}`;
  const directory = sessionPath(root, id);
  return { directory, trace: path.join(directory, "input.kbmscript.json"), args: ["record", "--input", "keyboard-mouse", "--mouse-mode", mouseMode, "--pid", String(request.pid), "--out", path.join(directory, "input.kbmscript.json"), "--start-delay", "5", ...(request.video ? ["--video", path.join(directory, "human.mp4")] : [])] };
}
function compileDesktop(cache) {
  const source = path.join(ROOT, "shims", "desktop.cs");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex").slice(0, 20);
  fs.mkdirSync(cache, { recursive: true });
  const executable = path.join(cache, `qaping-desktop-${hash}.exe`);
  if (fs.existsSync(executable)) return executable;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "$ErrorActionPreference='Stop'; Add-Type -Path $env:RIG_DESKTOP_SOURCE -OutputAssembly $env:RIG_DESKTOP_OUTPUT -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions"], { encoding: "utf8", windowsHide: true, env: { ...process.env, RIG_DESKTOP_SOURCE: source, RIG_DESKTOP_OUTPUT: executable } });
  if (result.status !== 0) throw new Error(`Could not open the control panel: ${result.stderr || result.stdout}`);
  return executable;
}

async function start(args = {}) {
  if (process.platform !== "win32") throw new Error("The desktop control panel requires Windows");
  const root = path.resolve(args["data-dir"] || path.join(os.homedir(), "Videos", "Qaping Rig"));
  const cache = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "QapingRig");
  const videoCache = path.join(cache, "tools", "ffmpeg-8.1.2");
  fs.mkdirSync(root, { recursive: true });
  const ui = spawn(compileDesktop(cache), [], { windowsHide: false, stdio: ["pipe", "pipe", "pipe"] });
  let job = null, closing = false, lastVideo = null, uiError = "";
  const send = value => { if (!ui.stdin.destroyed && !closing) ui.stdin.write(JSON.stringify(value) + "\n"); };
  const state = (message, extra = {}) => send({ type: "state", message, busy: !!job, sessions: sessionList(root), folder: root, ...extra });
  const launchFile = file => {
    if (!file || !fs.existsSync(file)) throw new Error("No video is available for this session yet");
    // A fixed shell application receives a generated local path, never a command string.
    const child = spawn("explorer.exe", [file], { windowsHide: true, detached: true, stdio: "ignore" });
    child.on("error", error => state(error.message)); child.unref();
  };
  const stop = () => {
    if (!job) return;
    job.cancelled = true; job.abort.abort();
    if (job.child?.connected) job.child.send({ type: "stop" });
    else { job = null; state("Cancelled. No game input was sent."); }
  };
  const complete = (current, code) => {
    if (job !== current) return;
    let message = code === 0 ? "Session finished." : "Session stopped. See details below.";
    let outcome = "stopped";
    try {
      if (current.request.mode === "record" && fs.existsSync(current.plan.trace)) {
        const script = scripts.loadScript(fs.readFileSync(current.plan.trace, "utf8"));
        const sidecar = JSON.parse(fs.readFileSync(current.plan.trace + ".capture.json", "utf8"));
        const metadata = { game: script.game?.exe, title: current.request.title, seconds: script.duration_ms / 1000, events: script.timeline.length, created: new Date(script.created_at).toLocaleString(), stop: sidecar.stopped_by, lastVideo: sidecar.video && !sidecar.video.failure ? "human.mp4" : null };
        fs.writeFileSync(path.join(current.plan.directory, "session.json"), JSON.stringify(metadata, null, 2));
        lastVideo = sidecar.video?.failure ? null : path.join(current.plan.directory, "human.mp4");
        message = `Saved ${metadata.seconds.toFixed(1)} seconds of play (${metadata.events} inputs). ${metadata.stop === "operator" ? "Ready for another session." : "Stopped: " + metadata.stop + "."}`;
        if (sidecar.video?.failure || sidecar.warnings?.length) message += " Video needs checking; see details.";
        outcome = "saved";
      } else if (current.request.mode === "replay") {
        const runs = path.join(current.plan.directory, "replays");
        const latest = current.log.match(/^run (run-[a-z0-9-]+) /m)?.[1];
        if (latest) {
          const folder = path.join(runs, latest);
          const receipt = JSON.parse(fs.readFileSync(path.join(folder, "receipt.json"), "utf8"));
          lastVideo = receipt.media?.recording ? path.join(folder, "recording.mp4") : null;
          message = receipt.inputs?.stop_reason === "script_end" ? "Replay finished. Watch the video to check the gameplay." : `Replay stopped: ${receipt.failure_cause?.message || receipt.inputs?.stop_reason || "see details"}`;
          outcome = receipt.inputs?.stop_reason === "script_end" ? "completed" : "stopped";
          if (receipt.warnings?.length) {
            message += ` ${receipt.warnings.length} warning(s); open Show details.`;
            current.log += "\n" + receipt.warnings.join("\n");
          }
          const metadataFile = path.join(current.plan.directory, "session.json");
          const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
          metadata.lastVideo = lastVideo ? path.relative(current.plan.directory, lastVideo) : null;
          fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
        }
      } else message = "No physical recording was saved. Start again when the game is ready.";
    } catch (error) { message += ` ${error.message}`; }
    job = null;
    state(message, { finished: true, outcome, canWatch: !!lastVideo && fs.existsSync(lastVideo), details: current.log.slice(-14000) });
    if (closing) ui.kill();
  };
  const begin = async request => {
    if (job) throw new Error("Finish the current session first");
    const plan = planSession(root, request);
    const current = { id: crypto.randomUUID(), plan, request, abort: new AbortController(), log: "", cancelled: false };
    job = current;
    state(request.video ? "Preparing video. First use may download FFmpeg (161 MB)." : "Getting ready…");
    try {
      if (request.video) current.ffmpeg = await videoTool.ensureVideoTool(videoCache, { signal: current.abort.signal, progress: percent => state(`Setting up video: ${percent}% downloaded. This is a one-time setup.`) });
      if (current.cancelled || job !== current) return;
      fs.mkdirSync(plan.directory, { recursive: true });
      const cursor = plan.script?.timeline.find(e => e.input.cursor)?.input.cursor;
      send({ type: "focus", id: current.id, pid: request.pid, exe: request.exe, width: cursor?.width || 0, height: cursor?.height || 0, normalized: cursor?.space === "client-normalized" });
    } catch (error) {
      if (job !== current) return;
      job = null; state(error.message, { finished: true, outcome: "error" });
    }
  };
  const commands = readline.createInterface({ input: ui.stdout });
  commands.on("line", line => {
    Promise.resolve().then(async () => {
      const message = JSON.parse(line);
      if (message.type === "ready") return state("Choose your running game. Pause it at the starting point before recording.");
      if (message.type === "start") return begin(message);
      if (message.type === "stop") return stop();
      if (message.type === "folder") return launchFile(root);
      if (message.type === "watch") return launchFile(sessionVideo(root, message.session));
      if (message.type === "import") {
        if (job) throw new Error("Finish the current session first");
        const script = scripts.loadScript(fs.readFileSync(message.file, "utf8"));
        const id = `session-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
        const directory = sessionPath(root, id); fs.mkdirSync(directory);
        fs.copyFileSync(message.file, path.join(directory, "input.kbmscript.json"));
        fs.writeFileSync(path.join(directory, "session.json"), JSON.stringify({ game: script.game?.exe, title: script.source === "recorded" ? script.game?.exe : `${script.game?.exe || "Game"} (${script.source})`, seconds: script.duration_ms / 1000, events: script.timeline.length, created: new Date().toLocaleString(), stop: "imported" }));
        return state("Session imported. Restore its starting point, then select it to replay.");
      }
      if (message.type === "focused") {
        const current = job;
        if (!current || current.id !== message.id || current.child || current.cancelled) return;
        if (!message.ok) { job = null; return state(message.error || "Bring the game to the foreground and try again.", { finished: true, outcome: "error" }); }
        const child = fork(__filename, ["--session", ...current.plan.args], { silent: true, windowsHide: true, env: { ...process.env, ...(current.ffmpeg ? { RIG_FFMPEG: current.ffmpeg } : {}), RIG_RUNS_DIR: path.join(current.plan.directory, "replays") } });
        current.child = child;
        const receive = bytes => { current.log += bytes.toString(); send({ type: "progress", text: bytes.toString() }); };
        child.stdout.on("data", receive); child.stderr.on("data", receive);
        child.on("error", error => { current.log += error.message; complete(current, 1); });
        child.on("exit", code => complete(current, code));
      }
    }).catch(error => state(error.message));
  });
  ui.stderr.on("data", bytes => { uiError += bytes.toString(); console.error(bytes.toString()); });
  ui.stdin.on("error", () => {});
  ui.on("error", error => { console.error(error.message); stop(); });
  ui.on("exit", () => { closing = true; stop(); });
  process.once("SIGINT", () => { closing = true; stop(); if (!job) ui.kill(); });
  await new Promise((resolve, reject) => ui.once("close", code => code !== 0 && code !== null ? reject(new Error(uiError || "The control panel stopped unexpectedly")) : resolve()));
}

// Keep cancellation on the existing CLI path so the native helper releases held
// input and ffmpeg finalizes its file, including when the parent disappears.
async function sessionChild(argv) {
  let stopping = false;
  process.on("message", message => { if (message?.type === "stop") stopping = true; });
  process.on("disconnect", () => { stopping = true; });
  const timer = setInterval(() => { if (stopping && process.listenerCount("SIGINT")) process.emit("SIGINT"); }, 50);
  try { await require("./cli").main(argv); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { clearInterval(timer); if (process.connected) process.disconnect(); }
}
function showError(message) {
  if (process.platform !== "win32") return;
  spawnSync("powershell.exe", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:RIG_DESKTOP_ERROR,'Qaping Replay') | Out-Null"], { windowsHide: true, env: { ...process.env, RIG_DESKTOP_ERROR: message } });
}
if (require.main === module && process.argv[2] === "--session") sessionChild(process.argv.slice(3));
module.exports = { start, planSession, sessionPath, sessionList, sessionVideo, compileDesktop, showError };
