# Canvas Prompt for Codex

简体中文 · [English](./README.md)

Canvas Prompt 是一块运行在本地的思考画布，承接那些还没被整理成一句清晰提示词的过程。

你可以在上面画、圈、移动、缩放并同步讲述。Canvas Prompt 会把画布状态、事件时间线、语音对齐和修改过程保存成项目内的 **Prompt Package**。Codex 读取它时，会区分直接观察、推断和仍待确认的部分。

## Alpha 能力范围

- **推演**：保留一个问题如何展开，包括分支、移动、缩放、删除和改写。
- **图片批阅**：把图片放到画布上，圈出区域，直接说出修改要求。
- **项目本地档案**：在当前项目的 `.canvas-prompt/` 中保存 Prompt Package、原始录音、画布快照、Process IR、Compact Package 和交付回执。
- **交给 Codex**：将某一轮不可变的上下文提交到当前 Codex 任务，并分别呈现“已保存到本地、主任务已接收、已送达、发送失败”。
- **证据边界**：保留能直接观察到的画布和语音信息；推断不会伪装成用户已经明确表达的事实。

当前 Alpha 暂不包含画布内 AI 生成、自动教学、BoardScript 回写和 PDF/PPT 批阅。OCR 仍是隔离的研究路径，尚未接入主应用流程。

## v0.1 发布边界

v0.1 只承诺可靠保存一次白板推演，并把它交给当前 Codex 主对话继续处理。圈选、箭头、鼠标停留和中英文指代目前都只作为观察或候选证据，不会自动写成确定语义。

发布前只修会丢数据、串项目、误导推送状态或泄露内容的问题；新增识别能力进入后续校准。完整的冻结条件和三轮人工验收见 [v0.1 Alpha 发布冻结](./docs/v0.1-alpha-freeze.zh-CN.md)。

## 运行要求

当前 Alpha 只在 macOS 与 Codex Desktop 上完成验证。本地开发需要：

- Node.js `22.12` 或更高版本，以及 npm；
- Python `3.11` 或更高版本，用于 Process IR 编译和校验；
- 使用语音时，需要授予麦克风权限；
- 如需带时间戳的语音转写，需要在 `http://127.0.0.1:8080` 运行本地 ASR 服务。

本地 ASR 未运行时，画布动作和快照仍然可以使用，原始录音也可以进入本地档案；语音时间线会标记为不可用。首次启动开发服务时可能需要下载 npm 依赖。

## 本地开发

```bash
npm ci
npm --prefix app ci
npm run verify
./scripts/start-canvas.sh /当前项目的绝对路径
```

请打开启动脚本实际输出的地址。脚本会优先使用 `http://127.0.0.1:43223/`，端口被占用时会自动选择其他本地端口。

## 插件安装状态

当前开发源码本身就是插件的唯一源码。本机个人插件市场可以这样安装：

```bash
codex plugin add canvas-prompt@personal
```

公开 Git marketplace 已设为 `dlxeva/canvas-prompt`。添加市场并安装插件：

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin add canvas-prompt@canvas-prompt
```

安装或更新插件后，请新建一个 Codex 任务，让最新的 Skill 与 MCP 工具重新载入。

## 其他本地 AI 终端

Canvas Prompt 的稳定产物是项目内的 Prompt Package 和本地 MCP 读取器。接入其他侧边栏 AI 终端时，用本地交付模式启动：

```bash
CANVAS_PROMPT_DELIVERY_MODE=local ./scripts/start-canvas.sh /当前项目的绝对路径
```

画布会完成本地保存与编译。让该终端以同一个项目路径设置 `CANVAS_PROMPT_PROJECT_DIR` 并运行随插件提供的 MCP server，即可读取最新 Canvas Prompt Package。Codex 是第一个具备自动交付的宿主；其他宿主通过这条本地上下文包与 MCP 路径接入。

## 隐私

请阅读 [隐私说明](./PRIVACY.zh-CN.md) 或 [Privacy](./PRIVACY.md)。未经明确许可，请勿公开 `.canvas-prompt/` 数据、真实录音、截图、转写或白板内容。

## 开源协议

Canvas Prompt 自有代码采用 [AGPL-3.0-or-later](./LICENSE)。第三方组件继续遵循各自的许可证，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
