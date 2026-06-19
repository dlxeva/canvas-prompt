# Canvas Prompt

Canvas Prompt is a high-bandwidth input protocol for thinking with AI before goals are fully formed.

## The Problem

Most AI interfaces assume you already know what you want.

They work well once a task can be written as:

- a prompt
- a PRD
- an issue
- a structured request

But many important tasks start earlier than that.

Before the goal is fully formed, people think in fragments:

- sketches
- arrows
- spatial grouping
- revisions
- spoken clarifications
- partial structures

That stage is still poorly supported by today's AI interfaces.

## The Claim

Canvas Prompt is based on a simple claim:

**the way you think should itself become part of the input.**

Instead of forcing early-stage thinking into a linear chat box, we treat:

- canvas state
- drawing order
- grouping
- spatial hierarchy
- voice
- revision history

as a richer input layer for AI collaboration.

## Current Direction

This project is exploring three layers:

1. `Final canvas understanding`
   AI reads the final whiteboard as a structured thinking artifact.

2. `Event timeline understanding`
   AI reconstructs what was drawn first, what was revised later, and how the structure evolved.

3. `Voice + timeline + canvas alignment`
   AI combines spoken explanation with the evolving whiteboard state to infer intent more reliably.

## Current Status

This is an active research and prototype project.

What already exists:

- a web MVP
- Prompt Package export
- whiteboard event capture
- final canvas snapshot export
- voice capture diagnostics
- early multimodal interpretation experiments

What is still being validated:

- robust speech-to-text quality
- stable multimodal alignment
- benchmark examples with human gold labels

## Why This Matters

If this works, AI no longer waits only for finished prompts.

It can collaborate earlier, while ideas are still forming.

That opens a path toward:

- better strategic thinking support
- better creative collaboration
- better knowledge externalization
- higher-bandwidth human-AI co-thinking

## Scope

Canvas Prompt is **not** trying to replace all chat interfaces.

It is designed for cases where:

- the thinking is complex
- the structure matters
- the process matters
- linear text is too lossy

## Early Keywords

- high-bandwidth AI input
- pre-goal collaboration
- Prompt Package
- nonlinear input protocol
- cognitive event stream
- whiteboard-native AI collaboration

## License

Apache-2.0
