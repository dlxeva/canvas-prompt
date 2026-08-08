#!/usr/bin/env python3
"""Validate the MCPack-01 bounded model envelope."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

try:  # package import
    from .build_minimal_context_pack import (  # type: ignore
        CONTRACT,
        HARD_TEXT_TOKENS,
        MAX_CLAIMS,
        MAX_EVIDENCE_REFS,
        MAX_RELATION_CANDIDATES,
        MAX_SPEECH_SEGMENTS,
        QUALITY_OVERALL,
        QUALITY_STATES,
        SOURCE_LAYERS,
        STATUSES,
    )
except ImportError:  # existing script-style imports
    from build_minimal_context_pack import (
        CONTRACT,
        HARD_TEXT_TOKENS,
        MAX_CLAIMS,
        MAX_EVIDENCE_REFS,
        MAX_RELATION_CANDIDATES,
        MAX_SPEECH_SEGMENTS,
        QUALITY_OVERALL,
        QUALITY_STATES,
        SOURCE_LAYERS,
        STATUSES,
    )


REQUIRED_FIELDS = {
    "contract",
    "context_id",
    "context_version",
    "package_id",
    "source",
    "task",
    "claims",
    "relation_candidates",
    "unresolved",
    "evidence",
    "quality",
    "constraints",
    "budget",
}
ALLOWED_CANDIDATE_TYPES = {
    "unresolved_handdrawn_connection",
    "unresolved_handdrawn_circle",
    "unresolved_intersecting_stroke_pair",
    "reference_candidate",
    "spatial_near",
    "contains_like",
}
_SAFE_SOURCE_REF = re.compile(r"^/[A-Za-z0-9_./-]+$")


def _walk_for_forbidden(value: Any, path: str = "$") -> list[str]:
    errors: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {
                "canvas_event_track", "timeline_fusion", "caption_track", "full_canvas_event_track",
                "full_process_ir", "process_ir", "strokes", "stroke_points", "audio", "audio_bytes",
                "raw_audio", "raw_transcript", "tool_trace", "tool_calls", "model_trace", "archive",
                "archive_path", "absolute_path",
            }:
                errors.append(f"{path}.{key} is complete-archive material and cannot enter the envelope")
            errors.extend(_walk_for_forbidden(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            errors.extend(_walk_for_forbidden(child, f"{path}[{index}]"))
    return errors


def _refs(item: dict[str, Any], prefix: str, evidence_ids: set[str], errors: list[str]) -> None:
    refs = item.get("evidence_refs")
    if not isinstance(refs, list) or not refs:
        errors.append(f"{prefix}.evidence_refs must contain at least one evidence ID")
        return
    if len(refs) > MAX_EVIDENCE_REFS:
        errors.append(f"{prefix}.evidence_refs exceeds {MAX_EVIDENCE_REFS}")
    if any(not isinstance(ref, str) or not ref for ref in refs):
        errors.append(f"{prefix}.evidence_refs must contain non-empty strings")
    missing = [ref for ref in refs if isinstance(ref, str) and ref not in evidence_ids]
    if missing:
        errors.append(f"{prefix}.evidence_refs contains unknown IDs: {', '.join(missing)}")


def _validate_time_window(value: Any, prefix: str, errors: list[str]) -> None:
    if value is None:
        return
    if not isinstance(value, dict) or not isinstance(value.get("start_ms"), (int, float)) or not isinstance(value.get("end_ms"), (int, float)):
        errors.append(f"{prefix} must contain numeric start_ms/end_ms")
    elif value["start_ms"] > value["end_ms"]:
        errors.append(f"{prefix} start_ms must not exceed end_ms")


def validate_minimal_context_pack(value: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(value, dict):
        return ["Context Pack must be a JSON object"]
    errors.extend(_walk_for_forbidden(value))
    missing = sorted(REQUIRED_FIELDS - set(value))
    errors.extend(f"Missing required field: {field}" for field in missing)
    if value.get("contract") != CONTRACT:
        errors.append(f"contract must equal {CONTRACT}")
    if not isinstance(value.get("context_id"), str) or not value["context_id"].startswith("ctx_"):
        errors.append("context_id must be a generated ctx_ identifier")
    if value.get("execution_authorized") is not False:
        errors.append("top-level execution_authorized must be false")
    source = value.get("source")
    if not isinstance(source, dict):
        errors.append("source must be an object")
    task = value.get("task")
    if not isinstance(task, dict) or not isinstance(task.get("kind"), str) or not isinstance(task.get("question"), str):
        errors.append("task must contain bounded kind and question strings")
    constraints = value.get("constraints")
    if not isinstance(constraints, dict):
        errors.append("constraints must be an object")
    else:
        if constraints.get("execution_authorized") is not False:
            errors.append("constraints.execution_authorized must be false")
        confirmation = constraints.get("confirmation")
        if not isinstance(confirmation, dict) or confirmation.get("status") not in {"none", "needs_clarification", "confirmed"}:
            errors.append("constraints.confirmation.status must be a valid confirmation state")
        elif confirmation.get("status") == "confirmed":
            refs = confirmation.get("evidence_refs")
            if not isinstance(refs, list) or not refs:
                errors.append("confirmed constraints require confirmation evidence_refs")

    evidence_items = value.get("evidence") if isinstance(value.get("evidence"), list) else []
    evidence_ids: set[str] = set()
    for index, item in enumerate(evidence_items):
        prefix = f"evidence[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue
        evidence_id = item.get("evidence_id")
        if not isinstance(evidence_id, str) or not evidence_id:
            errors.append(f"{prefix}.evidence_id must be non-empty")
        elif evidence_id in evidence_ids:
            errors.append(f"{prefix}.evidence_id must be unique")
        else:
            evidence_ids.add(evidence_id)
        if item.get("availability") not in {"available", "unavailable"}:
            errors.append(f"{prefix}.availability must be available or unavailable")
        source_ref = item.get("source_ref")
        if not isinstance(source_ref, str) or not _SAFE_SOURCE_REF.match(source_ref) or ".." in source_ref:
            errors.append(f"{prefix}.source_ref must be a local JSON pointer, not a path/URL")
        _validate_time_window(item.get("time_window_ms"), f"{prefix}.time_window_ms", errors)

    claims = value.get("claims") if isinstance(value.get("claims"), list) else []
    if not isinstance(value.get("claims"), list):
        errors.append("claims must be a list")
    elif len(claims) > MAX_CLAIMS:
        errors.append(f"claims exceeds {MAX_CLAIMS}")
    claim_ids: set[str] = set()
    for index, claim in enumerate(claims):
        prefix = f"claims[{index}]"
        if not isinstance(claim, dict):
            errors.append(f"{prefix} must be an object")
            continue
        claim_id = claim.get("claim_id")
        if not isinstance(claim_id, str) or not claim_id or claim_id in claim_ids:
            errors.append(f"{prefix}.claim_id must be unique and non-empty")
        claim_ids.add(claim_id) if isinstance(claim_id, str) else None
        if claim.get("source_layer") not in SOURCE_LAYERS:
            errors.append(f"{prefix}.source_layer is invalid")
        if claim.get("status") not in STATUSES:
            errors.append(f"{prefix}.status is invalid")
        content = claim.get("content")
        if not isinstance(content, dict) or not isinstance(content.get("text"), str) or not content.get("text").strip():
            errors.append(f"{prefix}.content.text must be bounded text")
        _refs(claim, prefix, evidence_ids, errors)
        _validate_time_window(claim.get("time_window_ms"), f"{prefix}.time_window_ms", errors)
        if claim.get("status") == "confirmed" and claim.get("source_layer") != "confirmation":
            errors.append(f"{prefix} confirmed status requires confirmation source_layer")

    candidates = value.get("relation_candidates") if isinstance(value.get("relation_candidates"), list) else []
    if not isinstance(value.get("relation_candidates"), list):
        errors.append("relation_candidates must be a list")
    elif len(candidates) > MAX_RELATION_CANDIDATES:
        errors.append(f"relation_candidates exceeds {MAX_RELATION_CANDIDATES}")
    candidate_ids: set[str] = set()
    for index, candidate in enumerate(candidates):
        prefix = f"relation_candidates[{index}]"
        if not isinstance(candidate, dict):
            errors.append(f"{prefix} must be an object")
            continue
        candidate_id = candidate.get("candidate_id")
        if not isinstance(candidate_id, str) or not candidate_id or candidate_id in candidate_ids:
            errors.append(f"{prefix}.candidate_id must be unique and non-empty")
        candidate_ids.add(candidate_id) if isinstance(candidate_id, str) else None
        if candidate.get("candidate_type") not in ALLOWED_CANDIDATE_TYPES:
            errors.append(f"{prefix}.candidate_type is not an allowed unresolved candidate type")
        if candidate.get("status") not in {"unresolved", "confirmed"}:
            errors.append(f"{prefix}.status must remain unresolved or explicitly confirmed")
        if candidate.get("status") == "confirmed":
            errors.append(f"{prefix} geometry/reference candidates cannot be confirmed by this adapter")
        _refs(candidate, prefix, evidence_ids, errors)
        _validate_time_window(candidate.get("time_window_ms"), f"{prefix}.time_window_ms", errors)

    unresolved = value.get("unresolved") if isinstance(value.get("unresolved"), list) else []
    if not isinstance(value.get("unresolved"), list):
        errors.append("unresolved must be a list")
    for index, item in enumerate(unresolved):
        prefix = f"unresolved[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue
        if not isinstance(item.get("id"), str) or not item.get("id"):
            errors.append(f"{prefix}.id must be non-empty")
        if item.get("reason") not in {"unavailable", "conflicting", "degraded", "truncated", "unresolved"}:
            errors.append(f"{prefix}.reason is invalid")
        _refs(item, prefix, evidence_ids, errors)

    quality = value.get("quality")
    if not isinstance(quality, dict):
        errors.append("quality must be an object")
    else:
        if quality.get("overall") not in QUALITY_OVERALL:
            errors.append("quality.overall is invalid")
        layers = quality.get("layers")
        if not isinstance(layers, dict):
            errors.append("quality.layers must be an object")
        else:
            for key, state in layers.items():
                if state not in QUALITY_STATES:
                    errors.append(f"quality.layers.{key} is invalid")
        coverage = quality.get("coverage")
        if not isinstance(coverage, dict):
            errors.append("quality.coverage must be an object")
        else:
            for key in ("claims_included", "candidate_included", "candidate_omitted"):
                if not isinstance(coverage.get(key), int) or coverage[key] < 0:
                    errors.append(f"quality.coverage.{key} must be a non-negative integer")
            for key in ("truncated", "saturated"):
                if not isinstance(coverage.get(key), bool):
                    errors.append(f"quality.coverage.{key} must be boolean")
        if not isinstance(quality.get("saturated"), bool):
            errors.append("quality.saturated must be boolean")
        if not isinstance(quality.get("truncated"), bool):
            errors.append("quality.truncated must be boolean")

    budget = value.get("budget")
    if not isinstance(budget, dict):
        errors.append("budget must be an object")
    else:
        if not isinstance(budget.get("text_token_estimate"), int) or budget["text_token_estimate"] < 0:
            errors.append("budget.text_token_estimate must be a non-negative integer")
        elif budget["text_token_estimate"] > HARD_TEXT_TOKENS and not value.get("quality", {}).get("truncated"):
            errors.append("over-hard-budget envelope must declare quality.truncated")
        if not isinstance(budget.get("json_bytes"), int) or budget["json_bytes"] <= 0:
            errors.append("budget.json_bytes must be positive")
        if budget.get("candidate_count") != len(candidates):
            errors.append("budget.candidate_count must equal relation_candidates length")
        if budget.get("speech_segment_count") > MAX_SPEECH_SEGMENTS:
            errors.append("budget speech segment count exceeds bound")

    # Confirmation evidence IDs, if present, also must resolve to bounded refs.
    confirmation = (value.get("constraints") or {}).get("confirmation") if isinstance(value.get("constraints"), dict) else {}
    if isinstance(confirmation, dict):
        for ref in confirmation.get("evidence_refs", []):
            if ref not in evidence_ids:
                errors.append(f"constraints.confirmation references unknown evidence ID {ref}")
    return errors


def validate_context_pack(value: Any) -> list[str]:
    return validate_minimal_context_pack(value)


def validate_package(value: Any) -> tuple[list[str], list[str]]:
    """Compact-validator-compatible return shape for evaluator callers."""
    return validate_minimal_context_pack(value), []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args(argv)
    try:
        value = json.loads(args.path.read_text(encoding="utf-8"))
    except Exception as error:  # pragma: no cover - CLI guard
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    errors = validate_minimal_context_pack(value)
    if errors:
        print("FAIL")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
