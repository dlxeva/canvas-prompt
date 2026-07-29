#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CALLER_DIR="$PWD"
PROJECT_MODE="${CANVAS_PROMPT_PROJECT_MODE:-project}"
THREAD_ID="${CANVAS_PROMPT_THREAD_ID:-${CANVAS_PROMPT_CODEX_THREAD_ID:-}}"
SESSION_ID="${CANVAS_PROMPT_SESSION_ID:-}"
PROJECT_DIR=""
WORKING_DIR="${1:-$CALLER_DIR}"
if [[ "$PROJECT_MODE" == "project" ]]; then
  PROJECT_DIR="${CANVAS_PROMPT_PROJECT_DIR:-$WORKING_DIR}"
elif [[ "$PROJECT_MODE" == "conversation" ]]; then
  [[ -n "$THREAD_ID" ]] || { echo "Canvas Prompt conversation storage requires an explicit thread ID." >&2; exit 1; }
else
  echo "Unknown Canvas Prompt project mode: $PROJECT_MODE" >&2
  exit 1
fi
PORT="${CANVAS_PROMPT_PORT:-43223}"
ASR_URL="${CANVAS_PROMPT_ASR_URL:-http://127.0.0.1:${CANVAS_PROMPT_ASR_PORT:-8080}}"
ASR_ENABLED="${CANVAS_PROMPT_ASR:-enabled}"
DELIVERY_MODE="${CANVAS_PROMPT_DELIVERY_MODE:-local}"
CORE_APP_DIR="$ROOT_DIR/app"
RUNNER="$ROOT_DIR/scripts/run-canvas-service.sh"
WORKING_DIR="$(cd "$WORKING_DIR" && pwd -P)"
if [[ -n "$PROJECT_DIR" ]]; then
  PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd -P)"
  export CANVAS_PROMPT_PROJECT_DIR="$PROJECT_DIR"
else
  unset CANVAS_PROMPT_PROJECT_DIR
fi
if [[ -n "$THREAD_ID" ]]; then export CANVAS_PROMPT_THREAD_ID="$THREAD_ID"; fi
if [[ -n "$SESSION_ID" ]]; then export CANVAS_PROMPT_SESSION_ID="$SESSION_ID"; fi
THREAD_SCOPE_KEY=""
SCOPE_DIRECTORY="threads"
SCOPE_ID="$THREAD_ID"
if [[ -z "$SCOPE_ID" ]]; then
  SCOPE_ID="$SESSION_ID"
  SCOPE_DIRECTORY="sessions"
fi
if [[ -n "$SCOPE_ID" ]]; then
  [[ "$SCOPE_ID" =~ ^[A-Za-z0-9_-]{8,200}$ ]] || { echo "Canvas Prompt received an invalid conversation session." >&2; exit 1; }
  THREAD_SCOPE_KEY="$(printf '%s' "$SCOPE_ID" | shasum -a 256 | cut -c1-24)"
fi
if [[ "${CANVAS_PROMPT_SINGLE_BOARD:-1}" == "1" ]]; then
  PROMPT_PACKAGE_PATH="${HOME}/.canvas-prompt/board/latest-prompt-package.json"
elif [[ -n "$PROJECT_DIR" && -n "$THREAD_SCOPE_KEY" ]]; then
  PROMPT_PACKAGE_PATH="${PROJECT_DIR}/.canvas-prompt/${SCOPE_DIRECTORY}/${THREAD_SCOPE_KEY}/latest-prompt-package.json"
elif [[ -n "$PROJECT_DIR" ]]; then
  PROMPT_PACKAGE_PATH="${PROJECT_DIR}/.canvas-prompt/latest-prompt-package.json"
else
  PROMPT_PACKAGE_PATH="${HOME}/.canvas-prompt/conversations/${THREAD_SCOPE_KEY}/latest-prompt-package.json"
fi

port_pids() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

runtime_identity() {
  local candidate="$1" identity
  identity="$(curl --silent --show-error --max-time 1 "http://127.0.0.1:${candidate}/api/runtime-identity" 2>/dev/null || true)"
  [ -n "$identity" ] || return 1
  printf '%s' "$identity"
}

