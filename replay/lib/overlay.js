// lib/overlay.js — burn the pad's input trace into a run's recording.
//
// The overlay is drawn FROM inputs.jsonl (+ inputs-timing.jsonl when present),
// the same files the receipt points at — not from a live widget. That keeps the
// demo honest: what the viewer sees bottom-right is the recorded input stream,
// resynced to the video, not a re-enactment. Everything here is dependency-free
// (hand-rolled PNG encoder over node:zlib, per-pixel rasterizer) because the rig
// deliberately ships no node_modules beyond itself.
//
// Sync model, in video seconds:
//   capture_start = capture_stop_run_ms - video_duration*1000
// where capture_stop is the label event cmdPlay stamps right before asking
// ffmpeg to finish (old receipts fall back to duration_ms — the anchor is then
// loose by ffmpeg's flush time, correctable with --offset-ms). Each input lands
// at its measured at_ms when inputs-timing.jsonl exists (closed-loop scripts
// pause the clock at wait_log barriers, so script t_ms alone drifts); otherwise
// at input_start + t_ms.
"use strict";

const zlib = require("zlib");
const { serializePad, normalizePad } = require("./padscript");

// ── PNG (RGBA8, one IDAT, filter 0) ──────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(canvas) {
  const { w, h, data } = canvas;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── rasterizer (src-over blend, 1px edge antialias) ──────────────────────────

function makeCanvas(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) };
}

function blendPx(c, x, y, [r, g, b, a], cov = 1) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const sa = (a / 255) * cov;
  if (sa <= 0) return;
  const i = (y * c.w + x) * 4;
  const d = c.data;
  const da = d[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  d[i] = Math.round((r * sa + d[i] * da * (1 - sa)) / oa);
  d[i + 1] = Math.round((g * sa + d[i + 1] * da * (1 - sa)) / oa);
  d[i + 2] = Math.round((b * sa + d[i + 2] * da * (1 - sa)) / oa);
  d[i + 3] = Math.round(oa * 255);
}

function fillRoundRect(c, x0, y0, x1, y1, rad, rgba) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
      const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
      const dist = Math.hypot(x - cx, y - cy);
      const cov = Math.min(1, Math.max(0, rad - dist + 0.5));
      if (cov > 0) blendPx(c, x, y, rgba, cov);
    }
  }
}

function fillRect(c, x0, y0, x1, y1, rgba) {
  for (let y = Math.round(y0); y < Math.round(y1); y++)
    for (let x = Math.round(x0); x < Math.round(x1); x++) blendPx(c, x, y, rgba);
}

