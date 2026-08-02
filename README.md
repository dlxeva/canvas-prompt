<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo.svg" width="88" alt="Canvas Prompt">
  </picture>
</p>

<h1 align="center">Canvas Prompt</h1>

<p align="center">
  <a href="https://github.com/dlxeva/canvas-prompt/blob/main/.codex-plugin/plugin.json"><img src="https://img.shields.io/badge/release-v0.1.33-C8462B" alt="release v0.1.33"></a>
  <a href="https://github.com/dlxeva/canvas-prompt/actions/workflows/verify.yml"><img src="https://github.com/dlxeva/canvas-prompt/actions/workflows/verify.yml/badge.svg?branch=main" alt="CI status"></a>
  <img src="https://img.shields.io/badge/runtime-local--first-3A7D44" alt="local-first runtime">
  <img src="https://img.shields.io/badge/verified-macOS%20arm64-147E9E" alt="verified on macOS arm64">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-7A5195" alt="AGPL-3.0-or-later license"></a>
</p>

<p align="center"><strong>Show AI what to change.</strong></p>

<p align="center">Say it where you mean it.</p>

<p align="center">Mark · Speak · Continue</p>

<p align="center"><a href="./README.zh-CN.md">简体中文</a> · English</p>

Some work happens before a clean chat prompt exists: a rough sketch, an image
with two circled details, a sentence that changes halfway through, a cursor
resting on the thing you mean. Canvas Prompt gives that work a local canvas.

Draw, circle, move, paste, and explain naturally. At the end of a round,
Canvas Prompt compiles the visible result **and the path that produced it**
into a device-local Prompt Package. An AI can then distinguish what was drawn,
what changed, what was said, and what still needs confirmation.

## Try it in Codex Desktop

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin add canvas-prompt@canvas-prompt
```

Open a new Codex task, then:

1. Ask Codex to open Canvas Prompt and start a session.
2. Draw, paste an image, mark a region, or explain your idea aloud. Finish the
   session when the round is complete.
3. Back in the conversation, type **“Continue with the canvas context”**.

## How one round travels

```text
your marks + material + speech
              ↓
       local Prompt Package
              ↓
the conversation you choose to continue
```

<p align="center">
  <img src="./assets/session-replay.gif" width="800" alt="A Canvas Prompt session replay: alternatives appear on the canvas, one is rejected, and a final direction is marked.">
</p>

The board stays available after a round. The package is saved locally first;
the conversation reads it only when you explicitly ask it to continue.

## What it feels like

1. **Put the work on the canvas.** Sketch a structure, paste an image, circle a
   region, draw an arrow, move a block, or just talk while you work.
2. **Finish the round.** The canvas keeps your work in place and saves an
   immutable record of that round. It never silently clears the board.
3. **Continue in the conversation you choose.** In Codex Desktop, type
   **“Continue with the canvas context”**. Codex reads the latest completed
   round from your single local board, then responds to the work rather than a
   hand-written summary of it.

## Three useful starting points

### Review a PDF or PPTX page by page

Choose **Interactive Review** at the top of Canvas Prompt, then open a local
PDF or PPTX. Move through the pages, draw directly over the rendered page, and
explain the changes aloud. When the review is complete, return to the
conversation and ask the AI to read your latest interactive review.

Canvas Prompt keeps the source document read-only. PDFs render locally in the
app; PPTX files are converted locally into a review-only PDF derivative with
LibreOffice while the original file hash, derivative hash, version, and page
numbers remain distinct. A missing local font can change the derivative's
appearance, so the app reports that limitation instead of claiming
pixel-perfect fidelity.

The AI first receives a compact review with the overall request, page anchors,
marks, and speech. It requests an archived page image only when the compact
evidence is insufficient. Before any file is changed, it restates the overall
goal, global and page-specific changes, items to preserve, unresolved
ambiguities, and expected output for confirmation. A completed review does not
authorize execution by itself.

Below the document entry, **Interactive prototype review** opens a built-in
four-step synthetic web flow. You can use the flow, attach text feedback to its
clicks and state changes, and watch a fixed visible Agent walkthrough. This
experimental preview does not open arbitrary URLs or user projects, does not
capture audio, and keeps every generated suggestion proposal-only.

### Review an image without translating every mark into prose

Paste the original image, circle the parts that matter, and explain only what
you want changed. The annotated snapshot becomes the visual brief; the
unmarked original is retained separately as the edit reference. If no original
was placed on the canvas, Canvas Prompt asks for it in chat when exact visual
fidelity matters instead of treating a small screenshot as the source file.

When Codex produces a revised image, copy it from the conversation and press
`⌘V` on the canvas to make it the substrate for the next review round.

### Think through a problem before you can phrase it

Make a rough structure, branch an idea, cross something out, move a part, and
say what changed your mind. The package carries the final canvas together with
the time-ordered evidence behind it, so the conversation can start with a
grounded reading instead of asking you to reconstruct the whole thought.

## What the AI receives

- the final canvas snapshot and the objects still on it;
- the process timeline: drawing, moving, resizing, deletion, and revision;
- speech aligned with the relevant moment when local transcription is ready;
- visual references such as circles, arrows, crossings, and pointer dwell;
- a separation between direct observations, inferred intent, and unresolved
  points.

Canvas Prompt preserves evidence. It does not turn an ambiguous mark or a
single pronoun into a fake certainty.

## Continue safely

The continuation command authorizes an AI to **understand** the canvas. It does
not authorize it to immediately change a website or file, generate or replace
a deliverable, send, delete, or publish. Discussion can continue directly. For
material work, Codex enters Plan mode when available, or presents an equivalent
chat plan with its reading, proposed actions, and open questions for your
confirmation.

## v0.1 focus and boundary

**Codex Desktop is the supported, recommended integration for the first public
release.** It opens one local canvas and reads the latest completed package
through MCP after the explicit continuation command. Project and conversation
metadata are retained as provenance; they are not routing keys.

Other MCP-capable terminals can read the portable local archive, but they are
compatibility paths. v0.1 does not promise their native side panel, automatic
chat injection, or equivalent handoff experience.

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
| PDF review | Bundled PDF.js runtime | Renders the selected PDF locally; the source file remains read-only. |
| PPTX review | Local LibreOffice `soffice` executable | Converts the selected PPTX into an isolated review-only PDF derivative. Canvas Prompt does not install LibreOffice or edit the source presentation. |
| AI continuation | Single-board MCP | The explicit continuation command reads the latest completed single-board round; users never supply a project path or manage a chat binding. |

PPTX review is available when `soffice` is discoverable on `PATH`, or when
`CANVAS_PROMPT_SOFFICE_BIN` points to the executable. If no compatible local
renderer is available, the app reports that PPTX review is unavailable; PDF
review continues to work.

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

## Project resources

- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Privacy](./PRIVACY.md)
- [Third-party notices](./THIRD_PARTY_NOTICES.md)

## License

Canvas Prompt-owned code is available under [AGPL-3.0-or-later](./LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
