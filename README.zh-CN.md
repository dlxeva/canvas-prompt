# Canvas Prompt：面向 AI 工作流的视觉上下文

简体中文 · [English](./README.md)

Canvas Prompt 是一块运行在本地的思考画布，承接那些还没被整理成一句清晰提示词的过程。

**第一波公开发布以 Codex Desktop 为已验证、推荐的集成。** Canvas Prompt 打开一块本地画布并导出不可变轮次。当前 Codex Desktop 集成请在任意任务输入固定续接指令 **“根据画布内容推进”**，随后由 Codex 经 MCP 读取这块唯一画布的最新已完成轮次。项目只作为包的来源信息，不再负责路由。其他支持 MCP 的终端可以读取本地包，但只是可选兼容路径，不承诺同等的原生界面或交接体验。

你可以在上面画、圈、移动、缩放并同步讲述。Canvas Prompt 会把画布状态、事件时间线、语音对齐和修改过程保存成这台设备上的 **Prompt Package**。Codex 读取它时，会区分直接观察、推断和仍待确认的部分。

## Alpha 能力范围

- **推演**：保留一个问题如何展开，包括分支、移动、缩放、删除和改写。
- **图片批阅**：把原图粘贴或放到画布上，圈出区域并说出修改要求；带标注的最终快照负责表达修改，未标注的原图会单独归档并作为改图参考。若画布中没有原图，Canvas Prompt 不会把截图冒充成可精确编辑的源文件；需要一致性时才在主对话请用户补原图。Codex 在主对话生成新版图片后，可复制图片并回到画布按 `⌘V` 粘贴，作为下一轮批阅的底图。
- **单活跃画布档案**：每位用户只有一块活跃画布，所有已完成轮次保存在 `~/.canvas-prompt/board/`；原项目路径仅记录为包的来源信息。再次打开时复用健康的现有画布服务，不创建第二块。
- **仅显式交接**：Canvas Prompt 先保存不可变上下文包。只有用户明确输入续接指令时，才读取这块画布的最新已完成轮次；该指令可以从任意对话发起。
- **先计划、后执行**：续接指令只授权 AI 理解画布，不授权它立即改网站、改文件、生成或替换交付物、发送或发布。分析和讨论可直接继续；涉及实质动作时，Codex 会先进入可用的计划模式，或在对话中复述「我理解的修改／准备怎么做／待确认」，等待用户确认后才执行。
- **证据边界**：保留能直接观察到的画布和语音信息；推断不会伪装成用户已经明确表达的事实。

当前 Alpha 暂不包含画布内 AI 生成、自动教学、BoardScript 回写和 PDF/PPT 批阅。OCR 仍是隔离的研究路径，尚未接入主应用流程。

已使用旧版项目档案的用户可显式迁入历史轮次；该命令只复制、不扫描、不删除源档案，遇到同 ID 不同内容会停止：

```bash
node bin/canvas-prompt.mjs migrate --from /旧项目目录
```

## v0.1 发布边界

v0.1 对 Codex Desktop 承诺：可靠保存一次白板推演；用户在希望继续的任意主对话输入“根据画布内容推进”后，宿主读取单一活动白板最近完成的包。项目路径和当前对话只记录为来源信息，不能被用来猜测交接目标。其他 MCP 宿主同理，属于待验证的可选兼容路径。圈选、箭头、鼠标停留和中英文指代目前都只作为观察或候选证据，不会自动写成确定语义。

发布前只修会丢数据、串项目、误导推送状态或泄露内容的问题；新增识别能力进入后续校准。完整的冻结条件和三轮人工验收见 [v0.1 Alpha 发布冻结](./docs/v0.1-alpha-freeze.zh-CN.md)。

## 运行依赖与能力契约

Canvas Prompt 是本地优先产品，不是“零依赖网页”。干净机器需要下列组件；`canvas-prompt setup` 只管理 Canvas Prompt 自己的运行时，不会改写用户的全局 Node/Python 环境。