runtime_delivery_mode() {
  local candidate="$1" identity
  identity="$(runtime_identity "$candidate")" || return 1
  printf '%s' "$identity" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("delivery_mode") or "local")' 2>/dev/null
}

is_healthy_canvas() {
  local candidate="$1"
  local pid command page

  pid="$(port_pids "$candidate" | head -n 1)"
  [ -n "$pid" ] || return 1

  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  # When ps succeeds but the command is NOT a Canvas Prompt vite process,
  # reject immediately — something else is on this port.
  # When ps is unavailable (sandbox, restricted environment), command is
  # empty; fall through to runtime-identity verification which is sufficient
  # to confirm a genuine Canvas Prompt instance responding on this port.
  if [[ -n "$command" ]]; then
    [[ "$command" == *"canvas-prompt"* && "$command" == *"vite"* ]] || return 1
  fi

  page="$(curl --silent --show-error --max-time 1 "http://127.0.0.1:${candidate}/" 2>/dev/null || true)"
  [[ "$page" == *"<title>Canvas Prompt</title>"* ]] || return 1
  runtime_identity "$candidate" >/dev/null
}

is_healthy_current_canvas() {
  local candidate="$1" identity running_project running_scope running_storage_kind running_delivery_mode
  is_healthy_canvas "$candidate" || return 1
  identity="$(runtime_identity "$candidate")"
  running_storage_kind="$(printf '%s' "$identity" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("storage_kind") or "")' 2>/dev/null)"
  if [[ "$running_storage_kind" == "single_board" ]]; then
    running_delivery_mode="$(printf '%s' "$identity" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("delivery_mode") or "local")' 2>/dev/null)"
    [[ "$running_delivery_mode" == "$DELIVERY_MODE" ]]
    return $?
  fi
  running_project="$(printf '%s' "$identity" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("project_dir") or "")' 2>/dev/null)"
  running_scope="$(printf '%s' "$identity" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("thread_scope_key") or "")' 2>/dev/null)"
  [[ "$running_project" == "$PROJECT_DIR" && "$running_scope" == "$THREAD_SCOPE_KEY" ]]
}

is_reconfigurable_canvas() {
  local candidate="$1" identity running_storage_kind running_delivery_mode
  is_healthy_canvas "$candidate" || return 1
  identity="$(runtime_identity "$candidate")"
  running_storage_kind="$(printf '%s' "$identity" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("storage_kind") or "")' 2>/dev/null)"
  [[ "$running_storage_kind" == "single_board" ]] || return 1
  running_delivery_mode="$(printf '%s' "$identity" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("delivery_mode") or "local")' 2>/dev/null)"
  [[ "$running_delivery_mode" != "$DELIVERY_MODE" ]]
}

stop_canvas_on_port() {
  local candidate="$1"
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
  done < <(port_pids "$candidate")
}

stop_stale_canvas() {
  local candidate="$1"
  local pid command
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    # When ps is unavailable, skip the command-line guard and rely on
    # runtime-identity alone. If runtime_identity also fails, the process
    # on this port is stale (not a healthy Canvas) and may be stopped.
    local ps_confirmed=false
    if [[ -n "$command" ]]; then
      [[ "$command" == *"/canvas-prompt/"* && "$command" == *"vite"* ]] || continue
      ps_confirmed=true
    fi
    if ! is_healthy_canvas "$candidate"; then
      echo "Stopping stale Canvas Prompt server (PID ${pid}) on port ${candidate}." >&2
      kill "$pid" 2>/dev/null || true
    fi
  done < <(port_pids "$candidate")
}

