#!/usr/bin/env bash
set -euo pipefail

# Install only Canvas Prompt-owned runtime pieces. Existing healthy app
# dependencies and the managed ASR venv are reused; nothing is installed into
# a user's global Node or Python environment.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---with-asr}"
RUNTIME_DIR="${CANVAS_PROMPT_RUNTIME_DIR:-$ROOT_DIR/.canvas-prompt-runtime}"
PYTHON_BIN="${CANVAS_PROMPT_PYTHON:-python3}"

if [[ "$MODE" != "--core-only" && "$MODE" != "--with-asr" ]]; then
  echo "Usage: $0 [--core-only|--with-asr]" >&2
  exit 2
fi

require_version() {
  local actual="$1" required="$2" label="$3"
  if [[ "$(printf '%s\n%s\n' "$required" "$actual" | sort -V | head -n1)" != "$required" ]]; then
    echo "Canvas Prompt requires ${label} ${required} or newer; found ${actual}." >&2
    exit 1
  fi
}

NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
[[ -n "$NODE_VERSION" ]] || { echo "Canvas Prompt requires Node.js 22.12 or newer." >&2; exit 1; }
require_version "$NODE_VERSION" "22.12.0" "Node.js"

PYTHON_VERSION="$($PYTHON_BIN -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null || true)"
[[ -n "$PYTHON_VERSION" ]] || { echo "Canvas Prompt requires Python 3.11 or newer for its compiler." >&2; exit 1; }
require_version "$PYTHON_VERSION" "3.11.0" "Python"

if [[ ! -x "$ROOT_DIR/app/node_modules/.bin/vite" ]]; then
  echo "Installing Canvas Prompt app dependencies…" >&2
  npm --prefix "$ROOT_DIR/app" ci
else
  echo "Reusing Canvas Prompt app dependencies." >&2
fi

if [[ "$MODE" == "--core-only" ]]; then
  exit 0
fi

VENV_DIR="$RUNTIME_DIR/asr-venv"
ASR_PYTHON="$VENV_DIR/bin/python"
if [[ -x "$ASR_PYTHON" ]] && "$ASR_PYTHON" -c 'import fastapi, uvicorn, faster_whisper' >/dev/null 2>&1; then
  echo "Reusing Canvas Prompt local ASR runtime: $VENV_DIR" >&2
else
  echo "Canvas Prompt local ASR will use a private runtime at $VENV_DIR (about 235 MB in the current macOS arm64 check; exact size varies by platform)." >&2
  echo "The speech model is downloaded separately on its first launch (base model: about 148 MB) and stays in the local model cache." >&2
  echo "Installing Canvas Prompt local ASR runtime…" >&2
  mkdir -p "$RUNTIME_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
  # Do not upgrade pip here. A surprise upgrade adds another network request
  # and changes the first-run dependency graph before we even install Canvas
  # Prompt. The venv's bundled pip is enough for the pinned direct runtime
  # requirements below.
  "$ASR_PYTHON" -m pip install --disable-pip-version-check -r "$ROOT_DIR/runtime/requirements-asr.txt"
  "$ASR_PYTHON" -m pip check
fi
printf '%s\n' "$ASR_PYTHON"
