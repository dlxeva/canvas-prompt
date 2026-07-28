#!/usr/bin/env python3
"""
Compact Prompt Package Validator

Validates that a compact prompt package JSON file conforms to the specification.

Usage:
    python validate_compact_package.py <path_to_compact_prompt_package.json>

Exit codes:
    0 - PASS (all checks passed)
    1 - FAIL (one or more checks failed)
    2 - Error (file not found, invalid JSON, etc.)
"""

import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

# ── Constants ──────────────────────────────────────────────────────────────────

REQUIRED_FIELDS = {
    "final_canvas_snapshot",
    "transcript",
    "compact_caption_summary",
    "semantic_events",
    "relevant_object_states",
    "evidence_refs",
    "structural_observations",
    "review_marks",
    "view_transform_observations",
    "process_ir_summary",
    "constraints",
}

FORBIDDEN_FIELDS = {
    "canvas_event_track",
    "timeline_fusion",
    "caption_track",
    "fusion_report",
    "semantic_event_generation_report",
    "manual_semantic_event_track",
    "blind_mapping",
    "evaluation_scores",
}

SEMANTIC_EVENT_REQUIRED_FIELDS = {
    "semantic_event_id",
    "semantic_type",
    "timestamp_start",
    "timestamp_end",
    "summary",
    "involved_object_ids",
    "confidence",
    "assertion_level",
    "evidence",
    "counter_evidence",
    "features",
}

SEMANTIC_EVENT_SOURCE_FIELDS = {
    "source_caption_ids",
    "source_event_refs",
}

CONSTRAINTS_REQUIRED_KEYS = {
    "do_not_infer_deleted_paths_without_evidence",
    "do_not_treat_pause_as_uncertainty_without_text_evidence",
    "semantic_events_are_generated_not_manual",
    "full_canvas_event_track_excluded",
    "full_timeline_fusion_excluded",
    "inline_canvas_data_excluded",
    "structural_observations_are_unresolved",
}

MAX_SOURCE_EVENT_REFS = 5

# Semantic events may use alternate field names in some implementations
SEMANTIC_FIELD_ALIASES = {
    "type": "semantic_type",
    "time_range_ms": ("timestamp_start", "timestamp_end"),
}


# ── Validation Functions ───────────────────────────────────────────────────────

