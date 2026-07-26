---
name: canvas-prompt-demo-acceptance
description: Run the Canvas Prompt v0.1 Alpha manual-demo acceptance gate and write an auditable local report. Use when preparing or verifying the formal Canvas Prompt demo, checking the blank-canvas, image-review, or project-isolation acceptance rounds, or deciding whether the installed candidate is ready for Alpha release.
---

# Canvas Prompt Demo Acceptance

Validate the installed candidate, not merely the source tree. The user performs
the drawing, recording and send actions; inspect the immutable round artifacts
afterward. Never create a substitute round, inspect a live canvas as evidence,
or treat a successful build as end-to-end acceptance.

## Run the three rounds

1. Start the installed Canvas Prompt for project A. Complete a blank-canvas
   reasoning round with drawing, speech, a circle or connection, an object move,
   and **Send to Codex**. Record its package ID as `blank`.
2. In project A, import an image. Circle two regions, speak about only one,
   zoom/pan, move one mark, and send it. Record its package ID as `review`.
3. Start the installed Canvas Prompt for project B. Complete and send any short
   round. Record its package ID as `isolation`.

Do not mark a round passed only because it was saved. A handoff must be
`accepted` or `delivered`; `failed`, `timed_out`, or merely local storage fails
the gate.

## Generate the evidence report

Run the bundled script from this skill folder. It reads existing artifacts and
writes a JSON report only when all three paths are supplied.

```bash
python3 scripts/check_demo_acceptance.py \
  --project-a /absolute/path/to/project-a \
  --blank-round pp_... \
  --review-round pp_... \
  --project-b /absolute/path/to/project-b \
  --isolation-round pp_... \
  --report /absolute/path/to/demo-acceptance-report.json
```

For a failed round, report the exact missing or invalid artifact. Do not repair
the round in place. Re-run the user-visible flow after a fix and create a new
round.

## Interpret the result

- `passed: true` means the three exported packages satisfy this v0.1 evidence
  gate. It does not prove language generalization, automatic intent resolution,
  or public-release readiness.
- `passed: false` blocks Alpha until the relevant failure is fixed and a fresh
  round passes.
- Keep the report local or attach it to a private PR. Never put real round
  archives, recordings, snapshots or transcripts into a public repository.

The gate checks factual evidence, not a user-facing mode label: a blank round
must have no image material, while an image-review round must contain image
material and material-relative review-mark observations. Canvas Prompt does not
ask users to select a “reasoning” or “review” mode.
