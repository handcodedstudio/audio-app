'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const audio = require('./audio');
const { initAutoUpdater } = require('./updater');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    fullscreenable: false,
    title: 'Audio Shrink',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  initAutoUpdater(() => mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Let the user pick an MP3.
ipcMain.handle('choose-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose an MP3',
    properties: ['openFile'],
    filters: [{ name: 'MP3 Audio', extensions: ['mp3'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const stat = fs.statSync(filePath);
  return { path: filePath, name: path.basename(filePath), sizeMB: stat.size / (1024 * 1024) };
});

// Validate a path dropped onto the window.
ipcMain.handle('inspect-file', async (_e, filePath) => {
  if (!filePath || path.extname(filePath).toLowerCase() !== '.mp3') return null;
  try {
    const stat = fs.statSync(filePath);
    return { path: filePath, name: path.basename(filePath), sizeMB: stat.size / (1024 * 1024) };
  } catch {
    return null;
  }
});

// Reveal a saved file in Finder / Explorer.
ipcMain.handle('reveal-file', (_e, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});

async function askSavePath(inputPath) {
  const base = path.basename(inputPath, path.extname(inputPath));
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Save processed MP3',
    defaultPath: `${base}-processed.mp3`,
    filters: [{ name: 'MP3 Audio', extensions: ['mp3'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return null;
  return saveResult.filePath;
}

ipcMain.handle('process', async (event, opts) => {
  const { inputPath, maxMB, normalise, denoise, denoiseStrength } = opts;
  const send = (channel, payload) => event.sender.send(channel, payload);

  // 1. Probe duration + current size.
  send('status', { stage: 'Reading file…', progress: 0 });
  const duration = await audio.probeDuration(inputPath);
  const inputSizeMB = fs.statSync(inputPath).size / (1024 * 1024);

  // Short-circuit: nothing to process and it already fits — just copy it,
  // avoiding a needless re-encode and quality loss.
  if (!normalise && !denoise && inputSizeMB <= maxMB) {
    const savePath = await askSavePath(inputPath);
    if (!savePath) return { canceled: true };
    fs.copyFileSync(inputPath, savePath);
    return {
      canceled: false,
      savedPath: savePath,
      sizeMB: inputSizeMB,
      bitrate: null,
      underTarget: true,
      copied: true,
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshrink-'));
  const tmpOut = path.join(tmpDir, 'out.mp3');

  try {
    // 2. Two-pass normalisation: measure loudness first for an accurate result.
    let loudnormMeasured = null;
    if (normalise) {
      send('status', { stage: 'Analysing loudness…', progress: 0 });
      loudnormMeasured = await audio.measureLoudness({
        input: inputPath,
        denoise,
        denoiseStrength,
        durationSec: duration,
        onProgress: (p) => send('status', { stage: 'Analysing loudness…', progress: p }),
      });
    }

    // 3. Work out the starting bitrate for the hard ceiling.
    const stageLabel = denoise && normalise ? 'Denoising & normalising…'
      : denoise ? 'Reducing noise…'
        : normalise ? 'Normalising…'
          : 'Encoding…';

    let finalBitrate = audio.targetBitrate(maxMB, duration);
    let resultSizeMB;
    for (;;) {
      send('status', { stage: `${stageLabel} (${finalBitrate} kbps)`, progress: 0 });
      await audio.encode({
        input: inputPath,
        output: tmpOut,
        bitrate: finalBitrate,
        normalise,
        denoise,
        denoiseStrength,
        loudnormMeasured,
        durationSec: duration,
        onProgress: (p) => send('status', { stage: `${stageLabel} (${finalBitrate} kbps)`, progress: p }),
      });

      resultSizeMB = fs.statSync(tmpOut).size / (1024 * 1024);
      if (resultSizeMB <= maxMB) break; // within the ceiling

      const lower = audio.stepDown(finalBitrate);
      if (!lower) break; // already at the lowest bitrate; can't shrink further
      finalBitrate = lower;
    }

    // 4. Ask where to save and copy the result out.
    send('status', { stage: 'Saving…', progress: 1 });
    const savePath = await askSavePath(inputPath);
    if (!savePath) return { canceled: true };

    fs.copyFileSync(tmpOut, savePath);

    return {
      canceled: false,
      savedPath: savePath,
      sizeMB: resultSizeMB,
      bitrate: finalBitrate,
      underTarget: resultSizeMB <= maxMB,
      copied: false,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
