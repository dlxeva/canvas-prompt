# Contributing to Canvas Prompt

Canvas Prompt is an early local-first alpha. Small, evidence-backed fixes are
the most useful contributions: correctness, single-board integrity, privacy,
installation reliability, accessibility, and documentation clarity.

## Before opening a pull request

1. Do not add real whiteboards, recordings, transcripts, screenshots,
   `.canvas-prompt/` archives, credentials, or machine-specific paths.
2. Keep an intentional distinction between direct observations, inferences,
   and unresolved candidates. Do not turn a visual cue into a claimed user
   intent without evidence.
3. Keep the single-board archive private and explicit. A change must not scan
   arbitrary project archives or a user's arbitrary local files.
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

## Candidate dev/preview verification

The Vite development server and preview server register the same guarded local
API. The browser checks use Node.js `22.12+` and Python `3.11+`, allocate random
loopback ports, and create a temporary `CANVAS_PROMPT_DATA_HOME` and project
directory for each run. They leave `HOME` and real board/cache data untouched.

```bash
# Runs dev recovery/retry/media-failure/smoke and preview smoke.
npm run test:browser:round-export

# Existing Artifact Review entry, handoff, visual failure, responsive and image checks.
npm run test:browser:artifact-review

# Responsive PDF navigation check.
node scripts/artifact-review-browser-harness.mjs --scenario responsive
```

The exact browser setup and optional OCR research setup are documented in
[`docs/getting-started.md`](docs/getting-started.md) and
[`docs/getting-started.zh-CN.md`](docs/getting-started.zh-CN.md). These checks
describe the current candidate checkout. Passing them does not claim a
published release, human microphone/ASR acceptance, remote-host integration, or
remote CI verification of real ASR.

## Pull request notes

State what changed, how it was verified, and what remains unproven. If the
 change affects a host integration, say whether it changes only local
 package reading or a user-visible host behavior; do not imply the latter
without a real host acceptance result.
