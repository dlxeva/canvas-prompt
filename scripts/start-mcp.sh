#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# The MCP server intentionally uses only Node's standard library. Do not run
# npm install here: MCP may be loaded before a canvas session, and a silent
# dependency mutation at that point makes host startup slow and opaque.
exec node ./mcp/server.mjs
