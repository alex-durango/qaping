// lib/padscript.js — the pingfusi-padscript/v1 format: validate, compile, iterate.
//
// A padscript is the versionable unit of "how the game was played": either authored
// `moves` (high-level primitives, compiled here) or an explicit `timeline` of sparse
// FULL-STATE keyframes. Semantics that keep replay deterministic:
//   - a timeline entry REPLACES the whole pad state; omitted fields mean neutral
//     (buttons released, axes 0). State holds until the next entry.
//   - `changeEvents()` is a pure function of the script — the same script always
//     yields byte-identical events, which is what inputs.jsonl records. Wall-clock
//     jitter lives in the receipt, never in the event stream.
"use strict";

const SCHEMA = "pingfusi-padscript/v1";

const BUTTONS = [
  "A", "B", "X", "Y", "LB", "RB", "BACK", "START", "LS", "RS",
  "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT",
];
const BUTTON_SET = new Set(BUTTONS);
const AXES = ["lx", "ly", "rx", "ry"]; // -1..1
const TRIGGERS = ["lt", "rt"]; // 0..1

const DEFAULT_RATE_HZ = 120;
const DEFAULT_PRESS_MS = 80;
const DEFAULT_COMBO_GAP_MS = 150;

// ── pad state ─────────────────────────────────────────────────────────────────

function neutralPad() {
  return { buttons: [], lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (v) => Math.round(v * 1000) / 1000;

// Full canonical state from a sparse pad object. Unknown buttons throw at
// validate time; here they are dropped so normalize is total.
function normalizePad(pad) {
  const p = pad || {};
  const state = neutralPad();
  if (Array.isArray(p.buttons)) {
    state.buttons = [...new Set(p.buttons.filter((b) => BUTTON_SET.has(b)))].sort();
  }
  for (const a of AXES) if (typeof p[a] === "number") state[a] = round3(clamp(p[a], -1, 1));
  for (const t of TRIGGERS) if (typeof p[t] === "number") state[t] = round3(clamp(p[t], 0, 1));
  return state;
}

function serializePad(state) {
  const s = normalizePad(state);
  return [
    s.buttons.join("+") || "-",
    s.lx, s.ly, s.rx, s.ry, s.lt, s.rt,
  ].join("|");
}

function padEquals(a, b) {
  return serializePad(a) === serializePad(b);
}

// ── validation ────────────────────────────────────────────────────────────────

function validateScript(script) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!script || typeof script !== "object") return { ok: false, errors: ["not an object"] };
  if (script.schema !== SCHEMA) err(`schema must be "${SCHEMA}"`);
  if (script.rate_hz != null && !(Number.isFinite(script.rate_hz) && script.rate_hz >= 10 && script.rate_hz <= 1000)) {
    err("rate_hz must be 10..1000");
  }
  if (script.source != null && !["authored", "recorded", "generated"].includes(script.source)) {
    err(`source must be authored|recorded|generated`);
  }
  const hasMoves = Array.isArray(script.moves) && script.moves.length > 0;
  const hasTimeline = Array.isArray(script.timeline) && script.timeline.length > 0;
  if (!hasMoves && !hasTimeline) err("script needs moves or timeline");

  if (hasMoves) {
    script.moves.forEach((m, i) => {
      const at = `moves[${i}]`;
      if (!m || typeof m !== "object" || typeof m.op !== "string") return err(`${at}: missing op`);
      const needBtn = ["press", "hold", "mash"].includes(m.op);
      if (needBtn && !BUTTON_SET.has(m.btn)) err(`${at}: unknown btn ${m.btn}`);
      switch (m.op) {
        case "press": case "hold": case "neutral": case "wait":
          if (m.ms != null && !(m.ms > 0)) err(`${at}: ms must be > 0`);
          break;
        case "mash":
          if (!(m.hz > 0 && m.hz <= 30)) err(`${at}: hz must be 0..30`);
          if (!(m.ms > 0)) err(`${at}: ms must be > 0`);
          break;
        case "stick":
          if (!["L", "R"].includes(m.stick)) err(`${at}: stick must be L|R`);
          if (!(typeof m.x === "number" && typeof m.y === "number")) err(`${at}: x/y required`);
          if (!(m.ms > 0)) err(`${at}: ms must be > 0`);
          break;
        case "trigger":
          if (!["LT", "RT"].includes(m.trigger)) err(`${at}: trigger must be LT|RT`);
          if (!(typeof m.v === "number")) err(`${at}: v required`);
          if (!(m.ms > 0)) err(`${at}: ms must be > 0`);
          break;
        case "walk":
          if (typeof m.dir_deg !== "number") err(`${at}: dir_deg required`);
          if (!(m.ms > 0)) err(`${at}: ms must be > 0`);
          break;
        case "combo":
          if (!Array.isArray(m.steps) || m.steps.length === 0) err(`${at}: steps required`);
          else m.steps.forEach((s, j) => {
            if (!BUTTON_SET.has(s.btn)) err(`${at}.steps[${j}]: unknown btn ${s.btn}`);
            if (s.after_ms != null && !(s.after_ms >= 0)) err(`${at}.steps[${j}]: after_ms must be >= 0`);
          });
          break;
        case "wait_log":
          // Sync barrier: pause the input clock until the game log emits `match`
          // (or timeout_ms passes — the run continues with a warning either way).
          // Turns open-loop replay into log-gated segments; the pad state carries
          // across the barrier unchanged.
          if (typeof m.match !== "string" || m.match.length === 0) err(`${at}: match required`);
          if (m.timeout_ms != null && !(m.timeout_ms > 0)) err(`${at}: timeout_ms must be > 0`);
          break;
        default:
          err(`${at}: unknown op ${m.op}`);
      }
    });
  }

  if (hasTimeline) {
    let last = -1;
    script.timeline.forEach((e, i) => {
      const at = `timeline[${i}]`;
      if (!e || typeof e !== "object" || !Number.isFinite(e.t_ms) || e.t_ms < 0) return err(`${at}: t_ms required`);
      if (e.t_ms < last) err(`${at}: t_ms must be non-decreasing`);
      last = e.t_ms;
      const p = e.pad || {};
      if (Array.isArray(p.buttons)) {
        for (const b of p.buttons) if (!BUTTON_SET.has(b)) err(`${at}: unknown btn ${b}`);
      }
      for (const a of AXES) if (p[a] != null && !(typeof p[a] === "number" && p[a] >= -1 && p[a] <= 1)) err(`${at}: ${a} out of range`);
      for (const t of TRIGGERS) if (p[t] != null && !(typeof p[t] === "number" && p[t] >= 0 && p[t] <= 1)) err(`${at}: ${t} out of range`);
    });
  }

  if (script.labels != null) {
    if (!Array.isArray(script.labels)) err("labels must be an array");
    else script.labels.forEach((l, i) => {
      if (!l || !Number.isFinite(l.t_ms) || typeof l.label !== "string") err(`labels[${i}]: needs t_ms + label`);
    });
  }
  if (script.start != null) {
    const w = script.start.wait_for;
    if (!w || !["fixed_delay", "log_line"].includes(w.kind)) err("start.wait_for.kind must be fixed_delay|log_line");
    else if (w.kind === "fixed_delay" && !(w.ms >= 0)) err("start.wait_for.ms must be >= 0");
    else if (w.kind === "log_line" && typeof w.match !== "string") err("start.wait_for.match required");
  }
  return { ok: errors.length === 0, errors };
}

