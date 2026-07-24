# Privacy and local data

Canvas Prompt is designed to run locally.

## What a session stores

When you export a session, Canvas Prompt writes a local round under:

```
<active-project>/.canvas-prompt/
```

Depending on what you used, a round can contain:

- the Prompt Package JSON;
- a PNG snapshot of the exported canvas region;
- the original audio recording;
- deterministic Process IR and Compact Package artifacts;
- local compiler outputs used by Codex to read the exported round.

The in-app archive lets you inspect and delete saved rounds. Deleting a round is permanent.

## Microphone and transcription

The browser asks for microphone permission only when you start a reasoning session. Audio is retained locally as part of that round. The included development setup sends audio windows to a local transcription service at `127.0.0.1:8080`; it does not upload audio to a Canvas Prompt-operated cloud service.

If you configure another ASR backend, its privacy and retention policy applies. Do not record other people or confidential material without the necessary permission.

## Public examples

Never commit real recordings, transcripts, screenshots, whiteboards, or project-local `.canvas-prompt/` folders. Public examples must be synthetic or explicitly consented and de-identified.
