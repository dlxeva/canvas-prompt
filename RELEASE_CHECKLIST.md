# Release readiness — Canvas Prompt v0.1.0

This checklist distinguishes verified local facts from work that must happen before a public announcement.

## Verified locally on 2026-07-24

- [x] The repository contains a Codex marketplace manifest at `.agents/plugins/marketplace.json`.
- [x] The plugin is available as `canvas-prompt@canvas-prompt` from that marketplace layout.
- [x] A clean `CODEX_HOME` installed the plugin successfully.
- [x] The installed plugin started its bundled Excalidraw app against an active project.
- [x] The bundled app returned its root page and local archive endpoint.
- [x] `npm test` passed: 3 files, 13 tests.
- [x] `npm run build` passed.
- [x] The bundled deterministic compiler produced Process IR and Compact Package artifacts from an existing local Prompt Package.
- [x] The repository contains AGPL-3.0-or-later and third-party notice files.
- [x] The repository ignores dependency trees, build output, and `.canvas-prompt/` session data.

## Required before public push or announcement

- [ ] Inspect the full Git diff for accidental recordings, screenshots, transcripts, credentials, or project-local paths.
- [ ] Run one fresh browser session from the installed plugin: image review or reasoning, export, then MCP-read the resulting Prompt Package.
- [ ] Run the 10-minute regression and the supported 30-minute single-user acceptance session.
- [ ] Confirm microphone permission, local ASR availability/fallback behavior, and archive deletion wording on a fresh machine or profile.
- [ ] Verify the manual continuation path: export a round, then ask Codex to read the latest Canvas Prompt Package for the active project. Automatic insertion into the Codex composer is not a v0.1 claim.
- [ ] Commit the reviewed release state locally, then obtain explicit approval before pushing `dlxeva/canvas-prompt`.

## Deliberate v0.1 boundary

Canvas Prompt v0.1 is a local input-and-understanding demo. It supports open-ended reasoning and image review. It does not claim automatic AI canvas output, PDF/PPT review, real-time AI feedback during a reasoning turn, or hidden-intent detection.
