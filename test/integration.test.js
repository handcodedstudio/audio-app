'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const audio = require('../src/audio.js');

const ffmpeg = require('ffmpeg-static');

let workDir;
let tonePath;
const DURATION = 15; // seconds

// Generate a real MP3 once for all integration tests.
test.before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-int-'));
  tonePath = path.join(workDir, 'tone.mp3');
  execFileSync(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${DURATION}`,
    '-ac', '2',
    '-b:a', '256k',
    tonePath,
  ]);
});

test.after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

const sizeMB = (p) => fs.statSync(p).size / (1024 * 1024);

test('probeDuration: reads duration of a real MP3', async () => {
  const dur = await audio.probeDuration(tonePath);
  assert.ok(Math.abs(dur - DURATION) < 1, `expected ~${DURATION}s, got ${dur}`);
});

test('probeDuration: rejects a non-audio file', async () => {
  const bogus = path.join(workDir, 'bogus.mp3');
  fs.writeFileSync(bogus, 'this is not audio');
  await assert.rejects(() => audio.probeDuration(bogus));
});

test('encode: output stays under the size ceiling', async () => {
  const dur = await audio.probeDuration(tonePath);
  const maxMB = 0.15;
  const bitrate = audio.targetBitrate(maxMB, dur);
  const out = path.join(workDir, 'shrunk.mp3');
  await audio.encode({
    input: tonePath, output: out, bitrate,
    normalise: false, denoise: false, durationSec: dur,
  });
  assert.ok(fs.existsSync(out));
  assert.ok(sizeMB(out) <= maxMB, `output ${sizeMB(out).toFixed(3)}MB exceeds ${maxMB}MB`);
});

test('encode: reports progress between 0 and 1', async () => {
  const dur = await audio.probeDuration(tonePath);
  const out = path.join(workDir, 'prog.mp3');
  const samples = [];
  await audio.encode({
    input: tonePath, output: out, bitrate: 128,
    normalise: false, denoise: false, durationSec: dur,
    onProgress: (p) => samples.push(p),
  });
  assert.ok(samples.length > 0, 'expected at least one progress callback');
  for (const p of samples) {
    assert.ok(p >= 0 && p <= 1, `progress ${p} out of range`);
  }
});

test('encode: produces a valid MP3 with normalise + denoise applied', async () => {
  const dur = await audio.probeDuration(tonePath);
  const out = path.join(workDir, 'clean.mp3');
  await audio.encode({
    input: tonePath, output: out, bitrate: 96,
    normalise: true, denoise: true, durationSec: dur,
  });
  // Re-probe the output: it must be readable and roughly the same length.
  const outDur = await audio.probeDuration(out);
  assert.ok(Math.abs(outDur - dur) < 1.5, `output duration ${outDur} drifted from ${dur}`);
});

test('full ceiling loop: stepping down guarantees under-target output', async () => {
  // Simulate main.js's shrink loop against a strict ceiling.
  const dur = await audio.probeDuration(tonePath);
  const maxMB = 0.08;
  let bitrate = audio.targetBitrate(maxMB, dur);
  const out = path.join(workDir, 'loop.mp3');
  let result;
  for (;;) {
    await audio.encode({
      input: tonePath, output: out, bitrate,
      normalise: false, denoise: false, durationSec: dur,
    });
    result = sizeMB(out);
    if (result <= maxMB) break;
    const lower = audio.stepDown(bitrate);
    if (!lower) break;
    bitrate = lower;
  }
  assert.ok(result <= maxMB || bitrate === audio.MIN_BITRATE,
    `final ${result.toFixed(3)}MB at ${bitrate}kbps not under ${maxMB}MB`);
});
