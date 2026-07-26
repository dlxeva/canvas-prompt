---
name: canvas-prompt-release-check
description: Run the read-only Canvas Prompt open-source release check for privacy, plugin metadata, version, repository cleanliness, and validation evidence. Use when preparing a public Canvas Prompt repository or release candidate, reviewing a release before publication, or deciding whether a private branch is safe to promote to an open-source Alpha.
---

# Canvas Prompt Release Check

Run this before any public push, marketplace submission, package publication or
demo announcement. It is an evidence gate only: do not commit, push, publish,
delete files, or change repository visibility.

## Run the local checks

From the Canvas Prompt source repository, run:

```bash
python3 maintainer-skills/canvas-prompt-release-check/scripts/check_release.py --repo .
npm run verify
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" skills/canvas-prompt-open-canvas
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" skills/canvas-prompt-read-round
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" maintainer-skills/canvas-prompt-demo-acceptance
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" maintainer-skills/canvas-prompt-release-check
```

Then run `$canvas-prompt-demo-acceptance` against the installed release
candidate. A green source build cannot replace that result.

## Blockers

Treat these as blockers until reviewed and resolved:

- a tracked `.canvas-prompt/` archive, recording, snapshot, transcript or raw
  Prompt Package;
- a likely credential assignment or private absolute path in tracked text;
- missing LICENSE, privacy notice, plugin manifest, or version verification;
- a dirty worktree whose intended contents have not been reviewed;
- failed verification or missing three-round demo acceptance report.

The script deliberately reports suspicious paths and patterns without printing
possible secret values. It can have false positives; inspect each finding before
editing. Do not turn a warning into an automatic deletion.

## Report honestly

State separately: static repository check, automated verification, installed
demo acceptance, and publication authorization. Only the first is performed by
the bundled script. A pass does not authorize a public release.
