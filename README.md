# Canvas Prompt

**Put unfinished thinking on the canvas.**

Canvas Prompt is a local canvas for the work that happens before a clean chat prompt exists. Draw, circle, move, and explain; it keeps the canvas, the spoken explanation, and the changes made along the way together as context that Codex can pick up.

It is designed for two everyday moments:

- **Work through an open question** — sketch branches, revise structure, and explain the thought while it is still forming.
- **Review visual work** — place an image on the canvas, circle an area, and say what should change without first translating the location into a long written description.

## What happens in one round

1. Open Canvas Prompt from Codex.
2. Draw, circle, move, and optionally speak.
3. Finish and export the round.
4. Canvas Prompt saves a local Prompt Package under the active project's `.canvas-prompt/` folder.
5. Ask Codex to read the latest Canvas Prompt Package and continue from that context.

Each exported round can include a canvas snapshot, timestamped canvas actions, optional local speech transcription, the original recording, Process IR, and a Compact Package. The bundled MCP server can read the latest package for the active project.

## Install

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin install canvas-prompt@canvas-prompt
```

Then ask Codex: **Open Canvas Prompt for this project.**

## Local development

```bash
cd plugins/canvas-prompt
npm test
npm run build
./scripts/start-canvas.sh /absolute/path/to/active-project
```

The canvas runs at `http://127.0.0.1:43223/`. Exported rounds stay in the active project; the plugin remains reusable across projects.

## Privacy and license

Canvas Prompt is local-first. A round may contain a recording, transcript, canvas snapshot, and derived context files. Do not commit real session data. Read the [privacy guide](./plugins/canvas-prompt/PRIVACY.md) before recording.

Canvas Prompt-owned code is licensed under [AGPL-3.0-or-later](./LICENSE). Third-party components retain their own licenses; see [third-party notices](./plugins/canvas-prompt/THIRD_PARTY_NOTICES.md).

---

# Canvas Prompt 中文说明

**把还没想清楚的事，放到画布上说。**

Canvas Prompt 是给“提示词之前那段工作”准备的本地画布。你可以画、圈、移动、说；它把画布、口头说明和过程中的修改保留在一起，成为 Codex 可以继续接住的上下文。

它适合两类日常工作：

- **推演一个尚未成形的问题**：把分支、修改和解释留在思考发生的地方。
- **批阅视觉作品**：把图片放到画布上，圈出位置，直接说你希望怎么改，不必先把位置翻译成一段冗长文字。

## 一轮如何完成

1. 从 Codex 打开 Canvas Prompt。
2. 画、圈、移动；需要时直接说出来。
3. 结束并导出本轮。
4. Canvas Prompt 将本轮 Prompt Package 保存到当前项目的 `.canvas-prompt/` 文件夹。
5. 让 Codex 读取最新的 Canvas Prompt Package，并从这段上下文继续。

每一轮可以包含画布快照、带时间戳的画布动作、可选的本地语音转写、原始录音、Process IR 与 Compact Package。随插件提供的 MCP 可以读取当前项目最新的一轮。

## 安装

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin install canvas-prompt@canvas-prompt
```

安装后对 Codex 说：**为这个项目打开 Canvas Prompt。**

## 本地开发

```bash
cd plugins/canvas-prompt
npm test
npm run build
./scripts/start-canvas.sh /绝对路径/你的项目
```

画布默认运行在 `http://127.0.0.1:43223/`。每轮导出只写入当前项目，插件本身可复用于其他项目。

## 隐私与许可

Canvas Prompt 采用本地优先的方式工作。一轮内容可能包含录音、转写、画布快照和派生产物；不要提交真实会话数据。开始录音前请阅读[隐私说明](./plugins/canvas-prompt/PRIVACY.md)。

Canvas Prompt 自有代码采用 [AGPL-3.0-or-later](./LICENSE)；第三方组件保留各自许可证，见[第三方声明](./plugins/canvas-prompt/THIRD_PARTY_NOTICES.md)。
