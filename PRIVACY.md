# Privacy and local data

[简体中文](./PRIVACY.zh-CN.md) · English

Canvas Prompt is designed around project-local storage. Sending a round to Codex is a separate, explicit action.

## What a round stores

When a round is exported, Canvas Prompt writes local data under:

```text
<active-project>/.canvas-prompt/
```

Depending on the session, this can include:

- the Prompt Package JSON and raw lifecycle trace;
- a PNG snapshot and selected state frames;
- the original audio recording;
- Process IR and Compact Package artifacts;
- round metadata, local artifact paths, and a Codex handoff receipt;
- the selected Codex task and turn identifiers needed to track delivery.

The in-app archive can inspect and permanently delete a local round. A deleted round cannot be restored from Canvas Prompt.

## Microphone and transcription

Canvas Prompt requests microphone access when any round starts. If permission is denied or the microphone is unavailable, canvas events continue to be recorded without audio.

The current development setup sends completed audio windows to a local transcription service at `127.0.0.1:8080`. Canvas Prompt does not operate a transcription cloud service. If that local service is unavailable, the original recording may still be stored locally while timestamped transcript evidence remains unavailable.

If you configure a remote or third-party ASR backend, that provider's privacy, retention, and regional processing terms apply. Do not record other people or confidential material without the necessary permission.

## Sending a round to Codex

Selecting **Send to Codex** submits the immutable round context to the current Codex task through the local Codex app server. The submitted message can reference the compiled context, final snapshot, and project-local artifact paths. Handling after submission follows the privacy and retention terms of the user's Codex account and configured model provider.

Canvas Prompt records whether the task accepted or completed that turn. Deleting the local round later removes the local archive only; it cannot retract content that was already submitted to a Codex task or remove it from that task's history.

## Public examples

Never commit real recordings, transcripts, screenshots, whiteboards, project-local `.canvas-prompt/` folders, or exported task bindings. Public examples must be synthetic or explicitly consented and de-identified.
