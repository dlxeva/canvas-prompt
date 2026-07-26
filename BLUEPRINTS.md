# Future blueprints

## Human-confirmed board proposal

This is a retained future capability, not part of the current MVP flow.

1. A person explicitly asks AI to propose a text structure.
2. AI returns a constrained `canvas-prompt-board` proposal (at most six editable cards).
3. The person reviews it and explicitly chooses whether to place it on the whiteboard.
4. Only then does the client call `placeBoardProposal`.

The current MVP does none of these things. It reads an exported human whiteboard process and returns a tentative, correctable understanding. The human remains the person who advances the board.

## In-canvas AI conversation

The previous right-side AI conversation panel is retained as a future interface option, not part of the current MVP.

It may return when a dedicated in-canvas conversation has a distinct job from the main Codex conversation: for example, reviewing a selected round, presenting a tentative process interpretation, or collecting a correction that belongs to that round. Until then, the whiteboard MVP has one visible surface: the human's canvas. Exported rounds are handed to the main Codex conversation rather than creating a second chat lane.
