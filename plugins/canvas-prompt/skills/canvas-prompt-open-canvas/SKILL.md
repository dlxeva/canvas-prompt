---
name: canvas-prompt-open-canvas
description: Open the local Canvas Prompt thinking canvas for the active Codex project. Use when the user asks to open, launch, view, or work in the Canvas Prompt canvas, or wants a thinking-canvas side panel in Codex.
---

# Open Canvas Prompt

Start the local canvas for the active project and open it in Codex's in-app browser.

```bash
./scripts/start-canvas.sh /absolute/path/to/the/active/project
```

The default URL is `http://127.0.0.1:43223/`. The canvas writes its latest exported Prompt Package to `<active-project>/.canvas-prompt/latest-prompt-package.json`.

Do not describe the canvas as an AI output or teaching surface. Its current job is to capture human input and make that process understandable to AI.
