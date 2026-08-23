# AGENTS.md

## Commands

```bash
npm run dev            # Web dev server at http://localhost:5173
npm run dev:desktop    # Dev server + Electron window
npm run lint           # eslint . (the ONLY check — no tests, no typecheck)
npm run build          # Web build -> dist/
npm run build:desktop  # Vite build + electron-builder -mwl (all 3 OSes, local only)
```

- Verify changes with `npm run lint`. There is no test suite and no TypeScript.
- There is no backend: extraction is 100% client-side (ffmpeg.wasm). The old Express API (`server/`) and its Scaleway deploy workflow were removed.

## Gotchas

- **Electron is opt-in**: the electron plugin only activates when env `VITE_ELECTRON=true` (see `vite.config.js`). Plain `vite`/`npm run build` produces web-only output. Use `build:desktop:ci` to package only the current OS's installer (that's what CI runs).
- **COOP/COEP headers are mandatory** for ffmpeg.wasm (`SharedArrayBuffer`). They are set in two places that must stay in sync: `vite.config.js` (dev server) and `electron/main.js` (session headers + custom `app://` protocol handler). Production hosting must also send them.
- Electron prod loads the renderer via custom `app://` protocol instead of `file://` specifically so workers/WASM work (`electron/main.js`). Preload source is `electron/preload.js`, built as `preload.mjs`.
- PWA service worker `public/sw.js` pins a manual cache name (`framesnap-cache-v2`); bump it when changing precached assets or users get stale versions.

## Structure

- All web UI/extraction logic lives in one file: `src/App.jsx`. Entry is `src/main.jsx`.
- Extraction uses the FFmpeg `thumbnail` filter with two user-selectable modes:
  - **Fast**: single pass `-vf fps=1,thumbnail=2` for videos ≤ 120s; auto-falls back to the chunked engine beyond that threshold.
  - **Detailed**: always chunked. A metadata probe (`-i input.mp4`, no output) detects the real framerate first, then the thumbnail batch size is computed as `fps × 2s` (clamped 8–90) so the analysis window stays constant across 24/25/30/60 fps sources. Segments (`-ss` before `-i`, `-t` duration) are processed in a loop; after each segment frames are read via `readFile`, blob'd, then deleted from the MEMFS via `deleteFile` to cap RAM.
- Frame timestamps come from parsing `showinfo` filter logs (`parseShowinfoLogs`), with a per-segment time offset because `-ss` before `-i` resets `pts_time`.
- Progress is blended per segment via `progressCtxRef` consumed by the `ffmpeg.on('progress')` handler.
- `analyzeFrameImage` decodes each frame once and returns both the 16x16 RGB fingerprint (dedup) and a sharpness score (Laplacian variance on a downscaled grayscale copy); the gallery can be sorted by sharpness (`sortOrder: 'sharpness'`).
