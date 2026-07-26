---
name: canvas-prompt-read-round
description: Read and continue from the latest exported Canvas Prompt round in the active project. Use when the user has exported a canvas session, asks what Codex saw or understood from the whiteboard, asks to continue a reasoning or image-review round, or asks to read the latest Canvas Prompt Package.
---

# Canvas Prompt Read Round

Read the round as project-local context, then state clearly what is observed, what is inferred, and what remains unresolved. Do not create AI content on the canvas or claim that a thought has been understood more precisely than the package supports.

## Workflow

1. Use the `canvas_prompt` MCP server's `get_latest_prompt_package` tool. The MCP server is bound to one canonical active project when it starts; never supply or invent another project path. If it reports no round, stop: say that no exported Canvas Prompt round has reached this task and do not inspect a live browser canvas as a substitute. Prefer the returned Compact Package path, then Process IR; the raw package is for evidence checks. Inline screenshots and keyframes are intentionally excluded from normal MCP text to protect context budget. If visual inspection is necessary, open one returned local PNG path rather than requesting Base64.
2. Check whether the package includes a final canvas snapshot, timestamped actions, speech/transcription, and compiler outputs. Do not imply that a missing modality was observed.
3. Read local compiler outputs under the referenced round's `engine/` directory when available. Prefer the Compact Package for a short response and Process IR for evidence checks.
4. Classify the interaction before responding:
   - **Reasoning**: the user is working through an unfinished question or structure.
   - **Review**: the user placed an image or existing work on the canvas, marked regions, and described changes.
   - If the evidence does not distinguish them, say so rather than choosing a mode.
5. Respond in this order: what was received; concrete source-backed observations; current understanding labelled as an inference when needed; and one open point only when the ambiguity is material.
6. Continue the user's actual work when the desired outcome is clear: test the decision, find an omission, turn review marks into change requests, or execute the requested project action. Do not stop at a transcript-style “here is what I understood” response.

## Latency budget

- Read the Compact Package before any browser or image tool. Its role is to keep the first interpretation bounded even in a long Codex task.
- Do not replay raw stroke points, state frames, audio, or old task images into the conversation unless a specific unresolved observation requires one of them.
- A live-canvas screenshot is never a fallback for a missing export. It is both slower and less reliable than an explicit “no round received” state.

## Evidence boundaries

- Treat stroke geometry, timestamps, transform events, OCR, and speech as distinct sources. They can support each other but do not become the same fact.
- Do not identify a hand-drawn object, arrow direction, visual target, or user intent solely from temporal proximity.
- Do not let OCR override a clearer spoken statement; report a conflict if both are present.
- Treat the immutable round's `handoff.json` as the delivery receipt. Say “saved locally” when only the archive exists, “accepted and processing” after `turn/start`, and “delivered” only after the matching Codex turn completes. Never upgrade an accepted, timed-out, or failed receipt to delivered from inference.
- Keep the response in the Codex conversation unless the user explicitly asks for an AI addition to the canvas.

## Response shape

Use short prose first. Use bullets only when they make source distinctions clearer. For a review round, anchor descriptions to the imported work, such as “at the top of the imported image,” rather than to the global canvas quadrant.
