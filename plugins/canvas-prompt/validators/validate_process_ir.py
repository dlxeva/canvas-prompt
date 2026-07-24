#!/usr/bin/env python3
"""Validate the stable, language-neutral Process IR contract."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


REQUIRED_FIELDS = {
    "schema_version",
    "source",
    "speech_anchors",
    "canvas_actions",
    "objects",
    "spatial_relations",
    "reference_candidates",
    "ink_relation_candidates",
    "ink_arrowhead_candidates",
    "visual_unit_candidates",
    "attention_signals",
    "quality",
    "interpretation_constraints",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def validate_process_ir(data: Any) -> list[str]:
    if not isinstance(data, dict):
        return ["Process IR must be an object."]
    errors = [f"Missing required field: {field}" for field in sorted(REQUIRED_FIELDS - set(data))]
    if data.get("schema_version") != "process-ir-v0.3":
        errors.append("Unsupported or missing schema_version.")
    for field in (
        "speech_anchors", "canvas_actions", "objects", "spatial_relations",
        "reference_candidates", "ink_relation_candidates", "ink_arrowhead_candidates", "visual_unit_candidates",
        "attention_signals", "interpretation_constraints",
    ):
        if field in data and not isinstance(data[field], list):
            errors.append(f"{field} must be a list.")
    if "quality" in data and not isinstance(data["quality"], dict):
        errors.append("quality must be an object.")
    if "source" in data and not isinstance(data["source"], dict):
        errors.append("source must be an object.")
    elif "source" in data:
        if not SHA256_RE.fullmatch(str(data["source"].get("content_sha256", ""))):
            errors.append("source.content_sha256 must be a SHA-256 digest.")
        if not isinstance(data["source"].get("compiler_version"), str):
            errors.append("source.compiler_version must be a string.")
    for observation in data.get("observations", []):
        if observation.get("assertion_level") != "observation":
            errors.append("Process IR observations must use assertion_level=observation.")
        if observation.get("type") != "pause_observed":
            errors.append("Unsupported observation type.")
    for item in data.get("reference_candidates", []):
        if item.get("assertion_level") != "observation" or item.get("resolution_status") != "unresolved":
            errors.append("Reference candidates must be unresolved observations.")
        if not isinstance(item.get("candidate_objects"), list):
            errors.append("Reference candidate objects must be a list.")
    for item in data.get("ink_relation_candidates", []):
        if item.get("assertion_level") != "observation" or item.get("resolution_status") != "unresolved":
            errors.append("Hand-drawn relation candidates must be unresolved observations.")
        if item.get("relation") != "unresolved_handdrawn_connection":
            errors.append("Unsupported hand-drawn relation candidate type.")
        endpoints = item.get("endpoint_candidates")
        if not isinstance(endpoints, dict) or not endpoints.get("start_object_id") or not endpoints.get("end_object_id"):
            errors.append("Hand-drawn relation candidates require endpoint object candidates.")
        elif endpoints["start_object_id"] == endpoints["end_object_id"]:
            errors.append("Hand-drawn relation candidate endpoints must differ.")
    for item in data.get("ink_arrowhead_candidates", []):
        if item.get("assertion_level") != "observation" or item.get("resolution_status") != "unresolved":
            errors.append("Hand-drawn arrowhead candidates must be unresolved observations.")
        if item.get("type") != "unresolved_handdrawn_arrowhead":
            errors.append("Unsupported hand-drawn arrowhead candidate type.")
        if item.get("candidate_visual_direction") not in {"path_start_to_path_end", "path_end_to_path_start"}:
            errors.append("Hand-drawn arrowhead candidates require a visual direction candidate.")
        supports = item.get("support_stroke_ids")
        if not isinstance(supports, list) or len(supports) != 2 or supports[0] == supports[1]:
            errors.append("Hand-drawn arrowhead candidates require two distinct support strokes.")
    for item in data.get("visual_unit_candidates", []):
        if item.get("assertion_level") != "observation" or item.get("resolution_status") != "unresolved":
            errors.append("Visual-unit candidates must be unresolved observations.")
        members = item.get("member_object_ids")
        if not isinstance(members, list) or len(members) < 2:
            errors.append("Visual-unit candidates require at least two member objects.")
    return errors


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: validate_process_ir.py <process_ir.json>")
    path = Path(sys.argv[1])
    errors = validate_process_ir(json.loads(path.read_text(encoding="utf-8")))
    if errors:
        print("FAIL")
        print("\n".join(f"- {error}" for error in errors))
        raise SystemExit(1)
    print("PASS")


if __name__ == "__main__":
    main()

