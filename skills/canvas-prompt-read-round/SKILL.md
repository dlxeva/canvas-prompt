---
name: canvas-prompt-read-round
description: Read and continue from the latest exported Canvas Prompt round in the active scope. The canonical continuation commands are “根据画布内容推进” and “Continue with the canvas context”; invoke this skill whenever the user uses either command, then read the latest package before responding. Treat legacy “根据白板内容推进” as a compatible alias. Also use when the user explicitly asks Codex to read, understand, or continue from an exported Canvas Prompt round. Do not activate from an unrelated vague prompt or merely because an old project archive exists.
---

# Canvas Prompt Read Round

Read the latest completed single-board round as explicit user-provided context, then state clearly what is observed, what is inferred, and what remains unresolved. Do not create AI content on the canvas or claim that a thought has been understood more precisely than the package supports.

## Canonical continuation command

Treat **“根据画布内容推进”** and **“Continue with the canvas context”** as the
stable handoff commands. It means:

1. Read the latest immutable Canvas Prompt package in the fixed active scope.
2. Use the Compact Package first, then decide whether the user's next step is discussion or a material action. The command authorizes reading and understanding the canvas; it never independently authorizes a material action.
3. Do not ask the user to repeat “读取画布”, supply a Package ID, or describe the command as merely a suggestion.

It is a handoff, **not a mode selector**. The user does not need to decide
whether this was a “review”, “reasoning”, or another canvas use case before
starting or ending a round. Infer the useful next action from the package and
the current conversation.

Vague prompts such as “你怎么看？” remain ordinary conversation. The explicit
continuation command is the user's consent to read the single board's latest
completed round.

The legacy command **“根据白板内容推进”** remains a compatible alias, but is not
shown as the primary product wording.

## Workflow

1. Use the `canvas_prompt` MCP server's `get_latest_prompt_package` tool without a project path or conversation token. It reads the user's single active board. If it reports no round, say that the board has no exported round yet and do not inspect a live browser canvas as a substitute. Prefer the returned Compact Package path, then Process IR; the raw package is for evidence checks. Inline screenshots and keyframes are intentionally excluded from normal MCP text to protect context budget. If visual inspection is necessary, open one returned local PNG path rather than requesting Base64.
2. Check whether the package includes a final canvas snapshot, timestamped actions, speech/transcription, and compiler outputs. Do not imply that a missing modality was observed.
3. Read local compiler outputs under the referenced round's `engine/` directory when available. Prefer the Compact Package for a short response and Process IR for evidence checks.
4. Route by the user's actual objective, without exposing a mode choice:
   - **Change path.** When an imported image, existing work, or a prior canvas structure is being marked with circles, crosses, arrows, replacements, or explicit change language, compile the final snapshot, marks, spatial relations, and linked speech into a visual edit brief.
     - Treat generating or replacing an asset, changing a website or source file, sending, publishing, deleting, or any other material write as an **execution request**. First give a short collaborative restatement: observations, reasonable inferences, unresolved points, and the proposed plan. Wait for the user's explicit confirmation before acting, even when the requested outcome seems clear.
     - In Codex, use native Plan mode when it is available. In another host, produce the same confirmation plan in chat: “我理解的修改／准备怎么做／待确认” (or the equivalent in the user's language). Do not claim to have switched UI modes when the host does not expose one.
     - After confirmation, if the snapshot is clear enough to preserve the relevant visual details, use it as the reference and generate or edit a clean revised asset. Return the revised asset in the current conversation. Do not block on locating an original project file.
     - After confirmation, if the snapshot is too small, blurred, cropped, or otherwise insufficient to preserve important details, ask the user to attach the original image in the current conversation. Then combine that original with the already-compiled visual edit brief; do not ask the user to repeat the annotations.
     - Only after confirmation, search for and modify a project source file when the user explicitly asks to change that source. Never claim that a newly generated asset modified an unknown original file.
   - **Reasoning path.** When the round expresses a structure, trade-off, hypothesis, dependency, priority, or derivation, help the user advance it: surface assumptions, test the logic, identify omissions and risks, and propose the next decision or experiment. A request such as “还有哪里没考虑周全” belongs here.
   - **Context-and-collaboration path.** When the canvas primarily supplies background for an ongoing task, use it as context for the user's current request instead of narrating it back or asking the user to label the use case.
   - **Mixed path.** A marked design can also contain strategic reasoning. Preserve both when supported; do not force the round into one label.
   - Ask one minimal clarification only when neither the evidence nor the current request reveals the desired outcome. For example: “你希望我把这些落实成修改，还是先帮你推演和查漏？”
5. Respond in this order: what was received; concrete source-backed observations; current understanding labelled as an inference when needed; and the useful next work. Do not lead with an internal route label.
6. Continue pure reasoning or discussion when the desired outcome is clear: test the decision, find an omission, or surface risks. For a material action, stop after the confirmation plan and wait for the user’s explicit go-ahead. Do not stop at a transcript-style “here is what I understood” response or at “the original file path is unknown.”

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
