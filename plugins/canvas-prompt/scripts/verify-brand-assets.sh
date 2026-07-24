#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for asset in assets/logo.svg assets/logo-dark.svg assets/logo.png assets/logo-dark.png assets/icon.png; do
  test -s "$ROOT_DIR/$asset" || { echo "Missing brand asset: $asset" >&2; exit 1; }
done

cmp -s "$ROOT_DIR/assets/logo.svg" "$ROOT_DIR/app/public/favicon.svg" || {
  echo "favicon.svg must match assets/logo.svg" >&2
  exit 1
}

rg -q '"brandColor": "#C8462B"' "$ROOT_DIR/.codex-plugin/plugin.json"
rg -q '"composerIcon": "./assets/icon.png"' "$ROOT_DIR/.codex-plugin/plugin.json"
rg -q '"logo": "./assets/logo.png"' "$ROOT_DIR/.codex-plugin/plugin.json"
rg -q '"logoDark": "./assets/logo-dark.png"' "$ROOT_DIR/.codex-plugin/plugin.json"

echo "Canvas Prompt brand assets: OK"
