# Canvas Prompt Desktop Acceptance Gate

This gate proves facts that unit tests and a fake App Server cannot prove.
Run it in a real Codex Desktop task before a public plugin release.

## Preconditions

- Start Canvas Prompt with `./scripts/start-canvas.sh <project-dir>`.
- Open the URL reported by the launcher, not an assumed port.
- In the same Codex task, verify the MCP server stderr reports the canonical
  `<project-dir>` rather than `unbound` or the plugin installation directory.

## Mixed-material round

1. Start a round on an empty board, then import one or more images while recording.
2. Continue drawing ordinary diagram content; circle two regions on one material, describing only one of them by voice.
3. Zoom, pan, move one mark, then export and send to the current task.
4. Inspect `<project>/.canvas-prompt/rounds/<package_id>/`.

Expected evidence:

- `prompt-package.json`, `engine/process-ir.json`,
  `engine/compact-package.json`, `round.json`, `archive.json`, and
  `handoff.json` exist.
- Every imported material is retained as an independently addressable artifact,
  including materials added after the round began. The package does not emit a
  whiteboard-decided `round_kind`.
- A circle, freehand mark, or arrow overlapping a material becomes an
  unresolved, image-relative observation; it is not promoted to an edit intent.
- The unspoken mark has `speech_link_status: unavailable`.
- Zoom/pan appear only as viewport observations; object movement remains a
  layout observation.
- `handoff.json` reaches `accepted` or `delivered` with the exact thread/turn
  identifiers; a visible Desktop reply is required for `delivered`.
- `get_latest_prompt_package` and `get_round_artifact(process_ir)` read this
  project only. Inline image data must be excluded from MCP output.

## P0 deictic-binding round

1. 在同一回合中放置至少两个可区分的对象或素材区域。
2. 只说 `this / here` 或“这个 / 这里”，并在说话时圈选、指向或移动其中一个对象。
3. 导出后检查 Process IR / Compact Package。

Expected evidence:

- 每个指代语音片段都有时间范围与 `reference_candidate`；
- 候选对象或素材区域带空间边界，并说明来自 `nearby_canvas_action`、`pointer_hit`、素材相对位置等何种支撑；
- 无唯一证据时保持 `unresolved`，不输出确定对象绑定；
- 主对话只能基于候选复述或追问，不能把候选写成用户已确认的事实。

## Consecutive-round isolation

1. Immediately export a second, visibly different round.
2. Confirm `latest-prompt-package.json` identifies round B.
3. Confirm the prompt packages, screenshots, Process IRs, Compact packages and
  handoff receipts under rounds A and B still identify their own package IDs.
4. Delete B in Local Archive and confirm latest rolls back to A; wait past any pending handoff completion and confirm B is not recreated.
5. Delete A and confirm latest is removed.

## Fail conditions

Do not release if any of these occurs:

- Canvas service for project B reuses project A's identity or storage.
- MCP reports `unbound`, plugin-root scope, or reads another project.
- `handoff.json` claims acceptance before `turn/start` is accepted.
- A later `accepted`, timeout, or failure receipt overwrites an earlier `delivered` receipt.
- An accepted handoff times out or exits while the UI remains indefinitely in “processing”.
- A deleted round is recreated by a late handoff write.
- A package without timestamped segments binds speech to a review mark.
