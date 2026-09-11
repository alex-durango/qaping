// lib/pad.js — the virtual-gamepad feeder abstraction.
//
// The harness never talks to a driver binding directly; it talks JSON-lines to a
// child process ("the feeder"), so the backend is swappable without touching the
// harness: shims/padd.py (Python vgamepad over ViGEmBus — the default), a C# shim,
// or the selftest stub. Protocol, one JSON object per line:
//   harness → feeder:  {"op":"connect"}  {"op":"state", ...pad}  {"op":"disconnect"}
//   feeder → harness:  {"event":"ready"}            after connect succeeds
//                      {"event":"state_ack","seq":n} optional, stub uses it
//                      {"event":"error","message":..} fatal — feeder exits after
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const { normalizePad } = require("./padscript");

const DEFAULT_FEEDER = () => ({
  command: process.platform === "win32" ? "python" : "python3",
  args: [path.join(__dirname, "..", "shims", "padd.py")],
});

class PadFeeder {
  constructor(opts = {}) {
    const def = DEFAULT_FEEDER();
    this.command = opts.command || def.command;
    this.args = opts.args || def.args;
    this.child = null;
    this.events = [];
    this.waiters = [];
    this.exited = null;
    this.stderr = "";
  }

  _push(event) {
    const w = this.waiters.shift();
    if (w) w(event);
    else this.events.push(event);
  }

  _next(timeoutMs = 10000) {
    if (this.events.length) return Promise.resolve(this.events.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`pad feeder: no response within ${timeoutMs}ms${this.stderr ? ` — stderr: ${this.stderr.slice(-400)}` : ""}`));
      }, timeoutMs);
      const entry = (event) => { clearTimeout(t); resolve(event); };
      this.waiters.push(entry);
    });
  }

  async connect() {
    this.child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
    this.child.on("error", (e) => this._push({ event: "error", message: String(e.message || e) }));
    this.child.stderr.on("data", (d) => { this.stderr += d.toString(); });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      try { this._push(JSON.parse(line)); } catch { /* non-protocol chatter ignored */ }
    });
    this._write({ op: "connect" });
    const first = await this._next();
    if (first.event === "error") throw new Error(`pad feeder failed: ${first.message}`);
    if (first.event !== "ready") throw new Error(`pad feeder: expected ready, got ${JSON.stringify(first)}`);
    return this;
  }

  _write(obj) {
    if (!this.child || !this.child.stdin.writable) throw new Error("pad feeder not running");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  // Fire-and-forget by design: the 120Hz loop cannot await a round-trip per state.
  sendState(pad) {
    const s = normalizePad(pad);
    this._write({ op: "state", buttons: s.buttons, lx: s.lx, ly: s.ly, rx: s.rx, ry: s.ry, lt: s.lt, rt: s.rt });
  }

  // Drain-and-confirm used by tests and pad-test.
  async sendStateAcked(pad, seq) {
    const s = normalizePad(pad);
    this._write({ op: "state", seq, ack: true, buttons: s.buttons, lx: s.lx, ly: s.ly, rx: s.rx, ry: s.ry, lt: s.lt, rt: s.rt });
    const ev = await this._next();
    if (ev.event === "error") throw new Error(`pad feeder error: ${ev.message}`);
    return ev;
  }

  async close() {
    if (!this.child) return null;
    try { this._write({ op: "disconnect" }); } catch { /* already gone */ }
    this.child.stdin.end();
    const code = await Promise.race([this.exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (code === null && this.child.exitCode === null) this.child.kill();
    return code;
  }
}

module.exports = { PadFeeder, DEFAULT_FEEDER };
