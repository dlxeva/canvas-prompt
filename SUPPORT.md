# Support

Canvas Prompt v0.1.35 is an early local-first alpha. Support is maintained on
a best-effort basis. There is no guaranteed response time or uptime promise.

## Public support scope

- Codex Desktop is the supported and recommended first integration.
- The public workflow uses one local board, a local Prompt Package, and an
  explicit continuation command in the conversation.
- Other MCP-capable terminals are compatibility paths. Their native side
  panels, automatic chat injection, and automatic continuation are not part
  of the v0.1 promise.
- The v0.1.35 public release describes Interactive Review for local PDF and
  PPTX material. Environment-specific dependencies, including local
  LibreOffice for PPTX review, must be reported with the issue.
- The public repository identifies macOS arm64 as the verified platform. Other
  environments may require additional investigation and are not a published
  support promise.

## What this alpha does not promise

- Automatic reconstruction of every user intention.
- Automatic binding of an ambiguous phrase such as `this`, `here`, or `这个`
  to one unique object.
- Automatic injection into the currently visible chat or automatic
  continuation without an explicit user command.
- Support for local candidate work, unreleased host behavior, or private
  research branches.

## Where to ask

- Use a Bug Report issue for a reproducible public-version defect.
- Use an Installation or Host Issue for setup, Codex Desktop, MCP, or local
  dependency problems.
- Use a Documentation issue when the published instructions are missing or
  misleading.
- Use a Feature Proposal for a scoped workflow need. If Discussions is
  enabled, use it for early questions and ideas before opening a feature issue.
- Use the private security route described in [SECURITY.md](./SECURITY.md) for
  vulnerabilities.

## What to include

Include the exact version or commit, operating system and architecture, host
integration, reproduction steps, expected result, actual result, and sanitized
evidence. Say whether the report uses the published v0.1.35 release or a local
build.

Remove credentials, tokens, private canvas files, Prompt Packages, recordings,
transcripts, screenshots with sensitive information, machine-specific paths,
and client or student material before posting. Do not attach real whiteboards
or recordings to a public issue.

## Scope and triage

This is a maintainer-run alpha. Maintainers review new public reports once a
week, then reports may be triaged, labeled, answered, converted into a task,
or closed when they are outside the public scope, cannot be reproduced, or
require private material that cannot be shared. A weekly triage cadence does
not create a response-time or resolution-time guarantee.

Maintainers do not treat issue counts, comments, or reactions as product
validation without separate evidence review.

## 中文摘要

Canvas Prompt v0.1.35 是早期本地优先版本，支持按最佳努力提供，不承诺固定响应时间或 uptime。
Codex Desktop 是推荐集成；其他 MCP 宿主属于兼容路径。公开支持范围包含本地 PDF 和 PPTX 交互审阅，PPTX 需要本机可发现的 LibreOffice `soffice`，当前已验证平台为 macOS arm64。

公开支持不包含自动还原所有意图、自动把“这个”绑定到唯一对象、自动注入当前聊天、自动续聊、本地候选分支或未发布宿主行为。

提问时请提供版本、系统架构、宿主、复现步骤、预期结果、实际结果和脱敏证据。请删除凭据、Token、私有画布、Prompt Package、录音、转写、敏感截图、机器特有路径及客户或学生材料。维护者每周进行一次轻量 triage，但这不构成响应或解决时限承诺。
