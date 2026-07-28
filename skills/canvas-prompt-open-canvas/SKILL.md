---
name: canvas-prompt-open-canvas
description: Open the local Canvas Prompt thinking canvas for the active Codex project. Use when the user asks to open, launch, view, or work in the Canvas Prompt canvas.
---

# Open Canvas Prompt

Start the local canvas for the active project and open the URL reported by the
launcher in Codex's in-app browser. This is the supported v0.1 route. The
canvas exports an immutable round. The project decides archive location; only
an explicit host-provided current conversation ID may decide the conversation
scope. Never infer that ID from the project, recent tasks, a prior binding, or
browser state. Do not claim an experimental native host panel.

Before the first launch in a new installation, tell the user that bootstrap
will install Canvas Prompt-managed Node and local-ASR dependencies into an
isolated runtime (current macOS arm64 check: about 235 MB), and that first ASR
start downloads a separately cached base model (about 148 MB; cold downloads
can take several minutes). Then run the managed bootstrap. It reuses healthy
local runtime components when available. Opening runs the local speech
readiness gate before opening a normal voice-enabled canvas; do not claim the
canvas is ready until this gate has passed.
Never ask the user to manually find Whisper, ffmpeg, or a private ASR project.

```bash
node bin/canvas-prompt.mjs setup --project /absolute/path/to/the/active/project
node bin/canvas-prompt.mjs open --host codex --project /absolute/path/to/the/active/project
```

When the current turn contains the developer context
`CANVAS_PROMPT_HOST_SESSION_ID=<id>`, the host has supplied the active Codex
session identity. The `open` command **must** include that exact value:

```bash
node bin/canvas-prompt.mjs open --host codex --project /absolute/path/to/the/active/project --thread-id <id>
```

Never replace it with a task title, project path, browser URL, recent session,
or invented ID. This binding is what lets the next ordinary user message receive
the just-finished round without asking them to say “read the canvas”.

The launcher prefers `http://127.0.0.1:43223/`, reuses a healthy instance of the current plugin, removes stale Canvas Prompt servers, and otherwise selects an available local port. Read its output and open the actual reported URL; do not assume the default port.

When the host has supplied a current conversation ID, the canvas writes into
`<active-project>/.canvas-prompt/threads/<opaque-key>/`; otherwise it uses the
explicit project archive. After export, use `$canvas-prompt-read-round` only
from the same fixed scope. If Codex has not exposed a current conversation ID
to the launcher, do not say that the export was automatically routed back to
the visible conversation.

## Do not parse a live canvas by screenshot

Opening a canvas is not an export. If the user asks what the AI saw, says they have given feedback, or asks to continue from the whiteboard **before an exported round exists**, do not inspect the browser canvas, take a screenshot, or infer from the visible page. Say that no round has been received yet and ask the user to finish the round and choose **Send to Codex**.

Once an immutable round exists, browser control is not the reading path. `$canvas-prompt-read-round` must use the fixed-scope MCP tools and the Compact Package first. Screenshots are only a secondary local file check when the compiled package explicitly leaves a material visual ambiguity.

Do not describe the canvas as an AI output or teaching surface. Its current job is to capture human input and make that process understandable to AI.
