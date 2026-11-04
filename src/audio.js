'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Resolve the bundled binaries. When packaged inside an asar archive the
// binaries are unpacked (see asarUnpack in package.json), so rewrite the path.
function unpacked(p) {
  return p.replace('app.asar', 'app.asar.unpacked');
}

// The macOS build is universal (arm64 + x64), but ffmpeg-static only bundles a
// single arch. The beforePack hook stages both into Resources/ffmpeg, so prefer
// the one matching the running process. Falls back to ffmpeg-static for dev and
// single-arch (Windows/Linux) builds. ffprobe-static ships every arch, so its
// own path resolution already picks correctly at runtime.
function resolveFfmpeg() {
  if (process.resourcesPath) {
    const staged = path.join(process.resourcesPath, 'ffmpeg', `ffmpeg-${process.arch}`);
    if (fs.existsSync(staged)) return staged;
  }
  return unpacked(require('ffmpeg-static'));
}

const ffmpegPath = resolveFfmpeg();
const ffprobePath = unpacked(require('ffprobe-static').path);

// Valid CBR bitrates for libmp3lame (kbps).
const MP3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MIN_BITRATE = 32;
const MAX_BITRATE = 320;
// Leave headroom so container/metadata overhead never pushes us over the ceiling.
const SIZE_SAFETY = 0.96;
// Normalisation loudness target (EBU R128). -16 LUFS is the voice/podcast standard.
const LOUDNORM_TARGET = { I: -16, TP: -1.5, LRA: 11 };

// Noise reduction amount (dB) for afftdn, by user-selected strength.
const DENOISE_STRENGTH = { light: 6, medium: 12, strong: 24 };

function run(bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited with code ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

// Read duration (seconds) from the input file.
async function probeDuration(input) {
  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    input,
  ]);
  const duration = parseFloat(stdout.trim());
  if (!isFinite(duration) || duration <= 0) {
    throw new Error('Could not read the audio duration — the file may be corrupt or not a valid MP3.');
  }
  return duration;
}

// Pick the highest valid CBR bitrate that keeps the file at/under maxMB.
function targetBitrate(maxMB, durationSec) {
  const targetBits = maxMB * 1024 * 1024 * 8 * SIZE_SAFETY;
  const idealKbps = targetBits / durationSec / 1000;
  let chosen = MIN_BITRATE;
  for (const b of MP3_BITRATES) {
    if (b <= idealKbps) chosen = b;
  }
  if (idealKbps < MIN_BITRATE) chosen = MIN_BITRATE; // can't go lower; may exceed ceiling
  return Math.min(chosen, MAX_BITRATE);
}

// Next valid bitrate below the given one (for the re-encode fallback).
function stepDown(bitrate) {
  const idx = MP3_BITRATES.indexOf(bitrate);
  if (idx > 0) return MP3_BITRATES[idx - 1];
  return null;
}

// Build the denoise filters only. Shared by the loudness-measurement pass and
// the final encode so both act on the same signal.
function denoiseFilters(denoiseStrength) {
  const nr = DENOISE_STRENGTH[denoiseStrength] || DENOISE_STRENGTH.medium;
  // High-pass removes low-frequency hum/rumble; afftdn is an adaptive FFT
  // denoiser, with nr controlling how aggressively noise is reduced.
  return ['highpass=f=80', `afftdn=nr=${nr}`];
}

function buildFilters({ normalise, denoise, denoiseStrength, loudnormMeasured }) {
  const filters = [];
  if (denoise) {
    filters.push(...denoiseFilters(denoiseStrength));
  }
  if (normalise) {
    const { I, TP, LRA } = LOUDNORM_TARGET;
    let ln = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`;
    // Second pass of a two-pass normalise: feed in the measured values for a
    // precise, linear correction.
    if (loudnormMeasured) {
      const m = loudnormMeasured;
      ln += `:measured_I=${m.input_i}:measured_TP=${m.input_tp}`
        + `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}`
        + `:offset=${m.target_offset}:linear=true`;
    }
    filters.push(ln);
  }
  return filters;
}

// First pass of two-pass normalisation: run loudnorm in analysis mode and
// return the measured loudness stats (JSON printed to stderr by ffmpeg).
async function measureLoudness({ input, denoise, denoiseStrength, durationSec, onProgress }) {
  const { I, TP, LRA } = LOUDNORM_TARGET;
  const chain = [];
  if (denoise) chain.push(...denoiseFilters(denoiseStrength));
  chain.push(`loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`);

  const { stderr } = await run(ffmpegPath, [
    '-y', '-i', input, '-af', chain.join(','), '-f', 'null', '-',
  ], {
    onStderr: (chunk) => {
      const t = parseProgressTime(chunk);
      if (t != null && onProgress && durationSec) onProgress(Math.min(1, t / durationSec));
    },
  });

  // ffmpeg prints a JSON object at the end of stderr.
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Could not read loudness measurement from ffmpeg.');
  }
  return JSON.parse(stderr.slice(start, end + 1));
}

// Parse "time=00:01:23.45" from ffmpeg stderr into seconds.
function parseProgressTime(chunk) {
  const m = chunk.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

async function encode({ input, output, bitrate, normalise, denoise, denoiseStrength, loudnormMeasured, durationSec, onProgress }) {
  const filters = buildFilters({ normalise, denoise, denoiseStrength, loudnormMeasured });
  const args = ['-y', '-i', input];
  if (filters.length) args.push('-af', filters.join(','));
  args.push(
    '-c:a', 'libmp3lame',
    '-b:a', `${bitrate}k`,
    '-map_metadata', '0',
    '-id3v2_version', '3',
    output
  );
  await run(ffmpegPath, args, {
    onStderr: (chunk) => {
      const t = parseProgressTime(chunk);
      if (t != null && onProgress) {
        onProgress(Math.min(1, t / durationSec));
      }
    },
  });
}

module.exports = {
  probeDuration,
  targetBitrate,
  stepDown,
  encode,
  measureLoudness,
  buildFilters,
  denoiseFilters,
  parseProgressTime,
  ffmpegPath,
  ffprobePath,
  MIN_BITRATE,
  MAX_BITRATE,
  MP3_BITRATES,
  DENOISE_STRENGTH,
};
