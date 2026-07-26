#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$1"
PROJECT_DIR="$2"
PORT="$3"
NODE_BIN="$4"

export CANVAS_PROMPT_PROJECT_DIR="$PROJECT_DIR"
cd "$APP_DIR"
exec "$NODE_BIN" "$APP_DIR/node_modules/vite/bin/vite.js" --host 127.0.0.1 --port "$PORT"
