# Privacy and local data

[简体中文](./PRIVACY.zh-CN.md) · English

Canvas Prompt is designed around one device-local active board. Ending a round compiles and saves its context locally; a compatible host can then read the latest immutable round through the local MCP reader when the user explicitly asks it to continue. This does not by itself place a message into a visible chat or make the host reply.

## What a round stores

When a round is exported, Canvas Prompt writes local data under:

```text
~/.canvas-prompt/board/
```

Depending on the session, this can include:

- the Prompt Package JSON and raw lifecycle trace. Large traces and Packages
  are stored as bounded local segments and reassembled locally;
- a PNG snapshot and selected state frames;
- the original audio recording;
- Process IR and Compact Package artifacts;
- round metadata, local artifact paths, and a host handoff receipt when the host supports one;
- the originating project path when one exists, as provenance rather than a routing key.

The in-app archive can inspect and permanently delete a local round. A deleted round cannot be restored from Canvas Prompt.

## Microphone and transcription

Canvas Prompt requests microphone access when any round starts. If permission is denied or the microphone is unavailable, canvas events continue to be recorded without audio.

Canvas Prompt's managed runtime sends completed audio windows to a local transcription service on `127.0.0.1`. Its exact port is selected by the launcher and exposed in the runtime identity; it is not fixed at `8080`. Canvas Prompt does not operate a transcription cloud service. If local ASR is not ready, the user can explicitly start a visual-only round; any saved recording is marked as lacking timestamped transcript evidence.

Raw recordings, replay segments, and inline image bytes are local archive
artifacts. They are excluded from the normal model-facing Package response;
the host reads compact structured context and can request an archived artifact
only when its integration explicitly supports that action.

If you configure a remote or third-party ASR backend, that provider's privacy, retention, and regional processing terms apply. Do not record other people or confidential material without the necessary permission.

## Host reading and handoff

For Codex Desktop, the supported path is to enter the explicit continuation command in the task that should use the board. Canvas Prompt's local MCP reader then reads the latest completed immutable round from the single-board archive. It does not claim automatic visible-chat injection, delivery to a particular task, or an automatic reply.

If a host records a handoff receipt, deleting the local round later removes the local archive only; it cannot retract content that the user or host has already shared with a model provider or remove it from that provider's history.

## Public examples

Never commit real recordings, transcripts, screenshots, whiteboards, `.canvas-prompt/` archives, or exported task bindings. Public examples must be synthetic or explicitly consented and de-identified.
