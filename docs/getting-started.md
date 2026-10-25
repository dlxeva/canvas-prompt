# Getting Started (Runtime, development, and compatibility hosts)

This document hosts the detailed operational sections that are too long for the
project README.

## Runtime dependencies and capability contract

Canvas Prompt is local-first, not zero-dependency. A clean machine needs:

| Layer | Requirement | How it is handled |
| --- | --- | --- |
| Core canvas | Node.js `22.12+`, npm | Required from the host machine; app packages are installed once and reused. |
| Compiler | Python `3.11+` | Required from the host machine; current Process IR compiler uses the Python standard library only. |
| Speech transcription | Managed Canvas Prompt ASR runtime | Installed under `~/.canvas-prompt/runtime/asr-venv` (or `CANVAS_PROMPT_RUNTIME_DIR`); first start downloads the selected `faster-whisper` model to local cache. No private project/global Whisper/ffmpeg assumptions. |
| Voice capture | Browser microphone permission | Required only when recording. |
| PDF review | Bundled PDF.js runtime | Renders selected PDF locally; source file remains read-only. |
| PPTX review | Local LibreOffice `soffice` executable | Converts selected PPTX to isolated review-only PDF derivative; source presentation not edited. |
| Optional OCR research | Separate `research/ocr` package | Opt-in only; its dependencies are not part of the root or app install. |
| AI continuation | Single-board MCP | Reads latest completed single-board round after explicit continuation command. |

PPTX review is available when `soffice` is on `PATH` or `CANVAS_PROMPT_SOFFICE_BIN`
points to a compatible executable. If missing, the app marks PPTX review as
unavailable; PDF review continues to work.

`setup` prepares local ASR by default. It is not an optional hidden path.
The isolated runtime measured about **235 MB** in the current macOS arm64 check,
and the base speech model downloads about **148 MB** into the local cache on
first start. Exact size and first-start time vary by platform and network. If
you only need visual context, use `setup --core-only` or set
`CANVAS_PROMPT_ASR=disabled`.

The default app has no OCR, Paddle, OpenCV, or ONNX engine dependency. The
optional research smoke can be installed and run in its own directory:

```bash
cd research/ocr
npm install --ignore-scripts
npm run dev
```

This package owns its OCR runner and cache. It does not change the App,
Prompt Package, API, MCP, Python, or launcher contracts.

macOS arm64 has current public runtime verification; Intel macOS, Windows, and
Linux remain acceptance-test targets.

The launcher does not scan arbitrary folders for Whisper/ffmpeg. It reuses ASR only
after local health checks confirm compatibility.

Before session start, Canvas Prompt checks ASR health. If ASR is not ready, the
session still records visuals and is explicitly marked as audio-only capture.

## Local development

For a local personal-marketplace checkout, the plugin can also be installed with:

```bash
codex plugin add canvas-prompt@personal
```

```bash
# Install/reuse the Canvas Prompt app and local ASR runtime.
node bin/canvas-prompt.mjs setup --project /absolute/path/to/active-project

# Inspect project binding, ASR readiness, and MCP configuration.
node bin/canvas-prompt.mjs doctor --project /absolute/path/to/active-project

# Optional: migrate full rounds from a legacy archive into the active board.
node bin/canvas-prompt.mjs migrate --from /absolute/path/to/legacy-project

# Start managed ASR and open the canvas.
# Use --host codex only inside Codex.
node bin/canvas-prompt.mjs open --host codex --project /absolute/path/to/active-project
```

Open the URL printed by the launcher. Port `43223` is preferred, fallback is a
local alternate port.

## Dev/preview API parity and isolated browser checks

`app/vite.config.ts` registers the same `registerCanvasApi` middleware through
both Vite `configureServer` and `configurePreviewServer`. Dev and preview
therefore use the same local API boundary, including runtime identity/session,
token-protected round reads and media/package uploads. Use loopback only:

```bash
# Development server.
npm --prefix app run dev -- --host 127.0.0.1 --port 43223 --strictPort

# Preview server, after the production build.
npm --prefix app run build
(cd app && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort)
```

The browser harness starts these servers with a random available port and a
fresh temporary data/project pair. Its default environment is
`CANVAS_PROMPT_ASR=disabled` and `CANVAS_PROMPT_DELIVERY_MODE=local`.

For an isolated local browser tool directory, set the configurable Playwright
and browser paths before running the checks:

```bash
BROWSER_TOOLS="$(mktemp -d "${TMPDIR:-/tmp}/canvas-browser-tools.XXXXXX")"
npm install --prefix "$BROWSER_TOOLS" --no-package-lock --ignore-scripts playwright@1.62.1
node "$BROWSER_TOOLS/node_modules/playwright/cli.js" install chromium
export CANVAS_PROMPT_PLAYWRIGHT_MODULE="$BROWSER_TOOLS/node_modules/playwright"
export CANVAS_PROMPT_CHROME_PATH="$(node -e 'console.log(require(process.argv[1]).chromium.executablePath())' "$CANVAS_PROMPT_PLAYWRIGHT_MODULE")"

# Or point at an already managed local Chrome executable.
# export CANVAS_PROMPT_CHROME_PATH="/path/to/Google Chrome"
```

For the real PPTX-to-PDF smoke, point the converter at an isolated or managed
LibreOffice executable and check it before running the harness:

```bash
export CANVAS_PROMPT_SOFFICE_BIN="/path/to/isolated/soffice"
"$CANVAS_PROMPT_SOFFICE_BIN" --version
node scripts/artifact-review-browser-harness.mjs --scenario pptx
```

Run the candidate checks with the same temporary-data boundary:

```bash
node scripts/round-export-browser-harness.mjs --scenario smoke --server dev
node scripts/round-export-browser-harness.mjs --scenario smoke --server preview
npm run test:browser:round-export
npm run test:browser:artifact-review
node scripts/artifact-review-browser-harness.mjs --scenario responsive
```

The round-export `all` command covers dev recovery, explicit upload retry,
partial media failure, two-round isolation, and preview smoke. The harnesses
do not override `HOME`, reuse a real board, or claim a published runtime.

The browser checks disable ASR and use a local test route. They do not verify a
real microphone session, human ASR quality, or remote-host handoff. The remote
CI browser matrix provisions isolated Playwright/Chromium tools and runs the
same candidate checks; it does not establish human acceptance or real ASR
coverage.

## Other AI terminals, CLI tools, and agents (compatibility path)

Compatibility-hosts should use the host-neutral CLI:

```bash
node bin/canvas-prompt.mjs init --project /absolute/path/to/active-project
node bin/canvas-prompt.mjs setup --project /absolute/path/to/active-project
node bin/canvas-prompt.mjs open --project /absolute/path/to/active-project
```

`init` emits MCP configuration for the single active board. After saving and local
compilation, the host can read the latest completed package through MCP.

v0.1 does not promise native side panels, automatic chat injection, or automatic
continuation in non-Codex hosts.
