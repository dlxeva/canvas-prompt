#!/usr/bin/env python3
"""Build the bounded MCPack-01 model envelope.

The existing Compact Prompt Package and Process IR remain the source of truth.
This module is a one-way, evidence-first projection for a single model request:
it copies identities, emits bounded claims/candidates, and leaves the complete
round archive out of the envelope.  It deliberately has no write path back to
Prompt Package or Process IR.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from pathlib import Path
from typing import Any, Iterable


CONTRACT = "canvas-prompt/minimal-context-pack/0.1-draft"
CONTEXT_VERSION = "0.1-draft"
MAX_CLAIMS = 24
MAX_RELATION_CANDIDATES = 12
MAX_SPEECH_SEGMENTS = 10
MAX_EVIDENCE_REFS = 5
TARGET_TEXT_TOKENS = 4_000
HARD_TEXT_TOKENS = 6_000

SOURCE_LAYERS = {
    "visual_observation",
    "user_input",
    "compiler_candidate",
    "confirmation",
    "unavailable",
}
STATUSES = {"observed", "user_stated", "inferred", "confirmed", "unresolved"}
QUALITY_OVERALL = {"complete", "degraded", "unavailable", "conflicting"}
QUALITY_STATES = {"available", "degraded", "unavailable", "conflicting"}

# These names identify the complete archive or raw media.  They must never be
# present in a model envelope, including in nested user-provided dictionaries.
FORBIDDEN_KEYS = {
    "canvas_event_track",
    "timeline_fusion",
    "caption_track",
    "full_canvas_event_track",
    "full_process_ir",
    "process_ir",
    "strokes",
    "stroke_points",
    "audio",
    "audio_bytes",
    "raw_audio",
    "raw_transcript",
    "tool_trace",
    "tool_calls",
    "model_trace",
    "archive",
    "archive_path",
    "absolute_path",
}

_DIRECTION_RE = re.compile(
    r"(?P<left>[\w\u3400-\u9fff-]+)\s*(?:指向|指到|指着|指向了|points?\s+to|points?\s+towards?|directs?\s+to|goes?\s+to|leads?\s+to)\s*(?P<right>[\w\u3400-\u9fff-]+)",
    re.IGNORECASE,
)
_FROM_TO_RE = re.compile(
    r"(?:from|从)\s*(?P<left>[\w\u3400-\u9fff-]+)\s*(?:to|到)\s*(?P<right>[\w\u3400-\u9fff-]+)",
    re.IGNORECASE,
)


def _as_list(value: Any) -> list[dict[str, Any]]:
    return [item for item in value or [] if isinstance(item, dict)] if isinstance(value, list) else []


def _text(value: Any, limit: int = 280) -> str:
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    value = " ".join(value.split())
    return value[:limit]


def _safe_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _safe_bounds(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    result: dict[str, float] = {}
    for key in ("x", "y", "width", "height"):
        number = _safe_number(value.get(key))
        if number is None:
            return None
        result[key] = float(number)
    return result


def _json_pointer(path: str) -> str:
    return path if path.startswith("/") else f"/{path}"


def _pointer(path: str, index: int | None = None) -> str:
    suffix = f"/{index}" if index is not None else ""
    return _json_pointer(path) + suffix


def _caption_items(compact: dict[str, Any], process_ir: dict[str, Any]) -> list[dict[str, Any]]:
    raw = _as_list(process_ir.get("speech_anchors"))
    if raw:
        result = []
        for index, item in enumerate(raw):
            caption_id = item.get("caption_id") or item.get("segment_id") or f"speech_{index + 1:03d}"
            start = item.get("start_ms", item.get("timestamp_start", 0))
            end = item.get("end_ms", item.get("timestamp_end", start))
            result.append({
                "caption_id": str(caption_id),
                "start_ms": start if isinstance(start, (int, float)) else 0,
                "end_ms": end if isinstance(end, (int, float)) else start if isinstance(start, (int, float)) else 0,
                "text": _text(item.get("text", item.get("transcript", item.get("summary", "")))),
                "source_ref": _pointer("speech_anchors", index),
            })
        return result

    raw = _as_list(compact.get("compact_caption_summary"))
    result = []
    for index, item in enumerate(raw):
        caption_id = item.get("caption_id") or f"speech_{index + 1:03d}"
        start = item.get("timestamp_start_ms", item.get("start_ms", 0))
        end = item.get("timestamp_end_ms", item.get("end_ms", start))
        result.append({
            "caption_id": str(caption_id),
            "start_ms": start if isinstance(start, (int, float)) else 0,
            "end_ms": end if isinstance(end, (int, float)) else start if isinstance(start, (int, float)) else 0,
            "text": _text(item.get("summary", item.get("text", ""))),
            "source_ref": _pointer("compact_caption_summary", index),
        })
    return result


def _package_id(compact: dict[str, Any], process_ir: dict[str, Any]) -> str | None:
    meta = compact.get("meta") if isinstance(compact.get("meta"), dict) else {}
    source = process_ir.get("source") if isinstance(process_ir.get("source"), dict) else {}
    # Process IR carries the identity of the exported round.  Compact builders
    # may assign an implementation timestamp to their own metadata; that is a
    # derived artifact and must not replace the source package identity.
    value = source.get("package_id") or meta.get("package_id")
    return str(value) if value not in (None, "") else None


def _package_version(compact: dict[str, Any], process_ir: dict[str, Any]) -> str | None:
    meta = compact.get("meta") if isinstance(compact.get("meta"), dict) else {}
    source = process_ir.get("source") if isinstance(process_ir.get("source"), dict) else {}
    value = meta.get("version") or source.get("package_version")
    return str(value) if value not in (None, "") else None


def _round_id(compact: dict[str, Any], process_ir: dict[str, Any]) -> str | None:
    meta = compact.get("meta") if isinstance(compact.get("meta"), dict) else {}
    source = process_ir.get("source") if isinstance(process_ir.get("source"), dict) else {}
    capture = compact.get("capture") if isinstance(compact.get("capture"), dict) else {}
    for container, keys in (
        (compact, ("round_id", "sessionId", "session_id")),
        (meta, ("round_id", "sessionId", "session_id")),
        (capture, ("session_id", "sessionId")),
        (source, ("round_id", "session_id")),
    ):
        for key in keys:
            value = container.get(key)
            if value not in (None, ""):
                return str(value)
    return None


def _source(compact: dict[str, Any], process_ir: dict[str, Any]) -> dict[str, Any]:
    source = process_ir.get("source") if isinstance(process_ir.get("source"), dict) else {}
    provenance = (compact.get("process_ir_summary") or {}).get("source_provenance")
    provenance = provenance if isinstance(provenance, dict) else {}
    result = {
        "package_schema": (compact.get("meta") or {}).get("format") or "compact_timeline_aware",
        "process_ir_schema_version": process_ir.get("schema_version"),
        "compiler_version": source.get("compiler_version") or provenance.get("compiler_version"),
        "content_sha256": source.get("content_sha256") or provenance.get("content_sha256"),
        "package_id": _package_id(compact, process_ir),
        "round_id_source": "existing_package_or_process_ir" if _round_id(compact, process_ir) else "unavailable",
    }
    # Artifact Review/Interaction Review identities are copied only when the
    # source already supplied them. The adapter never includes artifact bytes.
    for key in ("artifact_id", "source_version_id", "source_sha256", "page_normalized_v1"):
        value = source.get(key) or compact.get(key)
        if value not in (None, ""):
            result[key] = value
    return result


def _evidence_id(prefix: str, value: Any) -> str:
    raw = str(value or "unknown")
    normalized = re.sub(r"[^A-Za-z0-9_-]+", "_", raw).strip("_")[:48] or "unknown"
    return f"ev_{prefix}_{normalized}"


class _Evidence:
    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {}

    def add(
        self,
        evidence_id: str,
        kind: str,
        source_ref: str,
        *,
        time_window_ms: Any = None,
        spatial_anchor: Any = None,
        excerpt: str | None = None,
        availability: str = "available",
    ) -> str:
        if evidence_id not in self.items:
            item: dict[str, Any] = {
                "evidence_id": evidence_id,
                "kind": kind,
                "source_ref": _json_pointer(source_ref),
                "availability": availability,
            }
            if isinstance(time_window_ms, (list, tuple)) and len(time_window_ms) == 2:
                item["time_window_ms"] = {
                    "start_ms": time_window_ms[0],
                    "end_ms": time_window_ms[1],
                }
            elif isinstance(time_window_ms, dict) and "start_ms" in time_window_ms and "end_ms" in time_window_ms:
                item["time_window_ms"] = {
                    "start_ms": time_window_ms["start_ms"],
                    "end_ms": time_window_ms["end_ms"],
                }
            if isinstance(spatial_anchor, dict):
                item["spatial_anchor"] = _spatial_anchor(spatial_anchor)
            if excerpt:
                item["excerpt"] = _text(excerpt)
            self.items[evidence_id] = item
        return evidence_id

    def unavailable(self, name: str, text: str) -> str:
        return self.add(
            _evidence_id("unavailable", name),
            "unavailable",
            f"/unavailable/{name}",
            excerpt=text,
            availability="unavailable",
        )


def _spatial_anchor(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "coordinate_space": value.get("coordinate_space", "canvas_base_v1"),
    }
    for key in ("object_id", "stroke_id", "unit_id"):
        if isinstance(value.get(key), str) and value[key]:
            result[key] = value[key]
    object_ids = value.get("object_ids")
    if isinstance(object_ids, list):
        result["object_ids"] = [str(item) for item in object_ids if item][:8]
    bounds = _safe_bounds(value.get("bounds"))
    if bounds:
        result["region"] = bounds
    return result


def _object_aliases(obj: dict[str, Any]) -> set[str]:
    aliases: set[str] = set()
    object_id = str(obj.get("object_id", ""))
    if object_id:
        aliases.add(object_id.casefold())
        if object_id.casefold().startswith("obj_"):
            aliases.add(object_id[4:].casefold())
    for key in ("label", "semantic_content", "text", "title", "name"):
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            aliases.add(value.strip().casefold())
    properties = obj.get("properties") if isinstance(obj.get("properties"), dict) else {}
    for key in ("label", "text", "title", "name", "content"):
        value = properties.get(key)
        if isinstance(value, str) and value.strip():
            aliases.add(value.strip().casefold())
    return aliases


def _direction_pairs(text: str, objects: list[dict[str, Any]]) -> set[tuple[str, str]]:
    aliases = {alias: str(obj.get("object_id")) for obj in objects for alias in _object_aliases(obj) if obj.get("object_id")}
    pairs: set[tuple[str, str]] = set()
    for pattern in (_DIRECTION_RE, _FROM_TO_RE):
        for match in pattern.finditer(text):
            left = aliases.get(match.group("left").casefold())
            right = aliases.get(match.group("right").casefold())
            if left and right and left != right:
                pairs.add((left, right))
    return pairs


def _time_window(item: dict[str, Any], *keys: str) -> list[int | float] | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, (list, tuple)) and len(value) == 2 and all(isinstance(v, (int, float)) for v in value):
            return [value[0], value[1]]
        if isinstance(value, dict) and isinstance(value.get("start_ms"), (int, float)) and isinstance(value.get("end_ms"), (int, float)):
            return [value["start_ms"], value["end_ms"]]
    timestamp = item.get("timestamp_ms")
    if isinstance(timestamp, (int, float)):
        return [timestamp, timestamp]
    return None


def _claim(
    claim_id: str,
    source_layer: str,
    status: str,
    kind: str,
    text: str,
    evidence_refs: Iterable[str],
    *,
    time_window_ms: list[int | float] | None = None,
    spatial_anchors: list[dict[str, Any]] | None = None,
    limitations: list[str] | None = None,
) -> dict[str, Any]:
    refs = list(dict.fromkeys(str(ref) for ref in evidence_refs if ref))[:MAX_EVIDENCE_REFS]
    result: dict[str, Any] = {
        "claim_id": claim_id,
        "source_layer": source_layer,
        "status": status,
        "content": {"kind": kind, "text": _text(text)},
        "evidence_refs": refs,
    }
    if time_window_ms is not None:
        result["time_window_ms"] = {"start_ms": time_window_ms[0], "end_ms": time_window_ms[1]}
    if spatial_anchors:
        result["spatial_anchors"] = [_spatial_anchor(anchor) for anchor in spatial_anchors[:4]]
    if limitations:
        result["limitations"] = list(dict.fromkeys(limitations))[:6]
    return result


def _candidate(
    candidate_id: str,
    candidate_type: str,
    status: str,
    evidence_refs: Iterable[str],
    *,
    endpoint_candidates: list[dict[str, Any]] | None = None,
    spatial_anchor: dict[str, Any] | None = None,
    time_window_ms: list[int | float] | None = None,
    failure_flags: list[str] | None = None,
    limitations: list[str] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "candidate_id": candidate_id,
        "candidate_type": candidate_type,
        "status": status,
        "evidence_refs": list(dict.fromkeys(str(ref) for ref in evidence_refs if ref))[:MAX_EVIDENCE_REFS],
    }
    if endpoint_candidates:
        result["endpoint_candidates"] = endpoint_candidates[:4]
    if spatial_anchor:
        result["spatial_anchor"] = _spatial_anchor(spatial_anchor)
    if time_window_ms is not None:
        result["time_window_ms"] = {"start_ms": time_window_ms[0], "end_ms": time_window_ms[1]}
    if failure_flags:
        result["failure_flags"] = list(dict.fromkeys(failure_flags))
    if limitations:
        result["limitations"] = list(dict.fromkeys(limitations))[:6]
    return result


def _object_claims(process_ir: dict[str, Any], evidence: _Evidence) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for index, obj in enumerate(_as_list(process_ir.get("objects"))):
        object_id = obj.get("object_id")
        if not object_id:
            continue
        ref = evidence.add(
            _evidence_id("object", object_id),
            "canvas_event",
            _pointer("objects", index),
            time_window_ms=_time_window(obj, "time_range_ms"),
            spatial_anchor={"object_id": object_id, "bounds": obj.get("bounds")},
            excerpt=obj.get("label") or obj.get("semantic_content") or obj.get("object_type") or "canvas object",
        )
        label = obj.get("label") or obj.get("semantic_content")
        description = f"画面中存在画布对象 {object_id}"
        if isinstance(label, str) and label.strip():
            description += f"，标注为“{_text(label, 80)}”"
        anchors = [{"object_id": object_id, "bounds": obj.get("bounds")}]
        claims.append(_claim(
            f"clm_visual_object_{index + 1:03d}",
            "visual_observation",
            "observed",
            "object",
            description,
            [ref],
            time_window_ms=_time_window(obj, "time_range_ms"),
            spatial_anchors=anchors,
        ))
    return claims


def _speech_claims(captions: list[dict[str, Any]], evidence: _Evidence) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for index, caption in enumerate(captions[:MAX_SPEECH_SEGMENTS]):
        caption_id = caption["caption_id"]
        ref = evidence.add(
            _evidence_id("speech", caption_id),
            "speech_segment",
            caption["source_ref"],
            time_window_ms=[caption["start_ms"], caption["end_ms"]],
            excerpt=caption["text"],
        )
        claims.append(_claim(
            f"clm_speech_{index + 1:03d}",
            "user_input",
            "user_stated",
            "user_statement",
            caption["text"],
            [ref],
            time_window_ms=[caption["start_ms"], caption["end_ms"]],
        ))
    return claims


def _spatial_claims(process_ir: dict[str, Any], evidence: _Evidence) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for index, relation in enumerate(_as_list(process_ir.get("spatial_relations"))[:12]):
        ids = relation.get("object_ids")
        if not isinstance(ids, list) or len(ids) < 2 or not all(isinstance(value, str) and value for value in ids[:2]):
            continue
        relation_name = str(relation.get("relation", "geometric_observation"))
        ref = evidence.add(
            _evidence_id("spatial", f"{index}_{ids[0]}_{ids[1]}_{relation_name}"),
            "process_ir_candidate",
            _pointer("spatial_relations", index),
            spatial_anchor={"object_ids": ids[:2]},
            excerpt=f"{ids[0]} {relation_name} {ids[1]}",
        )
        claims.append(_claim(
            f"clm_visual_spatial_{index + 1:03d}",
            "visual_observation",
            "observed",
            "mark",
            f"几何上观察到 {ids[0]} 与 {ids[1]} 之间存在 {relation_name} 关系",
            [ref],
            spatial_anchors=[{"object_ids": ids[:2]}],
            limitations=["geometric_observation_does_not_establish_semantic_relation"],
        ))
    return claims


def _semantic_claims(compact: dict[str, Any], process_ir: dict[str, Any], captions: list[dict[str, Any]], evidence: _Evidence) -> list[dict[str, Any]]:
    """Project only bounded, evidence-backed compiler interpretations."""
    claims: list[dict[str, Any]] = []
    caption_by_id = {caption["caption_id"]: caption for caption in captions}
    events = _as_list(process_ir.get("semantic_events")) or _as_list(compact.get("semantic_events"))
    for index, event in enumerate(events[:8]):
        source_caption_ids = [value for value in event.get("source_caption_ids", []) if isinstance(value, str)]
        source_event_ids = [value for value in event.get("source_canvas_event_ids", event.get("source_event_refs", [])) if isinstance(value, str)]
        refs: list[str] = []
        for caption_id in source_caption_ids[:MAX_EVIDENCE_REFS]:
            caption = caption_by_id.get(caption_id)
            if not caption:
                continue
            refs.append(evidence.add(
                _evidence_id("speech", caption_id),
                "speech_segment",
                caption["source_ref"],
                time_window_ms=[caption["start_ms"], caption["end_ms"]],
                excerpt=caption["text"],
            ))
        for event_id in source_event_ids[:MAX_EVIDENCE_REFS - len(refs)]:
            refs.append(evidence.add(
                _evidence_id("event", event_id),
                "canvas_event",
                f"/canvas_events/{event_id}",
                excerpt="bounded compiler evidence reference",
            ))
        if not refs:
            continue
        assertion = event.get("assertion_level")
        is_confirmation = assertion == "assertion" and str(event.get("type", event.get("semantic_type", ""))).startswith("confirm")
        source_layer = "confirmation" if is_confirmation else "compiler_candidate"
        status = "confirmed" if is_confirmation else "inferred"
        claims.append(_claim(
            f"clm_compiler_{index + 1:03d}",
            source_layer,
            status,
            "summary",
            event.get("summary") or event.get("type") or "bounded compiler candidate",
            refs,
            time_window_ms=_time_window(event, "time_range_ms"),
            spatial_anchors=[{"object_ids": event.get("involved_object_ids", [])}] if event.get("involved_object_ids") else None,
            limitations=[] if is_confirmation else ["compiler_candidate_requires_user_review"],
        ))
    return claims


def _reference_candidates(process_ir: dict[str, Any], captions: list[dict[str, Any]], evidence: _Evidence) -> list[dict[str, Any]]:
    caption_by_id = {caption["caption_id"]: caption for caption in captions}
    result: list[dict[str, Any]] = []
    for index, item in enumerate(_as_list(process_ir.get("reference_candidates"))):
        refs: list[str] = []
        caption_id = item.get("caption_id")
        caption = caption_by_id.get(caption_id)
        if caption:
            refs.append(evidence.add(
                _evidence_id("speech", caption_id), "speech_segment", caption["source_ref"],
                time_window_ms=[caption["start_ms"], caption["end_ms"]], excerpt=caption["text"],
            ))
        refs.append(evidence.add(
            _evidence_id("reference", item.get("reference_id") or index),
            "process_ir_candidate",
            _pointer("reference_candidates", index),
            time_window_ms=item.get("time_range_ms"),
            excerpt="unresolved reference candidate",
        ))
        endpoints = []
        for candidate in _as_list(item.get("candidate_objects"))[:4]:
            if candidate.get("object_id"):
                endpoints.append({
                    "role": "reference_candidate",
                    "object_id": candidate["object_id"],
                    "distance": candidate.get("distance"),
                })
        result.append(_candidate(
            f"rel_reference_{index + 1:03d}",
            "reference_candidate",
            "unresolved",
            refs,
            endpoint_candidates=endpoints,
            time_window_ms=item.get("time_range_ms"),
            limitations=["deictic_speech_and_pointer_proximity_do_not_establish_unique_binding"],
        ))
    return result


def _handdrawn_candidates(process_ir: dict[str, Any], captions: list[dict[str, Any]], evidence: _Evidence) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    relation_by_id: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(_as_list(process_ir.get("ink_relation_candidates"))):
        relation_id = str(item.get("relation_id") or f"ink_relation_{index + 1:03d}")
        relation_by_id[relation_id] = item
        endpoint = item.get("endpoint_candidates") if isinstance(item.get("endpoint_candidates"), dict) else {}
        start = endpoint.get("start_object_id")
        end = endpoint.get("end_object_id")
        refs: list[str] = []
        refs.append(evidence.add(
            _evidence_id("stroke", item.get("stroke_id") or relation_id),
            "process_ir_candidate",
            _pointer("ink_relation_candidates", index),
            time_window_ms=item.get("temporal_evidence", {}).get("connection_timestamp_ms") if isinstance(item.get("temporal_evidence"), dict) else None,
            spatial_anchor={"stroke_id": item.get("stroke_id"), "object_ids": [value for value in (start, end) if value]},
            excerpt="unresolved hand-drawn connection geometry",
        ))
        for source in item.get("evidence_sources", [])[:MAX_EVIDENCE_REFS - len(refs)]:
            refs.append(evidence.add(
                _evidence_id("relation_source", f"{relation_id}_{source}"),
                "process_ir_candidate",
                _pointer("ink_relation_candidates", index),
                excerpt=str(source),
            ))
        endpoints = []
        if start:
            endpoints.append({"role": "start_like", "object_id": start, "distance": endpoint.get("start_distance")})
        if end:
            endpoints.append({"role": "end_like", "object_id": end, "distance": endpoint.get("end_distance")})
        candidates.append(_candidate(
            relation_id,
            "unresolved_handdrawn_connection",
            "unresolved",
            refs,
            endpoint_candidates=endpoints,
            spatial_anchor={"stroke_id": item.get("stroke_id"), "object_ids": [value for value in (start, end) if value], "bounds": item.get("geometry", {}).get("bounds") if isinstance(item.get("geometry"), dict) else None},
            time_window_ms=item.get("temporal_evidence", {}).get("anchor_timestamps_ms") if isinstance(item.get("temporal_evidence"), dict) else None,
            limitations=["connection_geometry_does_not_establish_direction_or_semantic_relation"],
        ))

    for index, item in enumerate(_as_list(process_ir.get("ink_circle_candidates"))):
        object_ids = [value for value in item.get("candidate_object_ids", []) if isinstance(value, str)][:4]
        ref = evidence.add(
            _evidence_id("circle", item.get("circle_id") or index),
            "process_ir_candidate",
            _pointer("ink_circle_candidates", index),
            time_window_ms=item.get("timestamp_ms"),
            spatial_anchor={"stroke_id": item.get("stroke_id"), "object_ids": object_ids, "bounds": item.get("geometry", {}).get("bounds") if isinstance(item.get("geometry"), dict) else None},
            excerpt="unresolved hand-drawn circle geometry",
        )
        candidates.append(_candidate(
            f"circle_{item.get('circle_id') or index}",
            "unresolved_handdrawn_circle",
            "unresolved",
            [ref],
            endpoint_candidates=[{"role": "candidate_object", "object_id": value} for value in object_ids],
            spatial_anchor={"stroke_id": item.get("stroke_id"), "object_ids": object_ids, "bounds": item.get("geometry", {}).get("bounds") if isinstance(item.get("geometry"), dict) else None},
            time_window_ms=_time_window(item, "timestamp_ms"),
            limitations=["closed_ink_geometry_does_not_establish_selection_or_intent"],
        ))

    return candidates


def _detect_conflicts(candidates: list[dict[str, Any]], captions: list[dict[str, Any]], process_ir: dict[str, Any]) -> list[dict[str, Any]]:
    objects = _as_list(process_ir.get("objects"))
    spoken_pairs = set()
    for caption in captions:
        spoken_pairs.update(_direction_pairs(caption.get("text", ""), objects))
    conflicts: list[dict[str, Any]] = []
    for candidate in candidates:
        endpoints = candidate.get("endpoint_candidates") or []
        start = next((item.get("object_id") for item in endpoints if item.get("role") == "start_like"), None)
        end = next((item.get("object_id") for item in endpoints if item.get("role") == "end_like"), None)
        if not start or not end:
            continue
        # A visual candidate's endpoint order is only geometry.  A spoken
        # reverse direction makes the combined interpretation explicitly
        # unresolved and asks for clarification.
        if (end, start) in spoken_pairs:
            candidate.setdefault("failure_flags", []).append("conflicting")
            candidate.setdefault("limitations", []).append("do_not_resolve_asr_conflict_by_visual_guess")
            conflicts.append({
                "id": f"unres_direction_{candidate.get('candidate_id')}",
                "reason": "conflicting",
                "text": "视觉几何候选与语音方向不一致，需要用户澄清",
                "evidence_refs": candidate.get("evidence_refs", [])[:MAX_EVIDENCE_REFS],
                "candidate_id": candidate.get("candidate_id"),
            })
    return conflicts


def _quality(
    compact: dict[str, Any],
    process_ir: dict[str, Any],
    *,
    claim_count: int,
    candidate_count: int,
    candidate_omitted: int,
    truncated: bool,
    conflicts: list[dict[str, Any]],
    captions: list[dict[str, Any]],
) -> dict[str, Any]:
    source_quality = process_ir.get("quality") if isinstance(process_ir.get("quality"), dict) else {}
    ink_trace = source_quality.get("ink_trace") if isinstance(source_quality.get("ink_trace"), dict) else {}
    has_snapshot = bool(compact.get("final_canvas_snapshot")) or bool(process_ir.get("canvas_snapshot"))
    speech_available = bool(captions)
    ocr_available = bool(_as_list(process_ir.get("ocr_observations")))
    if conflicts:
        overall = "conflicting"
    elif not has_snapshot and not speech_available and not _as_list(process_ir.get("objects")):
        overall = "unavailable"
    elif not has_snapshot or not speech_available or candidate_omitted or truncated:
        overall = "degraded"
    else:
        overall = "complete"
    ink_geometry = ink_trace.get("geometry_status", "unavailable") if ink_trace else "unavailable"
    if ink_geometry == "missing":
        ink_geometry = "unavailable"
    layers = {
        "final_snapshot": "available" if has_snapshot else "unavailable",
        "speech": "available" if speech_available else "unavailable",
        "ink_geometry": ink_geometry,
        "ocr": "available" if ocr_available else "unavailable",
        "compiler": "available" if process_ir.get("schema_version") else "unavailable",
    }
    issues: list[str] = []
    if not has_snapshot:
        issues.append("final_snapshot_unavailable")
    if not speech_available:
        issues.append("speech_unavailable")
    if not ocr_available:
        issues.append("ocr_unavailable")
    if conflicts:
        issues.append("visual_speech_direction_mismatch")
    if candidate_omitted:
        issues.append("candidate_budget_saturated")
    if truncated:
        issues.append("text_budget_truncated")
    return {
        "overall": overall,
        "layers": layers,
        "coverage": {
            "claims_included": claim_count,
            "candidate_included": candidate_count,
            "candidate_omitted": candidate_omitted,
            "truncated": truncated,
            "saturated": bool(candidate_omitted),
        },
        "saturated": bool(candidate_omitted),
        "truncated": truncated,
        "issues": issues,
    }


def _budget(pack_without_budget: dict[str, Any], candidate_count: int, speech_count: int) -> dict[str, Any]:
    serialized = json.dumps(pack_without_budget, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    json_bytes = len(serialized.encode("utf-8"))
    text_tokens = (len(serialized) + 3) // 4
    return {
        "text_token_estimate": text_tokens,
        "json_bytes": json_bytes,
        "target_text_tokens": TARGET_TEXT_TOKENS,
        "hard_text_tokens": HARD_TEXT_TOKENS,
        "within_target": text_tokens <= TARGET_TEXT_TOKENS,
        "candidate_count": candidate_count,
        "candidate_limit": MAX_RELATION_CANDIDATES,
        "speech_segment_count": speech_count,
        "speech_segment_limit": MAX_SPEECH_SEGMENTS,
        "max_evidence_refs_per_item": MAX_EVIDENCE_REFS,
    }


def build_minimal_context_pack(
    compact_package: dict[str, Any],
    process_ir: dict[str, Any] | None = None,
    *,
    task: dict[str, Any] | None = None,
    context_id: str | None = None,
    parent_context_id: str | None = None,
) -> dict[str, Any]:
    """Build one bounded Context Pack from an existing compact package and IR."""
    # Accept the CLI fixture shape as a convenience for local evaluators while
    # keeping the explicit two-source call as the primary API.
    if process_ir is None and isinstance(compact_package, dict):
        if isinstance(compact_package.get("compact_package"), dict) and isinstance(compact_package.get("process_ir"), dict):
            compact_package, process_ir = compact_package["compact_package"], compact_package["process_ir"]
    # A few callers naturally pass (process_ir, compact_package).  Detect that
    # shape by the stable top-level keys and normalize it without changing the
    # source identity rules above.
    if isinstance(compact_package, dict) and isinstance(process_ir, dict):
        if "schema_version" in compact_package and "meta" in process_ir:
            compact_package, process_ir = process_ir, compact_package
    if not isinstance(compact_package, dict) or not isinstance(process_ir, dict):
        raise TypeError("compact_package and process_ir must be JSON objects")
    evidence = _Evidence()
    captions = _caption_items(compact_package, process_ir)
    claims = _object_claims(process_ir, evidence)
    claims.extend(_speech_claims(captions, evidence))
    claims.extend(_semantic_claims(compact_package, process_ir, captions, evidence))
    claims.extend(_spatial_claims(process_ir, evidence))

    if not captions:
        evidence.unavailable("speech", "带时间戳的语音来源不可用")
    if not compact_package.get("final_canvas_snapshot") and not process_ir.get("canvas_snapshot"):
        evidence.unavailable("final_snapshot", "最终画布快照不可用")
    if not _as_list(process_ir.get("ocr_observations")):
        evidence.unavailable("ocr", "OCR 来源不可用或按策略留在本地复核")

    relation_candidates = _reference_candidates(process_ir, captions, evidence)
    relation_candidates.extend(_handdrawn_candidates(process_ir, captions, evidence))
    all_candidate_count = len(relation_candidates)
    conflicts = _detect_conflicts(relation_candidates, captions, process_ir)
    relation_candidates = relation_candidates[:MAX_RELATION_CANDIDATES]
    candidate_omitted = max(0, all_candidate_count - len(relation_candidates))

    unresolved: list[dict[str, Any]] = list(conflicts)
    if not captions:
        unresolved.append({
            "id": "unres_speech_unavailable",
            "reason": "unavailable",
            "text": "语音不可用，不能据此判断用户意图或修正视觉候选",
            "evidence_refs": [_evidence_id("unavailable", "speech")],
        })
    if not compact_package.get("final_canvas_snapshot") and not process_ir.get("canvas_snapshot"):
        unresolved.append({
            "id": "unres_snapshot_unavailable",
            "reason": "unavailable",
            "text": "最终快照不可用，画面事实范围受限",
            "evidence_refs": [_evidence_id("unavailable", "final_snapshot")],
        })
    if not _as_list(process_ir.get("ocr_observations")) and (_as_list(process_ir.get("objects")) or _as_list(process_ir.get("ink_annotation_candidates"))):
        unresolved.append({
            "id": "unres_ocr_unavailable",
            "reason": "unavailable",
            "text": "OCR 不可用，不能据此判断密集手写文字内容或关系",
            "evidence_refs": [_evidence_id("unavailable", "ocr")],
        })
    for item in unresolved:
        item["evidence_refs"] = list(dict.fromkeys(item.get("evidence_refs", [])))[:MAX_EVIDENCE_REFS]

    # A dense hand-written scene may generate many geometric near/overlap
    # observations.  They stay claims; only explicit Process IR candidates enter
    # relation_candidates, so no semantic relation is silently invented.
    claims = claims[:MAX_CLAIMS]
    quality = _quality(
        compact_package,
        process_ir,
        claim_count=len(claims),
        candidate_count=len(relation_candidates),
        candidate_omitted=candidate_omitted,
        truncated=False,
        conflicts=conflicts,
        captions=captions,
    )
    task_value = task if isinstance(task, dict) else {}
    envelope: dict[str, Any] = {
        "contract": CONTRACT,
        "context_id": context_id or f"ctx_{uuid.uuid4().hex}",
        "context_version": CONTEXT_VERSION,
        "package_id": _package_id(compact_package, process_ir),
        "package_version": _package_version(compact_package, process_ir),
        "round_id": _round_id(compact_package, process_ir),
        "source": _source(compact_package, process_ir),
        "task": {
            "kind": str(task_value.get("kind") or "understand"),
            "question": _text(task_value.get("question") or "Summarize the bounded evidence for this round.", 500),
        },
        "claims": claims[:MAX_CLAIMS],
        "relation_candidates": relation_candidates,
        "unresolved": unresolved,
        "evidence": list(evidence.items.values()),
        "quality": quality,
        "constraints": {
            "execution_authorized": False,
            "confirmation": {"status": "none", "evidence_refs": []},
            "progressive_read": "archive_requires_explicit_evidence_id_and_new_context_id",
        },
        "execution_authorized": False,
    }
    if parent_context_id:
        envelope["parent_context_id"] = str(parent_context_id)
    envelope["budget"] = _budget(envelope, len(relation_candidates), len(captions[:MAX_SPEECH_SEGMENTS]))
    if envelope["budget"]["text_token_estimate"] > HARD_TEXT_TOKENS:
        # The first implementation reports an over-budget envelope and keeps
        # identity, conflicts and unresolved states intact.  It does not silently
        # pull archive material to make the number look smaller.
        envelope["quality"]["truncated"] = True
        envelope["quality"]["coverage"]["truncated"] = True
        envelope["quality"]["issues"].append("text_budget_truncated")
        envelope["quality"]["overall"] = "degraded" if envelope["quality"]["overall"] == "complete" else envelope["quality"]["overall"]
        envelope["budget"]["truncation_reason"] = "bounded_projection_exceeds_hard_text_budget"
    return envelope


def adapt(compact_package: dict[str, Any], process_ir: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    """Compatibility alias for callers that use the existing adapter naming."""
    return build_minimal_context_pack(compact_package, process_ir, **kwargs)


build_context_pack = build_minimal_context_pack
build_model_envelope = build_minimal_context_pack


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _load_input(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    if args.compact_package and args.process_ir:
        return read_json(args.compact_package), read_json(args.process_ir)
    if not args.input:
        raise ValueError("provide --input or both --compact-package and --process-ir")
    value = read_json(args.input)
    if isinstance(value, dict) and isinstance(value.get("compact_package"), dict) and isinstance(value.get("process_ir"), dict):
        return value["compact_package"], value["process_ir"]
    if isinstance(value, dict) and isinstance(value.get("compact"), dict) and isinstance(value.get("process_ir"), dict):
        return value["compact"], value["process_ir"]
    raise ValueError("--input must contain compact_package and process_ir objects")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--compact-package", type=Path)
    parser.add_argument("--process-ir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--task-kind", default="understand")
    parser.add_argument("--question", default="Summarize the bounded evidence for this round.")
    parser.add_argument("--context-id")
    args = parser.parse_args(argv)
    try:
        compact, process_ir = _load_input(args)
        result = build_minimal_context_pack(
            compact,
            process_ir,
            task={"kind": args.task_kind, "question": args.question},
            context_id=args.context_id,
        )
        write_json(args.output, result)
        print(json.dumps({"ok": True, "output": str(args.output), "context_id": result["context_id"], "budget": result["budget"]}, ensure_ascii=False))
        return 0
    except Exception as error:  # pragma: no cover - CLI guard
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
