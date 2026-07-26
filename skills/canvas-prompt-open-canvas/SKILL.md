---
name: canvas-prompt-open-canvas
description: Open the local Canvas Prompt thinking canvas for the active Codex project. Use when the user asks to open, launch, view, or work in the Canvas Prompt canvas, or wants a thinking-canvas side panel in Codex.
---

# Open Canvas Prompt

Start the local canvas for the active project and open the URL reported by the launcher in Codex's in-app browser.

```bash
CANVAS_PROMPT_DELIVERY_MODE=codex ./scripts/start-canvas.sh /absolute/path/to/the/active/project
```

The launcher prefers `http://127.0.0.1:43223/`, reuses a healthy instance of the current plugin, removes stale Canvas Prompt servers, and otherwise selects an available local port. Read its output and open the actual reported URL; do not assume the default port.

The canvas writes its latest exported Prompt Package to `<active-project>/.canvas-prompt/latest-prompt-package.json`. After export, use `$canvas-prompt-read-round` to read and continue from that round in the Codex conversation.

## Do not parse a live canvas by screenshot

Opening a canvas is not an export. If the user asks what the AI saw, says they have given feedback, or asks to continue from the whiteboard **before an exported round exists**, do not inspect the browser canvas, take a screenshot, or infer from the visible page. Say that no round has been received yet and ask the user to finish the round and choose **Send to Codex**.

Once an immutable round exists, browser control is not the reading path. `$canvas-prompt-read-round` must use the project-bound MCP tools and the Compact Package first. Screenshots are only a secondary local file check when the compiled package explicitly leaves a material visual ambiguity.

Do not describe the canvas as an AI output or teaching surface. Its current job is to capture human input and make that process understandable to AI.
