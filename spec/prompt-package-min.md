# Prompt Package (Minimal Draft)

## What It Is

Prompt Package is the minimal portable artifact produced from a thinking session.

It is designed to preserve enough structure for an AI system to reconstruct:

- what appeared on the canvas
- in what order it appeared
- what was emphasized or revised
- what the human was trying to express

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
- emphasis / revision signals

### 3. Optional voice

Voice is an intent-enhancement layer.

It should be attached when available, but it is not the only source of meaning.

## Minimal JSON Shape

```json
{
  "sessionId": "session-...",
  "startTime": 0,
  "endTime": 0,
  "duration": 0,
  "events": [],
  "canvasSnapshot": "",
  "audioFileName": "audio-....webm"
}
```

## Current Principle

The final canvas should be treated as a primary semantic input.

The event timeline should enhance it.

Voice should further disambiguate intent.
