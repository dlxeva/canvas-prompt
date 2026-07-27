# Contributing to Canvas Prompt

Canvas Prompt is an early local-first alpha. Small, evidence-backed fixes are
the most useful contributions: correctness, project isolation, privacy,
installation reliability, accessibility, and documentation clarity.

## Before opening a pull request

1. Do not add real whiteboards, recordings, transcripts, screenshots,
   `.canvas-prompt/` archives, credentials, or machine-specific paths.
2. Keep an intentional distinction between direct observations, inferences,
   and unresolved candidates. Do not turn a visual cue into a claimed user
   intent without evidence.
3. Keep the canvas project-local. A change must not silently read another
   project or a user's arbitrary local files.
4. Add or update a focused test for behavioral changes.

## Local checks

```bash
npm ci
npm --prefix app ci
npm run verify
python3 maintainer-skills/canvas-prompt-release-check/scripts/check_release.py --repo .
```

For first-install changes, also run the isolated smoke test:

```bash
bash scripts/clean-room-smoke.sh
```

The smoke test downloads a local ASR model on a cold cache and may take several
minutes. It is not a substitute for a separate-machine or host-integration
acceptance test.

## Pull request notes

State what changed, how it was verified, and what remains unproven. If the
change affects a host integration, say whether it changes only project-bound
package reading or a user-visible host behavior; do not imply the latter
without a real host acceptance result.
