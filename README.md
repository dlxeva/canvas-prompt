# Canvas Prompt for Codex

[简体中文](./README.zh-CN.md) · English

Canvas Prompt is a local thinking canvas for the work that happens before a clean chat prompt exists.

Draw, circle, move, and explain. Canvas Prompt preserves the canvas state, event timeline, voice alignment, and revisions as a project-local **Prompt Package** that Codex can inspect while keeping observations, inferences, and unresolved points separate.

## Alpha scope

- **Reasoning rounds**: preserve how a question took shape, including branches, movement, resizing, deletion, and revision.
- **Image review rounds**: place an image on the canvas, mark regions, and explain requested changes aloud.
- **Project-local archive**: save the Prompt Package, original recording, canvas snapshot, Process IR, Compact Package, and handoff receipt under the active project's `.canvas-prompt/` directory.
- **Codex handoff**: submit one immutable round to the current Codex task and distinguish local save, task acceptance, delivery, and failure.
- **Evidence boundary**: retain observable canvas and speech evidence without presenting inferred intent as a direct fact.

This alpha does not include in-canvas AI generation, automated teaching, BoardScript write-back, or PDF/PPT review. OCR exists as an isolated research path and is not enabled in the main app flow.

## Requirements

The current alpha is validated on macOS with Codex Desktop. Local development requires:

- Node.js `22.12` or newer and npm;
- Python `3.11` or newer for the Process IR compiler and validators;
- microphone permission for voice capture;
- an optional local ASR service at `http://127.0.0.1:8080` for timestamped transcription.

Without the local ASR service, canvas actions and snapshots still work and the original recording can be archived, but timestamped speech evidence will be unavailable. The first development start may download npm dependencies.

## Local development

```bash
npm ci
npm --prefix app ci
npm run verify
./scripts/start-canvas.sh /absolute/path/to/active-project
```

Open the URL printed by the launcher. It prefers `http://127.0.0.1:43223/` and selects another local port when necessary.

## Plugin installation status

The development source of truth is the plugin directory itself. The local personal marketplace can install it with:

```bash
codex plugin add canvas-prompt@personal
```

A public Git marketplace release is planned at `dlxeva/canvas-prompt`. These commands are valid only after that repository contains the release layout `.agents/plugins/marketplace.json` plus `plugins/canvas-prompt/`:

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin add canvas-prompt@canvas-prompt
```

After installing or updating the plugin, open a new Codex task so the current skills and MCP tools are loaded.

## Privacy

See [PRIVACY.md](./PRIVACY.md) or [隐私说明](./PRIVACY.zh-CN.md). Do not publish `.canvas-prompt/` data or real recordings, screenshots, transcripts, or whiteboards without explicit permission.

## License

Canvas Prompt-owned code is available under [AGPL-3.0-or-later](./LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
