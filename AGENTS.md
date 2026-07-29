# Canvas Prompt integration contract

Canvas Prompt is a local-first thinking canvas. Its v0.1 public contract is
one private active board and an immutable Prompt Package for each completed
round. Do not replace it with a simplified canvas or claim behavior that the
current host has not demonstrated.

## Single board, any host

The user has one private active board. Which host (Codex / WorkBuddy / local)
started the canvas service is internal diagnostic information, not a routing
key or a reuse gate. Any healthy Canvas Prompt instance serving the single
board can be reused. The `delivery_mode` field in `runtime-identity` is
retained for diagnostics but does not affect board routing, reuse decisions,
or the reading path.

1. In Codex, install the plugin through the Git marketplace.
2. In WorkBuddy, install the plugin from the `.workbuddy-plugin/` directory.
   WorkBuddy does not provide a native thread-injection protocol; the round is
   saved locally (`host: 'workbuddy'`, `status: 'archived'`) and read through
   the `canvas_prompt` MCP server on explicit request. WorkBuddy opens the
   canvas in its built-in sidebar browser preview panel (via `present_files`
   with the localhost URL), keeping the canvas next to the conversation.
3. In another MCP-capable host, run `node bin/canvas-prompt.mjs init` and add
   the emitted MCP configuration.
4. Start the browser canvas with `node bin/canvas-prompt.mjs open`
   (`--host codex` for Codex, `--host workbuddy` for WorkBuddy, `--host local`
   or omitted for other hosts).
5. After the user completes a round and explicitly asks to continue, read
   `get_latest_prompt_package` from the fixed-scope `canvas_prompt` MCP
   server. When the MCP server is not registered as a tool in the current
   host session, use `node bin/canvas-prompt.mjs read` as a maintained CLI
   fallback that returns the same data through the same code path.

The durable v0.1 contract is the user's private single-board archive and its
MCP reader. Do not scan arbitrary local archives, infer a conversation from
history, or claim automatic chat injection. If the host cannot run commands or
MCP, explain that it supports only manual export.
