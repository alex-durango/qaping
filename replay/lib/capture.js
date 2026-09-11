// lib/capture.js — ffmpeg argument builders for screen recording + shot extraction.
//
// Primary path ("hw" mode): screen capture feeding a hardware encoder without leaving
// the GPU. The working (source × encoder) pairs travel together — NVIDIA is
// ddagrab→h264_nvenc; AMD is vsrc_amf→h264_amf (AMF's own DirectCapture: ddagrab's
// BGRA d3d11 textures are refused by both the AMF encoder and vpp_amf on the AMD APU
// rig, verified live 2026-08-20). Both need the interactive console session — RDP
// breaks them (rig doctrine). Fallback: gdigrab + libx264 (slower, works anywhere).
// `rig doctor` runs a real test encode per candidate; the grep-the-encoder-list check
// it replaced passed on a box where NVENC could never open (no NVIDIA GPU at all).
"use strict";

// probe order: prefer NVENC (discrete NVIDIA) before AMF (AMD)
const HW_ENCODERS = ["h264_nvenc", "h264_amf"];

function encoderArgs(encoder) {
  if (encoder === "h264_amf") return ["-c:v", "h264_amf", "-quality", "balanced"];
  if (encoder === "h264_nvenc") return ["-c:v", "h264_nvenc", "-preset", "p4"];
  return ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"];
}

// tiny synthetic encode with a null sink — proves the encoder can actually open,
// which the -encoders listing does not (compiled-in ≠ driver present)
function probeArgs(encoder) {
  return ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=256x256:rate=30",
    "-frames:v", "8", ...encoderArgs(encoder), "-f", "null", "-"];
}

function recordingArgs({ output, fps = 60, mode = "hw", bitrate = "8M", maxMinutes = 35, encoder }) {
  const t = ["-t", String(maxMinutes * 60)]; // absolute ceiling — teardown normally stops it first
  if (mode === "gdigrab") {
    return ["-y", "-f", "gdigrab", "-framerate", String(fps), "-i", "desktop",
      ...t, ...encoderArgs("libx264"), "-b:v", bitrate, output];
  }
  const enc = encoder || "h264_nvenc";
  if (enc === "h264_amf") {
    return ["-y", "-filter_complex", `vsrc_amf=framerate=${fps}`,
      ...t, ...encoderArgs(enc), "-b:v", bitrate, output];
  }
  return ["-y", "-init_hw_device", "d3d11va", "-filter_complex", `ddagrab=framerate=${fps}`,
    ...t, ...encoderArgs(enc), "-b:v", bitrate, output];
}

// Frame at t_ms from a finished recording (event screenshots are cut afterwards, so
// the capture loop never pays for stills).
function shotArgs({ recording, tMs, output }) {
  return ["-y", "-ss", (tMs / 1000).toFixed(3), "-i", recording, "-frames:v", "1", "-q:v", "3", output];
}

module.exports = { HW_ENCODERS, encoderArgs, probeArgs, recordingArgs, shotArgs };
