#!/usr/bin/env bash
set -euo pipefail

# A reproducible “new user space” smoke test for release candidates. It keeps
# the host's Node/Python binaries, but isolates every Canvas Prompt file that
# could otherwise make a first-run test pass accidentally: source copy,
# project, HOME, managed runtime, model cache, services, and ports.
#
# It deliberately does not claim to test a different macOS version, CPU
# architecture, Codex Marketplace installation, or a host application's MCP
# reload behavior. Those require a second physical/VM environment.

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_ROOT="$(mktemp -d /tmp/canvas-prompt-clean-room.XXXXXX)"
SANDBOX_HOME="$SANDBOX_ROOT/home"
SANDBOX_REPO="$SANDBOX_ROOT/repo"
SANDBOX_PROJECT="$SANDBOX_ROOT/project"
ASR_PORT="${CANVAS_PROMPT_CLEAN_ROOM_ASR_PORT:-18081}"
CANVAS_PORT="${CANVAS_PROMPT_CLEAN_ROOM_CANVAS_PORT:-43321}"
TRASH_ROOT="${HOME}/.Trash"
SERVICE_LABEL=""
ASR_PID=""
ASR_TIMEOUT_SECONDS="${CANVAS_PROMPT_CLEAN_ROOM_ASR_TIMEOUT_SECONDS:-900}"

cleanup() {
  local code="$?"
  if [[ -n "$SERVICE_LABEL" ]] && command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
  fi
  if [[ -n "$ASR_PID" ]] && kill -0 "$ASR_PID" 2>/dev/null; then
    kill "$ASR_PID" 2>/dev/null || true
  fi
  if [[ -d "$SANDBOX_ROOT" ]]; then
    mkdir -p "$TRASH_ROOT"
    mv "$SANDBOX_ROOT" "$TRASH_ROOT/$(basename "$SANDBOX_ROOT")" || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

mkdir -p "$SANDBOX_HOME" "$SANDBOX_PROJECT"
rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'app/node_modules/' \
  --exclude 'app/dist/' \
  --exclude '.canvas-prompt/' \
  --exclude '.DS_Store' \
  "$SOURCE_ROOT/" "$SANDBOX_REPO/"

export HOME="$SANDBOX_HOME"
export CANVAS_PROMPT_RUNTIME_DIR="$SANDBOX_HOME/.canvas-prompt/runtime"
export HF_HOME="$SANDBOX_HOME/.cache/huggingface"
export CANVAS_PROMPT_ASR_PORT="$ASR_PORT"
export CANVAS_PROMPT_PORT="$CANVAS_PORT"

echo "[clean-room] isolated root: $SANDBOX_ROOT"
echo "[clean-room] installing fresh Canvas Prompt app and ASR runtime"
(
  cd "$SANDBOX_REPO"
  node bin/canvas-prompt.mjs setup --project "$SANDBOX_PROJECT"
)

echo "[clean-room] starting managed ASR and canvas"
OPEN_OUTPUT="$(
  cd "$SANDBOX_REPO"
  node bin/canvas-prompt.mjs open --host local --project "$SANDBOX_PROJECT" 2>&1
)"
printf '%s\n' "$OPEN_OUTPUT"
SERVICE_LABEL="$(printf '%s\n' "$OPEN_OUTPUT" | sed -n 's/^Service: //p' | tail -n 1)"
ASR_PID="$(cat "$CANVAS_PROMPT_RUNTIME_DIR/asr.pid" 2>/dev/null || true)"

echo "[clean-room] waiting up to ${ASR_TIMEOUT_SECONDS}s for first model download and ASR readiness"
for ((attempt = 0; attempt < ASR_TIMEOUT_SECONDS * 2; attempt++)); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:${ASR_PORT}/health" 2>/dev/null \
    | python3 -c 'import json, sys; value=json.load(sys.stdin); assert value["status"] == "ok" and value["canvas_prompt_asr"] is True' 2>/dev/null; then
    echo "[clean-room] ASR health: OK"
    break
  fi
  sleep 0.5
  if [[ "$attempt" -eq $((ASR_TIMEOUT_SECONDS * 2 - 1)) ]]; then
    echo "[clean-room] ASR did not become ready within ${ASR_TIMEOUT_SECONDS}s." >&2
    exit 1
  fi
done
curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${CANVAS_PORT}/api/runtime-identity" \
  | python3 -c "import json, sys; value=json.load(sys.stdin); assert value['project_dir'] == '$SANDBOX_PROJECT'; assert value['asr_url'] == 'http://127.0.0.1:$ASR_PORT'; print('[clean-room] canvas identity: OK')"

echo "[clean-room] PASS — fresh user-space install, ASR model bootstrap, and project-bound canvas startup succeeded."
echo "[clean-room] temporary sandbox will now move to Trash."