// ── moves → timeline compile ──────────────────────────────────────────────────
// Moves run SEQUENTIALLY, but STICK STATE PERSISTS until the next stick/neutral op
// for that stick (the gym scripts' convention — see apps/unreal-gym/AGENTS.md):
// press/hold/mash/combo/trigger ops overlap the held stick, which is how sequential
// moves express run-and-jump. `neutral` clears everything. Every compile still ends
// on a full-neutral keyframe.

function compileMoves(moves) {
  const timeline = [];
  let t = 0;
  const held = { lx: 0, ly: 0, rx: 0, ry: 0 }; // persistent stick context
  const withHeld = (extra) => ({ ...held, ...extra });
  const emit = (t_ms, pad) => timeline.push({ t_ms: Math.round(t_ms), pad: normalizePad(pad) });

  for (const m of moves) {
    switch (m.op) {
      case "press":
      case "hold": {
        const ms = m.ms ?? DEFAULT_PRESS_MS;
        emit(t, withHeld({ buttons: [m.btn] }));
        emit(t + ms, withHeld({}));
        t += ms;
        break;
      }
      case "neutral":
      case "wait": {
        held.lx = 0; held.ly = 0; held.rx = 0; held.ry = 0;
        emit(t, {});
        t += m.ms ?? DEFAULT_PRESS_MS;
        break;
      }
      case "mash": {
        const period = 1000 / m.hz;
        const down = Math.min(DEFAULT_PRESS_MS, period / 2);
        for (let mt = 0; mt + 1 <= m.ms; mt += period) {
          emit(t + mt, withHeld({ buttons: [m.btn] }));
          emit(t + mt + down, withHeld({}));
        }
        emit(t + m.ms, withHeld({}));
        t += m.ms;
        break;
      }
      case "stick": {
        if (m.stick === "L") { held.lx = m.x; held.ly = m.y; }
        else { held.rx = m.x; held.ry = m.y; }
        emit(t, withHeld({}));
        t += m.ms; // the stick HOLDS past this move's duration
        break;
      }
      case "walk": {
        // Sugar for a persistent L stick: dir_deg clockwise from forward
        // (0 = forward ly=+1, 90 = right lx=+1).
        const rad = (m.dir_deg * Math.PI) / 180;
        held.lx = Math.sin(rad); held.ly = Math.cos(rad);
        emit(t, withHeld({}));
        t += m.ms;
        break;
      }
      case "trigger": {
        const pad = m.trigger === "LT" ? { lt: m.v } : { rt: m.v };
        emit(t, withHeld(pad));
        emit(t + m.ms, withHeld({}));
        t += m.ms;
        break;
      }
      case "combo": {
        let stepStart = t;
        let end = t;
        m.steps.forEach((s, i) => {
          stepStart += i === 0 ? 0 : (s.after_ms ?? DEFAULT_COMBO_GAP_MS);
          const down = s.ms ?? DEFAULT_PRESS_MS;
          emit(stepStart, withHeld({ buttons: [s.btn] }));
          emit(stepStart + down, withHeld({}));
          end = Math.max(end, stepStart + down);
        });
        t = end;
        break;
      }
      case "wait_log": {
        // zero-width on the compile clock — the scheduler stretches real time here
        timeline.push({ t_ms: Math.round(t), wait_log: { match: m.match, timeout_ms: m.timeout_ms ?? 15000 } });
        break;
      }
      default:
        throw new Error(`compileMoves: unknown op ${m.op}`);
    }
  }
  emit(t, {}); // always end at neutral
  return timeline;
}

