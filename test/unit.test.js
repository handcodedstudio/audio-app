'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const audio = require('../src/audio.js');

test('targetBitrate: picks a valid MP3 bitrate', () => {
  const b = audio.targetBitrate(5, 180);
  assert.ok(audio.MP3_BITRATES.includes(b), `${b} should be a valid MP3 bitrate`);
});

test('targetBitrate: result keeps file under the ceiling (with safety margin)', () => {
  // For a chosen bitrate b (kbps), size = b*1000/8 * duration bytes.
  const durations = [30, 120, 600];
  const sizes = [1, 5, 10, 25];
  for (const dur of durations) {
    for (const maxMB of sizes) {
      const b = audio.targetBitrate(maxMB, dur);
      const estBytes = (b * 1000 / 8) * dur;
      const estMB = estBytes / (1024 * 1024);
      // Only assert when we didn't bottom out at the floor bitrate.
      if (b > audio.MIN_BITRATE) {
        assert.ok(estMB <= maxMB, `dur=${dur} max=${maxMB} chose ${b}kbps -> ~${estMB.toFixed(2)}MB exceeds ceiling`);
      }
    }
  }
});

test('targetBitrate: short+generous target does not exceed the max bitrate', () => {
  const b = audio.targetBitrate(100, 10); // huge allowance
  assert.equal(b, audio.MAX_BITRATE);
});

test('targetBitrate: tiny target floors at MIN_BITRATE', () => {
  const b = audio.targetBitrate(0.01, 600); // impossible ceiling
  assert.equal(b, audio.MIN_BITRATE);
});

test('targetBitrate: higher ceiling never gives a lower bitrate', () => {
  const dur = 300;
  let prev = 0;
  for (const maxMB of [1, 2, 4, 8, 16, 32]) {
    const b = audio.targetBitrate(maxMB, dur);
    assert.ok(b >= prev, `bitrate should be monotonic: ${b} < ${prev}`);
    prev = b;
  }
});

test('stepDown: returns the next valid bitrate below', () => {
  assert.equal(audio.stepDown(128), 112);
  assert.equal(audio.stepDown(40), 32);
});

test('stepDown: returns null at the floor', () => {
  assert.equal(audio.stepDown(32), null);
});

test('buildFilters: empty when no options selected', () => {
  assert.deepEqual(audio.buildFilters({ normalise: false, denoise: false }), []);
});

test('buildFilters: denoise adds highpass + afftdn', () => {
  const f = audio.buildFilters({ normalise: false, denoise: true });
  assert.ok(f.some((x) => x.startsWith('highpass')));
  assert.ok(f.some((x) => x.startsWith('afftdn')));
});

test('buildFilters: normalise adds loudnorm with -16 LUFS target', () => {
  const f = audio.buildFilters({ normalise: true, denoise: false });
  assert.ok(f.some((x) => x.startsWith('loudnorm') && x.includes('I=-16')));
});

test('buildFilters: denoise precedes normalise when both set', () => {
  const f = audio.buildFilters({ normalise: true, denoise: true });
  const hp = f.findIndex((x) => x.startsWith('highpass'));
  const ln = f.findIndex((x) => x.startsWith('loudnorm'));
  assert.ok(hp >= 0 && ln >= 0 && hp < ln, 'filters ordered denoise -> normalise');
});

test('parseProgressTime: parses ffmpeg time= into seconds', () => {
  assert.equal(audio.parseProgressTime('frame= time=00:01:30.50 bitrate='), 90.5);
  assert.equal(audio.parseProgressTime('time=01:00:00.00'), 3600);
});

test('parseProgressTime: returns null when no time present', () => {
  assert.equal(audio.parseProgressTime('no timing here'), null);
});
