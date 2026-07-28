# Canvas Prompt — visual context for AI workflows

[简体中文](./README.zh-CN.md) · English

Canvas Prompt is a local thinking canvas for the work that happens before a clean chat prompt exists.

**First public release: Codex Desktop is the supported and recommended integration.** Canvas Prompt opens one local canvas and exports immutable rounds. Continue with the explicit command **“Continue with the canvas context”**; Codex then reads the single board's latest completed package through MCP. The active project is retained as package provenance, not as a routing key. Other MCP-capable terminals may read the portable archive, but are compatibility paths rather than promised equivalent UI or handoff experiences.

Draw, circle, move, and explain. Canvas Prompt preserves the canvas state, event timeline, voice alignment, and revisions as a device-local **Prompt Package** that Codex can inspect while keeping observations, inferences, and unresolved points separate.

## Alpha scope

- **Reasoning rounds**: preserve how a question took shape, including branches, movement, resizing, deletion, and revision.
- **Image review rounds**: paste or place the original image on the canvas, mark regions, and explain requested changes aloud. The annotated snapshot is the visual brief, while the unmarked original is archived separately and supplied as the edit reference. If no original was placed on the canvas, Canvas Prompt will not pretend a screenshot is an exact edit source; it asks for the original in chat when fidelity matters. When Codex produces a revised image, copy it from the conversation and press `⌘V` on the canvas to use it as the substrate for the next review round.
- **Single-board archive**: each user has one active board. Its completed rounds live under `~/.canvas-prompt/board/`, while the original project remains package provenance. Reopening reuses the existing healthy board rather than creating another.
- **Explicit handoff only**: Canvas Prompt saves the immutable package first. It reads the latest round only after the user explicitly enters the continuation command; the command can be used from any conversation.
- **Plan before material action**: the continuation command authorizes an AI to understand the canvas, not to immediately change a website or file, generate or replace a deliverable, send, or publish. Analysis can continue directly; material work first enters Codex Plan mode when available, or presents an equivalent chat plan for confirmation.
- **Evidence boundary**: retain observable canvas and speech evidence without presenting inferred intent as a direct fact.

This alpha does not include in-canvas AI generation, automated teaching, BoardScript write-back, or PDF/PPT review. OCR exists as an isolated research path and is not enabled in the main app flow.

Existing users can explicitly copy a legacy project archive into the active
board. This command never scans or deletes a source archive, and stops if a
package ID conflicts with different content:

```bash
node bin/canvas-prompt.mjs migrate --from /path/to/legacy-project
```

## Runtime dependencies and capability contract

Canvas Prompt is local-first, not zero-dependency. A clean machine needs the
following; `canvas-prompt setup` manages Canvas Prompt-owned dependencies and
does **not** modify global Node/Python installs.

| Layer | Requirement | How it is handled |
| --- | --- | --- |
| Core canvas | Node.js `22.12+`, npm | Required from the host machine; locked app packages are installed once and then reused. |
| Compiler | Python `3.11+` | Required from the host machine; the current Process IR compiler uses only the Python standard library. |
| Speech transcription | Canvas Prompt local ASR runtime | Installed into `~/.canvas-prompt/runtime/asr-venv` (or `CANVAS_PROMPT_RUNTIME_DIR`); first start downloads the selected `faster-whisper` model to the local cache. No private project, global Whisper, or manually-installed `ffmpeg` is assumed. |
| Voice capture | Browser microphone permission | Required only to record audio. |
| AI continuation | Single-board MCP | The explicit continuation command reads the latest completed single-board round; users never supply a project path or manage a chat binding. |

Default `setup` prepares local ASR; it is not a hidden optional prerequisite.
The isolated runtime measured about **235 MB** in the current macOS arm64
check, and the base speech model downloads about **148 MB** into a local cache
on first start, then is reused. Exact size and first-start time vary by
platform and network; a cold model download can take several minutes. A normal
`open` completes the local speech readiness gate before it opens the canvas,
so a voice-enabled session never begins in an ambiguous “Speech preparing”
state. For an intentional visual-only canvas, explicitly use `setup --core-only` or set
`CANVAS_PROMPT_ASR=disabled`; browser speech recognition is never a default or
silent fallback.

The launcher never probes arbitrary project folders for Whisper/ffmpeg; it
reuses an occupied ASR endpoint only after its health response proves a
supported local Whisper-compatible contract. macOS arm64 is the only validated
platform today. Intel Macs, Windows, and Linux remain acceptance-test targets,
not supported-platform claims.

Before starting a session, the canvas checks local ASR health. If it is not
ready, the UI says **“Audio saved only”**: recording is archived locally, but
the round contains no speech transcript. A missing MCP or host handoff is also
reported as unavailable; an agent must not scan raw archives or invent a
browser/audio fallback.

## Local development

```bash
# Installs/reuses the Canvas Prompt app and local ASR runtime.
node bin/canvas-prompt.mjs setup --project /absolute/path/to/active-project

# Shows project binding, ASR readiness, and the MCP configuration.
node bin/canvas-prompt.mjs doctor --project /absolute/path/to/active-project

# Optional: copy complete rounds from one legacy project archive into the active board.
node bin/canvas-prompt.mjs migrate --from /absolute/path/to/legacy-project

# Starts the managed ASR service and the canvas. Use --host codex only inside Codex.
node bin/canvas-prompt.mjs open --host codex --project /absolute/path/to/active-project
```

Open the URL printed by the launcher. It prefers `http://127.0.0.1:43223/` and selects another local port when necessary.

## Plugin installation status

The development source of truth is the plugin directory itself. The local personal marketplace can install it with:

```bash
codex plugin add canvas-prompt@personal
```

The public Git marketplace is `dlxeva/canvas-prompt`. Add it and install the plugin with:

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin add canvas-prompt@canvas-prompt
```

After installing or updating the plugin, open a new Codex task so the current skills and MCP tools are loaded. After ending a round, use the explicit continuation command **“Continue with the canvas context”** in the same task. This avoids claiming an automatic thread bridge that Codex Desktop has not exposed to the plugin.

## Other AI terminals, CLI tools, and agents (compatibility path)

Canvas Prompt's durable output is a single-board Prompt Package archive plus a local MCP reader. For a non-Codex host, start with the host-neutral CLI:

```bash
node bin/canvas-prompt.mjs init --project /absolute/path/to/active-project
node bin/canvas-prompt.mjs setup --project /absolute/path/to/active-project
node bin/canvas-prompt.mjs open --project /absolute/path/to/active-project
```

`init` emits MCP configuration for the single active board. The canvas saves and compiles each round locally; another host may read the latest completed package through that MCP server. v0.1 does not claim a native side panel, automatic chat injection, or automatic continuation in any host; the user explicitly chooses when a conversation should read the board.

## Privacy

See [PRIVACY.md](./PRIVACY.md) or [隐私说明](./PRIVACY.zh-CN.md). Do not publish `.canvas-prompt/` data or real recordings, screenshots, transcripts, or whiteboards without explicit permission.

## License

Canvas Prompt-owned code is available under [AGPL-3.0-or-later](./LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
