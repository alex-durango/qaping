"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const PIN = Object.freeze({
  url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-02-13-13/ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1.zip",
  sha256: "954c2f5a219d6d34280393ceaf611777f6fcc96b785263328fb263df35dc1f8a",
  bytes: 168259261,
});
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function findVideoTool(cache) {
  for (const file of [process.env.RIG_FFMPEG, "ffmpeg", path.join(cache, "ffmpeg.exe")].filter(Boolean)) {
    const probe = spawnSync(file, ["-hide_banner", "-version"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
    if (probe.status === 0 && /ffmpeg version/.test(probe.stdout || "")) return file;
  }
  return null;
}
async function downloadVerified(destination, { pin = PIN, fetcher = fetch, signal, progress = () => {} } = {}) {
  const response = await fetcher(pin.url, { signal });
  if (!response.ok || !response.body) throw new Error(`Video download failed (${response.status})`);
  const handle = fs.openSync(destination, "wx");
  const hash = crypto.createHash("sha256");
  let total = 0, previous = -1;
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      total += chunk.length;
      if (total > pin.bytes) throw new Error("Video download exceeded its expected size");
      hash.update(chunk); fs.writeFileSync(handle, chunk);
      const percent = Math.floor(total * 100 / pin.bytes);
      if (percent !== previous) { progress(percent); previous = percent; }
    }
    if (total !== pin.bytes || hash.digest("hex") !== pin.sha256) throw new Error("Video download failed SHA-256 verification");
  } catch (error) {
    fs.closeSync(handle); fs.unlinkSync(destination); throw error;
  }
  fs.closeSync(handle);
}
async function ensureVideoTool(cache, { signal, progress } = {}) {
  const existing = findVideoTool(cache);
  if (existing) return existing;
  fs.mkdirSync(cache, { recursive: true });
  if (fs.lstatSync(cache).isSymbolicLink()) throw new Error("Video cache must be a regular directory");
  const archive = path.join(cache, PIN.sha256 + ".zip");
  if (!fs.existsSync(archive) || digest(archive) !== PIN.sha256) {
    const temporary = path.join(cache, `download-${crypto.randomUUID()}.zip`);
    await downloadVerified(temporary, { signal, progress });
    signal?.throwIfAborted();
    fs.renameSync(temporary, archive);
  }
  signal?.throwIfAborted();
  await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($env:RIG_VIDEO_ARCHIVE)
try {
  foreach($name in @('ffmpeg.exe','LICENSE.txt')) {
    $entries=@($archive.Entries | Where-Object { $_.Name -eq $name })
    if($entries.Count -ne 1) { throw ('Expected one '+$name+' in the video archive') }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0],(Join-Path $env:RIG_VIDEO_CACHE $name),$true)
  }
} finally { $archive.Dispose() }
`], { windowsHide: true, signal, env: { ...process.env, RIG_VIDEO_ARCHIVE: archive, RIG_VIDEO_CACHE: cache } });
  const file = path.join(cache, "ffmpeg.exe");
  if (!findVideoTool(cache)) throw new Error("Downloaded ffmpeg could not run");
  return file;
}
module.exports = { PIN, findVideoTool, ensureVideoTool, downloadVerified };
