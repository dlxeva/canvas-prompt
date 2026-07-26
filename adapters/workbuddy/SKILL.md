---
name: canvas-prompt-workbuddy
description: "Use Canvas Prompt context when the user returns from a saved canvas round, mentions a board, sketch, circle, arrow, or asks to continue from visual thinking."
version: "0.1.0"
---

# Canvas Prompt for WorkBuddy

When the user refers to a just-finished canvas, board, sketch, visual review, circle, arrow, or says “continue”, call `canvas_prompt.get_latest_prompt_package` before answering.

## Project and privacy boundary

- Read only through the `canvas_prompt` MCP tools bound to this WorkBuddy workspace.
- If no package exists, say this workspace has no exported Canvas Prompt round. Do not search other project directories or read raw files as a fallback.
- To change projects, the user must explicitly reconfigure the MCP project binding.

## Response contract

After a package is available, respond in this order:

1. **Visible receipt**: first say that the current conversation has read the Canvas Prompt round, including its Package ID and whether a final snapshot exists. Do not claim a screenshot attachment was inserted unless WorkBuddy's adapter actually confirmed it.
2. **Understanding**: summarize direct observations and explicitly stated speech.
3. **Candidates**: label spatial associations from circles, arrows, pointer actions, or pronouns as candidates unless the package marks them confirmed.
4. **Open questions**: ask the shortest question needed for unresolved intent.
5. **Continue**: engage with the user's actual decision, rather than dumping package metadata.

Never turn a visual candidate into a confirmed business fact. For example, a percentage positioned near a layer is not a confirmed assignment unless the user explicitly states that assignment.
