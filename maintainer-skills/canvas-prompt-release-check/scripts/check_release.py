#!/usr/bin/env python3
"""Read-only static release checks for a Canvas Prompt source repository."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any


SECRET_RE = re.compile(r"(?:api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}", re.IGNORECASE)
ABSOLUTE_PATH_RE = re.compile(r"/(?:Users|home|root)/[^\s'\"]+")
SENSITIVE_SUFFIXES = {".wav", ".mp3", ".m4a", ".webm", ".mov", ".mp4"}


def git_lines(repo: Path, *args: str) -> list[str]:
    result = subprocess.run(["git", *args], cwd=repo, text=True, capture_output=True, check=False)
    return result.stdout.splitlines() if result.returncode == 0 else []


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    blockers: list[str] = []
    warnings: list[str] = []
    checks: dict[str, Any] = {}

    manifest_path = repo / ".codex-plugin" / "plugin.json"
    for required in (repo / "LICENSE", repo / "PRIVACY.md", repo / "PRIVACY.zh-CN.md", manifest_path):
        if not required.is_file():
            blockers.append(f"missing required release file: {required.relative_to(repo)}")
    manifest: dict[str, Any] = {}
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            blockers.append("plugin manifest is not valid JSON")
        for field in ("name", "version", "skills"):
            if not manifest.get(field):
                blockers.append(f"plugin manifest lacks {field}")

    tracked = git_lines(repo, "ls-files")
    if not tracked:
        blockers.append("repository is not a readable Git worktree or has no tracked files")
    for relative in tracked:
        path = Path(relative)
        if ".canvas-prompt" in path.parts:
            blockers.append(f"tracked local Canvas Prompt archive: {relative}")
        if path.suffix.lower() in SENSITIVE_SUFFIXES and "assets" not in path.parts:
            warnings.append(f"tracked media requires privacy review: {relative}")
        absolute = repo / path
        if not absolute.is_file() or absolute.suffix.lower() in SENSITIVE_SUFFIXES or absolute.stat().st_size > 1_000_000:
            continue
        try:
            text = absolute.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if SECRET_RE.search(text):
            blockers.append(f"possible credential assignment in tracked file: {relative}")
        if ABSOLUTE_PATH_RE.search(text):
            warnings.append(f"private absolute path needs review: {relative}")

    dirty = git_lines(repo, "status", "--short")
    if dirty:
        warnings.append("worktree has uncommitted changes; review scope before release")
    checks["manifest_version"] = manifest.get("version")
    checks["tracked_file_count"] = len(tracked)
    checks["worktree_clean"] = not dirty
    report = {
        "gate": "canvas-prompt-open-source-static-check",
        "passed": not blockers,
        "blockers": sorted(set(blockers)),
        "warnings": sorted(set(warnings)),
        "checks": checks,
        "constraint": "static check only; run npm verify and installed demo acceptance separately before any public release",
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
