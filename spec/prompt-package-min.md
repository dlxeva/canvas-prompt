# Prompt Package (Minimal Draft)

**Status:** Draft v0.1. This document defines a portable evidence container, not a guarantee of intent reconstruction.

## What It Is

Prompt Package is the minimal portable artifact produced from a thinking session.

It is designed to preserve enough structure for an AI system or reviewer to inspect:

- what appeared on the canvas
- in what order it appeared
- what source evidence supports a stated revision or decision
- what remains unknown

## Minimal Layers

### 1. Final canvas

The final canvas is the highest-density semantic layer.

It should include:

- a final canvas image or render
- a structural snapshot of visible objects

### 2. Event timeline

The event timeline records how the canvas evolved.

It should include:

- creation order
- updates
- grouping actions
- source events that may support emphasis or revision

### 3. Optional voice

Voice is an optional explanation layer.

It should be attached or referenced when available, but it is not the only source of meaning. Transcript-derived conclusions should retain a source reference.

## Evidence Levels

Consumers should preserve the distinction between evidence and interpretation:

| Level | May say | Minimum requirement |
|---|---|---|
| Raw | An event or artifact exists | Original event, snapshot, or voice reference |
| Text process | The speaker revised, converged, or named a next step | Linked transcript/timeline evidence |
| Object state | A particular object was promoted, rejected, or superseded | Named object or another auditable object-to-evidence association |

An anonymous draw stroke must not receive an object-level state solely because it is near a phrase, a pause, or a visual marker.

## Minimal JSON Shape

```json
{
  "schemaVersion": "0.1-draft",
  "sessionId": "session-...",
  "startTime": 0,
  "endTime": 0,
  "duration": 0,
  "events": [],
  "canvasSnapshot": "",
  "voiceReference": null,
  "evidence": [],
  "textProcessEvents": [],
  "objectStates": []
}
```

## Current Principle

The final canvas should be treated as a primary artifact.

The event timeline should provide traceability.

Voice can add explanation when it is available and appropriately consented.

Interpretation should be conservative: absent evidence is unknown, not a negative conclusion.
