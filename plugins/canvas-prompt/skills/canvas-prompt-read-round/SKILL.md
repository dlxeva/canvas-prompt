---
name: canvas-prompt-read-round
description: Read and continue from the latest exported Canvas Prompt round in the active project. Use when the user has exported a canvas session, asks what Codex saw or understood from the whiteboard, asks to continue a reasoning or image-review round, or asks to read the latest Canvas Prompt Package.
---

# Canvas Prompt Read Round

Read the round as project-local context, then state clearly what is observed, what is inferred, and what remains unresolved. Do not create AI content on the canvas or claim that a thought has been understood more precisely than the package supports.

## Workflow

1. Use the `canvas_prompt` MCP server's `get_latest_prompt_package` tool with the active project directory. If it is unavailable, read `<project>/.canvas-prompt/latest-prompt-package.json` directly.
2. Check whether the package includes a final canvas snapshot, timestamped actions, speech/transcription, and compiler outputs. Do not imply that a missing modality was observed.
3. Read local compiler outputs under the referenced round's `engine/` directory when available. Prefer the Compact Package for a short response and Process IR for evidence checks.
4. Classify the interaction before responding:
   - **Reasoning**: the user is working through an unfinished question or structure.
   - **Review**: the user placed an image or existing work on the canvas, marked regions, and described changes.
   - If the evidence does not distinguish them, say so rather than choosing a mode.
5. Respond in this order: what was received; concrete source-backed observations; current understanding labelled as an inference when needed; and one open point only when the ambiguity is material.

## Evidence boundaries

- Treat stroke geometry, timestamps, transform events, OCR, and speech as distinct sources. They can support each other but do not become the same fact.
- Do not identify a hand-drawn object, arrow direction, visual target, or user intent solely from temporal proximity.
- Do not let OCR override a clearer spoken statement; report a conflict if both are present.
- Do not say that the round was delivered into the current chat automatically. It was exported locally for this project and is being read now.
- Keep the response in the Codex conversation unless the user explicitly asks for an AI addition to the canvas.

## Response shape

Use short prose first. Use bullets only when they make source distinctions clearer. For a review round, anchor descriptions to the imported work, such as “at the top of the imported image,” rather than to the global canvas quadrant.
