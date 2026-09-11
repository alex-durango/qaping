// lib/build-fetch.js — pull a hosted build (/b/<slug> or any URL) into a run dir.
//
// /b/<slug> answers with a 302 to a short-lived signed URL; global fetch follows it.
// The slug IS the capability — no auth header is ever sent. Local .zip paths and
// already-unzipped directories are accepted too (the rig works offline).
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

async function fetchBuild(source, destDir, opts = {}) {
  fs.mkdirSync(destDir, { recursive: true });

  // Already-unzipped local directory: use in place, no copy.
  if (!/^https?:\/\//.test(source) && fs.existsSync(source) && fs.statSync(source).isDirectory()) {
    return { dir: source, zip: null, sha256: null, source: "local-dir" };
  }

  let zipPath;
  let origin;
  if (/^https?:\/\//.test(source)) {
    zipPath = path.join(destDir, "build.zip");
    const res = await fetch(source, { redirect: "follow" });
    if (!res.ok) throw new Error(`build download failed: HTTP ${res.status} for ${source}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(zipPath, bytes);
    origin = source;
  } else {
    if (!fs.existsSync(source)) throw new Error(`no such build: ${source}`);
    zipPath = source;
    origin = "local";
  }

  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
  if (opts.expectSha256 && opts.expectSha256 !== sha256) {
    throw new Error(`build sha256 mismatch: expected ${opts.expectSha256}, got ${sha256}`);
  }

  const extractDir = path.join(destDir, "build");
  fs.mkdirSync(extractDir, { recursive: true });
  unzip(zipPath, extractDir);
  return { dir: extractDir, zip: zipPath, sha256, source: origin };
}

function unzip(zipPath, destDir) {
  const attempt = process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`],
        { stdio: "pipe" })
    : spawnSync("unzip", ["-q", "-o", zipPath, "-d", destDir], { stdio: "pipe" });
  if (attempt.error || attempt.status !== 0) {
    const detail = attempt.error ? attempt.error.message : (attempt.stderr || "").toString().slice(0, 400);
    throw new Error(`unzip failed: ${detail}`);
  }
}

// Which exe is the game? --exe wins; otherwise the largest .exe that isn't a known
// redistributable/installer. The pick is recorded in the receipt either way.
const NOT_THE_GAME_RE = /(vc_?redist|vcredist|dxsetup|dxwebsetup|ueprereq|prereq|setup|unins|crash(pad|report)|installer|dotnet|oalinst|epicwebhelper)/i;

function pickExe(buildDir, opts = {}) {
  if (opts.exe) {
    const explicit = path.isAbsolute(opts.exe) ? opts.exe : path.join(buildDir, opts.exe);
    if (!fs.existsSync(explicit)) throw new Error(`--exe not found: ${explicit}`);
    return { exe: explicit, pick: "flag" };
  }
  const found = [];
  walk(buildDir, 0, (file, depth) => {
    if (!/\.exe$/i.test(file)) return;
    if (NOT_THE_GAME_RE.test(path.basename(file))) return;
    found.push({ file, depth, size: fs.statSync(file).size });
  });
  if (found.length === 0) throw new Error(`no game .exe found under ${buildDir} (use --exe)`);
  // A UE shipped build has a thin bootstrap exe at the top that SPAWNS the real
  // game from Binaries\Win64 — attaching telemetry to the bootstrap's pid captures
  // a process that never presents a frame (found live 2026-08-26: PresentMon ran
  // clean and wrote nothing). Prefer the real binary; it launches fine directly.
  const rank = (f) => (/[\\/]Binaries[\\/]Win(64|GDK)[\\/]/i.test(f.file) ? 0 : 1);
  found.sort((a, b) => rank(a) - rank(b) || b.size - a.size || a.depth - b.depth);
  return { exe: found[0].file, pick: "heuristic" };
}

function walk(dir, depth, visit) {
  if (depth > 4) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, visit);
    else visit(full, depth);
  }
}

module.exports = { fetchBuild, pickExe, unzip, NOT_THE_GAME_RE };
