#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$1"
PROJECT_DIR="$2"
PORT="$3"
NODE_BIN="$4"
ASR_URL="$5"
ASR_ENABLED="$6"
DELIVERY_MODE="$7"

export CANVAS_PROMPT_PROJECT_DIR="$PROJECT_DIR"
export CANVAS_PROMPT_ASR_URL="$ASR_URL"
export CANVAS_PROMPT_ASR="$ASR_ENABLED"
export CANVAS_PROMPT_DELIVERY_MODE="$DELIVERY_MODE"
cd "$APP_DIR"
exec "$NODE_BIN" "$APP_DIR/node_modules/vite/bin/vite.js" --host 127.0.0.1 --port "$PORT"
