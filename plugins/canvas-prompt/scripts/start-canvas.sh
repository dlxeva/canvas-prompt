#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CALLER_DIR="$PWD"
PROJECT_DIR="${CANVAS_PROMPT_PROJECT_DIR:-${1:-$CALLER_DIR}}"
PORT="${CANVAS_PROMPT_PORT:-43223}"
CORE_APP_DIR="$ROOT_DIR/app"
export CANVAS_PROMPT_PROJECT_DIR="$PROJECT_DIR"

if [ ! -f "$CORE_APP_DIR/package.json" ]; then
  echo "Canvas Prompt core app was not found: $CORE_APP_DIR/package.json" >&2
  exit 1
fi

cd "$CORE_APP_DIR"
if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vite ]; then npm install; fi
echo "Starting Canvas Prompt on http://127.0.0.1:${PORT}"
echo "Canvas core: ${CORE_APP_DIR}"
echo "Prompt Package: ${PROJECT_DIR}/.canvas-prompt/latest-prompt-package.json"
exec npm run dev -- --host 127.0.0.1 --port "$PORT"