def validate_package(data: Dict[str, Any]) -> Tuple[List[str], List[str]]:
    """
    Validate a compact prompt package.
    Returns (errors, warnings).
    """
    errors: List[str] = []
    warnings: List[str] = []

    # 1. Top-level type check
    if not isinstance(data, dict):
        errors.append("Root element must be a JSON object.")
        return errors, warnings

    top_keys = set(data.keys())

    # 2. Required fields
    missing_required = REQUIRED_FIELDS - top_keys
    for field in sorted(missing_required):
        errors.append(f"Missing required field: '{field}'")

    # 3. Forbidden fields
    present_forbidden = FORBIDDEN_FIELDS & top_keys
    for field in sorted(present_forbidden):
        errors.append(f"Forbidden field present: '{field}'")

    # 4. Validate semantic_events
    semantic_events = data.get("semantic_events")
    if semantic_events is not None:
        if not isinstance(semantic_events, list):
            errors.append("'semantic_events' must be a list.")
        else:
            for idx, event in enumerate(semantic_events):
                prefix = f"semantic_events[{idx}]"
                _validate_semantic_event(event, prefix, errors, warnings)

    # 5. Validate constraints
    constraints = data.get("constraints")
    if constraints is not None:
        if not isinstance(constraints, dict):
            errors.append("'constraints' must be an object.")
        else:
            _validate_constraints(constraints, errors, warnings)

    # 6. Validate compact_caption_summary
    captions = data.get("compact_caption_summary")
    if captions is not None:
        if not isinstance(captions, list):
            errors.append("'compact_caption_summary' must be a list.")
        else:
            for idx, cap in enumerate(captions):
                if not isinstance(cap, dict):
                    errors.append(f"compact_caption_summary[{idx}]: must be an object.")
                else:
                    if "caption_id" not in cap:
                        warnings.append(f"compact_caption_summary[{idx}]: missing 'caption_id'.")

    # 7. Validate evidence_refs (if present)
    evidence_refs = data.get("evidence_refs")
    if evidence_refs is not None and not isinstance(evidence_refs, list):
        errors.append("'evidence_refs' must be a list.")

    # 8. Validate relevant_object_states
    object_states = data.get("relevant_object_states")
    if object_states is not None:
        if not isinstance(object_states, list):
            errors.append("'relevant_object_states' must be a list.")
        else:
            for idx, state in enumerate(object_states):
                if not isinstance(state, dict):
                    errors.append(f"relevant_object_states[{idx}]: must be an object.")

    # 9. Structural observations are useful context, never resolved semantics.
    structural = data.get("structural_observations")
    if structural is not None:
        if not isinstance(structural, dict):
            errors.append("'structural_observations' must be an object.")
        else:
            structural_fields = ["reference_candidates", "handdrawn_connection_candidates", "handdrawn_arrowhead_candidates", "visual_unit_candidates"]
            compact_version = str((data.get("meta") or {}).get("version") or "")
            if compact_version in {"2.3", "2.4", "2.5", "2.6"}:
                structural_fields.append("handdrawn_circle_candidates")
            if compact_version in {"2.4", "2.5", "2.6"}:
                structural_fields.append("handdrawn_cross_candidates")
            if compact_version in {"2.5", "2.6"}:
                structural_fields.append("handdrawn_check_candidates")
                structural_fields.append("paired_symbol_choice_candidates")
            if compact_version == "2.6":
                structural_fields.append("handdrawn_annotation_candidates")
            for field in structural_fields:
                values = structural.get(field)
                if not isinstance(values, list):
                    errors.append(f"structural_observations.{field} must be a list.")
                    continue
                for index, item in enumerate(values):
                    if not isinstance(item, dict) or item.get("assertion_level") != "observation" or item.get("resolution_status") != "unresolved":
                        errors.append(f"structural_observations.{field}[{index}] must be an unresolved observation.")

    # 10. Review and viewport evidence remain observations; their presence is
    # required even when empty so consumers do not confuse an older Compact
    # package with a new one that happened to contain no marks.
    for field in ("review_marks", "view_transform_observations"):
        values = data.get(field)
        if not isinstance(values, list):
            errors.append(f"'{field}' must be a list.")
            continue
        for index, item in enumerate(values):
            if not isinstance(item, dict) or item.get("assertion_level") != "observation":
                errors.append(f"{field}[{index}] must be an observation.")
    caption_items = captions if isinstance(captions, list) else []
    semantic_items = semantic_events if isinstance(semantic_events, list) else []
    object_state_items = object_states if isinstance(object_states, list) else []
    evidence_ref_items = evidence_refs if isinstance(evidence_refs, list) else []
    caption_ids = [
        item.get("caption_id") for item in caption_items
        if isinstance(item, dict) and isinstance(item.get("caption_id"), str)
    ]
    if len(set(caption_ids)) != len(caption_ids):
        errors.append("compact_caption_summary caption_id values must be unique.")
    caption_id_set = set(caption_ids)
    referenced_caption_ids = set()
    for item in semantic_items + object_state_items:
        if isinstance(item, dict):
            referenced_caption_ids.update(value for value in item.get("source_caption_ids", []) if isinstance(value, str) and value)
    for item in data.get("review_marks") or []:
        if isinstance(item, dict):
            referenced_caption_ids.update(value for value in item.get("evidence_caption_ids", []) if isinstance(value, str) and value)
    if isinstance(structural, dict):
        for item in structural.get("reference_candidates") or []:
            if isinstance(item, dict) and isinstance(item.get("caption_id"), str) and item.get("caption_id"):
                referenced_caption_ids.add(item["caption_id"])
    for item in evidence_ref_items:
        if isinstance(item, dict) and item.get("source_type") == "speech" and isinstance(item.get("source_id"), str):
            referenced_caption_ids.add(item["source_id"])
    missing_caption_ids = sorted(referenced_caption_ids - caption_id_set)
    if missing_caption_ids:
        errors.append(f"Referenced caption IDs are missing from compact_caption_summary: {', '.join(missing_caption_ids)}")

    provenance = data.get("process_ir_summary")
    if not isinstance(provenance, dict) or not isinstance(provenance.get("source_provenance"), dict):
        errors.append("process_ir_summary.source_provenance must be an object.")

    return errors, warnings