// The timeline that actually replays: explicit timeline wins; else compiled moves.
function resolveTimeline(script) {
  if (Array.isArray(script.timeline) && script.timeline.length > 0) return script.timeline;
  return compileMoves(script.moves);
}

// Deduped change events — THE deterministic record. Same script in, same events out.
function changeEvents(script) {
  const timeline = resolveTimeline(script);
  const events = [];
  let lastKey = null;
  let seq = 0;
  for (const e of timeline) {
    if (e.wait_log) {
      // barriers ride the stream untouched; pad dedup state carries across
      events.push({ seq: seq++, t_ms: Math.round(e.t_ms), wait_log: e.wait_log });
      continue;
    }
    const state = normalizePad(e.pad);
    const key = serializePad(state);
    if (key === lastKey) continue;
    lastKey = key;
    events.push({ seq: seq++, t_ms: Math.round(e.t_ms), pad: state });
  }
  // Hold the final state to the timeline's recorded end: a recorded session that
  // finishes on a constant held stick has no trailing CHANGE, and without this
  // marker playback ends at the last change and drops the held tail (a human
  // trace lost its last 5.6s of full-forward running, live 2026-08-27).
  const endMs = timeline.length ? Math.round(timeline[timeline.length - 1].t_ms) : 0;
  const lastPad = [...events].reverse().find((e) => e.pad);
  if (lastPad && lastPad.t_ms < endMs) {
    events.push({ seq: seq++, t_ms: endMs, pad: lastPad.pad });
  }
  return events;
}

function durationMs(script) {
  const timeline = resolveTimeline(script);
  return timeline.length ? Math.round(timeline[timeline.length - 1].t_ms) : 0;
}

function loadScript(json) {
  const script = typeof json === "string" ? JSON.parse(json) : json;
  const v = validateScript(script);
  if (!v.ok) {
    const e = new Error(`invalid padscript: ${v.errors.join("; ")}`);
    e.errors = v.errors;
    throw e;
  }
  return script;
}

module.exports = {
  SCHEMA,
  BUTTONS,
  DEFAULT_RATE_HZ,
  neutralPad,
  normalizePad,
  serializePad,
  padEquals,
  validateScript,
  compileMoves,
  resolveTimeline,
  changeEvents,
  durationMs,
  loadScript,
};
