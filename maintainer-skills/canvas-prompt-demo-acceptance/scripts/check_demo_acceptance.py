#!/usr/bin/env python3
"""Verify exported Canvas Prompt rounds for the v0.1 manual-demo gate."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def read_json(path: Path, errors: list[str]) -> dict[str, Any] | None:
    if not path.is_file():
        errors.append(f"missing: {path}")
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"invalid JSON: {path} ({exc})")
        return None
    if not isinstance(value, dict):
        errors.append(f"JSON object required: {path}")
        return None
    return value


def round_dir(board_dir: Path, package_id: str) -> Path:
    return board_dir / "rounds" / package_id


def check_round(board_dir: Path, package_id: str, case: str) -> dict[str, Any]:
    root = round_dir(board_dir, package_id)
    errors: list[str] = []
    package = read_json(root / "prompt-package.json", errors)
    receipt = read_json(root / "handoff.json", [])
    process_ir = read_json(root / "engine" / "process-ir.json", errors)
    compact = read_json(root / "engine" / "compact-package.json", errors)

    if package and package.get("meta", {}).get("package_id") != package_id:
        errors.append("package ID does not match its directory")
    if not isinstance(process_ir, dict) or not isinstance(compact, dict):
        errors.append("compiler outputs are incomplete")
    if receipt and receipt.get("status") == "failed":
        errors.append("handoff is not accepted or delivered: 'failed'")

    baseline = package.get("baseline_context", {}) if package else {}
    if case == "blank":
        if baseline.get("image_count", 0) != 0:
            errors.append("blank round must not contain a baseline image")
        if package and package.get("base_artifacts"):
            errors.append("blank round must not contain base artifacts")
        if not (package.get("strokes") or []):
            errors.append("blank round has no recorded drawing strokes")
    elif case == "review":
        base_artifacts = package.get("base_artifacts") or []
        has_image_material = baseline.get("image_count", 0) >= 1 or any(
            isinstance(artifact, dict) and artifact.get("type") == "image"
            for artifact in base_artifacts
        )
        if not has_image_material:
            errors.append("review round has no image material")
        if not (process_ir or {}).get("review_mark_candidates"):
            errors.append("review round has no exported review-mark observation")

    return {
        "case": case,
        "board_dir": str(board_dir.resolve()),
        "package_id": package_id,
        "handoff_status": receipt.get("status") if receipt else None,
        "passed": not errors,
        "errors": errors,
    }


def waived_continuation(reason: str) -> dict[str, Any]:
    return {
        "case": "continuation",
        "package_id": None,
        "status": "waived",
        "waived": True,
        "waiver_reason": reason,
        "passed": True,
        "errors": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--board-dir", type=Path, required=True,
                        help="single-board archive directory, normally ~/.canvas-prompt/board")
    parser.add_argument("--blank-round", required=True)
    parser.add_argument("--review-round", required=True)
    continuation = parser.add_mutually_exclusive_group(required=True)
    continuation.add_argument("--continuation-round",
                              help="the most recent round explicitly read from a second main conversation")
    continuation.add_argument("--waive-continuation", action="store_true",
                              help="record an explicit release-owner waiver instead of claiming this round passed")
    parser.add_argument("--waiver-reason",
                        help="required with --waive-continuation; recorded verbatim in the private report")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    if args.waive_continuation and not args.waiver_reason:
        parser.error("--waiver-reason is required with --waive-continuation")
    if args.waiver_reason and not args.waive_continuation:
        parser.error("--waiver-reason requires --waive-continuation")

    results: list[dict[str, Any]] = [
        check_round(args.board_dir, args.blank_round, "blank"),
        check_round(args.board_dir, args.review_round, "review"),
    ]
    if args.waive_continuation:
        results.append(waived_continuation(args.waiver_reason))
    else:
        continuation_result = check_round(args.board_dir, args.continuation_round, "continuation")
        latest = read_json(args.board_dir / "latest-prompt-package.json", continuation_result["errors"])
        if latest and latest.get("meta", {}).get("package_id") != args.continuation_round:
            continuation_result["errors"].append("latest package is not the round used for cross-conversation continuation")
        continuation_result["passed"] = not continuation_result["errors"]
        results.append(continuation_result)
    report = {
        "gate": "canvas-prompt-v0.1-alpha-demo-acceptance",
        "passed": all(result["passed"] for result in results),
        "results": results,
        "constraint": "passing proves the supplied round artifacts; a waived continuation is not evidence of cross-conversation continuation. This report never proves automatic intent understanding, auto-injection, or language generalization",
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
