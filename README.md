# Audio Shrink

A simple cross-platform desktop app (macOS + Windows) that takes **one MP3**, shrinks it to a **maximum size you choose**, and can optionally **normalise the audio** and **remove white noise**. Click **Start**, pick where to save, done.

Everything runs locally and offline — the audio engine (ffmpeg) is bundled inside the app, so end users install nothing extra.

---

## How it works

1. You select an MP3 and enter a maximum size in MB.
2. The app reads the audio duration and calculates the highest MP3 bitrate that keeps the file **at or below** your target (a "hard ceiling" — it is guaranteed to fit, trading quality if necessary).
3. If you ticked the options, it applies:
   - **Remove white noise** → a high-pass filter (removes low rumble/hum) plus `afftdn`, an adaptive FFT denoiser for steady background hiss. A **Light / Medium / Strong** selector controls how aggressively noise is reduced.
   - **Normalise audio** → **two-pass** `loudnorm` (EBU R128) targeting **−16 LUFS**, the standard for voice/podcast. The first pass measures the file's loudness so the second pass can correct it precisely.
4. It encodes with LAME MP3 at the chosen bitrate, verifies the result is under the ceiling (re-encoding one step lower in the rare case it overshoots), then prompts you to save the processed file. You can **Show in folder** to reveal the saved file.

> If no processing is requested and the file already fits under the target, it's saved as a direct copy — no needless re-encode or quality loss.

### The processing pipeline

| Step | Tool | Notes |
|------|------|-------|
| Read duration | `ffprobe` | Rejects corrupt / non-audio files |
| Pick bitrate | bitrate math | `maxMB → kbps`, 4% safety margin, clamped 32–320 kbps |
| Measure loudness | `loudnorm` (pass 1, `print_format=json`) | Only if "Normalise audio" is ticked; measures the (optionally denoised) signal |
| Denoise | `highpass=f=80, afftdn=nr=<6/12/24>` | Only if "Remove white noise" is ticked; `nr` set by strength |
| Normalise | `loudnorm=I=-16:TP=-1.5:LRA=11` + measured values | Pass 2, linear correction from the measurement |
| Encode | `libmp3lame` (CBR) | Predictable, under-ceiling output |

---

## Tech stack

- **Electron** — desktop shell (one codebase → Mac + Windows)
- **Vanilla HTML/CSS/JS** — the UI is a single screen, no framework needed
- **ffmpeg / ffprobe** via **`ffmpeg-static`** + **`ffprobe-static`** — bundled binaries, zero user setup
- **electron-builder** — produces the installers (`.dmg`, `.exe`)
- **electron-updater** — auto-updates from GitHub Releases
- **`node:test`** + **jsdom** — built-in test runner; jsdom drives the renderer UI tests

---

## Project layout

```
audio-app/
├── package.json          # scripts, deps, electron-builder config
├── LICENSE               # MIT
├── build/
│   ├── icon.png          # app icon (electron-builder generates .icns/.ico)
│   └── entitlements.mac.plist  # hardened-runtime entitlements for signing
├── scripts/
│   └── fix-electron.js   # postinstall: repairs a truncated Electron extract
├── src/
│   ├── main.js           # Electron main: window, dialogs, orchestration
│   ├── preload.js        # secure IPC bridge (contextIsolation)
│   ├── audio.js          # bitrate math + ffmpeg pipeline (the core logic)
│   ├── updater.js        # auto-update wiring (electron-updater)
│   └── renderer/
│       ├── index.html    # the single screen
│       ├── style.css
│       └── app.js        # UI state, drag/drop, progress
├── test/
│   ├── unit.test.js        # pure logic: bitrate math, filters, progress parsing
│   ├── integration.test.js # real ffmpeg: probe, measure, encode, size-ceiling loop
│   └── renderer.test.js    # jsdom: UI state, options wiring, update status
├── .github/workflows/release.yml  # tag-triggered build + publish
└── samples/              # test MP3s (git-ignored)
```

---

## Prerequisites

- **Node.js 18+** (developed on Node 24)
- npm 9+

No separate ffmpeg install is required — it comes in through npm.

---

## Getting started (development)

```bash
# Install dependencies (also downloads the bundled ffmpeg/ffprobe binaries)
npm install

# Launch the app in development
npm start
```

---

## Running the tests

```bash
npm test
```

This runs the full suite with Node's built-in test runner:

- **Unit tests** — bitrate selection (hard-ceiling math, monotonicity, floor/ceiling clamps), filter-chain construction and ordering, and ffmpeg progress parsing.
- **Integration tests** — generate a real MP3 with the bundled ffmpeg, then verify duration probing, loudness measurement, under-ceiling encoding, progress callbacks, normalise + denoise output validity, and the full step-down shrink loop.
- **Renderer tests** (jsdom) — load `index.html`, mock the preload `api`, and check UI state: Start enable/disable, the noise-strength toggle, the options passed to processing, result/reveal rendering, and the update-status line.

### Generate a sample file to test with manually

```bash
# ~30 MB, 13-minute MP3 (tone + white noise) for exercising shrink/normalise/denoise
node -e "const ff=require('ffmpeg-static');require('child_process').execFileSync(ff,['-y','-f','lavfi','-i','sine=frequency=440:duration=786','-f','lavfi','-i','anoisesrc=color=white:duration=786:amplitude=0.05','-filter_complex','[0][1]amix=inputs=2:duration=shortest','-ac','2','-ar','44100','-b:a','320k','samples/test-30mb.mp3'],{stdio:'inherit'})"
```

