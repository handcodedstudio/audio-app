'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const APP_PATH = require.resolve('../src/renderer/app.js');

const tick = () => new Promise((r) => setTimeout(r, 0));

// Load index.html into a fresh DOM, inject a mocked preload `api`, then run
// app.js against it exactly as the renderer would.
function setup({ chooseFile = null, processResult = { canceled: true } } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/' });
  const win = dom.window;

  const calls = { reveal: [], process: [] };
  let updateCb = null;
  win.api = {
    chooseFile: async () => chooseFile,
    inspectFile: async () => null,
    pathForFile: (f) => '/dropped/' + f.name,
    process: async (opts) => { calls.process.push(opts); return processResult; },
    revealFile: (p) => { calls.reveal.push(p); },
    onStatus: () => () => {},
    onUpdateStatus: (cb) => { updateCb = cb; return () => {}; },
  };

  global.window = win;
  global.document = win.document;
  global.setTimeout = setTimeout;

  delete require.cache[APP_PATH];
  require(APP_PATH);

  const $ = (id) => win.document.getElementById(id);
  return { win, $, calls, emitUpdate: (payload) => updateCb(payload) };
}

test('Start is disabled with no file selected', () => {
  const { $ } = setup();
  assert.equal($('startBtn').disabled, true);
});

test('Start enables once a valid file + size are set', async () => {
  const { $ } = setup({ chooseFile: { path: '/a.mp3', name: 'a.mp3', sizeMB: 5 } });
  $('chooseBtn').click();
  await tick();
  assert.equal($('startBtn').disabled, false);
});

test('Invalid max size keeps Start disabled', async () => {
  const { $, win } = setup({ chooseFile: { path: '/a.mp3', name: 'a.mp3', sizeMB: 5 } });
  $('chooseBtn').click();
  await tick();
  const maxMB = $('maxMB');
  maxMB.value = '0';
  maxMB.dispatchEvent(new win.Event('input'));
  assert.equal($('startBtn').disabled, true);
});

test('Noise-removal strength selector is hidden until denoise is ticked', () => {
  const { $, win } = setup();
  assert.ok($('strengthField').classList.contains('hidden'));
  const dn = $('denoise');
  dn.checked = true;
  dn.dispatchEvent(new win.Event('change'));
  assert.ok(!$('strengthField').classList.contains('hidden'));
});

test('Processing passes the selected options through to the main process', async () => {
  const { $, win, calls } = setup({
    chooseFile: { path: '/a.mp3', name: 'a.mp3', sizeMB: 20 },
    processResult: { canceled: false, savedPath: '/out.mp3', sizeMB: 8, bitrate: 128, underTarget: true },
  });
  $('chooseBtn').click();
  await tick();
  $('denoise').checked = true;
  $('denoise').dispatchEvent(new win.Event('change'));
  $('denoiseStrength').value = 'strong';
  $('normalise').checked = true;
  $('startBtn').click();
  await tick();
  assert.equal(calls.process.length, 1);
  assert.deepEqual(calls.process[0], {
    inputPath: '/a.mp3', maxMB: 10, normalise: true, denoise: true, denoiseStrength: 'strong',
  });
});

test('Successful result shows a summary and enables "Show in folder"', async () => {
  const { $, win, calls } = setup({
    chooseFile: { path: '/a.mp3', name: 'a.mp3', sizeMB: 20 },
    processResult: { canceled: false, savedPath: '/out.mp3', sizeMB: 8.2, bitrate: 128, underTarget: true },
  });
  $('chooseBtn').click();
  await tick();
  $('startBtn').click();
  await tick();
  assert.ok(!$('result').classList.contains('hidden'));
  assert.match($('resultText').textContent, /128 kbps/);
  $('revealBtn').click();
  assert.deepEqual(calls.reveal, ['/out.mp3']);
});

test('Copied (already-under-target) result is reported as a copy', async () => {
  const { $, win } = setup({
    chooseFile: { path: '/a.mp3', name: 'a.mp3', sizeMB: 4 },
    processResult: { canceled: false, savedPath: '/out.mp3', sizeMB: 4, bitrate: null, underTarget: true, copied: true },
  });
  $('chooseBtn').click();
  await tick();
  $('startBtn').click();
  await tick();
  assert.match($('resultText').textContent, /copy/i);
});

test('Update status renders for "checking" and stays quiet on "error"', () => {
  const { $, emitUpdate } = setup();
  emitUpdate({ state: 'checking' });
  assert.ok(!$('updateStatus').classList.contains('hidden'));
  assert.match($('updateStatus').textContent, /Checking/);

  emitUpdate({ state: 'error' });
  assert.ok($('updateStatus').classList.contains('hidden'));
});

test('Non-MP3 drop shows an error message', async () => {
  const { $, win } = setup();
  const dt = { files: [{ name: 'notes.txt' }] };
  const ev = new win.Event('drop');
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  win.document.dispatchEvent(ev);
  await tick();
  assert.ok(!$('error').classList.contains('hidden'));
  assert.match($('error').textContent, /isn’t an MP3/);
});
