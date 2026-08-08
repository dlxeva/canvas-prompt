<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo.svg" width="88" alt="Canvas Prompt">
  </picture>
</p>

<h1 align="center">Canvas Prompt</h1>

<p align="center">
  <a href="https://github.com/dlxeva/canvas-prompt/releases/latest"><img src="https://img.shields.io/github/v/release/dlxeva/canvas-prompt?label=latest%20release" alt="latest release"></a>
  <a href="https://github.com/dlxeva/canvas-prompt/actions/workflows/verify.yml"><img src="https://github.com/dlxeva/canvas-prompt/actions/workflows/verify.yml/badge.svg?branch=main" alt="CI status"></a>
  <img src="https://img.shields.io/badge/runtime-local--first-3A7D44" alt="local-first runtime">
  <img src="https://img.shields.io/badge/verified-macOS%20arm64-147E9E" alt="verified on macOS arm64">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-7A5195" alt="AGPL-3.0-or-later license"></a>
</p>

<p align="center"><strong>Show AI what to change.</strong></p>

<p align="center">Say it where you mean it.</p>

<p align="center">Mark · Speak · Continue</p>

<p align="center">
  <a href="https://canvas-prompt.aizhiz.com/">Website</a> · <a href="https://youtu.be/J5hnvWZsh3I" target="_blank" rel="noopener noreferrer"><strong>Watch the 3:50 demo ↗</strong></a> · <a href="./README.zh-CN.md">简体中文</a> · English
</p>

Some work happens before a clean prompt appears: a rough sketch, an annotated
image, a changed sentence, a cursor on the thing you mean. Canvas Prompt gives
that process a local canvas.

Draw, circle, move, paste, and explain naturally. At the end of a round it
stores an immutable Prompt Package on device, including the final canvas state and
the evidence path that produced it.

## How one round travels

```text
your marks + materials + speech
               ↓
     local Prompt Package
               ↓
conversation you explicitly continue
```

The board stays available after the round ends. A conversation reads the package
only when you explicitly ask it to continue with the canvas context.

<p align="center">
  <img src="./assets/session-replay.gif" width="800" alt="A Canvas Prompt session replay: alternatives appear on the canvas, one is rejected, and a final direction is marked.">
</p>

## Try it in Codex Desktop

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin add canvas-prompt@canvas-prompt
```

Then in a new Codex task:

1. Start a Canvas Prompt session.
2. Draw / paste image / mark region / speak while working.
3. End the round and type **“Continue with the canvas context”**.

## Three starting scenarios

### Review a PDF or PPTX page by page

Open a local PDF or PPTX via **Interactive Review** and mark changes on the
rendered page. PDF is rendered locally. PPTX is converted to an isolated
review-only PDF derivative via local LibreOffice; the source presentation stays
read-only.

### Review an image without translating every mark into prose

Drop an image, circle target areas, and only describe what should change. The
annotated snapshot is preserved as the visual brief. If no original image is on
the canvas and precision is needed, Canvas Prompt asks for one instead of
pretending a screenshot is the source.

### Think through a problem before you can phrase it

Sketch a structure, branch an idea, cross out a path, or reorder objects.
Conversation continuation starts from process evidence rather than a rewritten
summary.

## AI receives

- final canvas snapshot and objects still present
- process timeline: draw, move, resize, delete, revise
- speech aligned to the relevant moments, when local transcription is ready
- visual references: circles, arrows, crossings, cursor dwell
- explicit distinction between observed facts, inferred intent, and unresolved items

The continuation command only authorizes understanding.

## Keep it safe

Continuation does **not** authorize direct edits, delivery generation,
deletion, publishing, or cross-context auto-injection. Material changes remain
separate actions that require their own confirmation.

If speech is unavailable, the round may still continue visually and is marked as
**“audio saved only”**.

## Dependency snapshot

| Layer | Requirement | Delivery note |
| --- | --- | --- |
| Core runtime | Node.js `22.12+` + npm | Required from host; canvas dependencies are installed once |
| Compiler | Python `3.11+` | Uses Python standard library for compile step |
| ASR | Managed local ASR runtime + `faster-whisper` | Setup prepares speech by default; optional visual-only mode is supported |
| PDF/PPTX | PDF.js + local `soffice` executable | PDF works locally; PPTX uses isolated derivative when `soffice` is available |

Full runtime dependency contract, local development commands, and host-neutral MCP
compatibility details are in:

- [docs/getting-started.md](./docs/getting-started.md)

## Plugin installation status

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin add canvas-prompt@canvas-prompt
```

After install/update, open a new Codex task so skills and MCP tools are reloaded.
End the round in the same task, then use the explicit continuation command.

## Local issues quick check

- If the round has no speech transcript, run `node bin/canvas-prompt.mjs doctor --project /absolute/path/to/active-project`.
- If PPTX review is unavailable, PDF review remains usable.
- If you are using a non-Codex host, only compatibility-path behavior is guaranteed.

## Privacy

See [PRIVACY.md](./PRIVACY.md) or [隐私说明](./PRIVACY.zh-CN.md). Do not
publish `.canvas-prompt/` data or real recordings, screenshots, transcripts, or
whiteboards without explicit permission.

## Resources

- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Support](./SUPPORT.md)
- [Privacy](./PRIVACY.md)
- [Third-party notices](./THIRD_PARTY_NOTICES.md)

## License

Canvas Prompt code is [AGPL-3.0-or-later](./LICENSE). Third-party components
keep their own licenses in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
