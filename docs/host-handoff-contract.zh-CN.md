# 宿主交接与自动快照附件契约

Canvas Prompt 的统一交付不是“某个宿主有批注按钮”，而是两条可分别验证的链路：

1. **完整上下文交接**：当前轮的 Prompt Package、过程证据与本地项目边界可被当前主对话读取。
2. **自动主对话快照附件**：同一轮的最终快照自动出现在当前主对话中，作为用户可见、可定位的送达凭据。

批注、网页元素加入聊天、预填会话附件或宿主消息 API 都只是第二条链路的实现方式。

## 宿主适配器必须报告的能力

每个适配器为当前运行时返回下面两项，禁止由“能打开网页”或“用户能手工上传图片”推断：

| 字段 | 枚举 | 含义 |
| --- | --- | --- |
| `context_delivery` | `automatic` / `mcp_pull` / `manual` / `unavailable` | 完整上下文如何到达当前主对话 |
| `snapshot_attachment` | `automatic` / `pending_verification` / `manual_only` / `unavailable` | 最终快照能否由适配器自动写入当前主对话 |

适配器还必须返回稳定的 `package_id` 和 `attachment_message_id`。同一 Package 重试使用同一个附件标识，不能堆叠重复快照或触发重复推理。

## 用户可见状态

| 上下文交接 | 快照附件 | 白板状态 |
| --- | --- | --- |
| `automatic` | `automatic` | `✓ 已送入主对话` |
| `automatic` | `pending_verification` | `主对话已接收上下文 · 正在确认快照附件` |
| `mcp_pull` | 任意非自动状态 | `✓ 已保存 · 等待当前对话读取` |
| `manual` | `manual_only` | `✓ 已保存 · 可手动附加快照` |
| `unavailable` | 任意 | `已保存 · 当前宿主无法交接` |

`✓ 已送入主对话` 只在两条链路均为 `automatic` 且目标宿主回执确认后使用。模型可见历史、用户手动拖拽附件、或仅存在网页批注 UI，都不能满足该状态。

## 当前已知适配状态

| 宿主 | 完整上下文 | 自动快照附件 | 当前行动 |
| --- | --- | --- | --- |
| Codex Desktop | `automatic` | `pending_verification` | 已通过 App Server 用同轮 `localImage` 与稳定 `clientUserMessageId` 请求附件；需安装版真人确认 UI 渲染。 |
| ZCode | `mcp_pull` | `pending_verification` | 已观察到“选择网页元素加入聊天”UI；需确认是否有供插件调用的会话附件写入 API。 |
| WorkBuddy | `mcp_pull` | `pending_verification` | 已确认项目绑定 MCP 读取；需探测是否存在当前会话本地图片附件写入 API。 |

## 实现顺序

1. 先在 Canvas 服务的运行时身份与 `handoff.json` 写入这两项能力和独立回执；前端严格按上表显示。
2. Codex 先完成安装版 UI 验收；失败时保留完整交接，不伪称快照可见。
3. ZCode、WorkBuddy 只在其官方接口证明可自动写入当前会话附件后新增适配器；不使用坐标点击、模拟地址栏按钮或未文档化内部协议。
4. 没有自动附件 API 的宿主，Host Skill 在读取到新 Package 后必须先发一条文字回执，再进入理解和讨论；文字回执是降级，不是附件能力。
