"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const ps = require("../lib/padscript");
const { playEvents } = require("../lib/scheduler");
const receiptLib = require("../lib/receipt");
const report = require("../lib/report");
const overlay = require("../lib/overlay");
const { makeLogWaiter, waitForLogLine, parseArgs } = require("../lib/cli");
const kbm = require("../lib/kbmscript");
const desktop = require("../lib/keyboard-mouse");
const panel = require("../lib/desktop");
const videoTool = require("../lib/video-tool");

test("desktop replay refuses missing reset, wrong game and unsafe session paths before input", t => {
  const root = temp(t), id = "session-example";
  const dir = path.join(root, id); fs.mkdirSync(dir);
  const script = { schema: kbm.SCHEMA, source: "recorded", duration_ms: 100,
    game: { exe: "game.exe" }, timeline: [{ t_ms: 0, input: { kind: "move", dx: 1, dy: 0 } }] };
  fs.writeFileSync(path.join(dir, "input.kbmscript.json"), JSON.stringify(script));
  const request = { mode: "replay", pid: 1234, exe: path.resolve(root, "game.exe"), session: id, video: true };
  assert.throws(() => panel.planSession(root, request), /Restore the starting/);
  assert.throws(() => panel.planSession(root, { ...request, restored: true, exe: path.resolve(root, "other.exe") }), /Choose that game/);
  assert.throws(() => panel.sessionPath(root, "../session-example"), /Choose a saved/);
  assert.throws(() => panel.planSession(root, { ...request, restored: true, pid: 0 }), /Refresh/);
  const plan = panel.planSession(root, { ...request, restored: true });
  assert.deepEqual(plan.script, script);
  assert.ok(plan.args.includes("--no-telemetry"));
  assert.equal(plan.args.at(-1), "5");
  const recording = panel.planSession(root, { ...request, mode: "record", video: false });
  assert.ok(!recording.args.includes("--video"));
  assert.notEqual(recording.directory, dir, "a new recording never replaces a saved take");
});

