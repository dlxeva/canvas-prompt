---
name: canvas-prompt-demo-acceptance
description: Run the Canvas Prompt v0.1 Alpha manual-demo acceptance gate and write an auditable local report. Use when preparing or verifying the formal Canvas Prompt demo, checking the blank-canvas, image-review, or explicit cross-conversation continuation rounds, or deciding whether the installed candidate is ready for Alpha release.
---

# Canvas Prompt Demo Acceptance

Validate the installed candidate, not merely the source tree. The user performs
the drawing, recording and send actions; inspect the immutable round artifacts
afterward. Never create a substitute round, inspect a live canvas as evidence,
or treat a successful build as end-to-end acceptance.

## Run the three rounds

1. Start the installed Canvas Prompt. Complete a blank-canvas
   reasoning round with drawing, speech, a circle or connection, an object move,
   and **Send to Codex**. Record its package ID as `blank`.
2. Import an image. Circle two regions, speak about only one,
   zoom/pan, move one mark, and send it. Record its package ID as `review`.
3. Switch to another main conversation (or reopen from another project). Confirm
   the same healthy Canvas Prompt service and board are reused, then explicitly
   enter “根据画布内容推进” in the conversation that should read the latest
   completed round. Record that latest package ID as `continuation`.

Do not mark a round passed only because it was saved. The visible continuation
conversation must read the latest immutable package after the explicit command;
it must not require a package ID, a project path, JSON pasted into chat, or a
guessed historical conversation binding.

## Generate the evidence report

Run the bundled script from this skill folder. It reads existing artifacts and
writes a private JSON report. The third round normally needs its path. If the
release owner explicitly waives it, record that waiver instead of inventing a
pass.

```bash
python3 scripts/check_demo_acceptance.py \
  --board-dir ~/.canvas-prompt/board \
  --blank-round pp_... \
  --review-round pp_... \
  --continuation-round pp_... \
  --report /absolute/path/to/demo-acceptance-report.json
```

An explicit waiver is auditable but is **not** evidence that cross-conversation
continuation worked:

```bash
python3 scripts/check_demo_acceptance.py \
  --board-dir ~/.canvas-prompt/board \
  --blank-round pp_... \
  --review-round pp_... \
  --waive-continuation \
  --waiver-reason "release owner judged this scenario non-essential for v0.1" \
  --report /absolute/path/to/demo-acceptance-report.json
```

For a failed round, report the exact missing or invalid artifact. Do not repair
the round in place. Re-run the user-visible flow after a fix and create a new
round.

## Interpret the result

- `passed: true` means the supplied evidence paths passed. A continuation
  waiver remains visible as `waived`; it does not prove that scenario. This
  never proves language generalization, automatic intent resolution, or public
  release readiness.
- `passed: false` blocks Alpha until the relevant failure is fixed and a fresh
  round passes.
- Keep the report local or attach it to a private PR. Never put real round
  archives, recordings, snapshots or transcripts into a public repository.

The gate checks factual evidence, not a user-facing mode label: a blank round
must have no image material, while an image-review round must contain image
material and material-relative review-mark observations. Canvas Prompt does not
ask users to select a “reasoning” or “review” mode.
