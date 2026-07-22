# Canvas Prompt

Canvas Prompt is an open, high-bandwidth input protocol for thinking with AI before goals are fully formed.

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

**the evidence produced while you think should be available as part of the input.**

Instead of forcing early-stage thinking into a linear chat box, we treat:

- canvas state
- drawing order
- grouping
- spatial hierarchy
- voice
- revision history

as a richer, auditable input layer for AI collaboration.

## Current Direction

This project is exploring three layers:

1. `Final canvas understanding`
   AI reads the final whiteboard as a structured thinking artifact.

2. `Event timeline as evidence`
   The protocol preserves what changed and when. It does not by itself prove the identity or meaning of an anonymous stroke.

3. `Voice + timeline + canvas alignment`
   Spoken explanations and canvas changes can support traceable, text-level process conclusions such as revision, convergence, or a stated next step.

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
- whether process evidence improves understanding on held-out, human-gold-labelled examples
- reliable named-object association before making object-level state claims

## Evidence Boundary

Canvas Prompt distinguishes three kinds of output:

1. **Raw evidence** — canvas snapshots, event records, and optional voice references.
2. **Text-level process evidence** — a stated revision, convergence, or next step, linked back to source evidence.
3. **Object-level claims** — for example, that a specific object was promoted, rejected, or superseded. These require a named object or another auditable association; time proximity alone is not enough.

This repository publishes the protocol and examples, not a claim that every drawing action can reveal a person's intent.

## Privacy and Examples

Public examples must be synthetic or explicitly consented and de-identified. Do not publish raw recordings, transcripts, screenshots, or whiteboards from real sessions without clear permission.

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

This repository is licensed under **GNU AGPL-3.0-or-later**. It is intended to keep public modifications to the protocol implementation and any network-deployed derivative available to the community under the same license.

The license applies to the contents of this repository; it does not publish private recordings, evaluation data, or other materials that are not included here.
