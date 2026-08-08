# 运行方式、Local development 与兼容终端说明

该文档承载 README 的运行时与开发细节，避免首页过长。

## 运行依赖与能力契约

Canvas Prompt 是本地优先产品，仍需要下列本机依赖：

| 层 | 依赖 | 处理方式 |
| --- | --- | --- |
| 核心画布 | Node.js `22.12+`、npm | 宿主提供；前端依赖首次安装后复用 |
| 编译器 | Python `3.11+` | 宿主提供；当前 Process IR 编译器仅使用 Python 标准库 |
| 语音转写 | 本地托管 ASR 运行时 | 安装在 `~/.canvas-prompt/runtime/asr-venv`（或 `CANVAS_PROMPT_RUNTIME_DIR`）；首次启动下载 `faster-whisper` 模型到本地缓存，不依赖用户项目全局 Whisper/ffmpeg |
| 录音 | 浏览器麦克风权限 | 仅在录音时需要 |
| PDF 审阅 | 内置 PDF.js 运行时 | 本机渲染 PDF，源文件只读 |
| PPTX 审阅 | 本机 `soffice` 可执行文件 | 所选 PPTX 转为仅审阅的隔离 PDF 衍生文件，源演示不修改 |
| AI 继续对话 | 单活跃白板 MCP | 用户显式续接命令后读取最近完成轮次 |

当 `soffice` 可从 `PATH` 发现，或 `CANVAS_PROMPT_SOFFICE_BIN` 指向可执行文件时可用 PPTX
审阅；否则提示不可用，PDF 审阅仍可继续。

`setup` 默认会准备本地 ASR，默认语音路径不是可选隐藏项。若只要视觉上下文，可设置
`setup --core-only` 或 `CANVAS_PROMPT_ASR=disabled`。

当前 macOS arm64 实测隔离运行时约 **235 MB**，首次启动还会下载约 **148 MB**
的 base 语音模型到本机缓存。实际体积和首次启动时间会随平台与网络变化。

当前已公开验证是 macOS arm64；Intel Mac、Windows、Linux 仍为验收待确认目标，不作为已支持
承诺。

启动器不会扫描任意目录寻找 Whisper/ffmpeg；仅在本地健康检查通过后复用兼容 ASR。

会话开始前会做 ASR 健康检查；未就绪时记录仍会保存可视化过程，但会明确标记为
`语音仅保存`。

## 本地开发

本机个人插件市场的开发 checkout 也可以这样安装：

```bash
codex plugin add canvas-prompt@personal
```

```bash
# 安装或复用 Canvas Prompt 的前端与本地 ASR 运行时
node bin/canvas-prompt.mjs setup --project /当前项目绝对路径

# 查看项目绑定、ASR 就绪状态与 MCP 配置
node bin/canvas-prompt.mjs doctor --project /当前项目绝对路径

# 可选：把旧项目完整轮次迁入当前活动白板
node bin/canvas-prompt.mjs migrate --from /旧项目绝对路径

# 启动托管 ASR 与画布；--host codex 仅在 Codex 使用
node bin/canvas-prompt.mjs open --host codex --project /当前项目绝对路径
```

请访问启动器输出的 URL。优先使用 `http://127.0.0.1:43223/`，端口占用时自动换本地端口。

## 其他 AI 终端、CLI 与 agent（兼容路径）

非 Codex 终端建议先用中性 CLI：

```bash
node bin/canvas-prompt.mjs init --project /当前项目绝对路径
node bin/canvas-prompt.mjs setup --project /当前项目绝对路径
node bin/canvas-prompt.mjs open --project /当前项目绝对路径
```

`init` 输出单一活跃白板的 MCP 配置。画布本地保存并编译每一轮后，其他宿主可通过 MCP
读取最近完成的轮次。

v0.1 不承诺非 Codex 宿主具备原生侧边栏、自动注入当前对话或自动续接。
