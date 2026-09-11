// lib/report.js — receipt → findings (studio annotations) + studio cache drop.
//
// The studio renders rig runs from `.pingfusi/studio/runs/<run_id>/`. Findings reuse
// the EXISTING pingfusi-studio-annotations/v1 shape so the studio's findings pane
// works unchanged. Author is always "rig" — a machine run must never read as a
// human review (independent-human-review doctrine).
"use strict";

const fs = require("fs");
const path = require("path");

const ANNOTATIONS_SCHEMA = "pingfusi-studio-annotations/v1";

function mmss(tMs) {
  const s = Math.floor(tMs / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Cluster death_guess events that fall within windowMs of each other — the
// "I died N times right here" stat without any engine integration.
function clusterDeaths(events, windowMs = 15000) {
  const deaths = events.filter((e) => e.kind === "death_guess").sort((a, b) => a.t_ms - b.t_ms);
  const clusters = [];
  for (const d of deaths) {
    const last = clusters[clusters.length - 1];
    if (last && d.t_ms - last.last_t_ms <= windowMs) {
      last.count++;
      last.last_t_ms = d.t_ms;
      last.times.push(d.t_ms);
    } else {
      clusters.push({ count: 1, first_t_ms: d.t_ms, last_t_ms: d.t_ms, times: [d.t_ms] });
    }
  }
  return clusters;
}

function receiptToAnnotations(receipt, extra = {}) {
  const findings = [];
  let n = 0;
  const finding = (title, sentiment, body, tMs, tags) => findings.push({
    id: `rig-${receipt.run_id}-${n++}`,
    created_at: receipt.at,
    author: "rig",
    title,
    sentiment,
    body,
    tags,
    evidence: tMs == null ? [] : [{ response_index: 0, time_ms: tMs, quote: mmss(tMs) }],
  });

  const events = receipt.events || [];
  const perf = receipt.performance && receipt.performance.summary;

  if (receipt.failure_cause) {
    finding(
      `Run ${receipt.result}: ${receipt.failure_cause.kind}`,
      "negative",
      receipt.failure_cause.message || receipt.failure_cause.kind,
      receipt.failure_cause.at_ms ?? null,
      ["rig", receipt.failure_cause.kind],
    );
  }

  for (const cluster of clusterDeaths(events)) {
    if (cluster.count < 2) continue;
    finding(
      `Died ${cluster.count}× in the same stretch`,
      "negative",
      `${cluster.count} deaths between ${mmss(cluster.first_t_ms)} and ${mmss(cluster.last_t_ms)} — check the recording around this window; a difficulty spike or a repeatable hazard.`,
      cluster.first_t_ms,
      ["rig", "difficulty"],
    );
  }

  for (const e of events.filter((ev) => ev.kind === "stuck").slice(0, 5)) {
    finding("Stuck: screen stopped changing", "negative",
      e.detail || "Frame diff stayed under threshold — possible softlock, invisible wall, or menu trap.",
      e.t_ms, ["rig", "stuck"]);
  }

  if (perf) {
    for (const stall of (perf.load_stalls || []).slice(0, 5)) {
      finding(`Load stall: ${(stall.gap_ms / 1000).toFixed(1)}s without a frame`, "negative",
        `No frame presented for ${stall.gap_ms}ms at ${mmss(stall.t_ms)} — a load screen or blocking hitch a player experiences as waiting.`,
        stall.t_ms, ["rig", "performance", "loading"]);
    }
    if ((perf.stutters || []).length > 0) {
      const worst = perf.stutters.reduce((a, b) => (b.frame_ms > a.frame_ms ? b : a));
      finding(`${perf.stutters.length} stutter${perf.stutters.length === 1 ? "" : "s"} (worst ${worst.frame_ms}ms)`,
        perf.stutters.length > 5 ? "negative" : "neutral",
        `Frames far above the median; worst at ${mmss(worst.t_ms)}. avg ${perf.avg_fps} fps, p95 ${perf.p95_ms}ms, 1% low ${perf.one_percent_low_fps} fps.`,
        worst.t_ms, ["rig", "performance"]);
    }
  }

  for (const w of receipt.warnings || []) {
    finding("Warning", "neutral", w, null, ["rig", "warning"]);
  }

  for (const f of extra.findings || []) finding(f.title, f.sentiment, f.body, f.tMs, f.tags);

  const summaryBits = [
    `${receipt.mode} run of ${receipt.build?.label || receipt.build?.filename || "build"} — ${receipt.result}`,
    perf ? `avg ${perf.avg_fps} fps, 1% low ${perf.one_percent_low_fps} fps` : null,
    ...(extra.summary || []),
    `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
  ].filter(Boolean);

  return {
    schema: ANNOTATIONS_SCHEMA,
    ping_id: null,
    run_id: receipt.run_id,
    summary: summaryBits.join(" · "),
    findings,
  };
}

// Copy a finished run into the studio cache the runs axis reads.
function dropToStudio(runDir, workDir, receipt, annotationBuilder = receiptToAnnotations) {
  const dest = path.join(workDir, ".pingfusi", "studio", "runs", receipt.run_id);
  fs.mkdirSync(path.join(dest, "media"), { recursive: true });

  // The studio resolves media as media/<file>, but a run dir stores recording.mp4
  // at its root and the receipt says so — which is why every real rig run rendered
  // "No recording captured". Rewrite the path on the COPY only: `rig overlay`
  // resolves media.recording relative to the run dir.
  const staged = JSON.parse(JSON.stringify(receipt));
  const rec = path.join(runDir, "recording.mp4");
  if (fs.existsSync(rec)) {
    fs.copyFileSync(rec, path.join(dest, "media", "recording.mp4"));
    staged.media = { ...(staged.media || {}), recording: "media/recording.mp4" };
  }
  const overlayed = path.join(runDir, "recording-overlay.mp4");
  if (fs.existsSync(overlayed)) {
    fs.copyFileSync(overlayed, path.join(dest, "media", "recording-overlay.mp4"));
  }
  fs.writeFileSync(path.join(dest, "receipt.json"), JSON.stringify(staged, null, 2) + "\n");

  const annotations = annotationBuilder(staged);
  fs.writeFileSync(path.join(dest, "annotations.json"), JSON.stringify(annotations, null, 2) + "\n");

  const shots = path.join(runDir, "shots");
  if (fs.existsSync(shots)) {
    fs.mkdirSync(path.join(dest, "shots"), { recursive: true });
    for (const f of fs.readdirSync(shots)) fs.copyFileSync(path.join(shots, f), path.join(dest, "shots", f));
  }
  return dest;
}

module.exports = { ANNOTATIONS_SCHEMA, receiptToAnnotations, clusterDeaths, dropToStudio, mmss };
