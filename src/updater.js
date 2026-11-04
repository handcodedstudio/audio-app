'use strict';

const { autoUpdater } = require('electron-updater');
const { dialog } = require('electron');

// Wire up auto-updates against GitHub Releases.
// Called once after the main window is ready.
function initAutoUpdater(getWindow) {
  // Don't auto-download; ask the user first so a large download never
  // starts silently mid-use.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Push a compact status to the renderer so it can show update state in-window.
  const emit = (state, detail) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update-status', { state, detail });
  };

  autoUpdater.on('checking-for-update', () => emit('checking'));
  autoUpdater.on('update-not-available', () => emit('up-to-date'));

  autoUpdater.on('download-progress', (p) => {
    emit('downloading', { percent: Math.round(p.percent) });
  });

  autoUpdater.on('error', (err) => {
    // Never interrupt the user over a failed update check — just log it.
    console.error('Auto-update error:', err == null ? 'unknown' : (err.stack || err).toString());
    emit('error');
  });

  autoUpdater.on('update-available', async (info) => {
    emit('available', { version: info.version });
    const win = getWindow();
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `Audio Shrink ${info.version} is available.`,
      detail: 'Would you like to download it now? You can keep using the app while it downloads.',
    });
    if (response === 0) autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-downloaded', async (info) => {
    emit('downloaded', { version: info.version });
    const win = getWindow();
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Audio Shrink ${info.version} has been downloaded.`,
      detail: 'Restart the app to apply the update. It will also install automatically next time you quit.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  // Check on startup; electron-updater no-ops in dev (unpackaged) builds.
  autoUpdater.checkForUpdates().catch(() => { /* handled by 'error' listener */ });
}

module.exports = { initAutoUpdater };
