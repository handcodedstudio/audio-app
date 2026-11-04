'use strict';

// electron-builder `beforePack` hook.
//
// `ffmpeg-static` only ships a single architecture (the build host's), but our
// macOS build is **universal** (arm64 + x64). This stages BOTH macOS ffmpeg
// binaries into `resources/ffmpeg/` so the packaged app can pick the matching
// one at runtime (see resolveFfmpeg() in src/audio.js). `ffprobe-static`
// already bundles every arch, so only ffmpeg needs this.
//
// No-op on non-macOS targets.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FFMPEG_DIR = path.join(ROOT, 'node_modules', 'ffmpeg-static');
const HOST_BINARY = path.join(FFMPEG_DIR, 'ffmpeg');
const OUT_DIR = path.join(ROOT, 'resources', 'ffmpeg');

function copyExec(src, dst) {
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
}

// Download a specific arch's ffmpeg via ffmpeg-static's own installer, restoring
// the host binary afterwards so local dev / node_modules is left untouched.
function fetchArch(arch, dst) {
  const backup = path.join(os.tmpdir(), `ffmpeg-host-${process.arch}.bak`);
  fs.copyFileSync(HOST_BINARY, backup);
  try {
    fs.rmSync(HOST_BINARY, { force: true });
    execFileSync(process.execPath, [path.join(FFMPEG_DIR, 'install.js')], {
      env: { ...process.env, npm_config_platform: 'darwin', npm_config_arch: arch },
      stdio: 'inherit',
    });
    copyExec(HOST_BINARY, dst);
  } finally {
    fs.copyFileSync(backup, HOST_BINARY); // restore host arch
    fs.rmSync(backup, { force: true });
  }
}

function stageMacFfmpeg() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const host = process.arch;                       // 'arm64' | 'x64'
  const other = host === 'arm64' ? 'x64' : 'arm64';

  copyExec(HOST_BINARY, path.join(OUT_DIR, `ffmpeg-${host}`));

  const otherOut = path.join(OUT_DIR, `ffmpeg-${other}`);
  if (!fs.existsSync(otherOut)) {
    console.log(`[before-pack] fetching ${other} ffmpeg for the universal build…`);
    fetchArch(other, otherOut);
  }
  console.log(`[before-pack] staged ffmpeg: ${fs.readdirSync(OUT_DIR).join(', ')}`);
}

module.exports = async function beforePack(context) {
  if (context.electronPlatformName === 'darwin') stageMacFfmpeg();
};
