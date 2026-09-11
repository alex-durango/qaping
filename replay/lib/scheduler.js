// lib/scheduler.js — plays a change-event stream against a wall clock.
//
// The event stream (padscript.changeEvents) is deterministic; this module's only job
// is delivering each event as close to its t_ms as the OS allows. Windows timers are
// coarse (~1-16ms), so we sleep until shortly before the deadline and spin the rest.
// Jitter is measured and reported — it never alters the event stream.
"use strict";

const DEFAULT_SPIN_MS = 4;

function hrtimeMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Plays events [{seq,t_ms,pad}] by calling `send(event)` at event.t_ms relative to
// start. Injectable clock/sleep for tests. Returns jitter stats.
async function playEvents(events, opts) {
  const {
    send,
    now = hrtimeMs,
    doSleep = sleep,
    spinMs = DEFAULT_SPIN_MS,
    shouldStop = () => false,
    waitLog = null,
  } = opts;
  const start = now();
  let shift = 0; // wall time spent inside wait_log barriers — the clock pauses there
  const jitters = [];
  for (const event of events) {
    if (event.wait_log) {
      if (waitLog) {
        const before = now();
        await waitLog(event);
        shift += now() - before;
      }
      continue; // barriers send nothing and count no jitter
    }
    const deadline = start + shift + event.t_ms;
    for (;;) {
      if (shouldStop()) return { stopped: true, sent: event.seq, jitter: jitterStats(jitters) };
      const remaining = deadline - now();
      if (remaining <= 0) break;
      if (remaining > spinMs) await doSleep(remaining - spinMs);
      else await doSleep(0); // yield; effectively a spin with event-loop turns
    }
    await send(event);
    jitters.push(now() - deadline);
  }
  return { stopped: false, sent: events.length, jitter: jitterStats(jitters) };
}

function jitterStats(jitters) {
  if (jitters.length === 0) return { count: 0 };
  const sorted = [...jitters].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    count: sorted.length,
    p50_ms: Math.round(q(0.5) * 100) / 100,
    p95_ms: Math.round(q(0.95) * 100) / 100,
    max_ms: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

module.exports = { playEvents, jitterStats, hrtimeMs };
