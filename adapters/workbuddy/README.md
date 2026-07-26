# WorkBuddy adapter

WorkBuddy needs both the project-bound `canvas_prompt` MCP server and this Skill. The MCP server makes the context readable; the Skill tells WorkBuddy when to read it and how to preserve evidence boundaries.

After the connector is trusted, install or register `SKILL.md` using WorkBuddy's connector-skill mechanism, then open a new WorkBuddy task. On the user's next natural follow-up after saving a canvas round, WorkBuddy should read the latest package before replying.

This adapter cannot make a browser save create a new WorkBuddy message by itself. That needs a future WorkBuddy conversation-event API.
