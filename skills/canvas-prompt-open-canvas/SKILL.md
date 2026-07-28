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

The launcher prefers `http://127.0.0.1:43223/`, reuses a healthy instance of the current plugin, removes stale Canvas Prompt servers, and otherwise selects an available local port. Read its output and open the actual reported URL; do not assume the default port.

## Launch reply

For a normal successful launch, keep the user-facing status to the outcome:
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
3. Return to the same conversation and enter the canonical continuation command.

Keep the guidance short and include copyable examples in the user's locale:

- Chinese:
  - `根据画布内容推进`
  - `根据画布内容推进，帮我看看还有哪里没考虑周全`
  - `根据画布内容推进，把标注整理成修改方案`
- English:
  - `Continue with the canvas context`
  - `Continue with the canvas context and point out what I may have missed`
  - `Continue with the canvas context and turn the annotations into revisions`

Explain that the first command is enough for normal use: Codex should infer
whether to continue reasoning, fill gaps, or act on annotations. The longer
examples are optional ways to make the desired outcome explicit.

When image review is relevant, include one optional iteration tip in the same
conversation guidance:

- Chinese: `如果 Codex 在主对话生成了新版图片，复制图片，回到画布按 ⌘V 粘贴，再继续圈改并开始下一轮。`
- English: `If Codex generates a revised image in chat, copy it, return to the canvas, press ⌘V to paste it, and continue annotating in a new round.`

This is a continuation of the image-review workflow, not a separate mode the
user must select. End the Chinese guide with: `不想每次看到这段说明，可以直接说“以后不再提示画布使用说明”。`
End the English guide with: `Say “Do not show Canvas Prompt guidance again” to hide this on future launches.`

When the user asks in natural language to stop showing this guidance, run:

```bash
node bin/canvas-prompt.mjs preferences --guidance off
```

Confirm that future launches will only report the opened canvas and URL. When
the user asks to restore or resume the guidance, run the same command with
`--guidance on`. If the preference is off, do not show the workflow guide on
later launches unless the user asks how to use the product.

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
