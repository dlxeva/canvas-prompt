# Canvas Prompt integration contract

If a user gives you this GitHub repository, do not treat it as Codex-only and do not replace it with a simplified canvas.

## Host identity gate

The **current host** is the agent application receiving this user's conversation. It is not any CLI binary that happens to be installed on the same machine.

- Use the Codex marketplace only when the current conversation itself runs in Codex and the user asked to install for Codex.
- Never select the Codex route merely because `codex` is on `PATH`, another Codex window exists, or a terminal command succeeds.
- When the current host is WorkBuddy, ZCode, or another agent, use that host's adapter or the generic MCP route.

1. If the current host is Codex, install the plugin through the Git marketplace.
2. If you can run local commands and use stdio MCP, run `node bin/canvas-prompt.mjs init --project <project>` and add the emitted MCP configuration to your host.
3. Start the browser canvas with `node bin/canvas-prompt.mjs open --project <project>`.
4. After export, read `get_latest_prompt_package` from the project-bound `canvas_prompt` MCP server.

Codex automatic handoff is an optional host adapter. The durable, portable contract is the project-local `.canvas-prompt/` archive plus the MCP reader. If the bound project has no round, say so; do not search other `.canvas-prompt` directories or read them directly. If your host cannot run commands or MCP, say that only manual export is available; do not claim an automatic integration.
