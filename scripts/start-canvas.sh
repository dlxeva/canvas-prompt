#!/usr/bin/env bash
set -euo pipefail

# Python is already required by the local compiler. Avoid a separate Perl
# Digest::SHA/shasum dependency, which is absent on minimal Linux installs.
sha256_stdin() {
  python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
}

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
ASR_URL="${CANVAS_PROMPT_ASR_URL:-http://127.0.0.1:${CANVAS_PROMPT_ASR_PORT:-18080}}"
ASR_ENABLED="${CANVAS_PROMPT_ASR:-enabled}"
DELIVERY_MODE="${CANVAS_PROMPT_DELIVERY_MODE:-local}"
CANVAS_DATA_HOME="${CANVAS_PROMPT_DATA_HOME:-$HOME}"
CORE_APP_DIR="$ROOT_DIR/app"
RUNNER="$ROOT_DIR/scripts/run-canvas-service.sh"
LOCK_KEY="$(printf '%s:%s' "$ROOT_DIR" "$PORT" | sha256_stdin | cut -c1-16)"
LAUNCH_LOCK="${TMPDIR:-/tmp}/canvas-prompt-launch-${LOCK_KEY}.lock"
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
  THREAD_SCOPE_KEY="$(printf '%s' "$SCOPE_ID" | sha256_stdin | cut -c1-24)"
fi
if [[ "${CANVAS_PROMPT_SINGLE_BOARD:-1}" == "1" ]]; then
  PROMPT_PACKAGE_PATH="${CANVAS_DATA_HOME}/.canvas-prompt/board/latest-prompt-package.json"
elif [[ -n "$PROJECT_DIR" && -n "$THREAD_SCOPE_KEY" ]]; then
  PROMPT_PACKAGE_PATH="${PROJECT_DIR}/.canvas-prompt/${SCOPE_DIRECTORY}/${THREAD_SCOPE_KEY}/latest-prompt-package.json"
elif [[ -n "$PROJECT_DIR" ]]; then
  PROMPT_PACKAGE_PATH="${PROJECT_DIR}/.canvas-prompt/latest-prompt-package.json"
else
  PROMPT_PACKAGE_PATH="${CANVAS_DATA_HOME}/.canvas-prompt/conversations/${THREAD_SCOPE_KEY}/latest-prompt-package.json"
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

is_canvas_runtime_identity() {
  local identity="$1"
  printf '%s' "$identity" | python3 -c '
import json
import re
import sys

try:
    value = json.load(sys.stdin)
except (ValueError, TypeError):
    raise SystemExit(1)

if not isinstance(value, dict):
    raise SystemExit(1)

service_version = value.get("service_version")
if not isinstance(service_version, str) or not re.fullmatch(
    r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?",
    service_version,
):
    raise SystemExit(1)

if value.get("storage_kind") not in {"single_board", "project", "conversation"}:
    raise SystemExit(1)

delivery_mode = value.get("delivery_mode")
if delivery_mode not in {None, "", "codex", "workbuddy", "local"}:
    raise SystemExit(1)
' 2>/dev/null
}

is_compatible_single_board_identity() {
  local identity="$1"
  is_canvas_runtime_identity "$identity" || return 1
  printf '%s' "$identity" | python3 -c '
import hashlib
import json
import os
import sys

value = json.load(sys.stdin)
if value.get("storage_kind") != "single_board":
    raise SystemExit(1)
if not value["service_version"].startswith("0.1."):
    raise SystemExit(1)
expected_scope = hashlib.sha256(os.path.abspath(os.path.join(sys.argv[1], ".canvas-prompt", "board")).encode()).hexdigest()
actual_scope = value.get("storage_scope_key")
if actual_scope and actual_scope != expected_scope:
    raise SystemExit(1)
if sys.argv[2] and not actual_scope:
    raise SystemExit(1)

# A single-board service is not conversation-bound. Older compatible
# identities may omit these optional fields, but a populated scope would make
# cross-project or cross-host reuse unsafe.
if value.get("conversation_bound") not in {None, False}:
    raise SystemExit(1)
if value.get("thread_scope_key") not in {None, ""}:
    raise SystemExit(1)
if value.get("session_scope_key") not in {None, ""}:
    raise SystemExit(1)
' "$CANVAS_DATA_HOME" "${CANVAS_PROMPT_DATA_HOME:-}"
}

is_healthy_canvas() {
  local candidate="$1"
  local pid page identity

  pid="$(port_pids "$candidate" | head -n 1)"
  [ -n "$pid" ] || return 1

  page="$(curl --silent --show-error --max-time 1 "http://127.0.0.1:${candidate}/" 2>/dev/null || true)"
  [[ "$page" == *"<title>Canvas Prompt</title>"* ]] || return 1
  identity="$(runtime_identity "$candidate")" || return 1
  is_canvas_runtime_identity "$identity"
}

# The user has one private active board (single_board). Any healthy Canvas
# Prompt instance serving that board can be reused regardless of which host
# (Codex / WorkBuddy / local) started it. The delivery_mode field is retained
# as internal diagnostic information but is NOT a routing key or reuse gate.
is_reusable_canvas() {
  local candidate="$1" identity
  is_healthy_canvas "$candidate" || return 1
  identity="$(runtime_identity "$candidate")" || return 1
  is_compatible_single_board_identity "$identity"
}

release_launch_lock() {
  rm -f "$LAUNCH_LOCK/pid"
  rmdir "$LAUNCH_LOCK" 2>/dev/null || true
}

