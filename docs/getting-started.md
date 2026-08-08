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