test("desktop session library opens only its own video and rejects linked folders", t => {
  const root = temp(t), id = "session-example", dir = path.join(root, id); fs.mkdirSync(dir);
  const metadata = path.join(dir, "session.json");
  fs.writeFileSync(path.join(dir, "input.kbmscript.json"), "{}");
  fs.writeFileSync(path.join(dir, "human.mp4"), "fixture");
  fs.writeFileSync(metadata, JSON.stringify({ id: "../override", game: "game.exe", seconds: 12, created: "today", lastVideo: "human.mp4" }));
  assert.equal(panel.sessionList(root)[0].id, id);
  assert.equal(panel.sessionVideo(root, id), path.join(dir, "human.mp4"));
  fs.writeFileSync(metadata, JSON.stringify({ lastVideo: "../private.mp4" }));
  assert.equal(panel.sessionVideo(root, id), null);
  fs.symlinkSync(dir, path.join(root, "session-linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => panel.sessionPath(root, "session-linked"), /cannot be links/);
});

test("video setup verifies the pinned bytes and removes incomplete downloads", async t => {
  const root = temp(t), crypto = require("node:crypto"), bytes = Buffer.from("a verified archive fixture");
  const pin = { url: "https://example.invalid/archive.zip", bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  const fetcher = async () => ({ ok: true, body: [bytes.subarray(0, 5), bytes.subarray(5)] });
  const good = path.join(root, "good.zip");
  await videoTool.downloadVerified(good, { pin, fetcher });
  assert.deepEqual(fs.readFileSync(good), bytes);
  for (const [name, changed] of [["hash", { ...pin, sha256: "0".repeat(64) }], ["length", { ...pin, bytes: 1 }]]) {
    const file = path.join(root, name + ".zip");
    await assert.rejects(videoTool.downloadVerified(file, { pin: changed, fetcher }), /verification|expected size/);
    assert.equal(fs.existsSync(file), false);
  }
  const abort = new AbortController(); abort.abort();
  const cancelled = path.join(root, "cancelled.zip");
  await assert.rejects(videoTool.downloadVerified(cancelled, { pin, fetcher, signal: abort.signal }));
  assert.equal(fs.existsSync(cancelled), false);
});

test("Windows desktop builds and enumerates windows without injecting input", { skip: process.platform !== "win32" }, t => {
  const exe = panel.compileDesktop(temp(t));
  const result = spawnSync(exe, ["--probe"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(result.stdout);
  assert.equal(probe.desktop, true);
  assert.ok(Number.isInteger(probe.games));
  const bootstrap = path.resolve(__dirname, "../scripts/start-desktop.ps1");
  const parse = spawnSync("powershell.exe", ["-NoProfile", "-Command", "$tokens=$null; $errors=$null; $null=[Management.Automation.Language.Parser]::ParseFile($env:RIG_BOOTSTRAP_SOURCE,[ref]$tokens,[ref]$errors); if($errors.Count){$errors | Out-String | Write-Error; exit 1}"], { encoding: "utf8", windowsHide: true, env: { ...process.env, RIG_BOOTSTRAP_SOURCE: bootstrap }, timeout: 15000 });
  assert.equal(parse.status, 0, parse.stderr);
});

test("keyboard/mouse keeps relative impulses, scan codes, ordering and neutral tail", async () => {
  const script = kbm.loadScript({ schema: kbm.SCHEMA, source: "recorded", duration_ms: 1000, timeline: [
    { t_ms: 120, input: { kind: "key", scan: 17, extended: false, down: true } },
    { t_ms: 120, input: { kind: "move", dx: 3, dy: -2 } },
    { t_ms: 121, input: { kind: "move", dx: 3, dy: -2 } },
    { t_ms: 600, input: { kind: "key", scan: 17, extended: false, down: false } },
  ] });
  const events = kbm.changeEvents(script);
  assert.equal(events.length, 4, "identical movement impulses must both replay");
  assert.equal(events[0].t_ms, 120, "preserve neutral lead-in");
  assert.equal(script.duration_ms, 1000, "preserve neutral tail independently of last input");
  assert.deepEqual(events, kbm.changeEvents(JSON.parse(JSON.stringify(script))));
  assert.deepEqual(events.map(e => e.seq), [0, 1, 2, 3]);
});

test("keyboard/mouse rejects malformed or dangerous trace interpretation", () => {
  const base = { schema: kbm.SCHEMA, source: "authored", duration_ms: 1000 };
  for (const input of [
    { kind: "move", dx: NaN, dy: 0 }, { kind: "move", dx: 2.1, dy: 0 },
    { kind: "absolute", x: 1, y: 2 }, { kind: "wheel", delta: 120, axis: "bad" },
    { kind: "key", scan: 17, extended: false, down: false },
    { kind: "key", scan: 0x42, extended: false, down: true },
    { kind: "key", scan: 0x43, extended: false, down: true },
    { kind: "key", scan: 0x5b, extended: true, down: true },
    { kind: "key", scan: 17, extended: 0, down: true },
    { kind: "button", button: "unknown", down: true },
  ]) assert.throws(() => kbm.loadScript({ ...base, timeline: [{ t_ms: 0, input }] }), /invalid keyboard\/mouse/);
  for (const time of [-1, Infinity, 1001]) assert.equal(kbm.validateScript({ ...base, timeline: [{ t_ms: time, input: { kind: "move", dx: 1, dy: 0 } }] }).ok, false);
  assert.equal(kbm.validateScript({ ...base, duration_ms: 0, timeline: [] }).ok, false);
  assert.throws(() => kbm.loadScript({ ...base, timeline: [{ t_ms: 0, pad: {} }] }), /missing input/);
});

test("menu cursor positions survive serialization and reject out-of-window clicks", () => {
  const base = { schema: kbm.SCHEMA, source: "recorded", duration_ms: 1000 };
  const cursor = { x: 801, y: 340, width: 1280, height: 720 };
  const inputs = [
    { kind: "move", dx: 12, dy: -6, cursor },
    { kind: "button", button: "left", down: true, cursor },
    { kind: "button", button: "left", down: false, cursor: null },
    { kind: "move", dx: -3, dy: 4, cursor: null },
    { kind: "wheel", axis: "vertical", delta: 120, cursor },
  ];
  const script = kbm.loadScript({ ...base, timeline: inputs.map((input, i) => ({ t_ms: i * 100, input })) });
  assert.deepEqual(kbm.changeEvents(JSON.parse(JSON.stringify(script))).map(e => e.input), inputs);
  for (const bad of [false, "cursor", {}, { ...cursor, x: -1 }, { ...cursor, x: 1280 },
    { ...cursor, y: 720 }, { ...cursor, width: 0 }, { ...cursor, height: Infinity }, { ...cursor, x: 1.2 }]) {
    assert.throws(() => kbm.loadScript({ ...base, timeline: [{ t_ms: 0,
      input: { kind: "button", button: "left", down: true, cursor: bad } }] }), /invalid client cursor/);
  }
});

test("native cursor encoding preserves buttons and maps moved windows without acceleration", { skip: process.platform !== "win32" }, t => {
  const file = path.join(temp(t), "cursor-encoding.ps1");
  // Exercise the actual INPUT encoder, never send input or change system settings.
  fs.writeFileSync(file, `param([string]$Source)
$ErrorActionPreference='Stop'
Add-Type -Path $Source -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
$serializer=New-Object System.Web.Script.Serialization.JavaScriptSerializer
$encode=[QapingDesktopInput].GetMethod('Encode',[Reflection.BindingFlags]'NonPublic,Static')
$position=[QapingDesktopInput].GetMethod('EncodeCursor',[Reflection.BindingFlags]'NonPublic,Static')
$eventData=$serializer.DeserializeObject('{"kind":"button","button":"left","down":true}')
$cursorData=$serializer.DeserializeObject('{"x":801,"y":340,"width":1280,"height":720}')
$inputData=$encode.Invoke($null,@($eventData))
$client=New-Object Drawing.Rectangle(-1800,100,1280,720)
$desktop=New-Object Drawing.Rectangle(-1920,0,4480,1440)
$encoded=$position.Invoke($null,@($inputData,$cursorData,$client,$desktop))
$rejected=$false
$wrongClient=New-Object Drawing.Rectangle(0,0,1920,1080)
try { $null=$position.Invoke($null,@($inputData,$cursorData,$wrongClient,$desktop)) } catch { $rejected=$_.Exception.ToString().Contains('client size differs') }
$raw=$encode.Invoke($null,@($serializer.DeserializeObject('{"kind":"move","dx":12,"dy":-6}')))
$capture=[QapingDesktopInput].GetMethod('CursorPosition',[Reflection.BindingFlags]'NonPublic,Static')
$map=[QapingDesktopInput].GetMethod('CursorPoint',[Reflection.BindingFlags]'NonPublic,Static')
$recordedClient=New-Object Drawing.Rectangle(100,50,1280,720)
$hiddenCamera=$capture.Invoke($null,@($false,420,230,$recordedClient,$false))
$pointer=$capture.Invoke($null,@($false,420,230,$recordedClient,$true))
$resizedClient=New-Object Drawing.Rectangle(200,150,1920,1080)
$mapped=$map.Invoke($null,@($pointer,$resizedClient))
$aspectRejected=$false
$wrongAspect=New-Object Drawing.Rectangle(0,0,1024,768)
try { $null=$map.Invoke($null,@($pointer,$wrongAspect)) } catch { $aspectRejected=$_.Exception.ToString().Contains('aspect ratio differs') }
$edge=$capture.Invoke($null,@($false,1379,769,$recordedClient,$true))
$mappedEdge=$map.Invoke($null,@($edge,$resizedClient))
@{dx=$encoded.data.mouse.dx;dy=$encoded.data.mouse.dy;flags=$encoded.data.mouse.flags;rejected=$rejected;rawDx=$raw.data.mouse.dx;rawDy=$raw.data.mouse.dy;rawFlags=$raw.data.mouse.flags;hiddenCameraNull=($null -eq $hiddenCamera);pointer=$pointer;mappedX=$mapped.X;mappedY=$mapped.Y;edgeX=$mappedEdge.X;edgeY=$mappedEdge.Y;aspectRejected=$aspectRejected}|ConvertTo-Json -Compress
`);
  const run = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file,
    "-Source", path.resolve(__dirname, "../shims/keyboard-mouse.cs")], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  const value = JSON.parse(run.stdout);
  assert.equal(value.dx, Math.floor((921.5 * 65536) / 4480));
  assert.equal(value.dy, Math.floor((440.5 * 65536) / 1440));
  assert.equal(value.flags, 0xe003, "absolute move and left down are one native event");
  assert.equal(value.rejected, true, "never guess coordinates after a resize");
  assert.deepEqual([value.rawDx, value.rawDy, value.rawFlags], [12, -6, 0x2001], "camera deltas remain raw");
  assert.equal(value.hiddenCameraNull, true);
  assert.equal(value.pointer.space, "client-normalized", "explicit pointer mode records even a hidden Windows cursor");
  assert.deepEqual([value.pointer.x, value.pointer.y], [320, 180]);
  assert.deepEqual([value.mappedX, value.mappedY], [680, 420], "point maps into a moved and proportionally resized window");
  assert.deepEqual([value.edgeX, value.edgeY], [2119, 1229], "last pixel stays inside the resized client");
  assert.equal(value.aspectRejected, true, "a changed game viewport must not silently alter targeting");
});

test("normalized pointer samples retain recorded evidence and reject ambiguous coordinates", () => {
  const cursor = { space: "client-normalized", x: 320, y: 180, width: 1280, height: 720, u: 320.5 / 1280, v: 180.5 / 720 };
  const trace = c => ({ schema: kbm.SCHEMA, source: "recorded", duration_ms: 100, timeline: [{ t_ms: 0, input: { kind: "move", dx: 3, dy: 4, cursor: c } }] });
  assert.deepEqual(kbm.loadScript(JSON.stringify(trace(cursor))), trace(cursor));
  for (const invalid of [{...cursor,u:0.9},{...cursor,v:NaN},{...cursor,u:undefined},{...cursor,space:"world"}]) assert.throws(() => kbm.loadScript(trace(invalid)), /normalized cursor|cursor space/);
  assert.equal(desktop.options({"mouse-mode":"pointer"}).mouseMode,"pointer");
  assert.throws(() => desktop.options({"mouse-mode":"guess"}), /mouse-mode/);
});

test("keyboard/mouse accepts extended keys, held tails, buttons and both scroll axes", () => {
  const inputs = [
    { kind: "key", scan: 0x1d, extended: true, down: true },
    { kind: "key", scan: 0x1d, extended: true, down: false },
    { kind: "button", button: "right", down: true },
    { kind: "button", button: "right", down: false },
    { kind: "wheel", delta: -120, axis: "vertical" },
    { kind: "wheel", delta: 120, axis: "horizontal" },
    { kind: "key", scan: 17, extended: false, down: true },
  ];
  assert.equal(kbm.validateScript({ schema: kbm.SCHEMA, source: "recorded", duration_ms: 1000,
    timeline: inputs.map((input, i) => ({ t_ms: i * 100, input })) }).ok, true);
  assert.throws(() => desktop.options({ pid: "12x" }), /pid/);
  assert.throws(() => desktop.options({ "max-minutes": -2 }), /max-minutes/);
  assert.throws(() => desktop.options({ "start-delay": "no" }), /start-delay/);
  assert.throws(() => desktop.options({ "start-delay": -0.001 }), /start-delay/);
  assert.equal(desktop.options({ pid: "123" }).startDelayMs, -1);
  assert.equal(desktop.options({}).countdownMs, 5000);
  assert.equal(desktop.options({}).showStatus, true);
  assert.equal(desktop.options({ countdown: 0, "no-status": true }).showStatus, false);
  for (const countdown of [-1, 31, "no", 0.0001]) assert.throws(() => desktop.options({ countdown }), /countdown/);
  assert.equal(desktop.sameExe(path.resolve("game.exe"), path.resolve("other.exe")), false);
});

test("keyboard/mouse helper acknowledges native sends and stops gracefully", async (t) => {
  const dir = temp(t), stub = path.join(dir, "desktop-stub.cjs");
  fs.writeFileSync(stub, `const rl=require('node:readline').createInterface({input:process.stdin});
console.log(JSON.stringify({event:'ready',exe:'game.exe'}));
rl.on('line',line=>{ const m=JSON.parse(line); if(m.op==='play'){
console.log(JSON.stringify({event:'started',utc_ms:1000}));
console.log(JSON.stringify({event:'sent',seq:0,at_ms:123}));
} else { console.log(JSON.stringify({event:'stopped',reason:'operator',started:true,duration_ms:500})); process.exit(0); }});`);
  const helper = new desktop.DesktopInput(1, "replay", { command: process.execPath, argv: [stub] });
  const messages = [];
  helper.on("message", m => messages.push(m));
  await helper.ready;
  helper.write({ op: "play" });
  await helper.close();
  assert.equal((await helper.done).reason, "operator");
  assert.equal(messages.find(m => m.event === "sent").at_ms, 123);
});

test("keyboard/mouse helper startup failure is surfaced without hanging", async () => {
  const helper = new desktop.DesktopInput(1, "replay", { command: process.execPath, argv: ["-e", "process.exit(3)"] });
  await assert.rejects(helper.ready, /closed/);
  assert.equal((await helper.done).reason, "input_error");
  await helper.close();
});

test("native keyboard/mouse decodes a timeline and refuses an unfocused target", { skip: process.platform !== "win32" }, async () => {
  const helper = new desktop.DesktopInput(process.pid, "replay", { startDelayMs: 0, maxSeconds: 1 });
  const messages = [];
  helper.on("message", m => messages.push(m));
  await helper.ready;
  helper.write({ op: "play", duration_ms: 100, timeline: [{ seq: 0, t_ms: 0, input: { kind: "move", dx: 1, dy: 0 } }] });
  const result = await helper.done;
  assert.equal(helper.failure, null);
  assert.equal(result.reason, "start_not_ready");
  assert.equal(result.sent, 0);
  assert.ok(messages.some(m => m.event === "armed"), "native timeline deserialization completed");
  await helper.close();
});

test("native countdown waits for Start and checks focus when it finishes", { skip: process.platform !== "win32" }, async () => {
  const helper = new desktop.DesktopInput(process.pid, "record", { countdownMs: 150, maxSeconds: 1 });
  const messages = [];
  helper.on("message", m => messages.push(m));
  try {
    await helper.ready;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(messages.some(m => m.event === "countdown" || m.event === "started"), false);
    helper.write({ op: "start" });
    const result = await helper.done;
    assert.equal(helper.failure, null);
    assert.deepEqual(messages.filter(m => m.event === "countdown").map(m => m.seconds), [1, 0]);
    assert.equal(result.reason, "start_not_ready");
    assert.equal(result.started, false);
    assert.equal(result.duration_ms, 0);
  } finally { await helper.close(); }
});

test("native countdown can be cancelled before any recording begins", { skip: process.platform !== "win32" }, async () => {
  const helper = new desktop.DesktopInput(process.pid, "record", { countdownMs: 5000, maxSeconds: 1 });
  const messages = [];
  helper.on("message", m => { messages.push(m); if (m.event === "countdown") helper.stop(); });
  try {
    await helper.ready;
    helper.write({ op: "start" });
    const result = await helper.done;
    assert.equal(helper.failure, null);
    assert.equal(result.reason, "operator");
    assert.equal(result.started, false);
    assert.equal(result.duration_ms, 0);
    assert.equal(messages.some(m => m.event === "started" || Number.isFinite(m.t_ms)), false);
  } finally { await helper.close(); }
});

test("video waits for Start and acknowledges only its first encoded frame", async () => {
  const helper = new EventEmitter(), writes = [];
  helper.child = { stdin: { destroyed: false } };
  helper.write = m => writes.push(m);
  let firstFrame, closed, calls = 0;
  const video = { ready: new Promise(resolve => { firstFrame = resolve; }),
    closed: new Promise(resolve => { closed = resolve; }), failed: null };
  desktop.captureOnStart(helper, () => { calls++; return video; });
  helper.emit("message", { event: "ready" });
  assert.equal(calls, 0, "idle waiting must not capture the desktop");
  helper.emit("message", { event: "prepare_capture" });
  helper.emit("message", { event: "prepare_capture" });
  assert.equal(calls, 1);
  assert.deepEqual(writes, [], "process spawn does not prove video is ready");
  firstFrame(); await Promise.resolve();
  assert.deepEqual(writes, [{ op: "capture_ready" }]);
  video.failed = "encoder stopped"; closed(); await Promise.resolve();
  assert.equal(writes.at(-1).op, "capture_failed");
});

test("capture startup failure stops the input helper", async () => {
  for (const asynchronous of [false, true]) {
    const helper = new EventEmitter(), writes = [];
    helper.child = { stdin: { destroyed: false } }; helper.write = m => writes.push(m);
    const session = desktop.captureOnStart(helper, () => {
      if (!asynchronous) throw new Error("output exists");
      return { ready: Promise.reject(new Error("no encoded frame")), closed: new Promise(() => {}) };
    });
    helper.emit("message", { event: "prepare_capture" });
    await Promise.resolve();
    assert.deepEqual(writes, [{ op: "capture_failed" }]);
    assert.match(session.failure, /output exists|no encoded frame/);
  }
});

test("cancelling video preparation cannot start a late countdown", async () => {
  const helper = new EventEmitter(), writes = [];
  helper.child = { stdin: { destroyed: false } }; helper.write = m => writes.push(m);
  let firstFrame;
  desktop.captureOnStart(helper, () => ({ ready: new Promise(resolve => { firstFrame = resolve; }), closed: new Promise(() => {}) }));
  helper.emit("message", { event: "prepare_capture" });
  helper.result = { reason: "operator" };
  firstFrame(); await Promise.resolve();
  assert.deepEqual(writes, []);
});

test("native Start waits for video before beginning the full countdown", { skip: process.platform !== "win32" }, async () => {
  const helper = new desktop.DesktopInput(process.pid, "record", { countdownMs: 150, maxSeconds: 1, waitForCapture: true });
  const messages = []; helper.on("message", m => messages.push(m));
  try {
    await helper.ready;
    const requested = new Promise(resolve => helper.on("message", m => { if (m.event === "prepare_capture") resolve(); }));
    helper.write({ op: "start" }); await requested;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(messages.some(m => m.event === "countdown" || m.event === "started"), false);
    helper.write({ op: "capture_ready" });
    const result = await helper.done;
    assert.deepEqual(messages.filter(m => m.event === "countdown").map(m => m.seconds), [1, 0]);
    assert.equal(result.reason, "start_not_ready");
    assert.equal(result.started, false);
  } finally { await helper.close(); }
});

test("native video failure cancels preparation without recording input", { skip: process.platform !== "win32" }, async () => {
  const helper = new desktop.DesktopInput(process.pid, "record", { maxSeconds: 1, waitForCapture: true });
  const messages = [];
  helper.on("message", m => { messages.push(m); if (m.event === "prepare_capture") helper.write({ op: "capture_failed" }); });
  try {
    await helper.ready; helper.write({ op: "start" });
    const result = await helper.done;
    assert.equal(result.reason, "capture_error");
    assert.equal(result.started, false);
    assert.equal(messages.some(m => m.event === "countdown" || m.event === "started" || Number.isFinite(m.t_ms)), false);
  } finally { await helper.close(); }
});

test("native video preparation can be cancelled by the operator", { skip: process.platform !== "win32" }, async () => {
  const helper = new desktop.DesktopInput(process.pid, "record", { maxSeconds: 1, waitForCapture: true });
  helper.on("message", m => { if (m.event === "prepare_capture") helper.stop(); });
  try {
    await helper.ready; helper.write({ op: "start" });
    const result = await helper.done;
    assert.equal(result.reason, "operator");
    assert.equal(result.started, false);
    assert.equal(result.duration_ms, 0);
  } finally { await helper.close(); }
});

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qaping-rig-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a recorded session has stable events, including its held final state", () => {
  const script = ps.loadScript(JSON.stringify({ schema: ps.SCHEMA, source: "recorded", timeline: [
    { t_ms: 0, pad: { ly: 1 } },
    { t_ms: 200, pad: { ly: 1, buttons: ["A"] } },
    { t_ms: 400, pad: { ly: 1 } },
    { t_ms: 1400, pad: { ly: 1 } },
  ] }));
  const events = ps.changeEvents(script);
  assert.deepEqual(events, ps.changeEvents(JSON.parse(JSON.stringify(script))));
  assert.equal(ps.durationMs(script), 1400);
  assert.equal(events.at(-1).t_ms, 1400);
  assert.equal(events.at(-1).pad.ly, 1);
});

test("jump and trigger actions retain a held stick until neutral", () => {
  const events = ps.compileMoves([
    { op: "stick", stick: "L", x: 0, y: 1, ms: 100 },
    { op: "press", btn: "A", ms: 50 },
    { op: "trigger", trigger: "RT", v: 1, ms: 100 },
    { op: "neutral", ms: 100 },
  ]);
  assert.equal(events.find((event) => event.pad.buttons.includes("A")).pad.ly, 1);
  assert.equal(events.find((event) => event.pad.rt === 1).pad.ly, 1);
  assert.equal(events.at(-1).pad.ly, 0);
});

test("invalid axes and decreasing timestamps cannot become playable scripts", () => {
  for (const timeline of [
    [{ t_ms: 0, pad: { lx: 2 } }],
    [{ t_ms: 200, pad: {} }, { t_ms: 100, pad: {} }],
  ]) assert.throws(() => ps.loadScript(JSON.stringify({ schema: ps.SCHEMA, timeline })), /invalid padscript/);
});

test("a synchronization wait shifts playback without changing the input stream", async () => {
  let now = 0;
  const sent = [];
  await playEvents([
    { seq: 0, t_ms: 0, pad: { ly: 1 } },
    { t_ms: 100, wait_log: { match: "ready" } },
    { seq: 1, t_ms: 200, pad: {} },
  ], {
    now: () => now, spinMs: 0,
    doSleep: async (ms) => { now += ms; },
    waitLog: async () => { now += 500; },
    send: (event) => sent.push({ event, at: now }),
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].at, 700);
  assert.equal(sent[1].event.t_ms, 200);
});

test("repeated log barriers require a fresh matching occurrence", async (t) => {
  const file = path.join(temp(t), "game.log");
  fs.writeFileSync(file, "old ready\n");
  const wait = makeLogWaiter(file, () => false);
  fs.appendFileSync(file, "new ready\n");
  assert.equal(await wait("ready", 20), true);
  assert.equal(await wait("ready", 20), false);
  fs.appendFileSync(file, "another ready\n");
  assert.equal(await wait("ready", 20), true);
});

test("receipts round-trip unknown extensions without claiming a human review", (t) => {
  const dir = temp(t);
  const receipt = { ...receiptLib.createReceipt(), extension_from_caller: { value: 1 } };
  receiptLib.writeReceipt(dir, receipt);
  assert.deepEqual(receiptLib.readReceipt(dir), receipt);
  assert.equal(report.receiptToAnnotations(receipt).ping_id, null);
  assert.throws(() => receiptLib.writeReceipt(dir, { ...receipt, result: "fail" }), /failure_cause/);
});

test("startup cannot match an old session in an appended or replaced game log", async (t) => {
  const file = path.join(temp(t), "game.log");
  const old = "previous session ready\n";
  fs.writeFileSync(file, old);
  assert.equal(await waitForLogLine(file, "ready", 10, () => false, old), false);
  fs.appendFileSync(file, "new session ready\n");
  assert.equal(await waitForLogLine(file, "ready", 10, () => false, old), true);
  fs.writeFileSync(file, "ready\n");
  assert.equal(await waitForLogLine(file, "ready", 10, () => false, old), true);
});

test("the CLI reports actual receipt findings from any working directory", (t) => {
  const dir = temp(t);
  receiptLib.writeReceipt(dir, receiptLib.createReceipt({ warnings: ["Recording started late"] }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/rig.js"), "report", dir], {
    cwd: os.tmpdir(), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const annotations = JSON.parse(fs.readFileSync(path.join(dir, "annotations.json")));
  assert.equal(annotations.ping_id, null);
  assert.ok(annotations.findings.every((finding) => finding.author === "rig"));
  assert.match(result.stdout, /Recording started late/);
});

test("an unsupported command fails without a module stack trace", () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/rig.js"), "compare", "a", "b"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported command/);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|at .*\.js:\d+/);
});

test("CLI paths with spaces remain a single argument", () => {
  const args = parseArgs(["play", "D:/Steam Library/Game", "--game-log", "D:/Game Logs/session.log", "--no-telemetry"]);
  assert.equal(args._[1], "D:/Steam Library/Game");
  assert.equal(args["game-log"], "D:/Game Logs/session.log");
  assert.equal(args["no-telemetry"], true);
});

test("input overlay encodes a PNG from the supplied controller state", () => {
  const a = overlay.encodePng(overlay.drawPad({ buttons: ["A"], lx: 1 }));
  const b = overlay.encodePng(overlay.drawPad({}));
  assert.equal(a.subarray(1, 4).toString(), "PNG");
  assert.notDeepEqual(a, b);
});