select_port() {
  local candidate="$PORT"
  local attempts=0
  while [ "$attempts" -lt 20 ]; do
    if [ -z "$(port_pids "$candidate")" ]; then
      printf '%s' "$candidate"
      return 0
    fi
    if is_healthy_current_canvas "$candidate"; then
      echo "Canvas Prompt is already running at http://127.0.0.1:${candidate}/" >&2
      printf 'reuse:%s' "$candidate"
      return 0
    fi
    if is_reconfigurable_canvas "$candidate"; then
      echo "Restarting Canvas Prompt with delivery mode '${DELIVERY_MODE}' (running service has '$(runtime_delivery_mode "$candidate")') on port ${candidate}." >&2
      stop_canvas_on_port "$candidate"
      for _ in {1..20}; do
        if [ -z "$(port_pids "$candidate")" ]; then
          printf '%s' "$candidate"
          return 0
        fi
        sleep 0.25
      done
      candidate=$((candidate + 1))
      attempts=$((attempts + 1))
      continue
    fi
    if is_healthy_canvas "$candidate"; then
      echo "Canvas Prompt on port ${candidate} belongs to another project; selecting another port." >&2
      candidate=$((candidate + 1))
      attempts=$((attempts + 1))
      continue
    fi
    stop_stale_canvas "$candidate"
    if [ -z "$(port_pids "$candidate")" ]; then
      printf '%s' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
    attempts=$((attempts + 1))
  done
  echo "Could not find a free Canvas Prompt port between ${PORT} and $((PORT + 19))." >&2
  exit 1
}

# The integration test sources the port-selection functions with mocked
# process/network commands. It must not install dependencies or start Vite.
if [[ "${CANVAS_PROMPT_TEST_ONLY:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

if [ ! -f "$CORE_APP_DIR/package.json" ]; then
  echo "Canvas Prompt core app was not found: $CORE_APP_DIR/package.json" >&2
  exit 1
fi

"$ROOT_DIR/scripts/bootstrap-runtime.sh" --core-only
cd "$CORE_APP_DIR"
PORT_SELECTION="$(select_port)"
if [[ "$PORT_SELECTION" == reuse:* ]]; then exit 0; fi
PORT="$PORT_SELECTION"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Starting Canvas Prompt on http://127.0.0.1:${PORT}"
  echo "Canvas core: ${CORE_APP_DIR}"
  echo "Prompt Package: ${PROMPT_PACKAGE_PATH}"
  exec npm run dev -- --host 127.0.0.1 --port "$PORT"
fi

NODE_BIN="$(command -v node)"
SERVICE_ID="$(printf '%s' "${ROOT_DIR}:${PROJECT_DIR}:${THREAD_SCOPE_KEY}:${PORT}" | shasum -a 256 | cut -c1-12)"
SERVICE_LABEL="com.canvas-prompt.${SERVICE_ID}"
SERVICE_LOG="${TMPDIR:-/tmp}/${SERVICE_LABEL}.log"

# A prior crashed job can survive without a listener. Remove it before submit.
launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
LAUNCHCTL_OK=false
if launchctl submit -l "$SERVICE_LABEL" -o "$SERVICE_LOG" -e "$SERVICE_LOG" -- \
  "$RUNNER" "$CORE_APP_DIR" "$WORKING_DIR" "$PROJECT_DIR" "$PORT" "$NODE_BIN" "$ASR_URL" "$ASR_ENABLED" "$DELIVERY_MODE" "$THREAD_ID" "$SESSION_ID" 2>/dev/null; then
  LAUNCHCTL_OK=true
fi

if [[ "$LAUNCHCTL_OK" == "false" ]]; then
  # launchctl submit is unavailable (e.g. sandboxed environments like WorkBuddy).
  # Start the Vite service directly in the background. A double-fork ensures
  # the daemon survives the launcher's exit — the intermediate child exits
  # immediately, orphaning the grandchild which is reparented to launchd.
  # The readiness polling below confirms the server is up before the script
  # exits.
  ( "$RUNNER" "$CORE_APP_DIR" "$WORKING_DIR" "$PROJECT_DIR" "$PORT" "$NODE_BIN" "$ASR_URL" "$ASR_ENABLED" "$DELIVERY_MODE" "$THREAD_ID" "$SESSION_ID" >"$SERVICE_LOG" 2>&1 & )
fi

for _ in {1..20}; do
  if curl --silent --show-error --max-time 1 "http://127.0.0.1:${PORT}/" 2>/dev/null | grep -q '<title>Canvas Prompt</title>'; then
    echo "Canvas Prompt is running at http://127.0.0.1:${PORT}/"
    echo "Canvas core: ${CORE_APP_DIR}"
    echo "Prompt Package: ${PROMPT_PACKAGE_PATH}"
    echo "Service: ${SERVICE_LABEL}"
    exit 0
  fi
  sleep 0.25
done

echo "Canvas Prompt did not become ready. Log: ${SERVICE_LOG}" >&2
exit 1
