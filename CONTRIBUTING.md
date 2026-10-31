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

# Flowchart/sequence native editing; class/ER known SVG fallback contracts.
npm run test:browser:mermaid

# Old public archive -> candidate read -> new browser round -> restart.
npm run test:browser:upgrade

# Responsive PDF navigation check.
node scripts/artifact-review-browser-harness.mjs --scenario responsive
```

The exact browser setup and optional OCR research setup are documented in
[`docs/getting-started.md`](docs/getting-started.md) and
[`docs/getting-started.zh-CN.md`](docs/getting-started.zh-CN.md). These checks
describe the current candidate checkout. Passing them does not claim a
published release, human microphone/ASR acceptance, remote-host integration, or
remote CI verification of real ASR.

`npm run verify` includes `npm run verify:deps` (`npm ls --all` for the app).
Green build/tests do not waive an invalid dependency tree. Nano ID overrides
are branch-scoped: the existing 3.x consumers remain on 3.x, while the ESM
Mermaid converter uses patched 5.x and is covered by a browser import check.
Class/ER SVG fallback was reproduced on public main `e344b509`; that check
records the limitation and rejects new/unexpected errors. It does not claim
that nodes inside those two diagram types are individually editable.

The upgrade gate requires Git history containing public baseline
`e344b509ac9f2bf44da23434b702ce38908a1692`. It reads that commit from the
candidate checkout, or from an explicitly supplied `CANVAS_PROMPT_PUBLIC_REPO`
local checkout. Missing history fails the test; it never fetches another repo
or searches host archives. Only the old archive/compiler functions run, with
synthetic data and temporary paths (including an isolated child-process home).
The candidate browser creates a new round, then a fresh candidate process
reopens both archives. The test records exact source/module identities and
checks that every old archive file stays byte-identical. Real user archives,
plugin caches, live listeners, and microphone/ASR acceptance remain outside
this automated gate.

## Pull request notes

State what changed, how it was verified, and what remains unproven. If the
 change affects a host integration, say whether it changes only local
 package reading or a user-visible host behavior; do not imply the latter
without a real host acceptance result.
