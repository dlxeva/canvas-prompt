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
| 可选 OCR research | 独立的 `research/ocr` 包 | 仅显式启用；不属于根目录或 `app` 的默认安装 |
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

默认 App 不安装 OCR、Paddle、OpenCV 或 ONNX 引擎。需要运行可选 OCR
research smoke 时，在独立目录安装：

```bash
cd research/ocr
npm install --ignore-scripts
npm run dev
```

该包自己管理 OCR runner 与缓存，不改变 App、Prompt Package、API、MCP、Python
或启动器契约。

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

## Dev/preview 统一 API 与隔离浏览器验证

`app/vite.config.ts` 在 Vite 的 `configureServer` 与
`configurePreviewServer` 中注册同一个 `registerCanvasApi` 中间件。因此 dev
与 preview 使用同一套本地 API 边界，包括 runtime identity/session、带 token 的
轮次读取和媒体/Package 上传。仅使用 loopback：

```bash
# 开发服务器
npm --prefix app run dev -- --host 127.0.0.1 --port 43223 --strictPort

# 生产构建后的 preview 服务器
npm --prefix app run build
(cd app && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort)
```

浏览器 harness 会改用随机可用端口，并为每次运行创建新的临时
`CANVAS_PROMPT_DATA_HOME` 与 project 目录。默认环境是
`CANVAS_PROMPT_ASR=disabled`、`CANVAS_PROMPT_DELIVERY_MODE=local`。

需要本地隔离浏览器工具时，可显式设置 Playwright 与浏览器路径：

```bash
BROWSER_TOOLS="$(mktemp -d "${TMPDIR:-/tmp}/canvas-browser-tools.XXXXXX")"
npm install --prefix "$BROWSER_TOOLS" --no-package-lock --ignore-scripts playwright@1.62.1
node "$BROWSER_TOOLS/node_modules/playwright/cli.js" install chromium
export CANVAS_PROMPT_PLAYWRIGHT_MODULE="$BROWSER_TOOLS/node_modules/playwright"
export CANVAS_PROMPT_CHROME_PATH="$(node -e 'console.log(require(process.argv[1]).chromium.executablePath())' "$CANVAS_PROMPT_PLAYWRIGHT_MODULE")"

# 也可以指向已管理的本机 Chrome 可执行文件
# export CANVAS_PROMPT_CHROME_PATH="/path/to/Google Chrome"
```

PPTX→PDF smoke 使用真实 LibreOffice 时，指定隔离或已管理的 `soffice` 并先核对版本：

```bash
export CANVAS_PROMPT_SOFFICE_BIN="/path/to/isolated/soffice"
"$CANVAS_PROMPT_SOFFICE_BIN" --version
node scripts/artifact-review-browser-harness.mjs --scenario pptx
```

候选验证命令：

```bash
node scripts/round-export-browser-harness.mjs --scenario smoke --server dev
node scripts/round-export-browser-harness.mjs --scenario smoke --server preview
npm run test:browser:round-export
npm run test:browser:artifact-review
node scripts/artifact-review-browser-harness.mjs --scenario responsive
```

round-export 的 `all` 还覆盖 dev 丢响应恢复、显式上传重试、媒体 partial failure、两轮隔离
与 preview smoke。harness 不改写 `HOME`，不复用真实白板或缓存，也不代表已发布运行时。

浏览器检查会关闭 ASR 并使用本地测试 route，因此未验证真实麦克风会话、真人 ASR 质量或远程
宿主 handoff。远程 CI 的浏览器矩阵会安装隔离的 Playwright/Chromium 并运行候选检查；这仍不
构成人工验收，也不提供真实 ASR 覆盖。

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