def _validate_semantic_event(
    event: Any, prefix: str, errors: List[str], warnings: List[str]
) -> None:
    """Validate a single semantic event entry."""
    if not isinstance(event, dict):
        errors.append(f"{prefix}: must be an object.")
        return

    event_keys = set(event.keys())

    # Check required fields (with alias tolerance)
    for field in SEMANTIC_EVENT_REQUIRED_FIELDS:
        if field == "semantic_type":
            # Accept either 'semantic_type' or 'type'
            if "semantic_type" not in event and "type" not in event:
                errors.append(f"{prefix}: missing 'semantic_type' (or alias 'type').")
        elif field == "timestamp_start":
            # Accept either timestamp_start or time_range_ms[0]
            if "timestamp_start" not in event and "time_range_ms" not in event:
                errors.append(f"{prefix}: missing 'timestamp_start' (or alias 'time_range_ms').")
        elif field == "timestamp_end":
            if "timestamp_end" not in event and "time_range_ms" not in event:
                errors.append(f"{prefix}: missing 'timestamp_end' (or alias 'time_range_ms').")
        else:
            if field not in event:
                errors.append(f"{prefix}: missing required field '{field}'.")

    # Check source fields (at least one required)
    has_source_captions = "source_caption_ids" in event
    has_source_events = "source_event_refs" in event
    if not has_source_captions and not has_source_events:
        errors.append(
            f"{prefix}: must have at least one of 'source_caption_ids' or 'source_event_refs'."
        )

    # Validate confidence range
    confidence = event.get("confidence")
    if confidence is not None:
        if not isinstance(confidence, (int, float)):
            errors.append(f"{prefix}: 'confidence' must be a number.")
        elif not (0 <= confidence <= 1):
            errors.append(f"{prefix}: 'confidence' must be between 0 and 1, got {confidence}.")

    # Validate source_event_refs length
    source_event_refs = event.get("source_event_refs")
    if source_event_refs is not None:
        if not isinstance(source_event_refs, list):
            errors.append(f"{prefix}: 'source_event_refs' must be a list.")
        elif len(source_event_refs) > MAX_SOURCE_EVENT_REFS:
            errors.append(
                f"{prefix}: 'source_event_refs' has {len(source_event_refs)} entries, "
                f"maximum allowed is {MAX_SOURCE_EVENT_REFS}."
            )

    # Validate involved_object_ids
    involved = event.get("involved_object_ids")
    if involved is not None and not isinstance(involved, list):
        errors.append(f"{prefix}: 'involved_object_ids' must be a list.")

    for field in ("evidence", "counter_evidence"):
        if field in event and not isinstance(event[field], list):
            errors.append(f"{prefix}: '{field}' must be a list.")
    if "features" in event and not isinstance(event["features"], dict):
        errors.append(f"{prefix}: 'features' must be an object.")

    assertion_level = event.get("assertion_level")
    if assertion_level is not None and assertion_level not in {"observation", "hypothesis", "assertion"}:
        errors.append(f"{prefix}: invalid assertion_level '{assertion_level}'.")

    # Validate timestamp fields
    if "time_range_ms" in event:
        tr = event["time_range_ms"]
        if not isinstance(tr, list) or len(tr) != 2:
            errors.append(f"{prefix}: 'time_range_ms' must be a 2-element list.")
        else:
            if not isinstance(tr[0], (int, float)) or not isinstance(tr[1], (int, float)):
                errors.append(f"{prefix}: 'time_range_ms' elements must be numbers.")
            elif tr[0] > tr[1]:
                errors.append(f"{prefix}: 'time_range_ms' start ({tr[0]}) > end ({tr[1]}).")
    else:
        ts = event.get("timestamp_start")
        te = event.get("timestamp_end")
        if ts is not None and te is not None:
            if isinstance(ts, (int, float)) and isinstance(te, (int, float)):
                if ts > te:
                    errors.append(f"{prefix}: 'timestamp_start' ({ts}) > 'timestamp_end' ({te}).")


