#!/usr/bin/env python3
"""Validate the stable, language-neutral Process IR contract."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


BASE_REQUIRED_FIELDS = {
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
    "layout_transform_observations",
    "review_mark_candidates",
    "view_transform_observations",
    "attention_signals",
    "quality",
    "interpretation_constraints",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def validate_process_ir(data: Any) -> list[str]:
    if not isinstance(data, dict):
        return ["Process IR must be an object."]
    schema_version = data.get("schema_version")
    required_fields = set(BASE_REQUIRED_FIELDS)
    if schema_version == "process-ir-v0.5":
        required_fields.add("ink_circle_candidates")
    errors = [f"Missing required field: {field}" for field in sorted(required_fields - set(data))]
    if schema_version not in {"process-ir-v0.3", "process-ir-v0.4", "process-ir-v0.5"}:
        errors.append("Unsupported or missing schema_version.")
    for field in (
        "speech_anchors", "canvas_actions", "objects", "spatial_relations",
        "reference_candidates", "ink_relation_candidates", "ink_arrowhead_candidates", "visual_unit_candidates",
        "layout_transform_observations", "review_mark_candidates", "view_transform_observations",
        "attention_signals", "interpretation_constraints",
    ):
        if field in data and not isinstance(data[field], list):
            errors.append(f"{field} must be a list.")
    if "ink_circle_candidates" in data and not isinstance(data["ink_circle_candidates"], list):
        errors.append("ink_circle_candidates must be a list.")
    if "quality" in data and not isinstance(data["quality"], dict):
        errors.append("quality must be an object.")
    if "source" in data and not isinstance(data["source"], dict):
        errors.append("source must be an object.")
    elif "source" in data:
        if not SHA256_RE.fullmatch(str(data["source"].get("content_sha256", ""))):
            errors.append("source.content_sha256 must be a SHA-256 digest.")
        if not isinstance(data["source"].get("compiler_version"), str):
            errors.append("source.compiler_version must be a string.")
    speech_anchors = data.get("speech_anchors", []) if isinstance(data.get("speech_anchors"), list) else []
    speech_anchor_ids = [item.get("caption_id") for item in speech_anchors if isinstance(item, dict)]
    if any(not isinstance(item, str) or not item for item in speech_anchor_ids):
        errors.append("Speech anchors require non-empty caption_id values.")
    if len(set(speech_anchor_ids)) != len(speech_anchor_ids):
        errors.append("Speech anchor caption_id values must be unique.")
    speech_anchor_id_set = {item for item in speech_anchor_ids if isinstance(item, str) and item}

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
        if item.get("caption_id") not in speech_anchor_id_set:
            errors.append("Reference candidate caption_id must resolve to a speech anchor.")
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
    for item in data.get("ink_circle_candidates", []):
        if item.get("assertion_level") != "observation" or item.get("resolution_status") != "unresolved":
            errors.append("Hand-drawn circle candidates must be unresolved observations.")
        if item.get("relation") != "unresolved_handdrawn_circle":
            errors.append("Unsupported hand-drawn circle candidate type.")
        object_ids = item.get("candidate_object_ids")
        if not isinstance(object_ids, list) or not object_ids or any(not isinstance(value, str) or not value for value in object_ids):
            errors.append("Hand-drawn circle candidates require candidate object IDs.")
        elif len(set(object_ids)) != len(object_ids):
            errors.append("Hand-drawn circle candidate object IDs must be unique.")
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
    for item in data.get("review_mark_candidates", []):
        if item.get("assertion_level") != "observation" or item.get("resolution_status") != "unresolved":
            errors.append("Review marks must be unresolved observations.")
        if item.get("coordinate_space") != "base_artifact":
            errors.append("Review marks must use base_artifact coordinates.")
        evidence_caption_ids = item.get("evidence_caption_ids")
        if not isinstance(evidence_caption_ids, list):
            errors.append("Review marks require an evidence_caption_ids list.")
            evidence_caption_ids = []
        unresolved_ids = [caption_id for caption_id in evidence_caption_ids if caption_id not in speech_anchor_id_set]
        if unresolved_ids:
            errors.append("Review mark evidence_caption_ids must resolve to speech anchors.")
        if item.get("speech_link_status") == "linked" and not evidence_caption_ids:
            errors.append("Linked review marks require at least one speech anchor.")
        if item.get("speech_link_status") == "unavailable" and evidence_caption_ids:
            errors.append("Unavailable review marks must not retain speech evidence IDs.")
    for item in data.get("layout_transform_observations", []):
        if item.get("assertion_level") != "observation":
            errors.append("Layout transforms must be observations.")
        if item.get("constraint") != "layout_change_does_not_establish_priority_or_intent":
            errors.append("Layout transforms must preserve the no-priority constraint.")
    for item in data.get("view_transform_observations", []):
        if item.get("assertion_level") != "observation":
            errors.append("Viewport transforms must be observations.")
        if item.get("coordinate_space") != "viewport_transform":
            errors.append("Viewport transforms must use viewport_transform coordinates.")
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
