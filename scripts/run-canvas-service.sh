#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$1"
WORKING_DIR="$2"
PROJECT_DIR="$3"
PORT="$4"
NODE_BIN="$5"
ASR_URL="$6"
ASR_ENABLED="$7"
DELIVERY_MODE="$8"
THREAD_ID="${9:-}"
SESSION_ID="${10:-}"
SOFFICE_BIN="${11:-}"

if [[ -n "$PROJECT_DIR" ]]; then export CANVAS_PROMPT_PROJECT_DIR="$PROJECT_DIR"; else unset CANVAS_PROMPT_PROJECT_DIR; fi
if [[ -n "$THREAD_ID" ]]; then export CANVAS_PROMPT_THREAD_ID="$THREAD_ID"; else unset CANVAS_PROMPT_THREAD_ID; fi
if [[ -n "$SESSION_ID" ]]; then export CANVAS_PROMPT_SESSION_ID="$SESSION_ID"; else unset CANVAS_PROMPT_SESSION_ID; fi
export CANVAS_PROMPT_ASR_URL="$ASR_URL"
export CANVAS_PROMPT_ASR="$ASR_ENABLED"
export CANVAS_PROMPT_DELIVERY_MODE="$DELIVERY_MODE"
if [[ -n "$SOFFICE_BIN" ]]; then export CANVAS_PROMPT_SOFFICE_BIN="$SOFFICE_BIN"; else unset CANVAS_PROMPT_SOFFICE_BIN; fi
cd "$WORKING_DIR"
cd "$APP_DIR"
exec "$NODE_BIN" "$APP_DIR/node_modules/vite/bin/vite.js" --host 127.0.0.1 --port "$PORT"
