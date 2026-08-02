---
name: canvas-prompt-read-artifact-review
description: Retrieve and understand the latest exported Canvas Prompt PDF or PPTX interactive review. Use after the user chooses the AI handoff action, asks the AI to collect or continue from a document review, or asks what was marked on reviewed pages. Distinguish project-native artifacts from external files, disclose page context progressively, measure understanding instead of inventing a recognition rate, and never treat review evidence as permission to edit the source.
---

# Canvas Prompt Read Artifact Review

Collect the latest immutable PDF/PPTX review, acknowledge receipt, and determine whether page, spatial, voice, and source context are sufficient to understand the requested changes.

## Retrieve the review

1. Use the `canvas_prompt` MCP tool `get_latest_artifact_review`. If that tool is unavailable in the current host, run the maintained fallback `node bin/canvas-prompt.mjs read-artifact-review`. Both return the same compact response.
2. Do not read arbitrary JSON paths, scan for likely PDFs/PPTX files, or use the live browser as a substitute for an exported review.
3. Confirm the package ID, source hash, artifact kind, page count, annotation count, voice count, review state, delivery mode, and visual-evidence availability. Local archive paths are deliberately not disclosed.
4. Reply with a receipt before analysis. The user should not need to ask the AI a second time after handoff.

## Identify the source path

Choose one evidence path without asking the user to label a mode:

- **Project-native artifact:** The current project already has a source file or render manifest whose hash/version matches the review. Reuse that known project context. Do not re-read or re-render the full artifact by default.
- **External artifact:** The review identifies the artifact by hash but the current project has no matching source context. Treat the file as unknown until a private local locator or explicit user attachment makes it available. Never guess a path or scan unrelated directories.

## Disclose context progressively

Stop as soon as the next level is sufficient:

1. **Identity:** artifact kind, hash/version, page count, package state.
2. **Review map:** visited pages, annotated pages, mark kinds, timestamps, transcript, unresolved references.
3. **Marked-page context:** text structure or a bounded render for annotated pages only.
4. **Target context:** the marked region plus a small surrounding crop, nearby text, and adjacent objects.
5. **Full page:** only when the local region remains ambiguous.
6. **Whole source:** only when a material edit requires it and the user has authorized that action.

Do not place original file bytes, every page render, dense gesture points, or unrelated pages into model context. Cache local page extraction by source hash and page number when the runtime supports it.

## Judge understanding

Keep these signals separate:

- page identity and visible-page timeline;
- normalized mark region and gesture kind;
- voice transcript and ASR confidence;
- temporal proximity between speech and marks;
- source page pixels/text;
- explicit user confirmation.

Report one status:

- **sufficient:** the requested target and change are supported by source context plus consistent page/spatial/voice evidence;
- **partial:** the general request is clear but one or more targets remain ambiguous;
- **insufficient:** page content or the requested change cannot be identified safely.

Temporal proximity alone is a candidate, never a confirmed binding. Reject a binding when the restored visible page and page-visit timeline disagree. Separate feedback about the review tool itself from feedback about the reviewed artifact.

## Measure recognition

Do not claim a percentage from one round. Track independently:

- transcript semantic retention;
- page attribution accuracy;
- annotation-to-voice binding precision and coverage;
- target identification accuracy after bounded page context is available;
- clarification rate;
- unsupported-action rate, which must remain zero.

Use user-confirmed targets as ground truth. A useful system prefers an explicit clarification over a confident wrong edit.

## Confirm intent in the conversation

Do not ask the person to confirm annotation IDs, evidence IDs, transcript segment IDs, or low-level speech-to-mark bindings. Those are internal evidence. Preserve uncertain bindings and resolve only the uncertainty that changes the proposed result.

When the person wants a PDF, PPTX, image, webpage, prototype, generated asset, or source file changed, translate the review into one human-readable confirmation plan in the conversation. Use this fixed semantic order, adapting labels naturally to the person's language:

1. **Overall goal:** what outcome the review appears to request.
2. **Global changes:** rules that affect more than one page or region.
3. **Page or region changes:** the concrete target, requested action, and reason, grouped by page or image rather than by internal evidence ID.
4. **Preserve:** what must remain unchanged, including the read-only original.
5. **Uncertainties:** only ambiguities that could materially change the output; give a bounded choice when possible.
6. **Output:** what new copy, version, or artifact will be produced.

End with one direct request to confirm or correct this plan. A clear affirmative reply to the immediately preceding bounded plan is sufficient; do not force a magic phrase. Until that reply, stop before any material write and treat `execution_authorized: false` as a hard gate.

After confirmation, execute only the confirmed scope. If execution discovers a material new choice, affected page, destructive operation, or scope expansion, stop and reconfirm. Never treat an earlier confirmation for another package or source version as reusable permission.

After execution, return a receipt stating what actually changed, what did not change, unresolved or failed items, the new output location or attachment, and whether the original remained unchanged.

Discussion, analysis, and summarization may continue without execution confirmation. The confirmation gate applies when a material change is about to occur, not when evidence is merely being read.
