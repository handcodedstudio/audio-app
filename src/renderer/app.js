'use strict';

const el = (id) => document.getElementById(id);
const drop = el('drop');
const dropLabel = el('dropLabel');
const fileInfo = el('fileInfo');
const chooseBtn = el('chooseBtn');
const maxMB = el('maxMB');
const normalise = el('normalise');
const denoise = el('denoise');
const denoiseStrength = el('denoiseStrength');
const strengthField = el('strengthField');
const startBtn = el('startBtn');
const progressWrap = el('progressWrap');
const progressBar = el('progressBar');
const statusText = el('statusText');
const result = el('result');
const resultText = el('resultText');
const revealBtn = el('revealBtn');
const errorBox = el('error');
const updateStatus = el('updateStatus');

let lastSavedPath = null;

let selected = null; // { path, name, sizeMB }

function fmtMB(n) {
  return `${n.toFixed(1)} MB`;
}

function setFile(info) {
  selected = info;
  if (info) {
    fileInfo.textContent = `${info.name} (${fmtMB(info.sizeMB)})`;
    fileInfo.classList.remove('hidden');
    dropLabel.classList.add('hidden');
  } else {
    fileInfo.classList.add('hidden');
    dropLabel.classList.remove('hidden');
  }
  refresh();
}

function validMax() {
  const v = parseFloat(maxMB.value);
  return isFinite(v) && v > 0;
}

function refresh() {
  startBtn.disabled = !(selected && validMax());
}

function clearOutcome() {
  result.classList.add('hidden');
  errorBox.classList.add('hidden');
}

// --- File selection ---------------------------------------------------------

chooseBtn.addEventListener('click', async () => {
  clearOutcome();
  const info = await window.api.chooseFile();
  if (info) setFile(info);
});

// Accept a drop anywhere in the window, with the drop zone highlighting.
['dragenter', 'dragover'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    // Only clear the highlight when the pointer actually leaves the window.
    if (ev === 'dragleave' && e.relatedTarget) return;
    drop.classList.remove('dragover');
  })
);

document.addEventListener('drop', async (e) => {
  clearOutcome();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const filePath = window.api.pathForFile(file);
  const info = await window.api.inspectFile(filePath);
  if (info) setFile(info);
  else showError(`“${file.name}” isn’t an MP3. Please drop a .mp3 file.`);
});

maxMB.addEventListener('input', refresh);

// Show the strength selector only when "Remove white noise" is ticked.
denoise.addEventListener('change', () => {
  strengthField.classList.toggle('hidden', !denoise.checked);
});

// --- Processing -------------------------------------------------------------

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

function setBusy(busy) {
  startBtn.disabled = busy || !(selected && validMax());
  chooseBtn.disabled = busy;
  maxMB.disabled = busy;
  normalise.disabled = busy;
  denoise.disabled = busy;
  denoiseStrength.disabled = busy;
  startBtn.textContent = busy ? 'Processing…' : 'Start';
}

let unsubscribe = null;

startBtn.addEventListener('click', async () => {
  clearOutcome();
  setBusy(true);
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '0%';
  statusText.textContent = 'Starting…';

  unsubscribe = window.api.onStatus(({ stage, progress }) => {
    statusText.textContent = stage;
    progressBar.style.width = `${Math.round((progress || 0) * 100)}%`;
  });

  try {
    const res = await window.api.process({
      inputPath: selected.path,
      maxMB: parseFloat(maxMB.value),
      normalise: normalise.checked,
      denoise: denoise.checked,
      denoiseStrength: denoiseStrength.value,
    });

    if (res.canceled) {
      statusText.textContent = 'Cancelled — nothing saved.';
    } else {
      let summary;
      if (res.copied) {
        summary = `Already under ${fmtMB(parseFloat(maxMB.value))} — saved a copy (${fmtMB(res.sizeMB)}).`;
      } else {
        const warn = res.underTarget ? '' : ' (smallest possible — slightly over the target)';
        summary = `Done — ${fmtMB(res.sizeMB)} at ${res.bitrate} kbps${warn}.`;
      }
      resultText.textContent = summary;
      lastSavedPath = res.savedPath;
      result.classList.remove('hidden');
      statusText.textContent = '';
      progressBar.style.width = '100%';
    }
  } catch (err) {
    showError(err.message || String(err));
    statusText.textContent = '';
  } finally {
    setBusy(false);
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }
});

// --- Reveal in folder (#8) --------------------------------------------------

revealBtn.addEventListener('click', () => {
  if (lastSavedPath) window.api.revealFile(lastSavedPath);
});

// --- Auto-update status (#18) -----------------------------------------------

window.api.onUpdateStatus(({ state, detail }) => {
  const messages = {
    checking: 'Checking for updates…',
    'up-to-date': 'Audio Shrink is up to date.',
    available: `Update available: ${detail && detail.version ? detail.version : ''}`.trim(),
    downloading: `Downloading update… ${detail && detail.percent != null ? detail.percent + '%' : ''}`.trim(),
    downloaded: 'Update downloaded — restart to apply.',
    error: '', // stay quiet on update errors
  };
  const msg = messages[state];
  if (!msg) {
    updateStatus.classList.add('hidden');
    return;
  }
  updateStatus.textContent = msg;
  updateStatus.classList.remove('hidden');
  // Fade the transient "up to date" message away after a few seconds.
  if (state === 'up-to-date') {
    setTimeout(() => updateStatus.classList.add('hidden'), 4000);
  }
});

refresh();