acquire_launch_lock() {
  local owner attempts=0
  while ! mkdir "$LAUNCH_LOCK" 2>/dev/null; do
    owner="$(cat "$LAUNCH_LOCK/pid" 2>/dev/null || true)"
    if [[ -z "$owner" ]] || ! kill -0 "$owner" 2>/dev/null; then
      rm -f "$LAUNCH_LOCK/pid"
      rmdir "$LAUNCH_LOCK" 2>/dev/null || true
      continue
    fi
    if [[ "$attempts" -ge 200 ]]; then
      echo "Another Canvas Prompt launcher is still preparing this port: PID ${owner}." >&2
      exit 1
    fi
    sleep 0.1
    attempts=$((attempts + 1))
  done
  printf '%s\n' "$$" > "$LAUNCH_LOCK/pid"
  trap release_launch_lock EXIT INT TERM
}

select_port() {
  local candidate="$PORT"
  local attempts=0
  while [[ "$attempts" -lt 20 ]]; do
    if is_reusable_canvas "$candidate"; then
      echo "Canvas Prompt is already running at http://127.0.0.1:${candidate}/" >&2
      printf 'reuse:%s' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
    attempts=$((attempts + 1))
  done
  candidate="$PORT"
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    if [ -z "$(port_pids "$candidate")" ]; then
      printf '%s' "$candidate"
      return 0
    fi
    if is_reusable_canvas "$candidate"; then
      echo "Canvas Prompt is already running at http://127.0.0.1:${candidate}/" >&2
      printf 'reuse:%s' "$candidate"
      return 0
    fi
    # An HTTP response cannot prove ownership of an existing process. Keep
    # occupied ports intact even when a Canvas-looking service is unhealthy.
    echo "Port ${candidate} is occupied by an incompatible or unavailable service; selecting another port." >&2
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

acquire_launch_lock

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
  release_launch_lock
  trap - EXIT INT TERM
  exec npm run dev -- --host 127.0.0.1 --port "$PORT"
fi

NODE_BIN="$(command -v node)"
SOFFICE_BIN="${CANVAS_PROMPT_SOFFICE_BIN:-}"
if [[ -z "$SOFFICE_BIN" ]]; then
  SOFFICE_BIN="$(command -v soffice 2>/dev/null || true)"
fi
if [[ -n "$SOFFICE_BIN" ]]; then
  export CANVAS_PROMPT_SOFFICE_BIN="$SOFFICE_BIN"
else
  unset CANVAS_PROMPT_SOFFICE_BIN
fi
# The service is the user's single board, not a plugin-cache checkout or a
# project/thread binding.  A stable label lets a newer plugin revision replace
# a crashed service instead of leaving launchctl jobs behind per cache path.
SERVICE_ID="$(printf '%s' "${CANVAS_DATA_HOME}/.canvas-prompt/board:${PORT}" | sha256_stdin | cut -c1-12)"
SERVICE_LABEL="com.canvas-prompt.${SERVICE_ID}"
SERVICE_LOG="${TMPDIR:-/tmp}/${SERVICE_LABEL}.log"

# A prior crashed job can survive without a listener. Remove it before submit.
launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
LAUNCHCTL_OK=false
if launchctl submit -l "$SERVICE_LABEL" -o "$SERVICE_LOG" -e "$SERVICE_LOG" -- \
  "$RUNNER" "$CORE_APP_DIR" "$WORKING_DIR" "$PROJECT_DIR" "$PORT" "$NODE_BIN" "$ASR_URL" "$ASR_ENABLED" "$DELIVERY_MODE" "$THREAD_ID" "$SESSION_ID" "$SOFFICE_BIN" "${CANVAS_PROMPT_DATA_HOME:-}" 2>/dev/null; then
  LAUNCHCTL_OK=true
fi

start_direct() {
  # A plain shell background job can be terminated with the host command's
  # process group. Python is already a runtime prerequisite; start a detached
  # session with closed input so it survives the launcher's exit.
  python3 - "$RUNNER" "$CORE_APP_DIR" "$WORKING_DIR" "$PROJECT_DIR" "$PORT" "$NODE_BIN" "$ASR_URL" "$ASR_ENABLED" "$DELIVERY_MODE" "$THREAD_ID" "$SESSION_ID" "$SOFFICE_BIN" "${CANVAS_PROMPT_DATA_HOME:-}" "$SERVICE_LOG" <<'PY'
import subprocess
import sys

with open(sys.argv[-1], "ab") as log:
    subprocess.Popen(sys.argv[1:-1], stdin=subprocess.DEVNULL, stdout=log,
                     stderr=subprocess.STDOUT, close_fds=True, start_new_session=True)
PY
}

wait_until_ready() {
  for _ in {1..20}; do
    if curl --silent --show-error --max-time 1 "http://127.0.0.1:${PORT}/" 2>/dev/null | grep -q '<title>Canvas Prompt</title>'; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

report_ready() {
    echo "Canvas Prompt is running at http://127.0.0.1:${PORT}/"
    echo "Canvas core: ${CORE_APP_DIR}"
    echo "Prompt Package: ${PROMPT_PACKAGE_PATH}"
    echo "Service: ${SERVICE_LABEL}"
    exit 0
}

if [[ "$LAUNCHCTL_OK" == "false" ]]; then start_direct; fi
if wait_until_ready; then report_ready; fi

# launchctl can accept the job while its child cannot read an external-volume
# checkout. Remove only our just-submitted job, and fall back only if its port
# remains free. Never stop an unrelated listener to make the fallback work.
if [[ "$LAUNCHCTL_OK" == "true" ]]; then
  launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
  if [ -z "$(port_pids "$PORT")" ]; then
    echo "Background service did not start; retrying directly from this session." >&2
    start_direct
    if wait_until_ready; then report_ready; fi
  fi
fi

echo "Canvas Prompt did not become ready. Log: ${SERVICE_LOG}" >&2
exit 1
