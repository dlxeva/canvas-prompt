---
name: canvas-prompt-read-round
description: Read and continue from the latest exported Canvas Prompt round in the active scope. The canonical continuation commands are “根据画布内容推进” and “Continue with the canvas context”; invoke this skill whenever the user uses either command, then read the latest package before responding. Treat legacy “根据白板内容推进” as a compatible alias. Also use when the user explicitly asks Codex to read, understand, or continue from an exported Canvas Prompt round. Do not activate from an unrelated vague prompt or merely because an old project archive exists.
---

# Canvas Prompt Read Round

Read the round as project-local context, then state clearly what is observed, what is inferred, and what remains unresolved. Do not create AI content on the canvas or claim that a thought has been understood more precisely than the package supports.

## Canonical continuation command

Treat **“根据画布内容推进”** and **“Continue with the canvas context”** as the
stable handoff commands. It means:

1. Read the latest immutable Canvas Prompt package in the fixed active scope.
2. Use the Compact Package first, then continue the user's actual work directly.
3. Do not ask the user to repeat “读取画布”, supply a Package ID, or describe the command as merely a suggestion.

It is a handoff, **not a mode selector**. The user does not need to decide
whether this was a “review”, “reasoning”, or another canvas use case before
starting or ending a round. Infer the useful next action from the package and
the current conversation.

Vague prompts such as “你怎么看？” remain ordinary conversation. Do not pretend
that the local canvas can reliably bind itself to the visible Codex task without
an explicit host-provided bridge. Never search an old project archive to
manufacture context.

The legacy command **“根据白板内容推进”** remains a compatible alias, but is not
shown as the primary product wording.

## Workflow

1. Use the `canvas_prompt` MCP server's `get_latest_prompt_package` tool. The MCP server is bound to one canonical active project when it starts; never supply or invent another project path. If it reports no round, stop: say that no exported Canvas Prompt round has reached this task and do not inspect a live browser canvas as a substitute. Prefer the returned Compact Package path, then Process IR; the raw package is for evidence checks. Inline screenshots and keyframes are intentionally excluded from normal MCP text to protect context budget. If visual inspection is necessary, open one returned local PNG path rather than requesting Base64.
2. Check whether the package includes a final canvas snapshot, timestamped actions, speech/transcription, and compiler outputs. Do not imply that a missing modality was observed.
3. Read local compiler outputs under the referenced round's `engine/` directory when available. Prefer the Compact Package for a short response and Process IR for evidence checks.
4. Route by the user's actual objective, without exposing a mode choice:
   - **Change path.** When an imported image, existing work, or a prior canvas structure is being marked with circles, crosses, arrows, replacements, or explicit change language, turn the evidence into concrete change requests. If the target and requested action are available in the active task, carry out the change; otherwise state the actionable edits and the one missing target only if it blocks action.
   - **Reasoning path.** When the round expresses a structure, trade-off, hypothesis, dependency, priority, or derivation, help the user advance it: surface assumptions, test the logic, identify omissions and risks, and propose the next decision or experiment. A request such as “还有哪里没考虑周全” belongs here.
   - **Context-and-collaboration path.** When the canvas primarily supplies background for an ongoing task, use it as context for the user's current request instead of narrating it back or asking the user to label the use case.
   - **Mixed path.** A marked design can also contain strategic reasoning. Preserve both when supported; do not force the round into one label.
   - Ask one minimal clarification only when neither the evidence nor the current request reveals the desired outcome. For example: “你希望我把这些落实成修改，还是先帮你推演和查漏？”
5. Respond in this order: what was received; concrete source-backed observations; current understanding labelled as an inference when needed; and the useful next work. Do not lead with an internal route label.
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