function fillCircle(c, cx, cy, r, rgba) {
  for (let y = Math.floor(cy - r) - 1; y <= Math.ceil(cy + r) + 1; y++) {
    for (let x = Math.floor(cx - r) - 1; x <= Math.ceil(cx + r) + 1; x++) {
      const cov = Math.min(1, Math.max(0, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (cov > 0) blendPx(c, x, y, rgba, cov);
    }
  }
}

function strokeCircle(c, cx, cy, r, thick, rgba) {
  const half = thick / 2;
  for (let y = Math.floor(cy - r - half) - 1; y <= Math.ceil(cy + r + half) + 1; y++) {
    for (let x = Math.floor(cx - r - half) - 1; x <= Math.ceil(cx + r + half) + 1; x++) {
      const cov = Math.min(1, Math.max(0, half - Math.abs(Math.hypot(x - cx, y - cy) - r) + 0.5));
      if (cov > 0) blendPx(c, x, y, rgba, cov);
    }
  }
}

// ── the pad ──────────────────────────────────────────────────────────────────

const PAD_W = 380;
const PAD_H = 210;
const PANEL = [13, 13, 17, 208];
const OUTLINE = [255, 255, 255, 52];
const BASE = [255, 255, 255, 36];
const ACTIVE = [255, 255, 255, 235];
const FACE = {
  A: [63, 191, 95, 255],
  B: [217, 83, 79, 255],
  X: [79, 143, 217, 255],
  Y: [217, 195, 79, 255],
};
const STICK_TRAVEL_L = 24;
const STICK_TRAVEL_R = 18;

function dim([r, g, b], a) { return [r, g, b, a]; }

function drawStick(c, cx, cy, r, x, yAxis, pressed, travel, dotR) {
  strokeCircle(c, cx, cy, r, 3, OUTLINE);
  const dx = cx + x * travel;
  const dy = cy - yAxis * travel; // +y on the pad is forward → up on screen
  const moved = Math.abs(x) > 0.02 || Math.abs(yAxis) > 0.02;
  fillCircle(c, dx, dy, dotR, moved || pressed ? ACTIVE : BASE);
  if (pressed) strokeCircle(c, dx, dy, dotR + 3, 2, ACTIVE);
}

function drawTrigger(c, x0, y0, x1, y1, v) {
  fillRoundRect(c, x0, y0, x1, y1, 6, BASE);
  if (v > 0.01) {
    const h = (y1 - y0 - 6) * v;
    fillRect(c, x0 + 3, y1 - 3 - h, x1 - 3, y1 - 3, ACTIVE);
  }
}

// One full pad state → a fresh RGBA canvas. Pure: same state, same pixels.
function drawPad(state) {
  const s = normalizePad(state);
  const on = new Set(s.buttons);
  const c = makeCanvas(PAD_W, PAD_H);
  fillRoundRect(c, 0, 0, PAD_W - 1, PAD_H - 1, 18, PANEL);

  // bumpers
  fillRoundRect(c, 64, 14, 148, 30, 8, on.has("LB") ? ACTIVE : BASE);
  fillRoundRect(c, 232, 14, 316, 30, 8, on.has("RB") ? ACTIVE : BASE);
  // triggers (analog fill, bottom-up)
  drawTrigger(c, 22, 42, 44, 122, s.lt);
  drawTrigger(c, 336, 42, 358, 122, s.rt);
  // sticks
  drawStick(c, 104, 84, 38, s.lx, s.ly, on.has("LS"), STICK_TRAVEL_L, 12);
  drawStick(c, 228, 152, 30, s.rx, s.ry, on.has("RS"), STICK_TRAVEL_R, 10);
  // face diamond
  fillCircle(c, 276, 111, 13, on.has("A") ? FACE.A : dim(FACE.A, 70));
  fillCircle(c, 303, 84, 13, on.has("B") ? FACE.B : dim(FACE.B, 70));
  fillCircle(c, 249, 84, 13, on.has("X") ? FACE.X : dim(FACE.X, 70));
  fillCircle(c, 276, 57, 13, on.has("Y") ? FACE.Y : dim(FACE.Y, 70));
  for (const [btn, cx, cy] of [["A", 276, 111], ["B", 303, 84], ["X", 249, 84], ["Y", 276, 57]]) {
    if (on.has(btn)) strokeCircle(c, cx, cy, 16, 2, ACTIVE);
  }
  // back/start
  fillRoundRect(c, 166, 78, 186, 90, 5, on.has("BACK") ? ACTIVE : BASE);
  fillRoundRect(c, 194, 78, 214, 90, 5, on.has("START") ? ACTIVE : BASE);
  // d-pad cross + pressed wedges
  fillRoundRect(c, 128, 144, 176, 160, 4, BASE);
  fillRoundRect(c, 144, 128, 160, 176, 4, BASE);
  if (on.has("DPAD_UP")) fillRect(c, 145, 129, 159, 146, ACTIVE);
  if (on.has("DPAD_DOWN")) fillRect(c, 145, 158, 159, 175, ACTIVE);
  if (on.has("DPAD_LEFT")) fillRect(c, 129, 145, 146, 159, ACTIVE);
  if (on.has("DPAD_RIGHT")) fillRect(c, 158, 145, 175, 159, ACTIVE);
  return c;
}

// ── sync + frame planning ────────────────────────────────────────────────────

// Maps each input event to video seconds. timingBySeq (from inputs-timing.jsonl)
// carries measured run-time per event; without it, script time after input_start
// stands in — fine for straight-line scripts, drifty across wait_log barriers.
function makeTimebase({ receipt, videoDurationS, timingBySeq, offsetMs = 0 }) {
  const label = (name) => {
    const e = (receipt.events || []).find((ev) => ev.kind === "label" && ev.detail === name);
    return e ? e.t_ms : null;
  };
  const captureStopMs = label("capture_stop") ?? receipt.duration_ms;
  const captureStartMs = captureStopMs - videoDurationS * 1000;
  const inputStartMs = label("input_start") ?? 0;
  const anchor = label("capture_stop") !== null ? "capture_stop" : "duration_ms";
  return {
    anchor,
    usingTiming: !!(timingBySeq && timingBySeq.size),
    toVideoS(ev) {
      const runMs = timingBySeq && timingBySeq.has(ev.seq)
        ? timingBySeq.get(ev.seq)
        : inputStartMs + ev.t_ms;
      return (runMs - captureStartMs + offsetMs) / 1000;
    },
  };
}

// Sample the pad state at a fixed overlay fps across the whole video, then
// collapse runs of identical states: few unique PNGs, one ffconcat entry per
// run. Returns { segments: [{key, frames}], states: Map key→pad }.
function planFrames({ inputs, toVideoS, videoDurationS, fps }) {
  const timed = inputs
    .map((ev) => ({ atS: toVideoS(ev), pad: ev.pad }))
    .sort((a, b) => a.atS - b.atS);
  const frameCount = Math.max(1, Math.ceil(videoDurationS * fps));
  const states = new Map();
  const segments = [];
  let cursor = 0;
  let current = normalizePad({});
  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    while (cursor < timed.length && timed[cursor].atS <= t) {
      current = normalizePad(timed[cursor].pad);
      cursor++;
    }
    const key = serializePad(current);
    if (!states.has(key)) states.set(key, current);
    const last = segments[segments.length - 1];
    if (last && last.key === key) last.frames++;
    else segments.push({ key, frames: 1 });
  }
  return { segments, states, frameCount };
}

// ffconcat listing for the planned segments. The concat demuxer ignores the
// final duration, so the last file line is repeated to pin it.
function ffconcatText(segments, fileForKey, fps) {
  const lines = ["ffconcat version 1.0"];
  for (const seg of segments) {
    lines.push(`file '${fileForKey(seg.key)}'`);
    lines.push(`duration ${(seg.frames / fps).toFixed(6)}`);
  }
  if (segments.length) lines.push(`file '${fileForKey(segments[segments.length - 1].key)}'`);
  return lines.join("\n") + "\n";
}

const CORNERS = {
  br: "x=main_w-overlay_w-24:y=main_h-overlay_h-24",
  bl: "x=24:y=main_h-overlay_h-24",
  tr: "x=main_w-overlay_w-24:y=24",
  tl: "x=24:y=24",
};

function composeArgs({ video, concatFile, output, corner = "br" }) {
  const pos = CORNERS[corner] || CORNERS.br;
  return [
    "-hide_banner", "-y",
    "-i", video,
    "-f", "concat", "-safe", "0", "-i", concatFile,
    "-filter_complex", `[1:v]format=rgba,setpts=PTS-STARTPTS[ov];[0:v][ov]overlay=${pos}:eof_action=pass[out]`,
    "-map", "[out]", "-map", "0:a?", "-c:a", "copy",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    output,
  ];
}

// "Duration: 00:03:01.42" from `ffmpeg -i` stderr (no ffprobe dependency).
function parseFfmpegDuration(stderrText) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderrText || "");
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

module.exports = {
  encodePng, drawPad, makeTimebase, planFrames, ffconcatText, composeArgs,
  parseFfmpegDuration, makeCanvas, PAD_W, PAD_H, CORNERS,
};
