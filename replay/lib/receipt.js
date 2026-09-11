// lib/receipt.js — the pingfusi-rig-run/v1 receipt: the run's durable record.
//
// Motion-doctrine shape: receipts + warnings, never a gate. `result` is a verdict
// against the recorded observations; `ok` says whether the harness
// itself completed the run. A crashed game is ok:true (harness worked) result:"fail".
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA = "pingfusi-rig-run/v1";
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;

const RESULTS = new Set(["pass", "fail", "error"]);
const MODES = new Set(["replay", "record", "agent"]);
const EXIT_REASONS = new Set(["script_end", "budget", "crash", "hang_kill", "operator", "game_exit"]);

function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const rand = crypto.randomBytes(3).toString("hex");
  return `run-${stamp}-${rand}`;
}

function createReceipt(base = {}) {
  return {
    schema: SCHEMA,
    run_id: base.run_id || newRunId(),
    at: base.at || new Date().toISOString(),
    duration_ms: base.duration_ms ?? 0,
    ok: base.ok ?? true,
    result: base.result || "pass",
    failure_cause: base.failure_cause ?? null,
    gym: base.gym ?? null,
    rig: base.rig ?? null,
    build: base.build ?? null,
    mode: base.mode || "replay",
    script: base.script ?? null,
    process: base.process ?? null,
    inputs: base.inputs ?? null,
    performance: base.performance ?? null,
    media: base.media ?? { recording: null, screenshots: [] },
    events: base.events ?? [],
    // Optional legacy extension fields are preserved without interpreting them.
    gym_verify: base.gym_verify ?? null,
    // Additional observations from external analysis.
    // Findings only — a divergence never flips `result`.
    gym_diff: base.gym_diff ?? null,
    replay_fidelity: base.replay_fidelity ?? null,
    agent: base.agent ?? null,
    warnings: base.warnings ?? [],
  };
}

function validateReceipt(r) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!r || typeof r !== "object") return { ok: false, errors: ["not an object"] };
  if (r.schema !== SCHEMA) err(`schema must be "${SCHEMA}"`);
  if (!RUN_ID_RE.test(r.run_id || "")) err("run_id must match ^[a-z0-9][a-z0-9-]{7,63}$");
  if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) err("at must be an ISO date");
  if (!Number.isFinite(r.duration_ms) || r.duration_ms < 0) err("duration_ms must be >= 0");
  if (typeof r.ok !== "boolean") err("ok must be boolean");
  if (!RESULTS.has(r.result)) err("result must be pass|fail|error");
  if (!MODES.has(r.mode)) err("mode must be replay|record|agent");
  if (r.failure_cause != null) {
    if (typeof r.failure_cause !== "object" || typeof r.failure_cause.kind !== "string") err("failure_cause needs kind");
  }
  if (r.result !== "pass" && r.failure_cause == null) err("non-pass result needs failure_cause");
  if (r.process != null && r.process.exit_reason != null && !EXIT_REASONS.has(r.process.exit_reason)) {
    err(`process.exit_reason must be one of ${[...EXIT_REASONS].join("|")}`);
  }
  if (r.events != null) {
    if (!Array.isArray(r.events)) err("events must be an array");
    else r.events.forEach((e, i) => {
      if (!e || !Number.isFinite(e.t_ms) || typeof e.kind !== "string") err(`events[${i}]: needs t_ms + kind`);
    });
  }
  if (r.warnings != null && !Array.isArray(r.warnings)) err("warnings must be an array");
  if (r.performance != null) {
    const s = r.performance.summary;
    if (!s || typeof s !== "object") err("performance needs summary");
    else if (s.series_1s != null && !Array.isArray(s.series_1s)) err("performance.summary.series_1s must be an array");
  }
  return { ok: errors.length === 0, errors };
}

// Atomic write: never leave a half-written receipt for the studio to trip on.
function writeReceipt(dir, receipt) {
  const v = validateReceipt(receipt);
  if (!v.ok) {
    const e = new Error(`invalid receipt: ${v.errors.join("; ")}`);
    e.errors = v.errors;
    throw e;
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "receipt.json");
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

function readReceipt(dir) {
  const raw = fs.readFileSync(path.join(dir, "receipt.json"), "utf8");
  const receipt = JSON.parse(raw);
  const v = validateReceipt(receipt);
  if (!v.ok) throw new Error(`invalid receipt in ${dir}: ${v.errors.join("; ")}`);
  return receipt;
}

module.exports = { SCHEMA, RUN_ID_RE, newRunId, createReceipt, validateReceipt, writeReceipt, readReceipt };
