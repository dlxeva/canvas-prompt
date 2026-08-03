# GitHub Discussions setup

This document describes the proposed categories and maintenance practice for
GitHub Discussions. It does not enable GitHub Discussions or create a remote
post.

## Purpose

Use Discussions for non-code collaboration around the public Canvas Prompt
v0.1.35 release. Keep reproducible bugs and scoped implementation work in
Issues. Move a discussion to an Issue only after the problem, scope, and
acceptance signal are clear. Never post credentials, private canvas data,
recordings, transcripts, Prompt Packages, or sensitive screenshots.

## Proposed categories

| Category | Use it for | First maintainer action |
| --- | --- | --- |
| Announcements | Published releases, public boundary changes, and maintenance notices | Pin the current scope and link the matching Release |
| Q&A | Installation, Codex Desktop, MCP, local setup, and public workflow questions | Answer with the public docs and mark a useful answer when available |
| Workflows | How people use a canvas, material, speech, and explicit continuation | Ask one concrete follow-up and separate observation from interpretation |
| Ideas | Early needs and possible directions | Keep it as discussion until scope and evidence are clear |
| Show and tell | Non-sensitive public examples and workflow notes | Check that no private material or unverified product claim is included |

If GitHub category permissions support maintainer-only announcements, use that
setting for Announcements. Do not depend on it for safety; review every public
post before pinning it.

## Proposed first post

Title: `Welcome to Canvas Prompt Discussions`

Body:

```text
Canvas Prompt is an early local-first alpha for carrying canvas structure,
revisions, speech, timing, and visual references into an explicit AI
continuation step.

Codex Desktop is the supported and recommended first integration for v0.1.35.
Other MCP-capable terminals are compatibility paths. Ambiguous references stay
as evidence-bounded candidates when the available evidence is insufficient.

Please use this space for questions and workflow reports. For reproducible
public-version defects, open an Issue. For security concerns, follow
SECURITY.md and keep private material out of public conversations.

What is the first point where your current visual-to-AI workflow loses context?
Please describe the workflow without sharing private canvas data.
```

Official maintainer communication should be in English. A concise Chinese
summary may be added when it helps readers understand the post without
changing the canonical English wording.

## Maintenance practice

- Add a concrete question to every maintainer post.
- Explain the purpose of every external link. Do not post links only to drive
  traffic.
- Do not cross-post the same announcement into several categories.
- Mark answers when they resolve a question; do not treat reactions as product
  validation.
- Convert a discussion to an Issue when the task has a clear scope and
  acceptance signal.
- Review new public Discussions and Issues once a week, record a status or
  next step, and keep the cadence separate from any response-time promise.
- Lock or close conversations that become off-topic, unsafe, or repetitive,
  following the Code of Conduct and GitHub Community Guidelines.

## Enablement decision

Before enabling Discussions, the owner should choose:

1. Who can moderate and answer public questions.
2. How often the repository will be triaged.
3. Whether announcements are maintainer-only.
4. Which language is the default for public replies.
5. What evidence can be discussed publicly without exposing private work.

## 中文摘要

这份文件说明未来启用 GitHub Discussions 时的分类和维护方式，当前不会开启 Discussions，也不会创建远程帖子。

Discussions 适合安装问答、公开工作流分享和早期想法；可复现缺陷应进入 Issue，安全问题应按照 `SECURITY.md` 走私密渠道。请勿发布凭据、私有画布、录音、转写、Prompt Package 或敏感截图。建议分类包括公告、问答、工作流、想法和展示分享。

官方维护沟通使用英语，必要时可以附简短中文摘要。维护者每周查看新 Issue 和 Discussion，记录状态或下一步；这个节奏不构成固定响应时间承诺。由仓库负责人承担最终维护判断，日常准备、回复草拟和 triage 可以获得协助。