def _validate_constraints(
    constraints: Dict[str, Any], errors: List[str], warnings: List[str]
) -> None:
    """Validate the constraints object."""
    missing_keys = CONSTRAINTS_REQUIRED_KEYS - set(constraints.keys())
    for key in sorted(missing_keys):
        errors.append(f"constraints: missing required key '{key}'.")

    # Verify boolean values for known keys
    for key in CONSTRAINTS_REQUIRED_KEYS:
        if key in constraints and not isinstance(constraints[key], bool):
            warnings.append(f"constraints: '{key}' should be a boolean, got {type(constraints[key]).__name__}.")


# ── Metrics ────────────────────────────────────────────────────────────────────

def compute_metrics(data: Dict[str, Any], file_size: int) -> Dict[str, Any]:
    """Compute field scale metrics for the package."""
    metrics: Dict[str, Any] = {
        "file_size_bytes": file_size,
    }

    # Count semantic events
    se = data.get("semantic_events")
    if isinstance(se, list):
        metrics["semantic_event_count"] = len(se)

    # Count captions
    cs = data.get("compact_caption_summary")
    if isinstance(cs, list):
        metrics["caption_count"] = len(cs)

    # Count object states
    os_list = data.get("relevant_object_states")
    if isinstance(os_list, list):
        metrics["object_state_count"] = len(os_list)

    # Count evidence refs
    er = data.get("evidence_refs")
    if isinstance(er, list):
        metrics["evidence_ref_count"] = len(er)

    # Transcript length
    transcript = data.get("transcript")
    if isinstance(transcript, str):
        metrics["transcript_char_count"] = len(transcript)

    return metrics


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> int:
    """CLI entry point. Returns exit code."""
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <compact_prompt_package.json>", file=sys.stderr)
        return 2

    filepath = sys.argv[1]

    # Resolve path
    filepath = os.path.expanduser(filepath)
    filepath = os.path.abspath(filepath)

    if not os.path.isfile(filepath):
        print(f"ERROR: File not found: {filepath}", file=sys.stderr)
        return 2

    # Read and parse
    try:
        file_size = os.path.getsize(filepath)
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"ERROR: Failed to read file: {e}", file=sys.stderr)
        return 2

    # Validate
    errors, warnings = validate_package(data)
    metrics = compute_metrics(data, file_size)

    # Determine pass/fail
    passed = len(errors) == 0

    # Output
    print("=" * 60)
    print("Compact Prompt Package Validator")
    print("=" * 60)
    print(f"File: {os.path.basename(filepath)}")
    print()

    if passed:
        print("Result: PASS ✓")
    else:
        print("Result: FAIL ✗")
    print()

    # Errors
    if errors:
        print(f"Errors ({len(errors)}):")
        for err in errors:
            print(f"  ✗ {err}")
        print()

    # Warnings
    if warnings:
        print(f"Warnings ({len(warnings)}):")
        for warn in warnings:
            print(f"  ⚠ {warn}")
        print()

    # Metrics
    print("Package Metrics:")
    for key, value in sorted(metrics.items()):
        print(f"  {key}: {value}")
    print()

    print("=" * 60)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
