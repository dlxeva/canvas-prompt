# Canvas Prompt integration contract

Canvas Prompt is a local-first thinking canvas. Its v0.1 public contract is
one private active board and an immutable Prompt Package for each completed
round. Do not replace it with a simplified canvas or claim behavior that the
current host has not demonstrated.

## Host identity and continuation

The **current host** is the agent application receiving the user's
conversation. It is not a CLI binary that happens to be installed on the same
machine.

- Use the Codex marketplace only when the current conversation runs in Codex
  and the user asked to install for Codex.
- Use the WorkBuddy plugin only when the current conversation runs in
  WorkBuddy and the user asked to install for WorkBuddy.
- Do not select the Codex or WorkBuddy route merely because the host binary is
  on `PATH`, another host window exists, or a terminal command succeeds.
- A project path and a thread ID are provenance for a round. They never select
  which archive is read.

1. In Codex, install the plugin through the Git marketplace.
2. In WorkBuddy, install the plugin from the `.workbuddy-plugin/` directory.
   WorkBuddy does not provide a native thread-injection protocol; the round is
   saved locally (`host: 'workbuddy'`, `status: 'archived'`) and read through
   the `canvas_prompt` MCP server on explicit request.
3. In another MCP-capable host, run `node bin/canvas-prompt.mjs init` and add
   the emitted MCP configuration.
4. Start the browser canvas with `node bin/canvas-prompt.mjs open`
   (`--host codex` for Codex, `--host workbuddy` for WorkBuddy, `--host local`
   or omitted for other hosts).
5. After the user completes a round and explicitly asks to continue, read
   `get_latest_prompt_package` from the fixed-scope `canvas_prompt` MCP
   server.

The durable v0.1 contract is the user's private single-board archive and its
MCP reader. Do not scan arbitrary local archives, infer a conversation from
history, or claim automatic chat injection. If the host cannot run commands or
MCP, explain that it supports only manual export.
