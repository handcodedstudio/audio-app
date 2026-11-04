'use strict';

// Repairs an incomplete Electron install. The `extract-zip` step electron's
// own postinstall uses can fail silently in some sandboxed environments,
// leaving a truncated app bundle (missing the Electron Framework) that can't
// launch. This re-extracts the already-downloaded, cached zip with the system
// archiver. It is a safe no-op when Electron is already healthy, and never
// throws — a repair failure must not break `npm install`.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function log(msg) { console.log(`[fix-electron] ${msg}`); }

function relBinaryFor(platform) {
  if (platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  if (platform === 'win32') return 'electron.exe';
  return 'electron';
}

function isHealthy(distDir, platform) {
  const binary = path.join(distDir, relBinaryFor(platform));
  if (!fs.existsSync(binary)) return false;
  // On macOS the framework is the piece that goes missing on a bad extract.
  if (platform === 'darwin') {
    return fs.existsSync(path.join(distDir, 'Electron.app/Contents/Frameworks/Electron Framework.framework'));
  }
  return true;
}

function cacheRoot(platform) {
  if (process.env.electron_config_cache) return process.env.electron_config_cache;
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'electron');
  if (platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'electron', 'Cache');
  return path.join(os.homedir(), '.cache', 'electron');
}

// Find the cached zip for this exact version/platform/arch (nested under a hash dir).
function findCachedZip(root, name) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      const hit = findCachedZip(full, name);
      if (hit) return hit;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}

function extract(zip, destDir) {
  // bsdtar (macOS + Windows 10+) extracts zips; fall back to `unzip` (Linux).
  try {
    execFileSync('tar', ['-xf', zip, '-C', destDir], { stdio: 'ignore' });
    return true;
  } catch {
    try {
      execFileSync('unzip', ['-q', '-o', zip, '-d', destDir], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

function main() {
  let electronDir;
  try {
    electronDir = path.dirname(require.resolve('electron/package.json'));
  } catch {
    return; // electron not installed (e.g. production install) — nothing to do
  }

  const platform = process.platform;
  const arch = process.arch;
  const version = require(path.join(electronDir, 'package.json')).version;
  const distDir = path.join(electronDir, 'dist');
  const pathTxt = path.join(electronDir, 'path.txt');
  const relBinary = relBinaryFor(platform);

  if (isHealthy(distDir, platform)) {
    if (!fs.existsSync(pathTxt)) fs.writeFileSync(pathTxt, relBinary);
    return;
  }

  log('Electron install looks incomplete — attempting to repair from cache…');
  const zipName = `electron-v${version}-${platform}-${arch}.zip`;
  const zip = findCachedZip(cacheRoot(platform), zipName);
  if (!zip) {
    log(`No cached ${zipName} found. Run "npm install" again with a network connection.`);
    return;
  }

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  if (!extract(zip, distDir)) {
    log('Could not extract the cached zip (no working tar/unzip). Repair skipped.');
    return;
  }

  if (isHealthy(distDir, platform)) {
    fs.writeFileSync(pathTxt, relBinary);
    log('Repair complete.');
  } else {
    log('Repair ran but the bundle still looks incomplete.');
  }
}

try {
  main();
} catch (err) {
  // Never fail the install over a repair attempt.
  log(`Skipped: ${err && err.message ? err.message : err}`);
}
