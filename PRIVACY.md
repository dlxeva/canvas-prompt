# Privacy and local data

[简体中文](./PRIVACY.zh-CN.md) · English

Canvas Prompt is designed around project-local storage. Ending a round compiles and saves its context locally; a compatible host can then read that immutable round through the local MCP reader. This does not by itself place a message into a visible chat or make the host reply.

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
- round metadata, local artifact paths, and a host handoff receipt when the host supports one;
- an explicit host conversation identifier only when the host provides one for scoped reading.

The in-app archive can inspect and permanently delete a local round. A deleted round cannot be restored from Canvas Prompt.

## Microphone and transcription

Canvas Prompt requests microphone access when any round starts. If permission is denied or the microphone is unavailable, canvas events continue to be recorded without audio.

Canvas Prompt's managed runtime sends completed audio windows to a local transcription service on `127.0.0.1`. Its exact port is selected by the launcher and exposed in the runtime identity; it is not fixed at `8080`. Canvas Prompt does not operate a transcription cloud service. If local ASR is not ready, the user can explicitly start a visual-only round; any saved recording is marked as lacking timestamped transcript evidence.

If you configure a remote or third-party ASR backend, that provider's privacy, retention, and regional processing terms apply. Do not record other people or confidential material without the necessary permission.

## Host reading and handoff

For Codex Desktop, the supported path is to let the current task read the immutable project-local round through Canvas Prompt's local MCP reader. A host that explicitly provides a conversation ID can use it to scope that read. Without such an ID, Canvas Prompt provides only explicit project-local reading; it does not claim automatic visible-chat injection, delivery to a particular task, or an automatic reply.

If a host records a handoff receipt, deleting the local round later removes the local archive only; it cannot retract content that the user or host has already shared with a model provider or remove it from that provider's history.

## Public examples

Never commit real recordings, transcripts, screenshots, whiteboards, project-local `.canvas-prompt/` folders, or exported task bindings. Public examples must be synthetic or explicitly consented and de-identified.
