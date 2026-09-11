"use strict";

// Raw relative impulses retain camera motion. Visible menu pointers additionally
// carry client-area pixels; replay must not apply pointer acceleration twice.
const SCHEMA = "qaping-kbmscript/v1";
const MAX_DURATION_MS = 35 * 60000;
const BUTTONS = ["left", "right", "middle", "x1", "x2"];
const integer = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

function validateScript(s) {
  const errors = [];
  const fail = (m) => errors.push(m);
  if (!s || typeof s !== "object") return { ok: false, errors: ["not an object"] };
  if (s.schema !== SCHEMA) fail(`schema must be ${SCHEMA}`);
  if (!["recorded", "authored", "generated"].includes(s.source)) fail("source must be recorded|authored|generated");
  if (!Number.isFinite(s.duration_ms) || s.duration_ms <= 0 || s.duration_ms > MAX_DURATION_MS) fail("duration_ms must be 0..2100000");
  if (!Array.isArray(s.timeline) || !s.timeline.length || s.timeline.length > 2000000) {
    return { ok: false, errors: [...errors, "timeline needs 1..2000000 events"] };
  }
  let previous = 0;
  const held = new Set();
  s.timeline.forEach((e, i) => {
    const at = `timeline[${i}]`;
    if (!e || !Number.isFinite(e.t_ms) || e.t_ms < previous || e.t_ms > s.duration_ms) { fail(`${at}: invalid time`); return; }
    previous = e.t_ms;
    const k = e.input;
    if (!k || typeof k !== "object") { fail(`${at}: missing input`); return; }
    if (k.cursor !== undefined && k.cursor !== null) {
      const c = k.cursor;
      if (!["move", "button", "wheel"].includes(k.kind) || typeof c !== "object" ||
          !integer(c.width, 1, 32768) || !integer(c.height, 1, 32768) ||
          !integer(c.x, 0, c.width - 1) || !integer(c.y, 0, c.height - 1)) fail(`${at}: invalid client cursor`);
      if (c.space !== undefined && c.space !== "client-normalized") fail(`${at}: unsupported cursor space`);
      if (c.space === "client-normalized" && (!Number.isFinite(c.u) || !Number.isFinite(c.v) ||
          Math.abs(c.u - (c.x + .5) / c.width) > 1e-9 || Math.abs(c.v - (c.y + .5) / c.height) > 1e-9)) fail(`${at}: invalid normalized cursor`);
    }
    let id;
    switch (k.kind) {
      case "key":
        if (!integer(k.scan, 1, 127) || typeof k.extended !== "boolean" || typeof k.down !== "boolean") fail(`${at}: invalid scan key`);
        // F8/F9 are reserved for transport; Windows keys would leave game focus.
        if ([0x42, 0x43].includes(k.scan) || (k.extended && [0x5b, 0x5c].includes(k.scan))) fail(`${at}: reserved key`);
        id = `key:${k.scan}:${k.extended}`;
        break;
      case "button":
        if (!BUTTONS.includes(k.button) || typeof k.down !== "boolean") fail(`${at}: invalid mouse button`);
        id = `button:${k.button}`;
        break;
      case "move":
        if (!integer(k.dx, -32767, 32767) || !integer(k.dy, -32767, 32767)) fail(`${at}: invalid relative motion`);
        break;
      case "wheel":
        if (!["vertical", "horizontal"].includes(k.axis) || !integer(k.delta, -32768, 32767) || !k.delta) fail(`${at}: invalid wheel`);
        break;
      default: fail(`${at}: unsupported input kind`);
    }
    if (id) {
      if (!k.down && !held.has(id)) fail(`${at}: release without a press`);
      if (k.down) held.add(id); else held.delete(id);
    }
  });
  // A stop while holding W is valid. The backend releases it at duration_ms,
  // and also on focus loss, cancellation, target exit, stdin EOF or errors.
  return { ok: errors.length === 0, errors };
}

function loadScript(raw) {
  const script = typeof raw === "string" ? JSON.parse(raw) : raw;
  const v = validateScript(script);
  if (!v.ok) throw new Error(`invalid keyboard/mouse script: ${v.errors.join("; ")}`);
  return script;
}

function changeEvents(script) {
  loadScript(script);
  return script.timeline.map((e, seq) => ({ seq, t_ms: e.t_ms, input: { ...e.input } }));
}

module.exports = { SCHEMA, MAX_DURATION_MS, BUTTONS, validateScript, loadScript, changeEvents };
