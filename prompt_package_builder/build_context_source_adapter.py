#!/usr/bin/env python3
"""Project existing review/round inputs into the MCPack-01 envelope.

This module is intentionally a one-way boundary adapter.  It accepts the
source packages that already exist in the Canvas Prompt project, projects
their bounded evidence into the existing ``compact_package`` / Process IR
input shape, and delegates the final envelope construction to
``build_minimal_context_pack``.  It does not create a new package identity,
semantic relation vocabulary, archive reader, or write path.

The adapter is deliberately conservative:

* Artifact Review pages are page evidence, not a Canvas snapshot.  The source
  package therefore does not open the MCPack-02 visual-answer gate on its own.
* Interaction Review DOM/state observations are kept as route/viewport
  observations.  They never become Canvas semantic relations or execution.
* Only an explicit confirmation record can become a confirmation claim.
  ``unique_evidence``, ``candidate`` and ``proposal-only`` remain unresolved or
  compiler-candidate layers.
* The complete source package is never copied into the resulting envelope.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path
from typing import Any

try:  # package imports
    from .browser_package_to_fixture import normalized_captions, normalized_events, raw_objects
    from .build_compact_package import build_compact_caption_summary
    from .build_minimal_context_pack import (
        HARD_TEXT_TOKENS,
        _budget as _minimal_budget,
        build_minimal_context_pack,
    )
    from .process_ir import compile_process_ir
except ImportError:  # existing script-style imports
    from browser_package_to_fixture import normalized_captions, normalized_events, raw_objects
    from build_compact_package import build_compact_caption_summary
    from build_minimal_context_pack import HARD_TEXT_TOKENS, _budget as _minimal_budget, build_minimal_context_pack
    from process_ir import compile_process_ir


CONTRACT = "canvas-prompt/minimal-context-source-adapter/0.1-draft"
ADAPTER_VERSION = "0.1-draft"
SUPPORTED_INPUT_KINDS = frozenset({"artifact_review", "interaction_review", "canvas_round"})
_SOURCE_KIND_ALIASES = {
    "artifact-review": "artifact_review",
    "interaction-review": "interaction_review",
    "canvas-round": "canvas_round",
    "canvas": "canvas_round",
}
ARTIFACT_REVIEW_SCHEMA = "artifact-review/0.2-draft"
INTERACTION_REVIEW_DRAFT_SCHEMA = "interaction-review/0.1-draft"
INTERACTION_REVIEW_I0_SCHEMA = "interaction-review-package/0.1"
CANVAS_COMPACT_SCHEMA = "compact_timeline_aware"

_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _items(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _text(value: Any, limit: int = 280) -> str:
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    return " ".join(value.split())[:limit]


def _strings(value: Any, limit: int = 32) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    if not isinstance(value, list):
        return result
    for item in value:
        if not isinstance(item, str) or not item or item in seen:
            continue
        result.append(item)
        seen.add(item)
        if len(result) >= limit:
            break
    return result


def _safe_relative_path(value: Any) -> str | None:
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value:
        return None
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return None
    return value[:160]


def _safe_state_observation(value: Any, *, identifier: str | None = None) -> dict[str, Any] | None:
    state = _record(value)
    if not state:
        return None
    nested_state = _record(state.get("state"))
    state_for_keys = nested_state or state
    result: dict[str, Any] = {}
    if identifier:
        result["id"] = identifier
    route = state.get("route")
    if isinstance(route, str) and re.fullmatch(r"/[A-Za-z0-9/_-]*", route):
        result["route"] = route
    title = state.get("title", nested_state.get("title"))
    if isinstance(title, str):
        result["title"] = _text(title, 120)
    scroll = _record(state.get("scroll", nested_state.get("scroll")))
    if all(_number(scroll.get(key)) is not None for key in ("x", "y")):
        result["scroll"] = {"x": scroll["x"], "y": scroll["y"]}
    result["state_keys"] = sorted(
        key for key in state_for_keys
        if isinstance(key, str) and key not in {"title", "scroll"} and _ID_RE.match(key)
    )[:24]
    return result


def _number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _hash(value: Any) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) else None


def _package_id(value: Any) -> str:
    package_id = _record(value).get("package_id")
    if not isinstance(package_id, str) or not package_id:
        raise ValueError("source package must carry its existing package_id")
    return package_id


def _schema(value: Any) -> str | None:
    record = _record(value)
    raw = record.get("schema_version", record.get("schema"))
    return raw if isinstance(raw, str) and raw else None


def detect_context_source(value: Any) -> str:
    """Return the supported source kind without changing the input."""
    record = _record(value)
    if isinstance(record.get("compact_package"), dict) and isinstance(record.get("process_ir"), dict):
        return "canvas_round"
    if isinstance(record.get("compact"), dict) and isinstance(record.get("process_ir"), dict):
        return "canvas_round"
    schema = _schema(record)
    if schema == ARTIFACT_REVIEW_SCHEMA:
        return "artifact_review"
    if schema in {INTERACTION_REVIEW_DRAFT_SCHEMA, INTERACTION_REVIEW_I0_SCHEMA}:
        return "interaction_review"
    # A raw exported Canvas round is the current bridge input.  Its exact
    # schema is owned by the existing export/compiler path, so detect only the
    # stable fields and leave the original package untouched.
    if isinstance(record.get("transcript"), dict) and (
        isinstance(record.get("meta"), dict)
        or isinstance(record.get("timeline"), list)
        or isinstance(record.get("objects"), list)
    ):
        return "canvas_round"
    raise ValueError("unsupported context source package schema")


def _assert_kind(value: Any, source_kind: str | None) -> str:
    detected = detect_context_source(value)
    normalized = _SOURCE_KIND_ALIASES.get(source_kind, source_kind)
    if normalized is not None and normalized != detected:
        raise ValueError(f"source_kind {source_kind!r} does not match detected {detected!r}")
    return detected


def _assert_execution_false(value: Any, *, path: str = "source") -> None:
    record = _record(value)
    if record.get("execution_authorized") is True:
        raise ValueError(f"{path}.execution_authorized cannot be true")
    review_state = _record(record.get("review_state"))
    if review_state.get("execution_authorized") is True:
        raise ValueError(f"{path}.review_state.execution_authorized cannot be true")
    agent_boundary = record.get("agent_boundary")
    if agent_boundary and agent_boundary != "Agent may propose changes only. Prototype mutation requires explicit per-proposal confirmation.":
        # The formal I0 package has a fixed boundary.  A different value is a
        # semantic upgrade attempt, so fail closed instead of normalizing it.
        if _schema(record) == INTERACTION_REVIEW_I0_SCHEMA:
            raise ValueError("Interaction Review agent_boundary is unsupported")


def _time_window(item: dict[str, Any], *keys: str) -> list[int | float] | None:
    for key in keys:
        value = item.get(key)
        if _number(value) is not None:
            return [value, value]
        if isinstance(value, dict):
            start, end = _number(value.get("start_ms")), _number(value.get("end_ms"))
            if start is not None and end is not None:
                return [start, max(start, end)]
        if isinstance(value, (list, tuple)) and len(value) == 2:
            start, end = _number(value[0]), _number(value[1])
            if start is not None and end is not None:
                return [start, max(start, end)]
    timestamp = _number(item.get("timestamp_ms", item.get("at_ms")))
    return [timestamp, timestamp] if timestamp is not None else None


def _bounds_from_region(region: Any) -> dict[str, float] | None:
    region = _record(region)
    ratio_keys = ("x_ratio", "y_ratio", "width_ratio", "height_ratio")
    if all(_number(region.get(key)) is not None for key in ratio_keys):
        return {
            "x": float(region["x_ratio"]),
            "y": float(region["y_ratio"]),
            "width": float(region["width_ratio"]),
            "height": float(region["height_ratio"]),
        }
    if all(_number(region.get(key)) is not None for key in ("x", "y", "width", "height")):
        return {key: float(region[key]) for key in ("x", "y", "width", "height")}
    return None


def _bounds_from_points(points: Any) -> dict[str, float] | None:
    valid = [
        point for point in (points if isinstance(points, list) else [])
        if _number(_record(point).get("x", _record(point).get("x_ratio"))) is not None
        and _number(_record(point).get("y", _record(point).get("y_ratio"))) is not None
    ]
    if not valid:
        return None
    xs = [float(_record(point).get("x", _record(point).get("x_ratio"))) for point in valid]
    ys = [float(_record(point).get("y", _record(point).get("y_ratio"))) for point in valid]
    return {
        "x": max(0.0, min(xs)),
        "y": max(0.0, min(ys)),
        "width": max(0.002, max(xs) - min(xs)),
        "height": max(0.002, max(ys) - min(ys)),
    }


def _bounded_snapshot(value: Any) -> dict[str, Any] | None:
    snapshot = _record(value)
    if not snapshot:
        return None
    # Only the availability/format box is allowed into the MCPack builder.
    # URLs, inline payloads and source bytes are intentionally dropped.
    if snapshot.get("availability") == "unavailable" or snapshot.get("note") == "snapshot not found":
        return None
    result: dict[str, Any] = {"availability": "available"}
    for key in ("format", "content_type"):
        if isinstance(snapshot.get(key), str) and snapshot[key]:
            result[key] = snapshot[key]
    for key in ("width", "height"):
        if _number(snapshot.get(key)) is not None:
            result[key] = snapshot[key]
    return result


def _source_ir(package_id: str, *, artifact: dict[str, Any] | None = None, artifact_id: str | None = None,
               source_version_id: str | None = None, source_sha256: str | None = None,
               page_normalized_v1: bool | None = None) -> dict[str, Any]:
    source: dict[str, Any] = {"package_id": package_id}
    artifact = artifact or {}
    artifact_id = artifact_id or (artifact.get("artifact_id") if isinstance(artifact.get("artifact_id"), str) else None)
    source_version_id = source_version_id or (artifact.get("source_version_id") if isinstance(artifact.get("source_version_id"), str) else None)
    source_sha256 = source_sha256 or _hash(artifact.get("source_sha256"))
    if artifact_id:
        source["artifact_id"] = artifact_id
    if source_version_id:
        source["source_version_id"] = source_version_id
    if source_sha256:
        source["source_sha256"] = source_sha256
    if page_normalized_v1 is not None:
        source["page_normalized_v1"] = page_normalized_v1
    return source


def _canonical_compact(package_id: str, schema: str, *, version: str | None = None,
                       captions: list[dict[str, Any]] | None = None,
                       snapshot: dict[str, Any] | None = None,
                       round_id: str | None = None,
                       source: dict[str, Any] | None = None) -> dict[str, Any]:
    compact: dict[str, Any] = {
        "meta": {
            "format": CANVAS_COMPACT_SCHEMA,
            "package_id": package_id,
            "version": version or schema,
        },
        "compact_caption_summary": build_compact_caption_summary(captions or []),
        "process_ir_summary": {"source_provenance": {"package_id": package_id}},
    }
    if snapshot:
        compact["final_canvas_snapshot"] = snapshot
    if round_id:
        compact["round_id"] = round_id
    if source:
        compact["process_ir_summary"]["source_provenance"].update({
            key: value for key, value in source.items()
            if key in {"content_sha256", "compiler_version", "package_id", "round_kind"} and value not in (None, "")
        })
    return compact


def _annotation_spatial_map(annotation_id: str, *, coordinate_space: str,
                            page_id: str | None = None, route: str | None = None) -> dict[str, Any]:
    info: dict[str, Any] = {"coordinate_space": coordinate_space}
    if page_id:
        info["page_id"] = page_id
    if route:
        info["route"] = route
    return info


def _artifact_review_inputs(value: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    _assert_execution_false(value)
    if _record(value.get("review_state")).get("execution_authorized") is not False:
        raise ValueError("Artifact Review review_state.execution_authorized must be false")
    package_id = _package_id(value)
    if _schema(value) != ARTIFACT_REVIEW_SCHEMA:
        raise ValueError("unsupported Artifact Review schema")
    artifact = _record(value.get("artifact"))
    artifact_id = artifact.get("artifact_id")
    source_version_id = artifact.get("source_version_id")
    source_sha256 = _hash(artifact.get("source_sha256"))
    pages = _items(value.get("pages"))
    if not isinstance(artifact_id, str) or not artifact_id or not isinstance(source_version_id, str) or not source_sha256:
        raise ValueError("Artifact Review artifact identity is incomplete")
    if source_version_id.startswith("/") or "://" in source_version_id:
        raise ValueError("Artifact Review source_version_id cannot be a path or URL")
    if not pages:
        raise ValueError("Artifact Review must contain at least one page")
    if _number(artifact.get("page_count")) != len(pages):
        raise ValueError("Artifact Review page_count must match the exported page list")
    if artifact.get("read_only") is not True:
        raise ValueError("Artifact Review source must remain read_only")
    if _record(value.get("privacy")).get("source_bytes_in_export") is not False:
        raise ValueError("Artifact Review source bytes must stay out of the export")
    pages_by_id = {item.get("page_id"): item for item in pages if isinstance(item.get("page_id"), str)}
    if len(pages_by_id) != len(pages):
        raise ValueError("Artifact Review page IDs must be unique")
    voice = _items(value.get("voice_segments"))
    captions: list[dict[str, Any]] = []
    caption_ids: set[str] = set()
    for index, segment in enumerate(voice):
        segment_id = segment.get("segment_id")
        if not isinstance(segment_id, str) or not segment_id or segment_id in caption_ids:
            raise ValueError("Artifact Review voice segment IDs must be unique")
        start, end = _number(segment.get("start_ms")), _number(segment.get("end_ms"))
        if start is None or end is None or end < start:
            raise ValueError("Artifact Review voice segment time window is invalid")
        caption_ids.add(segment_id)
        captions.append({
            "caption_id": segment_id,
            "start_ms": start,
            "end_ms": end,
            "text": _text(segment.get("text")),
        })
    annotations = _items(value.get("annotations"))
    evidence = _items(value.get("evidence"))
    evidence_by_id = {item.get("evidence_id"): item for item in evidence if isinstance(item.get("evidence_id"), str)}
    confirmation_by_annotation: dict[str, list[str]] = {}
    for item in evidence:
        if item.get("kind") != "clarification_response":
            continue
        annotation_id = item.get("annotation_id")
        evidence_id = item.get("evidence_id")
        if isinstance(annotation_id, str) and isinstance(evidence_id, str):
            confirmation_by_annotation.setdefault(annotation_id, []).append(evidence_id)

    objects: list[dict[str, Any]] = []
    spatial_map: dict[str, dict[str, Any]] = {}
    candidate_sources: dict[str, list[str]] = {}
    event_sources: dict[str, list[str]] = {}
    circle_index = 0
    relation_index = 0
    for annotation in annotations:
        annotation_id = annotation.get("annotation_id")
        page_id = annotation.get("page_id")
        if not isinstance(annotation_id, str) or not annotation_id or page_id not in pages_by_id:
            raise ValueError("Artifact Review annotation identity is invalid")
        page = pages_by_id[page_id]
        page_number = page.get("page_number")
        bounds = _bounds_from_region(annotation.get("region"))
        object_id = annotation_id
        objects.append({
            "object_id": object_id,
            "object_type": f"artifact_{annotation.get('kind', 'ink')}_annotation",
            "label": f"第 {page_number} 页 {annotation.get('kind', 'ink')} 标注",
            "bounds": bounds,
            "time_range_ms": _time_window(annotation, "created_at_ms"),
            "coordinate_space": "page_normalized_v1",
            "page_id": page_id,
        })
        spatial_map[object_id] = _annotation_spatial_map(object_id, coordinate_space="page_normalized_v1", page_id=page_id)
        original_evidence_ids = _strings(annotation.get("evidence_ids"), 8)
        event_sources[f"/objects/{len(objects) - 1}"] = original_evidence_ids
        if annotation.get("kind") == "circle":
            candidate_sources[f"/ink_circle_candidates/{circle_index}"] = original_evidence_ids
            circle_index += 1
        else:
            candidate_sources[f"/ink_relation_candidates/{relation_index}"] = original_evidence_ids
            relation_index += 1
        if annotation_id in confirmation_by_annotation:
            event_id = f"artifact_confirmation_{annotation_id}"
            event_sources[f"/canvas_events/{event_id}"] = confirmation_by_annotation[annotation_id]

    circle_candidates: list[dict[str, Any]] = []
    relation_candidates: list[dict[str, Any]] = []
    semantic_events: list[dict[str, Any]] = []
    for annotation in annotations:
        annotation_id = str(annotation.get("annotation_id"))
        page = pages_by_id.get(annotation.get("page_id"), {})
        page_number = page.get("page_number")
        bounds = _bounds_from_region(annotation.get("region"))
        original_evidence_ids = _strings(annotation.get("evidence_ids"), 8)
        voice_ids = _strings(_record(annotation.get("voice_window")).get("transcript_segment_ids"), 4)
        geometry = {"bounds": bounds, "coordinate_space": "page_normalized_v1", "page_id": annotation.get("page_id")}
        if annotation.get("kind") == "circle":
            circle_candidates.append({
                "circle_id": annotation_id,
                "stroke_id": annotation_id,
                "candidate_object_ids": [],
                "geometry": geometry,
                "timestamp_ms": annotation.get("created_at_ms", 0),
                "evidence_sources": original_evidence_ids,
            })
        else:
            relation_candidates.append({
                "relation_id": annotation_id,
                "stroke_id": annotation_id,
                "endpoint_candidates": {},
                "geometry": geometry,
                "temporal_evidence": {
                    **({"anchor_timestamps_ms": _time_window(annotation, "created_at_ms")} if _time_window(annotation, "created_at_ms") else {})
                },
                "evidence_sources": original_evidence_ids,
            })
        annotation_evidence_ids = set(_strings(annotation.get("evidence_ids"), 8))
        confirmation_ids = [
            evidence_id for evidence_id in confirmation_by_annotation.get(annotation_id, [])
            if evidence_id in annotation_evidence_ids
        ]
        # binding_status is deliberately insufficient on its own.  The
        # clarification_response evidence is the explicit confirmation gate.
        if annotation.get("binding_status") == "confirmed" and confirmation_ids:
            semantic_events.append({
                # Reuse the existing generic Process IR confirmation event
                # shape; the source-specific detail remains in summary and
                # evidence, so the adapter does not define a new relation DSL.
                "type": "confirm",
                "summary": f"用户明确确认第 {page_number} 页的 {annotation_id} 标注。",
                "source_caption_ids": voice_ids,
                "source_canvas_event_ids": [f"artifact_confirmation_{annotation_id}"],
                "involved_object_ids": [annotation_id],
                "assertion_level": "assertion",
                "evidence": confirmation_ids,
            })

    reference_candidates: list[dict[str, Any]] = []
    reference_sources: dict[str, list[str]] = {}
    annotations_by_id = {item.get("annotation_id"): item for item in annotations}
    for index, resolution in enumerate(_items(value.get("reference_resolutions"))):
        voice_id = resolution.get("voice_segment_id")
        if not isinstance(voice_id, str):
            continue
        annotation_id = resolution.get("annotation_id")
        candidate_objects = []
        if isinstance(annotation_id, str) and annotation_id in annotations_by_id:
            candidate_objects.append({"object_id": annotation_id, "distance": None})
        reference_candidates.append({
            "reference_id": resolution.get("resolution_id") or f"ref_{index + 1:03d}",
            "caption_id": voice_id,
            "time_range_ms": next((
                [item["start_ms"], item["end_ms"]] for item in captions if item["caption_id"] == voice_id
            ), None),
            "candidate_objects": candidate_objects,
            "resolution_status": "unresolved",
            "evidence_sources": _strings(resolution.get("evidence_ids"), 8),
        })
        reference_sources[f"/reference_candidates/{index}"] = _strings(resolution.get("evidence_ids"), 8)

    process_ir = {
        "source": _source_ir(
            package_id,
            artifact_id=artifact_id,
            source_version_id=source_version_id,
            source_sha256=source_sha256,
            page_normalized_v1=True,
        ),
        "speech_anchors": captions,
        "objects": objects,
        "spatial_relations": [],
        "reference_candidates": reference_candidates,
        "ink_relation_candidates": relation_candidates,
        "ink_circle_candidates": circle_candidates,
        "ink_annotation_candidates": [],
        "semantic_events": semantic_events,
        "ocr_observations": [],
        "quality": {"ink_trace": {"geometry_status": "available" if annotations else "unavailable"}},
    }
    compact = _canonical_compact(
        package_id,
        ARTIFACT_REVIEW_SCHEMA,
        captions=captions,
        source={"package_id": package_id},
    )
    metadata = {
        "input_kind": "artifact_review",
        "input_schema_version": ARTIFACT_REVIEW_SCHEMA,
        "input_artifact_kind": artifact.get("artifact_kind"),
        "input_page_count": len(pages),
        "input_coordinate_space": "page_normalized_v1",
        "input_read_only": True,
        "input_source_bytes_in_export": False,
        "input_evidence_ids": _strings(list(evidence_by_id), 24),
        "spatial_map": spatial_map,
        "source_evidence_map": {**candidate_sources, **event_sources, **reference_sources},
    }
    return compact, process_ir, metadata


def _interaction_common_source(value: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
    package_id = _package_id(value)
    schema = _schema(value)
    if schema not in {INTERACTION_REVIEW_DRAFT_SCHEMA, INTERACTION_REVIEW_I0_SCHEMA}:
        raise ValueError("unsupported Interaction Review schema")
    _assert_execution_false(value)
    return package_id, _record(value), schema or ""


def _interaction_draft_inputs(value: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    package_id, value, schema = _interaction_common_source(value)
    if value.get("execution_authorized") is not False:
        raise ValueError("Interaction Review execution_authorized must be false")
    source = _record(value.get("source"))
    if source.get("kind") != "local-static-html" or source.get("source_bytes_in_export") is not False:
        raise ValueError("Interaction Review source must be local-static-html and source-byte-free")
    if _record(value.get("privacy")).get("processing") != "local_only":
        raise ValueError("Interaction Review must remain local_only")
    captions: list[dict[str, Any]] = []
    for segment in _items(value.get("transcript")):
        segment_id = segment.get("segment_id")
        text = _text(segment.get("text"))
        start, end = _number(segment.get("start_ms")), _number(segment.get("end_ms"))
        if not isinstance(segment_id, str) or not segment_id or not text or start is None or end is None or end < start:
            raise ValueError("Interaction Review transcript segment is invalid")
        captions.append({"caption_id": segment_id, "start_ms": start, "end_ms": end, "text": text})
    objects: list[dict[str, Any]] = []
    spatial_map: dict[str, dict[str, Any]] = {}
    event_sources: dict[str, list[str]] = {}
    element_ids: set[str] = set()
    for index, event in enumerate(_items(value.get("events"))):
        target = _record(event.get("target"))
        element_id = target.get("element_id")
        if not isinstance(element_id, str) or not element_id:
            continue
        object_id = f"interaction_target_{element_id}"
        if object_id in element_ids:
            continue
        element_ids.add(object_id)
        rect = _record(target.get("rect"))
        bounds = {
            key: float(rect[key]) for key in ("x", "y", "width", "height")
        } if all(_number(rect.get(key)) is not None for key in ("x", "y", "width", "height")) else None
        objects.append({
            "object_id": object_id,
            "object_type": "interaction_target",
            "label": _text(target.get("label"), 100) or element_id,
            "bounds": bounds,
            "time_range_ms": _time_window(event, "at_ms"),
            "coordinate_space": "interaction_viewport_v1",
            "route": event.get("route"),
            "source_event_id": event.get("id"),
        })
        spatial_map[object_id] = _annotation_spatial_map(object_id, coordinate_space="interaction_viewport_v1", route=event.get("route"))
        if isinstance(event.get("id"), str):
            event_sources[f"/objects/{len(objects) - 1}"] = [event["id"]]

    annotations = _items(value.get("annotations"))
    circle_candidates: list[dict[str, Any]] = []
    relation_candidates: list[dict[str, Any]] = []
    for annotation in annotations:
        annotation_id = annotation.get("id")
        if not isinstance(annotation_id, str) or not annotation_id:
            continue
        object_id = f"interaction_annotation_{annotation_id}"
        bounds = _bounds_from_points(annotation.get("points"))
        objects.append({
            "object_id": object_id,
            "object_type": f"interaction_{annotation.get('kind', 'ink')}_annotation",
            "label": f"网页审阅 {annotation.get('kind', 'ink')} 标注",
            "bounds": bounds,
            "time_range_ms": _time_window(annotation, "created_at_ms"),
            "coordinate_space": "interaction_viewport_v1",
        })
        spatial_map[object_id] = _annotation_spatial_map(object_id, coordinate_space="interaction_viewport_v1")
        geometry = {"bounds": bounds, "coordinate_space": "interaction_viewport_v1"}
        if annotation.get("kind") == "circle":
            circle_candidates.append({"circle_id": annotation_id, "stroke_id": annotation_id, "candidate_object_ids": [], "geometry": geometry, "timestamp_ms": annotation.get("created_at_ms", 0)})
        else:
            relation_candidates.append({
                "relation_id": annotation_id,
                "stroke_id": annotation_id,
                "endpoint_candidates": {},
                "geometry": geometry,
                "temporal_evidence": {
                    **({"anchor_timestamps_ms": _time_window(annotation, "created_at_ms")} if _time_window(annotation, "created_at_ms") else {})
                },
            })
        spatial_map[annotation_id] = spatial_map[object_id]

    process_ir = {
        "source": _source_ir(package_id, source_sha256=_hash(source.get("sha256"))),
        "speech_anchors": captions,
        "objects": objects,
        "spatial_relations": [],
        "reference_candidates": [],
        "ink_relation_candidates": relation_candidates,
        "ink_circle_candidates": circle_candidates,
        "ink_annotation_candidates": [],
        "semantic_events": [],
        "ocr_observations": [],
        "quality": {"ink_trace": {"geometry_status": "available" if annotations else "unavailable"}},
    }
    compact = _canonical_compact(
        package_id,
        schema,
        captions=captions,
        source={"package_id": package_id},
    )
    session = _record(value.get("session"))
    state_observations = [
        observation for observation in (
            _safe_state_observation(event.get("state"), identifier=event.get("id"))
            for event in _items(value.get("events"))
        ) if observation
    ][:24]
    metadata = {
        "input_kind": "interaction_review",
        "input_schema_version": schema,
        "input_source_kind": source.get("kind"),
        "input_source_name": _text(source.get("name"), 120),
        "input_entry_path": _safe_relative_path(source.get("entry_path")),
        "input_source_sha256": _hash(source.get("sha256")),
        "input_coordinate_space": "interaction_viewport_v1",
        "input_capture_scope": session.get("capture_scope"),
        "input_event_count": len(_items(value.get("events"))),
        "input_annotation_count": len(annotations),
        "input_route_count": len({event.get("route") for event in _items(value.get("events")) if isinstance(event.get("route"), str)}),
        "input_state_observations": state_observations,
        "input_source_bytes_in_export": False,
        "spatial_map": spatial_map,
        "source_evidence_map": event_sources,
    }
    return compact, process_ir, metadata


def _interaction_i0_inputs(value: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    package_id, value, schema = _interaction_common_source(value)
    capture = _record(value.get("capture"))
    artifact = _record(value.get("artifact"))
    session_id = capture.get("session_id")
    if not isinstance(session_id, str) or package_id != f"irp_{session_id}":
        raise ValueError("Interaction Review package_id must preserve capture.session_id lineage")
    source_version = artifact.get("source_version")
    if isinstance(source_version, str) and (source_version.startswith("/") or "://" in source_version):
        raise ValueError("Interaction Review source_version cannot be a path or URL")
    if value.get("agent_boundary") != "Agent may propose changes only. Prototype mutation requires explicit per-proposal confirmation.":
        raise ValueError("Interaction Review agent_boundary must remain proposal-only")
    if capture.get("mode") != "explicit-review-session" or capture.get("background_monitoring") is not False:
        raise ValueError("Interaction Review capture must be explicit and foreground-only")
    privacy = _record(capture.get("privacy"))
    if privacy.get("sensitive_fields") != "excluded-by-default" or privacy.get("audio") != "not-captured":
        raise ValueError("Interaction Review sensitive fields/audio policy is unsupported")
    routes = _strings(capture.get("allowed_routes"), 32)
    if not routes or any(not re.fullmatch(r"/[A-Za-z0-9/_-]*", route) for route in routes):
        raise ValueError("Interaction Review must declare a route allowlist")
    events = _items(value.get("events"))
    snapshots = _record(value.get("snapshots"))
    evidence = _items(value.get("evidence"))
    evidence_by_id = {item.get("id"): item for item in evidence if isinstance(item.get("id"), str)}
    feedback = _items(value.get("feedback"))
    proposals = _items(value.get("proposals"))
    captions: list[dict[str, Any]] = []
    for feedback_item in feedback:
        feedback_id = feedback_item.get("id")
        window = _record(feedback_item.get("time_window"))
        text = _text(feedback_item.get("text"))
        start, end = _number(window.get("start_ms")), _number(window.get("end_ms"))
        if not isinstance(feedback_id, str) or not text or start is None or end is None or end < start:
            raise ValueError("Interaction Review feedback is invalid")
        captions.append({"caption_id": feedback_id, "start_ms": start, "end_ms": end, "text": text})

    objects: list[dict[str, Any]] = []
    spatial_map: dict[str, dict[str, Any]] = {}
    source_evidence_map: dict[str, list[str]] = {}
    seen_objects: set[str] = set()
    for event in events:
        element_id = event.get("element_id")
        if not isinstance(element_id, str) or not element_id:
            continue
        object_id = f"interaction_target_{element_id}"
        object_index = None
        if object_id not in seen_objects:
            seen_objects.add(object_id)
            object_index = len(objects)
            objects.append({
                "object_id": object_id,
                "object_type": "interaction_target",
                "label": element_id,
                "bounds": None,
                "time_range_ms": _time_window(event, "at_ms"),
                "coordinate_space": "interaction_route_v1",
                "route": event.get("route"),
                "source_event_id": event.get("id"),
            })
            spatial_map[object_id] = _annotation_spatial_map(object_id, coordinate_space="interaction_route_v1", route=event.get("route"))
        evidence_ids = [
            item_id for item_id, item in evidence_by_id.items()
            if item.get("kind") == "interaction_event" and item.get("event_id") == event.get("id")
        ]
        if object_index is not None:
            source_evidence_map[f"/objects/{object_index}"] = evidence_ids

    semantic_events: list[dict[str, Any]] = []
    reference_candidates: list[dict[str, Any]] = []
    for feedback_item in feedback:
        feedback_id = str(feedback_item.get("id"))
        anchor = _record(feedback_item.get("anchor"))
        binding = anchor.get("binding")
        evidence_ids = _strings(feedback_item.get("evidence_ids"), 8)
        target_id = anchor.get("element_id")
        target_object_id = f"interaction_target_{target_id}" if isinstance(target_id, str) and target_id else None
        if binding == "confirmed" and _record(feedback_item.get("confirmation")).get("status") == "confirmed-by-reviewer" and target_object_id:
            semantic_events.append({
                "type": "confirm",
                "summary": f"用户确认网页反馈 {feedback_id} 绑定到 {target_id}。",
                "source_caption_ids": [feedback_id],
                "source_canvas_event_ids": [f"interaction_feedback_{feedback_id}"],
                "involved_object_ids": [target_object_id],
                "assertion_level": "assertion",
                "evidence": evidence_ids,
            })
            source_evidence_map[f"/canvas_events/interaction_feedback_{feedback_id}"] = evidence_ids
        elif binding == "ambiguous":
            reference_candidates.append({
                "reference_id": feedback_id,
                "caption_id": feedback_id,
                "time_range_ms": [feedback_item["time_window"]["start_ms"], feedback_item["time_window"]["end_ms"]],
                "candidate_objects": [],
                "resolution_status": "unresolved",
                "evidence_sources": evidence_ids,
            })
            source_evidence_map[f"/reference_candidates/{len(reference_candidates) - 1}"] = evidence_ids

    for proposal in proposals:
        proposal_id = proposal.get("id")
        if not isinstance(proposal_id, str):
            continue
        proposal_evidence = _strings(proposal.get("evidence_ids"), 8)
        feedback_ids = [
            _record(evidence_by_id.get(evidence_id)).get("feedback_id")
            for evidence_id in proposal_evidence
            if _record(evidence_by_id.get(evidence_id)).get("kind") == "feedback"
        ]
        confirmation_status = _record(proposal.get("confirmation")).get("status")
        if confirmation_status in {"accepted", "rejected"}:
            action = "接受" if confirmation_status == "accepted" else "拒绝"
            semantic_events.append({
                "type": "confirm",
                "summary": f"用户明确{action}网页审阅提案 {proposal_id}：{_text(proposal.get('title'), 120)}",
                "source_caption_ids": [item for item in feedback_ids if isinstance(item, str)],
                "source_canvas_event_ids": [f"interaction_proposal_{proposal_id}"],
                "involved_object_ids": [],
                "assertion_level": "assertion",
                "evidence": proposal_evidence,
            })
        else:
            semantic_events.append({
                "type": "proposal",
                "summary": f"网页审阅提案 {proposal_id}：{_text(proposal.get('title'), 120)}",
                "source_caption_ids": [item for item in feedback_ids if isinstance(item, str)],
                "source_canvas_event_ids": [f"interaction_proposal_{proposal_id}"],
                "involved_object_ids": [],
                "assertion_level": "hypothesis",
                "evidence": proposal_evidence,
            })
        source_evidence_map[f"/canvas_events/interaction_proposal_{proposal_id}"] = proposal_evidence

    process_ir = {
        "source": _source_ir(
            package_id,
            artifact_id=artifact.get("artifact_id") if isinstance(artifact.get("artifact_id"), str) else None,
            source_version_id=artifact.get("source_version") if isinstance(artifact.get("source_version"), str) else None,
        ),
        "speech_anchors": captions,
        "objects": objects,
        "spatial_relations": [],
        "reference_candidates": reference_candidates,
        "ink_relation_candidates": [],
        "ink_circle_candidates": [],
        "ink_annotation_candidates": [],
        "semantic_events": semantic_events,
        "ocr_observations": [],
        "quality": {"ink_trace": {"geometry_status": "unavailable"}},
    }
    compact = _canonical_compact(package_id, schema, captions=captions, round_id=session_id, source={"package_id": package_id})
    snapshot_state_observations = [
        observation for observation in (
            _safe_state_observation(snapshot, identifier=str(snapshot_id))
            for snapshot_id, snapshot in snapshots.items()
        ) if observation
    ][:24]
    metadata = {
        "input_kind": "interaction_review",
        "input_schema_version": schema,
        "input_artifact_kind": artifact.get("kind"),
        "input_adapter_id": artifact.get("adapter_id"),
        "input_source_version": artifact.get("source_version"),
        "input_session_id": session_id,
        "input_allowed_routes": routes,
        "input_coordinate_space": "interaction_route_v1",
        "input_snapshot_ids": sorted(str(key) for key in snapshots.keys())[:24],
        "input_state_observations": snapshot_state_observations,
        "input_event_count": len(events),
        "input_feedback_count": len(feedback),
        "input_proposal_count": len(proposals),
        "input_agent_boundary": "proposal-only",
        "spatial_map": spatial_map,
        "source_evidence_map": source_evidence_map,
    }
    return compact, process_ir, metadata


def _canvas_round_inputs(value: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    # Compiled round boundary: accept both names used by existing local tools.
    if isinstance(value.get("compact_package"), dict) and isinstance(value.get("process_ir"), dict):
        compact = copy.deepcopy(value["compact_package"])
        process_ir = copy.deepcopy(value["process_ir"])
        package_id = _record(compact.get("meta")).get("package_id") or _record(process_ir.get("source")).get("package_id")
        if not isinstance(package_id, str) or not package_id:
            raise ValueError("Canvas round compact/process IR pair lacks package_id")
        process_package_id = _record(process_ir.get("source")).get("package_id")
        compact_package_id = _record(compact.get("meta")).get("package_id")
        if compact_package_id and process_package_id and compact_package_id != process_package_id:
            raise ValueError("Canvas round compact and Process IR package IDs disagree")
        metadata = {
            "input_kind": "canvas_round",
            "input_schema_version": _record(compact.get("meta")).get("format") or CANVAS_COMPACT_SCHEMA,
            "input_shape": "compiled_pair",
        }
        return compact, process_ir, metadata
    if isinstance(value.get("compact"), dict) and isinstance(value.get("process_ir"), dict):
        wrapper = {"compact_package": value["compact"], "process_ir": value["process_ir"]}
        compact, process_ir, metadata = _canvas_round_inputs(wrapper)
        metadata["input_shape"] = "compact_alias_pair"
        return compact, process_ir, metadata

    package = value
    package_id = _record(package.get("meta")).get("package_id") or package.get("package_id")
    if not isinstance(package_id, str) or not package_id:
        raise ValueError("exported Canvas round lacks meta.package_id")
    captions = normalized_captions(package)
    events = normalized_events(package)
    objects = raw_objects(package)
    process_ir = compile_process_ir(package, captions, events, objects)
    meta = _record(package.get("meta"))
    snapshot = _bounded_snapshot(_record(package.get("canvas_snapshot")).get("final"))
    round_id = meta.get("round_id") or package.get("round_id") or package.get("sessionId")
    compact = _canonical_compact(
        package_id,
        CANVAS_COMPACT_SCHEMA,
        version=meta.get("version") if isinstance(meta.get("version"), str) else None,
        captions=captions,
        snapshot=snapshot,
        round_id=str(round_id) if round_id not in (None, "") else None,
        source=process_ir.get("source"),
    )
    metadata = {
        "input_kind": "canvas_round",
        "input_schema_version": CANVAS_COMPACT_SCHEMA,
        "input_shape": "exported_round",
        "input_round_id_source": "existing_export_field" if round_id not in (None, "") else "unavailable",
    }
    return compact, process_ir, metadata


def _canonical_inputs(value: dict[str, Any], source_kind: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    if source_kind == "artifact_review":
        return _artifact_review_inputs(value)
    if source_kind == "interaction_review":
        return _interaction_i0_inputs(value) if _schema(value) == INTERACTION_REVIEW_I0_SCHEMA else _interaction_draft_inputs(value)
    if source_kind == "canvas_round":
        return _canvas_round_inputs(value)
    raise ValueError(f"unsupported context source kind: {source_kind}")


def _patch_spatial_anchors(pack: dict[str, Any], spatial_map: dict[str, dict[str, Any]]) -> None:
    def patch(anchor: Any) -> None:
        if not isinstance(anchor, dict):
            return
        keys = []
        if isinstance(anchor.get("object_id"), str):
            keys.append(anchor["object_id"])
        keys.extend(item for item in anchor.get("object_ids", []) if isinstance(item, str))
        if isinstance(anchor.get("stroke_id"), str):
            keys.append(anchor["stroke_id"])
        info = next((spatial_map[key] for key in keys if key in spatial_map), None)
        if not info:
            return
        anchor["coordinate_space"] = info["coordinate_space"]
        for key in ("page_id", "route"):
            if info.get(key):
                anchor[key] = info[key]

    for collection in (pack.get("claims"), pack.get("relation_candidates"), pack.get("evidence")):
        for item in collection if isinstance(collection, list) else []:
            if isinstance(item, dict):
                patch(item.get("spatial_anchor"))
                for anchor in item.get("spatial_anchors", []) if isinstance(item.get("spatial_anchors"), list) else []:
                    patch(anchor)


def _attach_source_evidence(pack: dict[str, Any], source_evidence_map: dict[str, list[str]]) -> None:
    if not source_evidence_map:
        return
    for evidence in pack.get("evidence", []):
        if not isinstance(evidence, dict):
            continue
        source_ref = evidence.get("source_ref")
        source_ids = source_evidence_map.get(source_ref)
        if source_ids:
            evidence["source_evidence_ids"] = _strings(source_ids, 8)


def _refresh_budget(pack: dict[str, Any]) -> None:
    old_budget = _record(pack.get("budget"))
    without_budget = {key: value for key, value in pack.items() if key != "budget"}
    candidates = pack.get("relation_candidates") if isinstance(pack.get("relation_candidates"), list) else []
    speech_count = sum(
        1 for claim in pack.get("claims", [])
        if isinstance(claim, dict) and claim.get("source_layer") == "user_input"
    )
    budget = _minimal_budget(without_budget, len(candidates), min(10, speech_count))
    if old_budget.get("truncation_reason"):
        budget["truncation_reason"] = old_budget["truncation_reason"]
    pack["budget"] = budget
    if budget.get("text_token_estimate", 0) > HARD_TEXT_TOKENS:
        quality = _record(pack.get("quality"))
        quality["truncated"] = True
        coverage = _record(quality.get("coverage"))
        coverage["truncated"] = True
        quality["coverage"] = coverage
        issues = quality.setdefault("issues", [])
        if "text_budget_truncated" not in issues:
            issues.append("text_budget_truncated")
        quality["overall"] = "degraded" if quality.get("overall") == "complete" else quality.get("overall")
        pack["quality"] = quality
        budget["truncation_reason"] = "adapter_metadata_exceeds_hard_text_budget"


def adapt_context_source(
    value: dict[str, Any],
    process_ir: dict[str, Any] | None = None,
    *,
    source_kind: str | None = None,
    task: dict[str, Any] | None = None,
    context_id: str | None = None,
    parent_context_id: str | None = None,
) -> dict[str, Any]:
    """Build one MCPack-01 envelope from one existing source package."""
    if process_ir is not None:
        if not isinstance(process_ir, dict):
            raise TypeError("process_ir must be a JSON object when supplied")
        value = {"compact_package": value, "process_ir": process_ir}
    if not isinstance(value, dict):
        raise TypeError("context source must be a JSON object")
    detected = _assert_kind(value, source_kind)
    compact, process_ir, metadata = _canonical_inputs(value, detected)
    spatial_map = metadata.pop("spatial_map", {})
    source_evidence_map = metadata.pop("source_evidence_map", {})
    pack = build_minimal_context_pack(
        compact,
        process_ir,
        task=task,
        context_id=context_id,
        parent_context_id=parent_context_id,
    )
    source = _record(pack.get("source"))
    source.update({
        "input_kind": detected,
        "input_schema_version": metadata.pop("input_schema_version", _schema(value) or CANVAS_COMPACT_SCHEMA),
        "adapter_version": ADAPTER_VERSION,
    })
    source.update({key: value for key, value in metadata.items() if value not in (None, "", [], {})})
    pack["source"] = source
    _patch_spatial_anchors(pack, spatial_map)
    _attach_source_evidence(pack, source_evidence_map)
    # Keep the existing immutable source package identity as the sole package
    # identity.  Context IDs remain generated per envelope by MCPack-01.
    if pack.get("package_id") != source.get("package_id"):
        raise ValueError("adapter changed the existing package_id")
    pack["execution_authorized"] = False
    _record(pack.get("constraints"))["execution_authorized"] = False
    _refresh_budget(pack)
    return pack


def adapt_artifact_review_package(value: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    return adapt_context_source(value, source_kind="artifact_review", **kwargs)


def adapt_interaction_review_package(value: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    return adapt_context_source(value, source_kind="interaction_review", **kwargs)


def adapt_canvas_round(value: dict[str, Any], process_ir: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    return adapt_context_source(value, process_ir, source_kind="canvas_round", **kwargs)


# Descriptive aliases make the one-way entry point discoverable to existing
# callers without adding a second protocol or identity.
adapt_artifact_review = adapt_artifact_review_package
adapt_interaction_review = adapt_interaction_review_package
adapt_canvas = adapt_canvas_round
build_context_source_pack = adapt_context_source
build_minimal_context_pack_from_source = adapt_context_source
adapt_source_to_minimal_context_pack = adapt_context_source
adapt = adapt_context_source


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-kind", choices=sorted(SUPPORTED_INPUT_KINDS))
    parser.add_argument("--task-kind", default="understand")
    parser.add_argument("--question", default="Summarize the bounded evidence for this source.")
    parser.add_argument("--context-id")
    parser.add_argument("--parent-context-id")
    args = parser.parse_args(argv)
    try:
        value = read_json(args.input)
        pack = adapt_context_source(
            value,
            source_kind=args.source_kind,
            task={"kind": args.task_kind, "question": args.question},
            context_id=args.context_id,
            parent_context_id=args.parent_context_id,
        )
        write_json(args.output, pack)
        print(json.dumps({"ok": True, "output": str(args.output), "context_id": pack["context_id"], "package_id": pack["package_id"]}, ensure_ascii=False))
        return 0
    except Exception as error:  # pragma: no cover - CLI guard
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
