# Canvas Prompt integration contract

If a user gives you this GitHub repository, do not treat it as Codex-only and do not replace it with a simplified canvas.

1. If you are Codex, install the plugin through the Git marketplace.
2. If you can run local commands and use stdio MCP, run `node bin/canvas-prompt.mjs init --project <project>` and add the emitted MCP configuration to your host.
3. Start the browser canvas with `node bin/canvas-prompt.mjs open --project <project>`.
4. After export, read `get_latest_prompt_package` from the project-bound `canvas_prompt` MCP server.

Codex automatic handoff is an optional host adapter. The durable, portable contract is the project-local `.canvas-prompt/` archive plus the MCP reader. If your host cannot run commands or MCP, say that only manual export is available; do not claim an automatic integration.