| 层 | 依赖 | 处理方式 |
| --- | --- | --- |
| 核心画布 | Node.js `22.12+`、npm | 宿主机器必须提供；锁定的前端依赖首次安装后复用。 |
| 编译器 | Python `3.11+` | 宿主机器必须提供；当前 Process IR 编译器只使用 Python 标准库。 |
| 语音转写 | Canvas Prompt 本地 ASR 运行时 | 安装到 `~/.canvas-prompt/runtime/asr-venv`（或 `CANVAS_PROMPT_RUNTIME_DIR`）；首次启动下载并缓存 `faster-whisper` 模型。无需私有项目、全局 Whisper 或手装 `ffmpeg`。 |
| 录音 | 浏览器麦克风权限 | 仅在需要录音时要求。 |
| AI 继续对话 | 单活跃画布 MCP | 用户输入续接指令后读取唯一画布的最新已完成轮次；不需要提供项目路径或维护对话绑定。 |

默认 `setup` 会准备本地 ASR，而不是把它藏成可选前提。当前 macOS arm64 实测隔离运行时约 **235 MB**；首次启动还会下载约 **148 MB** 的 base 语音模型到本机缓存，后续复用。实际体积和首次启动时间会随平台与网络变化，冷缓存下模型准备可能需要数分钟；画布会先打开并明确显示“语音准备中”。用户可以等待转写就绪，也可以明确选择“不等语音，开始画”：该轮只保证视觉过程，未就绪的语音不会被伪装成已转写。若只需画布视觉上下文，也可显式使用 `setup --core-only` 或设置 `CANVAS_PROMPT_ASR=disabled`；浏览器语音识别不是默认或静默回退。

启动器不会搜索任意项目中的 Whisper/ffmpeg；只有健康检查证明兼容本地 Whisper 契约时，才会复用已占用的 ASR 服务。当前仅在 macOS arm64 上完成验证；Intel Mac、Windows 和 Linux 仍属于待验收平台，不能当作已支持承诺。

画布开始前会检查 ASR 健康状态。不可用时界面明确显示**“语音仅保存”**：录音仍会本地归档，但本轮不会产生可供 AI 使用的语音转写。MCP 或宿主交接不可用也必须如实报告；Agent 不得扫描原始归档、更换项目路径，或临时拼接浏览器/音频恢复方案。

## 本地开发

```bash
# 安装或复用 Canvas Prompt 的前端与本地 ASR 运行时
node bin/canvas-prompt.mjs setup --project /当前项目的绝对路径

# 查看项目绑定、ASR 就绪状态与 MCP 配置
node bin/canvas-prompt.mjs doctor --project /当前项目的绝对路径

# 可选：把一个旧项目的完整轮次复制进单一活动白板档案
node bin/canvas-prompt.mjs migrate --from /旧项目的绝对路径

# 仅在 Codex 内使用 --host codex；它会启动受管理 ASR 与画布
node bin/canvas-prompt.mjs open --host codex --project /当前项目的绝对路径
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

安装或更新插件后，请新建一个 Codex 任务，让最新的 Skill 与 MCP 工具重新载入。结束一轮后，请在同一任务输入固定续接指令 **“根据画布内容推进”**。这比伪造一个 Desktop 尚未公开给插件的自动线程桥接更诚实、也更稳定。

## 其他 AI 终端、CLI 与 agent（兼容路径）

Canvas Prompt 的稳定产物是本机单一白板档案中的 Prompt Package 和本地 MCP 读取器。非 Codex 宿主使用通用 CLI：

```bash
node bin/canvas-prompt.mjs init --project /当前项目的绝对路径
node bin/canvas-prompt.mjs setup --project /当前项目的绝对路径
node bin/canvas-prompt.mjs open --project /当前项目的绝对路径
```

`init` 会输出读取单一活动白板的 MCP 配置。画布完成本地保存与编译后，其他宿主可以经 MCP 读取最新已完成的 Canvas Prompt Package。v0.1 不声称任何宿主具有原生侧边栏、自动把内容写入当前对话或自动续接的能力；用户应通过显式续接指令决定何时让当前对话读取画布。

## 隐私

请阅读 [隐私说明](./PRIVACY.zh-CN.md) 或 [Privacy](./PRIVACY.md)。未经明确许可，请勿公开 `.canvas-prompt/` 数据、真实录音、截图、转写或白板内容。

## 开源协议

Canvas Prompt 自有代码采用 [AGPL-3.0-or-later](./LICENSE)。第三方组件继续遵循各自的许可证，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
