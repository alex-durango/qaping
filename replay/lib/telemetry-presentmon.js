// lib/telemetry-presentmon.js — PresentMon CSV → frame stats.
//
// Fixture-driven on purpose: PresentMon renamed its columns between 1.x
// (msBetweenPresents / TimeInSeconds) and 2.x (FrameTime / CPUStartTime), so the
// parser hunts for the first matching column instead of assuming a version. When
// the rig's real PresentMon lands, its actual CSV becomes a fixture here.
"use strict";

const FRAME_MS_COLUMNS = ["msbetweenpresents", "frametime", "msbetweendisplaychange", "frametime(ms)"];
const TIME_S_COLUMNS = ["timeinseconds", "cpustarttime", "cpustarttime(s)", "timestamp"];
// 2.x's CPUStartTime is MILLISECONDS since capture start (verified live 2026-08-26:
// consecutive rows differ by exactly the FrameTime ms) — 1.x TimeInSeconds is seconds.
const TIME_SCALE = { timeinseconds: 1, cpustarttime: 0.001, "cpustarttime(s)": 1, timestamp: 1 };

const STUTTER_FACTOR = 4; // a frame this many times the median…
const STUTTER_MIN_MS = 50; // …and at least this long, is a stutter
const STALL_MIN_MS = 2000; // present gaps in this band are load stalls…
const STALL_MAX_MS = 10000; // …longer gaps belong to the hang watchdog (runtime)

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { frames: [], columns: null };
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const frameIdx = FRAME_MS_COLUMNS.map((c) => header.indexOf(c)).find((i) => i >= 0);
  const timeIdx = TIME_S_COLUMNS.map((c) => header.indexOf(c)).find((i) => i >= 0);
  if (frameIdx === undefined) {
    return { frames: [], columns: { header, error: "no frame-duration column found" } };
  }
  const frames = [];
  let cumulativeS = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const frameMs = parseFloat(cells[frameIdx]);
    if (!Number.isFinite(frameMs) || frameMs < 0) continue;
    let tS;
    if (timeIdx !== undefined) {
      tS = parseFloat(cells[timeIdx]) * (TIME_SCALE[header[timeIdx]] ?? 1);
      if (!Number.isFinite(tS)) { cumulativeS += frameMs / 1000; tS = cumulativeS; }
    } else {
      cumulativeS += frameMs / 1000;
      tS = cumulativeS;
    }
    frames.push({ t_s: tS, frame_ms: frameMs });
  }
  return { frames, columns: { header, frameColumn: header[frameIdx], timeColumn: timeIdx !== undefined ? header[timeIdx] : null } };
}

// Handles simple quoted cells; PresentMon output is plain but process names can
// carry commas when quoted.
function splitCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

function percentileMs(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  return sortedMs[Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length))];
}

function summarize(frames, opts = {}) {
  const stutterFactor = opts.stutterFactor ?? STUTTER_FACTOR;
  const stutterMinMs = opts.stutterMinMs ?? STUTTER_MIN_MS;
  const stallMinMs = opts.stallMinMs ?? STALL_MIN_MS;
  const stallMaxMs = opts.stallMaxMs ?? STALL_MAX_MS;
  if (!frames || frames.length === 0) return null;

  const t0 = frames[0].t_s;
  const durations = frames.map((f) => f.frame_ms);
  const sorted = [...durations].sort((a, b) => a - b);
  const totalMs = durations.reduce((a, b) => a + b, 0);
  const median = percentileMs(sorted, 0.5);

  // 1% low: the average fps of the slowest 1% of frames (reviewer convention).
  const worstCount = Math.max(1, Math.floor(sorted.length * 0.01));
  const worst = sorted.slice(-worstCount);
  const onePercentLowFps = worst.reduce((a, b) => a + b, 0) / worstCount;

  const round1 = (v) => Math.round(v * 10) / 10;
  const round2 = (v) => Math.round(v * 100) / 100;

  // 1-second fps buckets, and stutter/stall event scan in the same pass.
  const series = [];
  const stutters = [];
  const loadStalls = [];
  let bucketStart = t0;
  let bucketCount = 0;
  for (const f of frames) {
    while (f.t_s - bucketStart >= 1) {
      series.push(bucketCount);
      bucketCount = 0;
      bucketStart += 1;
    }
    bucketCount++;
    const tMs = Math.round((f.t_s - t0) * 1000);
    if (f.frame_ms >= stallMinMs && f.frame_ms <= stallMaxMs) {
      loadStalls.push({ t_ms: tMs, gap_ms: Math.round(f.frame_ms) });
    } else if (f.frame_ms >= stutterMinMs && f.frame_ms >= median * stutterFactor) {
      stutters.push({ t_ms: tMs, frame_ms: Math.round(f.frame_ms) });
    }
  }
  if (bucketCount > 0) series.push(bucketCount);

  return {
    frame_count: frames.length,
    duration_ms: Math.round(totalMs),
    avg_fps: round1(frames.length / (totalMs / 1000)),
    p50_ms: round2(median),
    p95_ms: round2(percentileMs(sorted, 0.95)),
    p99_ms: round2(percentileMs(sorted, 0.99)),
    one_percent_low_fps: round1(1000 / (onePercentLowFps || 1)),
    series_1s: series,
    stutters: stutters.slice(0, 200),
    load_stalls: loadStalls.slice(0, 50),
  };
}

// PresentMon CLI invocation, version-tolerant at the arg level too: 2.x uses
// --process_id, 1.x used -process_id. The caller probes with --help at doctor time.
function buildArgs({ pid, outputFile, style = "2" }) {
  if (style === "1") return ["-process_id", String(pid), "-output_file", outputFile, "-terminate_on_proc_exit"];
  return ["--process_id", String(pid), "--output_file", outputFile, "--terminate_on_proc_exit", "--stop_existing_session"];
}

module.exports = { parseCsv, summarize, buildArgs, STUTTER_FACTOR, STUTTER_MIN_MS, STALL_MIN_MS, STALL_MAX_MS };
