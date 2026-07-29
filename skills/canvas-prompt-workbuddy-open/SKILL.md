---
name: canvas-prompt-workbuddy-open
description: Open the local Canvas Prompt thinking canvas for the active WorkBuddy workspace. Use when the user asks to open, launch, view, or work in the Canvas Prompt canvas.
---

# Open Canvas Prompt

Start the local canvas for the active project and open the URL reported by the
launcher in the WorkBuddy sidebar browser preview panel. This is the
supported v0.1 route for WorkBuddy. The canvas exports an immutable round.
Canvas Prompt deliberately supports one active user board: all rounds live in
its private archive, and an explicit continuation command in any conversation
reads that board's latest round. Do not make the user copy a path, choose an
archive, or manage a conversation binding. WorkBuddy does not provide a native
thread-injection protocol; the round is saved locally and read through the
Canvas Prompt MCP server on explicit request.

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
```

After setup, launch the canvas in a background task so it persists after the
Bash tool shell exits. The CLI `open` command runs all readiness gates (ASR,
port selection, health check) and reports a URL when the canvas is ready:

```bash
node bin/canvas-prompt.mjs open --host workbuddy --project /absolute/path/to/the/active/project
```

In WorkBuddy, this command must be run with `run_in_background=true` in the
Bash tool so the canvas and ASR daemon processes survive after the tool shell
exits. After the background task completes, read its output to extract the
reported URL.

The launcher prefers `http://127.0.0.1:43223/`, reuses a healthy instance of the current plugin, removes stale Canvas Prompt servers, and otherwise selects an available local port. Read its output and open the actual reported URL; do not assume the default port.

After the launcher reports a ready URL, open it in the WorkBuddy sidebar
browser preview panel by calling `present_files` with the reported localhost
URL. This keeps the canvas next to the conversation: the user marks on the
canvas, clicks Finish session, and continues in the same window without
switching to an external browser. Do not open the canvas in the system default
browser unless the sidebar preview panel is unavailable.

## Launch reply

For a normal successful launch, first call `present_files` with the reported
localhost URL to open the canvas in the WorkBuddy sidebar browser preview
panel. Then keep the user-facing status to the outcome:
`Canvas Prompt 已打开：<actual URL>` in Chinese, or `Canvas Prompt is open: <actual URL>` in English.
Do not volunteer that local speech transcription, ASR, or a model is ready.
Those are internal readiness gates, not a user task. Explain their status only
when the user asks, startup is delayed or fails, or the user explicitly starts
a visual-only session.

## Launch guidance belongs in the conversation

Never place onboarding text, a tutorial overlay, or a first-run modal on the
canvas. By default, give this compact workflow guidance in the main
conversation after **every** successful launch. Before opening, read the
user-level preference:

```bash
node bin/canvas-prompt.mjs preferences
```

If `show_launch_guidance` is `true`, append the following compact guidance to
the normal launch reply in the user's locale:

1. Click **Start session**, then draw, circle, connect, move, or speak naturally.
2. Click **Finish session** and wait until the canvas says the round is ready.
3. Return to this conversation and enter the canonical continuation command.

Keep the guidance short and include copyable examples in the user's locale:

- Chinese:
  - `根据画布内容推进`
  - `根据画布内容推进，帮我看看还有哪里没考虑周全`
  - `根据画布内容推进，把标注整理成修改方案`
- English:
  - `Continue with the canvas context`
  - `Continue with the canvas context and point out what I may have missed`
  - `Continue with the canvas context and turn the annotations into revisions`

Explain that the first command is enough for normal use: WorkBuddy should infer
whether to continue reasoning, fill gaps, or act on annotations. The longer
examples are optional ways to make the desired outcome explicit.

When image review is relevant, include one optional iteration tip in the same
conversation guidance:

- Chinese: `如果在对话中生成了新版图片，复制图片，回到画布按 ⌘V 粘贴，再继续圈改并开始下一轮。`
- English: `If a revised image is generated in chat, copy it, return to the canvas, press ⌘V to paste it, and continue annotating in a new round.`

This is a continuation of the image-review workflow, not a separate mode the
user must select. End the Chinese guide with: `不想每次看到这段说明，可以直接说"以后不再提示画布使用说明"。`
End the English guide with: `Say "Do not show Canvas Prompt guidance again" to hide this on future launches.`

When the user asks in natural language to stop showing this guidance, run:

```bash
node bin/canvas-prompt.mjs preferences --guidance off
```

Confirm that future launches will only report the opened canvas and URL. When
the user asks to restore or resume the guidance, run the same command with
`--guidance on`. If the preference is off, do not show the workflow guide on
later launches unless the user asks how to use the product.

All completed rounds live under the plugin-private local archive
`~/.canvas-prompt/board/`; the active project is retained as package
provenance, not as a routing key. Opening Canvas Prompt again reuses the one
healthy board rather than creating another service. The user can intentionally
continue from a different conversation by entering the standard continuation
command there.

## Do not parse a live canvas by screenshot

Opening a canvas is not an export. If the user asks what the AI saw, says they have given feedback, or asks to continue from the whiteboard **before an exported round exists**, do not inspect the browser canvas, take a screenshot, or infer from the visible page. Say that no round has been received yet and ask the user to finish the round and return to this conversation.

Once an immutable round exists, browser control is not the reading path. `$canvas-prompt-workbuddy-read` must use the fixed-scope MCP tools and the Compact Package first. Screenshots are only a secondary local file check when the compiled package explicitly leaves a material visual ambiguity.

Do not describe the canvas as an AI output or teaching surface. Its current job is to capture human input and make that process understandable to AI.
