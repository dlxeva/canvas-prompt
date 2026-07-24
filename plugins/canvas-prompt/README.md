# Canvas Prompt for Codex

**Draw it. Say it where you mean it.**

Canvas Prompt is a local canvas for the work that happens before a clean chat prompt exists. Draw, circle, move, and explain; export the round as context that Codex can read from the active project.

Use it to work through an open question or review visual work: place an image on the canvas, circle what matters, and explain the requested change in your own words.

## Install from this Git marketplace

This plugin lives at `plugins/canvas-prompt/`; the marketplace manifest is at `.agents/plugins/marketplace.json`.

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin install canvas-prompt@canvas-prompt
```

Then ask Codex to open Canvas Prompt for the active project.

## Use

1. Draw, circle, move, and optionally record your explanation.
2. Export the round.
3. Ask Codex to read the latest Canvas Prompt Package for the project.

The exported round is kept locally at `<active-project>/.canvas-prompt/`. It can include the canvas snapshot, timestamped actions, optional local transcription, recording, Process IR, and Compact Package.

## Local development

```bash
./scripts/start-canvas.sh /absolute/path/to/active-project
```

For checks:

```bash
cd app
npm install
npm test
npm run build
```

## Privacy and license

Canvas Prompt is local-first. Do not publish real recordings, transcripts, screenshots, whiteboards, or `.canvas-prompt/` folders without explicit permission. See [PRIVACY.md](./PRIVACY.md).

Canvas Prompt-owned code is available under [AGPL-3.0-or-later](./LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

---

# Canvas Prompt 中文说明

**画出来，在你所指的地方说。**

Canvas Prompt 是给“提示词之前那段工作”准备的本地画布。你可以画、圈、移动、说；导出后，Codex 可以从当前项目读取这一轮上下文。

它既适合推演一个还没想清楚的问题，也适合批阅视觉作品：把图片放到画布上，圈出你在意的位置，再用自己的话说明希望如何调整。

## 从这个 Git marketplace 安装

插件位于 `plugins/canvas-prompt/`，marketplace 清单位于 `.agents/plugins/marketplace.json`。

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin install canvas-prompt@canvas-prompt
```

安装后，让 Codex 为当前项目打开 Canvas Prompt。

## 使用

1. 画、圈、移动；需要时直接录下说明。
2. 导出本轮。
3. 让 Codex 读取当前项目最新的 Canvas Prompt Package。

导出内容保存在 `<当前项目>/.canvas-prompt/`。一轮可包含画布快照、带时间戳的动作、可选的本地转写、录音、Process IR 与 Compact Package。

## 本地开发

```bash
./scripts/start-canvas.sh /绝对路径/你的项目
```

验证命令：

```bash
cd app
npm install
npm test
npm run build
```

## 隐私与许可

Canvas Prompt 本地优先。未经明确授权，不要公开真实录音、转写、截图、白板或 `.canvas-prompt/` 文件夹；详见 [PRIVACY.md](./PRIVACY.md)。

Canvas Prompt 自有代码采用 [AGPL-3.0-or-later](./LICENSE)；第三方组件保留各自许可证，见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
