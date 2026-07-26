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


def round_dir(project: Path, package_id: str) -> Path:
    return project / ".canvas-prompt" / "rounds" / package_id


def check_round(project: Path, package_id: str, case: str) -> dict[str, Any]:
    root = round_dir(project, package_id)
    errors: list[str] = []
    package = read_json(root / "prompt-package.json", errors)
    receipt = read_json(root / "handoff.json", errors)
    process_ir = read_json(root / "engine" / "process-ir.json", errors)
    compact = read_json(root / "engine" / "compact-package.json", errors)

    if package and package.get("meta", {}).get("package_id") != package_id:
        errors.append("package ID does not match its directory")
    if receipt and receipt.get("status") not in {"accepted", "delivered"}:
        errors.append(f"handoff is not accepted or delivered: {receipt.get('status')!r}")
    if not isinstance(process_ir, dict) or not isinstance(compact, dict):
        errors.append("compiler outputs are incomplete")

    baseline = package.get("baseline_context", {}) if package else {}
    if case == "blank":
        if baseline.get("image_count", 0) != 0:
            errors.append("blank round must not contain a baseline image")
        if package.get("base_artifacts"):
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
        "project": str(project.resolve()),
        "package_id": package_id,
        "handoff_status": receipt.get("status") if receipt else None,
        "passed": not errors,
        "errors": errors,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-a", type=Path, required=True)
    parser.add_argument("--blank-round", required=True)
    parser.add_argument("--review-round", required=True)
    parser.add_argument("--project-b", type=Path, required=True)
    parser.add_argument("--isolation-round", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    results = [
        check_round(args.project_a, args.blank_round, "blank"),
        check_round(args.project_a, args.review_round, "review"),
        check_round(args.project_b, args.isolation_round, "isolation"),
    ]
    if args.project_a.resolve() == args.project_b.resolve():
        results[-1]["errors"].append("project-isolation round must use a different project directory")
        results[-1]["passed"] = False
    report = {
        "gate": "canvas-prompt-v0.1-alpha-demo-acceptance",
        "passed": all(result["passed"] for result in results),
        "results": results,
        "constraint": "passing proves exported-artifact integrity for these rounds, not automatic intent understanding or language generalization",
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
