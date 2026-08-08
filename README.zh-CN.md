<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo.svg" width="88" alt="Canvas Prompt">
  </picture>
</p>

<h1 align="center">Canvas Prompt</h1>

<p align="center">
  <a href="https://github.com/dlxeva/canvas-prompt/releases/latest"><img src="https://img.shields.io/github/v/release/dlxeva/canvas-prompt?label=latest%20release" alt="latest release"></a>
  <a href="https://github.com/dlxeva/canvas-prompt/actions/workflows/verify.yml"><img src="https://github.com/dlxeva/canvas-prompt/actions/workflows/verify.yml/badge.svg?branch=main" alt="持续集成状态"></a>
  <img src="https://img.shields.io/badge/runtime-local--first-3A7D44" alt="本地优先运行时">
  <img src="https://img.shields.io/badge/verified-macOS%20arm64-147E9E" alt="已验证 macOS arm64">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-7A5195" alt="AGPL-3.0-or-later 许可证"></a>
</p>

<p align="center"><strong>让 AI 看见该改哪里。</strong></p>

<p align="center">在你指向的地方，说出你的意思。</p>

<p align="center">圈出来 · 说出来 · 继续推进</p>

<p align="center">
  <a href="https://canvas-prompt.aizhiz.com/zh/">官网</a> · <a href="https://youtu.be/J5hnvWZsh3I" target="_blank" rel="noopener noreferrer"><strong>观看 3 分 50 秒实机演示 ↗</strong></a> · 简体中文 · <a href="./README.md">English</a>
</p>

很多工作发生在一句清晰提示词之前：草图、圈注、改口的句子、停在意图上的光标。Canvas Prompt 给这些过程一块本地画布。

你可以画、圈、移动、粘贴并自然讲述。每一轮结束后，它会把最终画面与过程证据打包成
本机上的不可变 Prompt Package。

## 一轮如何进入对话

```text
你的标注 + 素材 + 语音
             ↓
        本机 Prompt Package
             ↓
     明确续接的对话
```

画布轮次结束后保留在本机。只有你明确要求继续时，主对话才会读取这份上下文。

## 在 Codex Desktop 试一次

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin add canvas-prompt@canvas-prompt
```

新建一个 Codex 任务后：

1. 打开并开始一轮 Canvas Prompt。
2. 画图、粘贴图片、圈选区域、边操作边说。
3. 结束该轮后输入 **根据画布内容推进**。

## 三个最适合开始的场景

### 逐页审阅 PDF 或 PPTX

在顶部选择 **交互审阅**，打开本地 PDF 或 PPTX，并在页面上做标注。PDF 在本机渲染；
PPTX 在本机 LibreOffice 条件下转为只读的 PDF 衍生文件，原文件不被修改。

### 批阅图片时，不必把每一笔都翻译成文字

把原图放进画布，圈出关注区域，只描述要改的部分。带标注的快照是视觉 Brief；
如果没有原图且需要精确改图，画布会提示补充原图，而不是用小截图当源文件。

### 想法还没成句时，先把它推出来

先画结构、分叉想法、划掉一条路径、移动模块，再说明转向原因。续接时，AI 从最终画面和过程证据
开始，而不是等你复述整段思路。

## AI 实际拿到什么

- 最终画布快照与当前保留对象
- 过程时间线：绘制、移动、缩放、删除、修订
- 本地转写就绪时对齐时刻的语音片段
- 圈选、箭头、划叉、停留区域等视觉定位
- 直接观察、推断和待确认项的区分

续接只授权 AI 理解画布，不授权直接改文件、改网站、删改交付物或发布。

## 安全边界

Canvas Prompt 不会自动续聊或把内容注入当前对话；只有用户显式下达续接命令才会读取画布。
若语音不可用，仍可进行视觉续接，并以 **语音仅保存** 标记。

## 依赖摘要

| 层级 | 依赖 | 说明 |
| --- | --- | --- |
| 核心画布 | Node.js `22.12+`、npm | 主机提供，前端依赖锁文件首次安装后复用 |
| 编译器 | Python `3.11+` | 当前编译流程只使用 Python 标准库 |
| 语音 | 托管本地 ASR + `faster-whisper` | `setup` 默认准备语音运行时；也可显式使用纯视觉模式 |
| PDF/PPTX | PDF.js + 本机 `soffice` | PDF 本地渲染；PPTX 需 `soffice` 才可转为可审阅衍生文件 |

完整的运行时依赖、本地开发命令和其他 MCP 宿主兼容路径请见：

- [docs/getting-started.zh-CN.md](./docs/getting-started.zh-CN.md)

运行时要点（完整细节见上文链接）：

- 首次 `setup` 默认会准备本地 ASR 运行时；不主动静默降级。
- 可设置纯视觉模式，避免等待语音就绪时阻塞画布流程。
- 若缺少 `soffice`，只影响 PPTX 审阅链路，PDF 审阅仍保留。
- 启动前会执行 ASR 健康检查，不可用时不伪造语音状态。
- 旧项目迁入只做显式复制，不扫描未指定目录。

## 插件安装状态

```bash
codex plugin marketplace add https://github.com/dlxeva/canvas-prompt
codex plugin add canvas-prompt@canvas-prompt
```

安装/更新后建议新开一个 Codex 任务，确保当前 MCP 与 Skill 重新加载。
结束轮次后在同一任务中使用显式续接指令。

## 常见排查

- 语音转写未准备好时，仍可先做纯视觉推演，状态会标记为语音仅保存。
- 若提示 PPTX 不可审阅，先确认本机 `soffice` 可用；PDF 审阅通常仍可继续。
- 非 Codex 的 MCP 兼容宿主为通用路径，需遵循显式续接，不自动注入对话。

## 隐私

请阅读 [隐私说明](./PRIVACY.zh-CN.md) 或 [Privacy](./PRIVACY.md)。未经许可，不得公开
`.canvas-prompt/` 数据、真实录音、截图、转写或白板内容。

## 资源与许可

- [参与贡献](./CONTRIBUTING.md)
- [安全政策](./SECURITY.md)
- [支持说明](./SUPPORT.zh-CN.md)
- [隐私说明](./PRIVACY.zh-CN.md)
- [第三方声明](./THIRD_PARTY_NOTICES.md)

## 开源协议

Canvas Prompt 自有代码采用 [AGPL-3.0-or-later](./LICENSE)。第三方组件许可证见
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