---

## Building installers

The build config lives under the `"build"` key in `package.json` (via electron-builder). The ffmpeg binaries are unpacked from the app archive (`asarUnpack`) so they remain executable at runtime.

```bash
npm run dist        # build for the current OS
npm run dist:mac    # macOS universal .dmg (+ .zip for auto-update)
npm run dist:win    # Windows .exe (NSIS installer)
```

The macOS build is a **universal** binary (Apple Silicon + Intel). Since `ffmpeg-static` only ships one architecture, a `beforePack` hook (`scripts/before-pack.js`) stages **both** Mac ffmpeg binaries into `resources/ffmpeg/`, and `resolveFfmpeg()` in `src/audio.js` picks the one matching the running arch. `ffprobe-static` already bundles every arch. The single-arch helper binaries are declared in `mac.x64ArchFiles` so the universal merge keeps them as-is.

Output appears in `dist/`.

> **Note:** cross-building a Windows installer from macOS (and vice-versa) can require extra tooling. The most reliable approach is to build each platform on its own OS (or in CI).

### Code signing / notarisation

**macOS signing + notarisation is configured** (see the `mac` block in `package.json` and `build/entitlements.mac.plist`). The app uses the hardened runtime, and `notarize: true` notarises via Apple's notarytool. Signing/notarisation only runs when the certificate is present — unsigned local builds (`npm run dist:mac` with no cert) are skipped automatically, so day-to-day development is unaffected.

To produce a signed, notarised Mac build you need an **Apple Developer ID Application** certificate ($99/yr) and these environment variables (set as repo secrets for CI — see `.github/workflows/release.yml`):

| Variable | What it is |
|----------|-----------|
| `CSC_LINK` | Your Developer ID `.p12`, base64-encoded (`base64 -i cert.p12`) |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your 10-character Apple Developer Team ID |

**Windows** still needs an Authenticode certificate to remove the SmartScreen warning, but installs and auto-updates work unsigned in the meantime.

---

## Auto-updates

The app updates itself from **GitHub Releases** using [`electron-updater`](https://www.electron.build/auto-update). On launch it checks for a newer release and, if one exists, prompts the user to download and then restart. Updates are **never** downloaded silently. Auto-update only runs in packaged builds — it no-ops during `npm start`.

### One-time setup

This is already configured in `package.json` → `build.publish` to point at the project repo:

```json
"publish": [
  { "provider": "github", "owner": "handcodedstudio", "repo": "audio-app" }
]
```

> **Note:** the repo is currently **private**. `electron-updater` cannot download release assets from a private repo without an access token embedded in the shipped app. For public auto-updates, either make the repo public or point `publish` at a dedicated public releases repo.

### Cutting a release

Releases are built and published by CI (`.github/workflows/release.yml`) when you push a version tag:

```bash
npm version patch       # bumps version in package.json + creates a git tag
git push --follow-tags  # triggers the GitHub Action (builds mac + win, runs tests, publishes)
```

The Action uploads the installers plus the update metadata (`latest.yml` / `latest-mac.yml`) to a GitHub Release. Installed apps pick it up on their next launch.

> Auto-update needs **two** releases to observe in action — the version a user has installed, and a newer one to update to.

To publish from your own machine instead of CI:

```bash
export GH_TOKEN=<GitHub personal access token with "repo" scope>
npm run release
```

### Signing requirements for updates

| Platform | Auto-update works unsigned? | Notes |
|----------|------------------------------|-------|
| **Windows** | ✅ Yes | Users see a SmartScreen warning on first install; an Authenticode cert removes it. Updates work either way. |
| **macOS** | ❌ No | Squirrel.Mac **refuses to apply updates to an unsigned app**. Signing + notarisation is already configured (see [Code signing / notarisation](#code-signing--notarisation)); it just needs an Apple Developer ID cert and the credential secrets to take effect. |

Add the five macOS signing secrets (listed under [Code signing / notarisation](#code-signing--notarisation)) as repository secrets, and the release workflow will produce signed, notarised Mac builds that can auto-update.

---

## Configuration notes

- **Normalisation target** is −16 LUFS (voice/podcast), applied as a two-pass `loudnorm`. To change it, edit `LOUDNORM_TARGET` in `src/audio.js`.
- **Denoise strength** maps Light/Medium/Strong to `afftdn` `nr` values of 6/12/24 dB — see `DENOISE_STRENGTH` in `src/audio.js`.
- **Bitrate range** is clamped to 32–320 kbps with a 4% size safety margin — see `MP3_BITRATES` / `SIZE_SAFETY` in `src/audio.js`.
- **Input/output** is MP3 only, by design.
- **App icon** lives at `build/icon.png` (1024×1024); electron-builder generates the platform `.icns`/`.ico` from it. Replace it with your own artwork anytime.

---

## Troubleshooting

### "Electron failed to install correctly"

The `extract-zip` step in Electron's own postinstall can fail silently in some sandboxed environments, leaving a truncated app bundle. The `postinstall` script (`scripts/fix-electron.js`) detects this and re-extracts the already-downloaded, cached zip automatically — it's a safe no-op when Electron is healthy. If you still hit the error, run it directly:

```bash
node scripts/fix-electron.js
```

If no cached zip exists yet, re-run `npm install` with a network connection first.
