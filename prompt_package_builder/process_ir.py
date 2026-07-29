"""Language-neutral Process IR for whiteboard reasoning traces.

The IR records observable facts separately from inferred intent.  It is the
stable contract between browser capture, deterministic inference, and the LLM
explanation layer; it deliberately contains no psychological labels.
"""

from __future__ import annotations

from collections import Counter
import hashlib
import json
import re
from typing import Any

try:  # Support both package imports and the existing script-style adapter.
    from prompt_package_builder.legacy_svg_outline import inspect_legacy_svg_outline
except ModuleNotFoundError:  # pragma: no cover - exercised by adapter import mode
    from legacy_svg_outline import inspect_legacy_svg_outline


# v0.3 adds bounded, unresolved arrowhead-like observations to the existing
# structural layer. It records visual orientation evidence without creating a
# causal edge or semantic relation.
# Raw Prompt Packages remain the source of truth, so historical packages are
# recompiled rather than mutating persisted IR snapshots in place.
SCHEMA_VERSION = "process-ir-v0.8"
COMPILER_VERSION = "process-ir-compiler-v0.7"
MAX_SPATIAL_RELATIONS = 300
MAX_INK_RELATION_CANDIDATES = 100
MAX_INK_CIRCLE_CANDIDATES = 100
MAX_INK_ARROWHEAD_CANDIDATES = 100
MAX_INK_CROSS_CANDIDATES = 100
MAX_INK_CHECK_CANDIDATES = 100
MAX_INK_ANNOTATION_CANDIDATES = 160
MAX_VISUAL_UNIT_MEMBERS = 12
TRANSFORM_SESSION_GAP_MS = 250
TRANSFORM_CREATION_GRACE_MS = 1_500
TRANSFORM_BATCH_GAP_MS = 400
TRANSFORM_MIN_MOVE_PX = 8.0
TRANSFORM_MIN_SCALE_DELTA = 0.05
# A visual unit is an immediate construction burst.  A longer pause is a
# boundary signal for grouping only; it never means a cognitive state.  The
# prior 2.5 s window merged a later connector into a nearby hand-drawn frame.
VISUAL_UNIT_TIME_WINDOW_MS = 1_200
VISUAL_UNIT_GAP_PX = 24
REFERENCE_RE = re.compile(
    r"(?:\bthis(?:\s+one)?\b|\bthat(?:\s+one)?\b|\bthese\b|\bthose\b|\bit\b|\b(?:over\s+)?here\b|\b(?:over\s+)?there\b|\bthe\s+one\s+on\s+the\s+(?:left|right)\b|这个|那个|这边|那边|这里|那里|上述|前面|后面)",
    re.IGNORECASE,
)


def _label(obj: dict[str, Any]) -> str | None:
    # Browser-native text is exported as a top-level semantic_content evidence
    # field. It is more direct than compatibility labels nested in properties.
    semantic_content = obj.get("semantic_content")
    if isinstance(semantic_content, str) and semantic_content.strip():
        return semantic_content.strip()
    properties = obj.get("properties") or {}
    for key in ("text", "label", "title", "content", "name"):
        value = properties.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def canonical_package_sha256(package: dict[str, Any]) -> str:
    """Fingerprint the parsed export before any compiler transformation.

    This is a canonical JSON fingerprint, not the byte hash of the downloaded
    file.  It stays stable across harmless whitespace/key-order changes and
    makes every IR and downstream explanation traceable to one input state.
    """
    canonical = json.dumps(package, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _rect(obj: dict[str, Any]) -> tuple[float, float, float, float] | None:
    bounds = obj.get("bounds") or {}
    try:
        x = float(bounds["x"])
        y = float(bounds["y"])
        width = max(0.0, float(bounds["width"]))
        height = max(0.0, float(bounds["height"]))
    except (KeyError, TypeError, ValueError):
        return None
    return x, y, width, height


def _spatial_relations(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Derive bounded, geometry-only relations; never infer semantic meaning."""
    geometric = [(obj, _rect(obj)) for obj in objects]
    geometric = [(obj, rect) for obj, rect in geometric if rect and obj.get("object_id")]
    relations = []
    for index, (left, left_rect) in enumerate(geometric):
        lx, ly, lw, lh = left_rect
        lright, lbottom = lx + lw, ly + lh
        lcx, lcy = lx + lw / 2, ly + lh / 2
        for right, right_rect in geometric[index + 1:]:
            rx, ry, rw, rh = right_rect
            rright, rbottom = rx + rw, ry + rh
            rcx, rcy = rx + rw / 2, ry + rh / 2
            horizontal_overlap = max(0.0, min(lright, rright) - max(lx, rx))
            vertical_overlap = max(0.0, min(lbottom, rbottom) - max(ly, ry))
            pair = {"object_ids": [left["object_id"], right["object_id"]], "assertion_level": "observation"}
            if lx <= rx and ly <= ry and lright >= rright and lbottom >= rbottom:
                relations.append({**pair, "relation": "contains", "confidence": 0.98})
            elif rx <= lx and ry <= ly and rright >= lright and rbottom >= lbottom:
                relations.append({**pair, "relation": "contained_by", "confidence": 0.98})
            elif horizontal_overlap > 0 and vertical_overlap > 0:
                relations.append({**pair, "relation": "overlaps", "confidence": 0.9})
            else:
                gap_x = max(lx - rright, rx - lright, 0.0)
                gap_y = max(ly - rbottom, ry - lbottom, 0.0)
                if (gap_x * gap_x + gap_y * gap_y) ** 0.5 <= 80:
                    relations.append({**pair, "relation": "near", "confidence": 0.7})
            if len(relations) >= MAX_SPATIAL_RELATIONS:
                return relations
            if abs(lcx - rcx) >= 40 or abs(lcy - rcy) >= 40:
                for relation in (
                    "left_of" if lcx < rcx else "right_of",
                    "above" if lcy < rcy else "below",
                ):
                    if len(relations) >= MAX_SPATIAL_RELATIONS:
                        return relations
                    relations.append({**pair, "relation": relation, "confidence": 0.99})
            if len(relations) >= MAX_SPATIAL_RELATIONS:
                return relations
    return relations


def _ink_trace_quality(package: dict[str, Any]) -> dict[str, Any]:
    """Report whether hand-drawn geometry is usable, without interpreting it.

    A hand-drawn arrow is not a tldraw ``arrow`` object.  It can only become a
    relation candidate if the export retains at least two ordered points for
    that stroke.  Older packages preserved just a bounding box / fallback point;
    those packages remain useful for timing and language regression, but must
    never be used to infer arrow direction or graph topology.
    """
    strokes = package.get("strokes") or []
    point_counts = [
        len(stroke.get("points") or [])
        for stroke in strokes
        if isinstance(stroke, dict)
    ]
    trace_count = sum(count >= 2 for count in point_counts)
    return {
        "stroke_count": len(point_counts),
        "trajectory_count": trace_count,
        "point_count": sum(point_counts),
        "geometry_status": "available" if trace_count else ("degraded" if point_counts else "missing"),
        "supports_handdrawn_relation_candidates": trace_count > 0,
    }


def _union_bounds(bounds: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float] | None:
    if not bounds:
        return None
    left = min(item[0] for item in bounds)
    top = min(item[1] for item in bounds)
    right = max(item[0] + item[2] for item in bounds)
    bottom = max(item[1] + item[3] for item in bounds)
    return left, top, right - left, bottom - top


def _transform_bounds(item: dict[str, Any], key: str) -> tuple[float, float, float, float] | None:
    value = item.get(key)
    if not isinstance(value, dict):
        return None
    try:
        return (
            float(value["x"]),
            float(value["y"]),
            max(0.0, float(value["width"])),
            max(0.0, float(value["height"])),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _layout_transform_observations(package: dict[str, Any], objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compress raw element update frames into conservative layout observations.

    Excalidraw emits an update for each element on each animation frame.  Those
    frames are not independently meaningful. We first discard the initial
    growth while a freehand stroke is being created, then coalesce later
    changes into object-level observations. A simultaneous batch is an
    additional aggregate, never a replacement. Neither proves priority or
    intent.
    """
    created_at = {
        str(obj.get("object_id", "")).removeprefix("obj_"): int(obj.get("timestamp_ms", 0) or 0)
        for obj in objects
        if obj.get("object_id")
    }
    by_object: dict[str, list[dict[str, Any]]] = {}
    for raw in package.get("transformations") or []:
        if not isinstance(raw, dict):
            continue
        raw_id = str(raw.get("object_id", ""))
        # A transform without a surviving canvas object cannot be tied to an
        # inspectable layout unit. Keeping it would turn transient pen frames
        # into fake emphasis evidence.
        if raw_id not in created_at:
            continue
        before = _transform_bounds(raw, "before_bounds")
        after = _transform_bounds(raw, "after_bounds")
        timestamp = raw.get("timestamp_ms")
        if not raw_id or before is None or after is None or not isinstance(timestamp, (int, float)):
            continue
        by_object.setdefault(raw_id, []).append(raw)

    sessions: list[dict[str, Any]] = []
    for raw_id, items in by_object.items():
        items.sort(key=lambda item: int(item.get("timestamp_ms", 0) or 0))
        chunks: list[list[dict[str, Any]]] = []
        for item in items:
            timestamp = int(item.get("timestamp_ms", 0) or 0)
            if not chunks or timestamp - int(chunks[-1][-1].get("timestamp_ms", 0) or 0) > TRANSFORM_SESSION_GAP_MS:
                chunks.append([item])
            else:
                chunks[-1].append(item)
        for chunk in chunks:
            start = int(chunk[0].get("timestamp_ms", 0) or 0)
            end = int(chunk[-1].get("timestamp_ms", 0) or 0)
            # Initial stroke growth is a renderer artifact, not a later layout decision.
            if start <= created_at.get(raw_id, 0) + TRANSFORM_CREATION_GRACE_MS:
                continue
            before = _transform_bounds(chunk[0], "before_bounds")
            after = _transform_bounds(chunk[-1], "after_bounds")
            if before is None or after is None:
                continue
            scale_x = after[2] / before[2] if before[2] > 0 else 1.0
            scale_y = after[3] / before[3] if before[3] > 0 else 1.0
            dx, dy = after[0] - before[0], after[1] - before[1]
            if max(abs(dx), abs(dy)) < TRANSFORM_MIN_MOVE_PX and max(abs(scale_x - 1), abs(scale_y - 1)) < TRANSFORM_MIN_SCALE_DELTA:
                continue
            sessions.append({
                "raw_id": raw_id,
                "object_id": f"obj_{raw_id}",
                "start_ms": start,
                "end_ms": end,
                "before": before,
                "after": after,
            })

    sessions.sort(key=lambda item: (item["start_ms"], item["raw_id"]))
    batches: list[list[dict[str, Any]]] = []
    for session in sessions:
        if not batches or session["start_ms"] - batches[-1][-1]["start_ms"] > TRANSFORM_BATCH_GAP_MS:
            batches.append([session])
        else:
            batches[-1].append(session)

    observations = []
    for index, session in enumerate(sessions, start=1):
        before = session["before"]
        after = session["after"]
        scale_x = after[2] / before[2] if before[2] > 0 else 1.0
        scale_y = after[3] / before[3] if before[3] > 0 else 1.0
        observations.append({
            "observation_id": f"object_transform_{index:03d}",
            "type": "object_layout_transform",
            "object_id": session["object_id"],
            "time_range_ms": [session["start_ms"], session["end_ms"]],
            "before_bounds": {"x": before[0], "y": before[1], "width": before[2], "height": before[3]},
            "after_bounds": {"x": after[0], "y": after[1], "width": after[2], "height": after[3]},
            "delta": {"x": after[0] - before[0], "y": after[1] - before[1]},
            "scale": {"x": scale_x, "y": scale_y},
            "assertion_level": "observation",
            "constraint": "layout_change_does_not_establish_priority_or_intent",
        })
    for index, batch in enumerate(batches, start=1):
        if len(batch) < 2:
            continue
        before = _union_bounds([item["before"] for item in batch])
        after = _union_bounds([item["after"] for item in batch])
        if before is None or after is None:
            continue
        scale_x = after[2] / before[2] if before[2] > 0 else 1.0
        scale_y = after[3] / before[3] if before[3] > 0 else 1.0
        dx = (after[0] + after[2] / 2) - (before[0] + before[2] / 2)
        dy = (after[1] + after[3] / 2) - (before[1] + before[3] / 2)
        observations.append({
            "observation_id": f"batch_transform_{index:03d}",
            "type": "batch_layout_transform",
            "time_range_ms": [min(item["start_ms"] for item in batch), max(item["end_ms"] for item in batch)],
            "member_object_ids": [item["object_id"] for item in batch],
            "member_count": len(batch),
            "before_bounds": {"x": before[0], "y": before[1], "width": before[2], "height": before[3]},
            "after_bounds": {"x": after[0], "y": after[1], "width": after[2], "height": after[3]},
            "net_delta": {"x": dx, "y": dy},
            "net_scale": {"x": scale_x, "y": scale_y},
            "assertion_level": "observation",
            "constraint": "layout_change_does_not_establish_priority_or_intent",
        })
    return observations


def _review_mark_candidates(package: dict[str, Any], captions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep selected image-review marks as unresolved, artifact-relative facts."""
    candidates: list[dict[str, Any]] = []
    caption_ids = {item.get("caption_id") for item in captions if isinstance(item.get("caption_id"), str)}
    for raw in package.get("review_items") or []:
        if not isinstance(raw, dict) or raw.get("assertion_level") != "observation":
            continue
        if raw.get("resolution_status") != "unresolved" or raw.get("coordinate_space") != "base_artifact":
            continue
        artifact_id = raw.get("artifact_object_id")
        region = raw.get("region")
        if not isinstance(artifact_id, str) or not isinstance(region, dict):
            continue
        evidence_caption_ids = [
            item for item in raw.get("evidence_caption_ids", [])
            if isinstance(item, str) and item in caption_ids
        ]
        speech_link_status = "linked" if raw.get("speech_link_status") == "linked" and evidence_caption_ids else "unavailable"
        candidates.append({
            "review_id": raw.get("review_id"),
            "artifact_object_id": artifact_id,
            "coordinate_space": "base_artifact",
            "region": region,
            "instruction": raw.get("instruction") if speech_link_status == "linked" and isinstance(raw.get("instruction"), str) else None,
            "evidence_caption_ids": evidence_caption_ids,
            "speech_link_status": speech_link_status,
            "assertion_level": "observation",
            "resolution_status": "unresolved",
            "constraint": "review_mark_does_not_establish_requested_edit_without_linked_speech",
        })
    return candidates[:24]


def _view_transform_observations(package: dict[str, Any]) -> list[dict[str, Any]]:
    """Retain viewport pan/zoom separately from scene object transforms."""
    observations: list[dict[str, Any]] = []
    for raw in package.get("view_transformations") or []:
        if not isinstance(raw, dict):
            continue
        if raw.get("type") != "view_transform" or raw.get("assertion_level") != "observation":
            continue
        if raw.get("coordinate_space") != "viewport_transform":
            continue
        before, after = raw.get("before"), raw.get("after")
        if not isinstance(before, dict) or not isinstance(after, dict):
            continue
        observations.append({
            "observation_id": raw.get("observation_id"),
            "type": "view_transform",
            "time_range_ms": raw.get("time_range_ms"),
            "kind": raw.get("kind") if raw.get("kind") in {"zoom", "pan", "zoom_pan"} else "pan",
            "before": before,
            "after": after,
            "sample_count": raw.get("sample_count"),
            "coordinate_space": "viewport_transform",
            "assertion_level": "observation",
            "constraint": "view_transform_does_not_establish_attention_or_priority",
        })
    return observations[:48]


def _temporal_extent(
    package: dict[str, Any],
    captions: list[dict[str, Any]],
    events: list[dict[str, Any]],
    gestures: list[dict[str, Any]],
) -> dict[str, Any]:
    """Compare reported session duration with direct timestamp evidence.

    Reported duration is UI metadata.  It must never manufacture a pause or
    truncate later ASR/canvas timestamps, which can arrive asynchronously.
    """
    meta = package.get("meta") or {}
    declared = meta.get("duration_ms", package.get("duration_ms"))
    declared_ms = int(declared) if isinstance(declared, (int, float)) and declared > 0 else None
    observed = [
        int(caption.get("end_ms", caption.get("start_ms", 0)) or 0)
        for caption in captions
    ]
    observed += [int(event.get("timestamp_ms", 0) or 0) for event in events]
    observed += [int(gesture.get("end_ms", gesture.get("start_ms", 0)) or 0) for gesture in gestures]
    for stroke in package.get("strokes") or []:
        if not isinstance(stroke, dict):
            continue
        start = int(stroke.get("timestamp_ms", 0) or 0)
        duration = stroke.get("duration_ms", 0)
        observed.append(start + int(duration) if isinstance(duration, (int, float)) else start)
    observed_end_ms = max(observed, default=0)
    if not observed_end_ms:
        status = "missing_observed_timestamps"
        delta_ms = None
    elif declared_ms is None:
        status = "missing_declared_duration"
        delta_ms = None
    else:
        delta_ms = observed_end_ms - declared_ms
        if abs(delta_ms) <= 2_000:
            status = "consistent"
        elif delta_ms > 0:
            status = "declared_shorter_than_observed"
        else:
            status = "declared_longer_than_observed"
    return {
        "declared_duration_ms": declared_ms,
        "observed_end_ms": observed_end_ms,
        "delta_ms": delta_ms,
        "status": status,
        "inference_time_authority": "direct_timestamped_events",
    }


OCR_MODEL_CONTEXT_POLICY = "review_only_pending_cross_modal_validation"


def _ocr_observations(package: dict[str, Any]) -> list[dict[str, Any]]:
    """Retain browser-local OCR as bounded, non-authoritative observations.

    OCR boxes are expressed in the exported image coordinate system.  Until a
    crop-to-canvas transform is explicitly recorded, they must not be merged
    into canvas object identity or used for reference resolution.
    """
    # PP-OCRv5 produced high-confidence false positives on real freehand
    # writing (for example, "文字识别" -> "移多。" at 0.888). Until a later
    # cross-modal validator is measured on an independent holdout, raw OCR is
    # export-only review evidence and is intentionally absent from model input.
    return []


def _reference_candidates(
    captions: list[dict[str, Any]],
    events: list[dict[str, Any]],
    objects: list[dict[str, Any]],
    gestures: list[dict[str, Any]],
    review_items: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Expose deictic speech as unresolved, inspectable candidate associations.

    This is deliberately not a resolver.  A user saying “这个” might mean an
    off-canvas concept, a line, or a cluster; time adjacency and a pointer hit
    merely produce candidates.  The candidates do not alter object state or
    semantic events until a separately evaluated resolver earns that right.
    """
    object_ids = {obj.get("object_id") for obj in objects if obj.get("object_id")}
    review_items = review_items or []
    candidates = []
    for index, caption in enumerate(captions, start=1):
        text = caption.get("text", "")
        if not isinstance(text, str) or not REFERENCE_RE.search(text):
            continue
        start = int(caption.get("start_ms", 0) or 0)
        end = int(caption.get("end_ms", start) or start)
        midpoint = (start + end) // 2
        support: dict[str, set[str]] = {}
        # Keep each dwell as separate evidence.  A single utterance may contain
        # more than one deictic reference ("这里和这里"), and collapsing two
        # cursor stops into only `pointer_hit` loses the ordering needed by a
        # later, evidence-bounded resolver.
        pointer_evidence: dict[str, list[dict[str, Any]]] = {}

        for gesture in gestures:
            hit_id = gesture.get("hit_object_id")
            gesture_time = int(gesture.get("end_ms", gesture.get("start_ms", 0)) or 0)
            if hit_id in object_ids and abs(gesture_time - midpoint) <= 4_000:
                support.setdefault(hit_id, set()).add("pointer_hit")
                pointer_evidence.setdefault(hit_id, []).append({
                    "gesture_id": gesture.get("gesture_id", ""),
                    "start_ms": int(gesture.get("start_ms", gesture_time) or gesture_time),
                    "end_ms": gesture_time,
                    "dwell_ms": int(gesture.get("dwell_ms", 0) or 0),
                })
        for event in events:
            object_id = event.get("object_id")
            event_time = int(event.get("timestamp_ms", 0) or 0)
            if object_id in object_ids and abs(event_time - midpoint) <= 4_000:
                support.setdefault(object_id, set()).add("nearby_canvas_action")
        # A mark that overlaps an imported material is already preserved as a
        # review item by the browser compiler. When its timestamped speech link
        # contains this caption, surface the material itself as a candidate too
        # rather than making the later reader infer it from a separate list.
        # This remains an unresolved association: a circle can identify a
        # region without proving the requested edit or a unique referent.
        for item in review_items:
            artifact_id = item.get("artifact_object_id")
            caption_ids = item.get("evidence_caption_ids") or []
            if artifact_id in object_ids and caption.get("caption_id") in caption_ids:
                support.setdefault(artifact_id, set()).add("material_relative_mark")
        for obj in objects:
            object_id = obj.get("object_id")
            timestamp = int(obj.get("timestamp_ms", 0) or 0)
            if object_id in object_ids and abs(timestamp - midpoint) <= 2_000:
                support.setdefault(object_id, set()).add("recent_object_creation")

        ranked = sorted(
            (
                {
                    "object_id": object_id,
                    "support": sorted(reasons),
                    "support_count": len(reasons),
                    **({"pointer_evidence": sorted(pointer_evidence[object_id], key=lambda item: (item["start_ms"], item["gesture_id"]))}
                       if object_id in pointer_evidence else {}),
                }
                for object_id, reasons in support.items()
            ),
            key=lambda item: (-item["support_count"], item["object_id"]),
        )[:5]
        candidates.append(
            {
                "reference_id": f"ref_{index:03d}",
                "caption_id": caption.get("caption_id", f"cap_{index:03d}"),
                "time_range_ms": [start, end],
                "surface_text": text,
                "candidate_objects": ranked,
                "resolution_status": "unresolved",
                "assertion_level": "observation",
                "constraint": "candidate_association_is_not_object_binding",
            }
        )
    return candidates


def _distance_to_rect(x: float, y: float, rect: tuple[float, float, float, float]) -> float:
    left, top, width, height = rect
    right, bottom = left + width, top + height
    dx = max(left - x, 0.0, x - right)
    dy = max(top - y, 0.0, y - bottom)
    return (dx * dx + dy * dy) ** 0.5


def _point(point: Any) -> tuple[float, float] | None:
    if not isinstance(point, dict):
        return None
    try:
        return float(point["x"]), float(point["y"])
    except (KeyError, TypeError, ValueError):
        return None


def _ink_relation_candidates(
    package: dict[str, Any],
    objects: list[dict[str, Any]],
    visual_unit_candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Find only unresolved connection geometry from complete hand-drawn traces.

    This is deliberately narrower than arrow recognition: a nearly straight
    stroke whose two endpoints reach distinct non-source objects becomes a
    connection *candidate*. It has no direction, causal label, or object-state
    effect. Human sketches with arrowheads, loops, or free-form marks need a
    later, separately evaluated recognizer.
    """
    indexed = []
    for obj in objects:
        object_id = obj.get("object_id")
        rect = _rect(obj)
        if object_id and rect:
            indexed.append((obj, rect))
    # A freehand box, character, or other compound mark has several raw
    # tldraw draw shapes.  Its sides must not become a relation merely because
    # each endpoint is near a different side.  Unit membership is an
    # auditable geometric grouping, not a semantic object identity.
    object_unit_ids = {
        object_id: unit.get("unit_id")
        for unit in visual_unit_candidates
        for object_id in unit.get("member_object_ids") or []
        if isinstance(object_id, str) and isinstance(unit.get("unit_id"), str)
    }
    candidates = []
    for stroke in package.get("strokes") or []:
        if not isinstance(stroke, dict):
            continue
        points = [point for point in (_point(raw) for raw in stroke.get("points") or []) if point]
        if len(points) < 2:
            continue
        start, end = points[0], points[-1]
        direct_distance = ((end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2) ** 0.5
        if direct_distance < 40:
            continue
        path_length = sum(
            ((right[0] - left[0]) ** 2 + (right[1] - left[1]) ** 2) ** 0.5
            for left, right in zip(points, points[1:])
        )
        if path_length <= 0 or path_length / direct_distance > 1.35:
            continue
        stroke_id = stroke.get("stroke_id")
        source_object_ids = {
            obj.get("object_id")
            for obj, _ in indexed
            if stroke_id and stroke_id in (obj.get("source_strokes") or [])
        }
        destinations = [item for item in indexed if item[0].get("object_id") not in source_object_ids]
        if not destinations:
            continue
        start_obj, start_rect = min(destinations, key=lambda item: _distance_to_rect(*start, item[1]))
        end_obj, end_rect = min(destinations, key=lambda item: _distance_to_rect(*end, item[1]))
        start_distance = _distance_to_rect(*start, start_rect)
        end_distance = _distance_to_rect(*end, end_rect)
        start_object_id = start_obj.get("object_id")
        end_object_id = end_obj.get("object_id")
        if start_object_id == end_object_id or max(start_distance, end_distance) > 35:
            continue
        start_unit_id = object_unit_ids.get(start_object_id)
        end_unit_id = object_unit_ids.get(end_object_id)
        if start_unit_id is not None and start_unit_id == end_unit_id:
            continue
        candidates.append(
            {
                "relation_id": f"ink_rel_{len(candidates) + 1:03d}",
                "stroke_id": stroke_id,
                "relation": "unresolved_handdrawn_connection",
                "endpoint_candidates": {
                    "start_object_id": start_object_id,
                    "end_object_id": end_object_id,
                    "start_distance": round(start_distance, 2),
                    "end_distance": round(end_distance, 2),
                },
                "geometry": {
                    "point_count": len(points),
                    "direct_distance": round(direct_distance, 2),
                    "path_to_direct_ratio": round(path_length / direct_distance, 3),
                },
                "resolution_status": "unresolved",
                "assertion_level": "observation",
                "constraint": "connection_geometry_does_not_establish_direction_or_semantic_relation",
            }
        )
        if len(candidates) >= MAX_INK_RELATION_CANDIDATES:
            break
    return candidates


def _ink_circle_candidates(package: dict[str, Any], objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Record closed hand-drawn loops that spatially enclose canvas objects.

    A loop is an observable mark, not proof that the enclosed object was
    selected, approved, rejected, or even intentionally circled.  Keeping the
    enclosing geometry gives a later resolver a concrete counterpart for
    deictic speech without silently upgrading a sketch into semantics.
    """
    indexed = [(obj, _rect(obj)) for obj in objects]
    indexed = [(obj, rect) for obj, rect in indexed if obj.get("object_id") and rect]
    candidates = []
    for stroke in package.get("strokes") or []:
        if not isinstance(stroke, dict):
            continue
        points = [point for point in (_point(raw) for raw in stroke.get("points") or []) if point]
        if len(points) < 6:
            continue
        xs, ys = zip(*points)
        min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
        width, height = max_x - min_x, max_y - min_y
        diagonal = (width * width + height * height) ** 0.5
        if min(width, height) < 40 or diagonal <= 0:
            continue
        closure_distance = ((points[-1][0] - points[0][0]) ** 2 + (points[-1][1] - points[0][1]) ** 2) ** 0.5
        if closure_distance > max(36.0, diagonal * 0.12):
            continue
        path_length = _path_length(points)
        if path_length / diagonal < 1.7:
            continue
        stroke_id = stroke.get("stroke_id")
        source_object_ids = {
            obj.get("object_id")
            for obj, _ in indexed
            if stroke_id and stroke_id in (obj.get("source_strokes") or [])
        }
        enclosed = []
        for obj, rect in indexed:
            object_id = obj.get("object_id")
            x, y, object_width, object_height = rect
            center_x, center_y = x + object_width / 2, y + object_height / 2
            if object_id in source_object_ids:
                continue
            if min_x <= center_x <= max_x and min_y <= center_y <= max_y:
                enclosed.append((object_width * object_height, object_id))
        if not enclosed:
            continue
        enclosed.sort(key=lambda item: (-item[0], item[1]))
        candidates.append({
            "circle_id": f"ink_circle_{len(candidates) + 1:03d}",
            "stroke_id": stroke_id,
            "relation": "unresolved_handdrawn_circle",
            "candidate_object_ids": [object_id for _, object_id in enclosed[:5]],
            "geometry": {
                "point_count": len(points),
                "bounds": {"x": round(min_x, 2), "y": round(min_y, 2), "width": round(width, 2), "height": round(height, 2)},
                "closure_distance": round(closure_distance, 2),
                "path_to_diagonal_ratio": round(path_length / diagonal, 3),
            },
            "resolution_status": "unresolved",
            "assertion_level": "observation",
            "constraint": "closed_ink_geometry_does_not_establish_selection_or_intent",
        })
        if len(candidates) >= MAX_INK_CIRCLE_CANDIDATES:
            break
    return candidates


def _path_length(points: list[tuple[float, float]]) -> float:
    return sum(
        ((right[0] - left[0]) ** 2 + (right[1] - left[1]) ** 2) ** 0.5
        for left, right in zip(points, points[1:])
    )


def _segment_intersection(
    start_a: tuple[float, float], end_a: tuple[float, float],
    start_b: tuple[float, float], end_b: tuple[float, float],
) -> tuple[float, float, float, float] | None:
    """Return an interior segment intersection as x, y, t, u when present."""
    ax, ay = start_a
    bx, by = end_a
    cx, cy = start_b
    dx, dy = end_b
    rx, ry = bx - ax, by - ay
    sx, sy = dx - cx, dy - cy
    denominator = rx * sy - ry * sx
    if abs(denominator) < 1e-6:
        return None
    qpx, qpy = cx - ax, cy - ay
    t = (qpx * sy - qpy * sx) / denominator
    u = (qpx * ry - qpy * rx) / denominator
    if not 0.15 <= t <= 0.85 or not 0.15 <= u <= 0.85:
        return None
    return ax + t * rx, ay + t * ry, t, u


def _ink_cross_candidates(package: dict[str, Any], objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Record intersecting straight strokes without naming their meaning.

    The visual result may be an X glyph, a crossing of two connections, or a
    markup symbol. Geometry alone cannot distinguish those readings, so this
    layer records only the intersection and never calls it a rejection mark.
    """
    traces = []
    for stroke in package.get("strokes") or []:
        if not isinstance(stroke, dict) or not isinstance(stroke.get("stroke_id"), str):
            continue
        points = [point for point in (_point(raw) for raw in stroke.get("points") or []) if point]
        if len(points) < 2:
            continue
        start, end = points[0], points[-1]
        direct = ((end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2) ** 0.5
        path = _path_length(points)
        if direct < 24 or path <= 0 or path / direct > 1.35:
            continue
        traces.append((stroke["stroke_id"], start, end, direct))

    indexed = [(obj, _rect(obj)) for obj in objects]
    indexed = [(obj, rect) for obj, rect in indexed if obj.get("object_id") and rect]
    candidates = []
    for left_index, (left_id, left_start, left_end, left_length) in enumerate(traces):
        left_vector = (left_end[0] - left_start[0], left_end[1] - left_start[1])
        for right_id, right_start, right_end, right_length in traces[left_index + 1:]:
            intersection = _segment_intersection(left_start, left_end, right_start, right_end)
            if not intersection:
                continue
            right_vector = (right_end[0] - right_start[0], right_end[1] - right_start[1])
            cosine = (left_vector[0] * right_vector[0] + left_vector[1] * right_vector[1]) / (left_length * right_length)
            # X arms should visibly diverge. This rejects parallel/doubled ink.
            if abs(cosine) > 0.75:
                continue
            x, y, left_t, right_t = intersection
            source_ids = {left_id, right_id}
            targets = []
            for obj, rect in indexed:
                object_id = obj.get("object_id")
                if object_id in source_ids or source_ids.intersection(obj.get("source_strokes") or []):
                    continue
                ox, oy, width, height = rect
                if ox <= x <= ox + width and oy <= y <= oy + height:
                    targets.append((width * height, object_id))
            if not targets:
                continue
            targets.sort(key=lambda item: (item[0], item[1]))
            candidates.append({
                "cross_id": f"ink_cross_{len(candidates) + 1:03d}",
                "type": "unresolved_intersecting_stroke_pair",
                "stroke_ids": [left_id, right_id],
                "candidate_object_ids": [object_id for _, object_id in targets[:5]],
                "geometry": {
                    "intersection": {"x": round(x, 2), "y": round(y, 2)},
                    "arm_lengths": [round(left_length, 2), round(right_length, 2)],
                    "arm_angle_cosine": round(cosine, 3),
                    "intersection_progress": [round(left_t, 3), round(right_t, 3)],
                },
                "resolution_status": "unresolved",
                "assertion_level": "observation",
                "constraint": "intersecting_strokes_do_not_establish_letterform_markup_or_intent_without_other_evidence",
            })
            if len(candidates) >= MAX_INK_CROSS_CANDIDATES:
                return candidates
    return candidates


def _ink_check_candidates(package: dict[str, Any], objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Record a single-stroke check-like bend without interpreting approval.

    A check glyph has a short descending arm followed by a longer ascending
    arm in screen coordinates. It can still be a V-like letterform or a piece
    of a sketch; this is only a shape observation for later cross-modal use.
    """
    indexed = [(obj, _rect(obj)) for obj in objects]
    indexed = [(obj, rect) for obj, rect in indexed if obj.get("object_id") and rect]
    candidates = []
    for stroke in package.get("strokes") or []:
        if not isinstance(stroke, dict) or not isinstance(stroke.get("stroke_id"), str):
            continue
        points = [point for point in (_point(raw) for raw in stroke.get("points") or []) if point]
        if len(points) < 3:
            continue
        start, end = points[0], points[-1]
        pivot_index = max(range(1, len(points) - 1), key=lambda index: points[index][1])
        pivot = points[pivot_index]
        first = (pivot[0] - start[0], pivot[1] - start[1])
        second = (end[0] - pivot[0], end[1] - pivot[1])
        first_length = (first[0] ** 2 + first[1] ** 2) ** 0.5
        second_length = (second[0] ** 2 + second[1] ** 2) ** 0.5
        progress = pivot_index / (len(points) - 1)
        if (
            first_length < 16 or second_length < 28 or second_length < first_length * 1.25
            or not (0.08 <= progress <= 0.68)
            or first[0] < 6 or first[1] < 6 or second[0] < 12 or second[1] > -6
        ):
            continue
        source_id = stroke["stroke_id"]
        targets = []
        for obj, rect in indexed:
            object_id = obj.get("object_id")
            if object_id == source_id or source_id in (obj.get("source_strokes") or []):
                continue
            ox, oy, width, height = rect
            if ox <= pivot[0] <= ox + width and oy <= pivot[1] <= oy + height:
                targets.append((width * height, object_id))
        if not targets:
            continue
        targets.sort(key=lambda item: (item[0], item[1]))
        candidates.append({
            "check_id": f"ink_check_{len(candidates) + 1:03d}",
            "type": "unresolved_checklike_stroke",
            "stroke_id": source_id,
            "candidate_object_ids": [object_id for _, object_id in targets[:5]],
            "geometry": {
                "pivot": {"x": round(pivot[0], 2), "y": round(pivot[1], 2)},
                "arm_lengths": [round(first_length, 2), round(second_length, 2)],
                "pivot_progress": round(progress, 3),
            },
            "resolution_status": "unresolved",
            "assertion_level": "observation",
            "constraint": "checklike_geometry_does_not_establish_approval_or_retention_without_other_evidence",
        })
        if len(candidates) >= MAX_INK_CHECK_CANDIDATES:
            return candidates
    return candidates


def _paired_symbol_choice_candidates(
    crosses: list[dict[str, Any]], checks: list[dict[str, Any]], objects: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Record the conventional X/✓ contrast when it occurs on peer objects.

    The pair is materially stronger than either symbol in isolation, but it is
    still a visual-convention candidate, not a command to mutate the canvas or
    a user's work. A later resolver can combine it with speech or task context.
    """
    objects_by_id = {obj.get("object_id"): obj for obj in objects if obj.get("object_id")}
    candidates = []
    for cross in crosses:
        for check in checks:
            for negative_id in cross.get("candidate_object_ids") or []:
                negative = objects_by_id.get(negative_id)
                negative_rect = _rect(negative or {})
                if not negative_rect:
                    continue
                for positive_id in check.get("candidate_object_ids") or []:
                    if positive_id == negative_id:
                        continue
                    positive = objects_by_id.get(positive_id)
                    positive_rect = _rect(positive or {})
                    if not positive_rect:
                        continue
                    negative_area = negative_rect[2] * negative_rect[3]
                    positive_area = positive_rect[2] * positive_rect[3]
                    if min(negative_area, positive_area) <= 0 or max(negative_area, positive_area) / min(negative_area, positive_area) > 3.0:
                        continue
                    candidates.append({
                        "choice_id": f"paired_symbol_choice_{len(candidates) + 1:03d}",
                        "type": "unresolved_paired_symbol_choice",
                        "negative_symbol": {"kind": "intersecting_stroke_pair", "object_id": negative_id, "source_id": cross.get("cross_id")},
                        "positive_symbol": {"kind": "checklike_stroke", "object_id": positive_id, "source_id": check.get("check_id")},
                        "candidate_outcome_mapping": {
                            "negative_object_id": negative_id,
                            "positive_object_id": positive_id,
                            "convention": "x_vs_check",
                        },
                        "resolution_status": "unresolved",
                        "assertion_level": "observation",
                        "constraint": "paired_x_and_check_are_a_visual_convention_candidate_not_an_executable_instruction",
                    })
    return candidates


def _ink_annotation_candidates(
    package: dict[str, Any], objects: list[dict[str, Any]], circles: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Extract conservative, object-bound board annotation shapes.

    These are deliberately visual candidates: a line through an object may be
    a strike-through, an underline, or a layout rule; a caret may be writing.
    Consumers receive shape and target evidence, never an automatic mutation.
    """
    indexed = [(obj, _rect(obj)) for obj in objects]
    indexed = [(obj, rect) for obj, rect in indexed if obj.get("object_id") and rect]
    strokes: list[tuple[str, list[tuple[float, float]]]] = []
    for stroke in package.get("strokes") or []:
        if not isinstance(stroke, dict) or not isinstance(stroke.get("stroke_id"), str):
            continue
        points = [point for point in (_point(raw) for raw in stroke.get("points") or []) if point]
        if len(points) >= 2:
            strokes.append((stroke["stroke_id"], points))

    candidates: list[dict[str, Any]] = []
    def emit(kind: str, stroke_ids: list[str], object_ids: list[str], geometry: dict[str, Any], constraint: str) -> None:
        if not object_ids or len(candidates) >= MAX_INK_ANNOTATION_CANDIDATES:
            return
        candidates.append({
            "mark_id": f"ink_mark_{len(candidates) + 1:03d}",
            "kind": kind,
            "stroke_ids": stroke_ids,
            "candidate_object_ids": object_ids[:5],
            "geometry": geometry,
            "resolution_status": "unresolved",
            "assertion_level": "observation",
            "constraint": constraint,
        })

    # Closed loops are enclosure candidates whether they look circular, boxed,
    # or lasso-like. The existing circle detector supplies the target evidence.
    for circle in circles:
        emit(
            "enclosure_like", [circle.get("stroke_id", "")], circle.get("candidate_object_ids") or [],
            circle.get("geometry") or {},
            "enclosure_geometry_does_not_establish_selection_or_grouping_intent",
        )

    straight: list[tuple[str, tuple[float, float], tuple[float, float], float, float]] = []
    for stroke_id, points in strokes:
        start, end = points[0], points[-1]
        direct = ((end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2) ** 0.5
        path = _path_length(points)
        if direct >= 24 and path > 0 and path / direct <= 1.35:
            straight.append((stroke_id, start, end, direct, path / direct))

    for stroke_id, start, end, direct, ratio in straight:
        dx, dy = end[0] - start[0], end[1] - start[1]
        # A nearly horizontal stroke gets a distinct target-relative reading.
        if abs(dy) <= direct * 0.3:
            for obj, rect in indexed:
                object_id = obj.get("object_id")
                if stroke_id in (obj.get("source_strokes") or []):
                    continue
                x, y, width, height = rect
                if width < 24 or height < 10 or min(start[0], end[0]) > x + width * 0.3 or max(start[0], end[0]) < x + width * 0.7:
                    continue
                mid_x = x + width / 2
                t = 0.5 if abs(dx) < 1e-6 else (mid_x - start[0]) / dx
                if not 0 <= t <= 1:
                    continue
                line_y = start[1] + t * dy
                relative_y = (line_y - y) / height
                geometry = {"relative_y": round(relative_y, 3), "path_to_direct_ratio": round(ratio, 3)}
                if 0.24 <= relative_y <= 0.76:
                    emit("strikethrough_like", [stroke_id], [object_id], geometry, "strikethrough_geometry_does_not_establish_removal_without_other_evidence")
                elif 0.86 <= relative_y <= 1.22:
                    emit("underline_like", [stroke_id], [object_id], geometry, "underline_geometry_does_not_establish_emphasis_without_other_evidence")

    # Plus-like pairs are distinguished from X-like pairs by horizontal and
    # vertical arms. Their semantics remain deliberately unspecified.
    for left_index, (left_id, left_start, left_end, left_length, _) in enumerate(straight):
        left_dx, left_dy = left_end[0] - left_start[0], left_end[1] - left_start[1]
        for right_id, right_start, right_end, right_length, _ in straight[left_index + 1:]:
            intersection = _segment_intersection(left_start, left_end, right_start, right_end)
            if not intersection:
                continue
            right_dx, right_dy = right_end[0] - right_start[0], right_end[1] - right_start[1]
            horizontal_vertical = (
                abs(left_dy) <= left_length * 0.3 and abs(right_dx) <= right_length * 0.3
            ) or (
                abs(right_dy) <= right_length * 0.3 and abs(left_dx) <= left_length * 0.3
            )
            if not horizontal_vertical:
                continue
            ix, iy, _, _ = intersection
            targets = []
            for obj, rect in indexed:
                if {left_id, right_id}.intersection(obj.get("source_strokes") or []):
                    continue
                x, y, width, height = rect
                if x <= ix <= x + width and y <= iy <= y + height:
                    targets.append((width * height, obj.get("object_id")))
            targets.sort(key=lambda item: (item[0], item[1]))
            emit("plus_like", [left_id, right_id], [object_id for _, object_id in targets], {"intersection": {"x": round(ix, 2), "y": round(iy, 2)}}, "plus_geometry_does_not_establish_addition_without_other_evidence")

    # A caret is a single V with its pivot above both ends, commonly used near
    # an insertion point. It is intentionally separate from the check-like V.
    for stroke_id, points in strokes:
        if len(points) < 3:
            continue
        pivot_index = min(range(1, len(points) - 1), key=lambda index: points[index][1])
        pivot = points[pivot_index]
        start, end = points[0], points[-1]
        left = (start[0] - pivot[0], start[1] - pivot[1])
        right = (end[0] - pivot[0], end[1] - pivot[1])
        if min(left[1], right[1]) < 8 or abs(left[0]) < 6 or abs(right[0]) < 6:
            continue
        if not 0.12 <= pivot_index / (len(points) - 1) <= 0.88:
            continue
        targets = []
        for obj, rect in indexed:
            if stroke_id in (obj.get("source_strokes") or []):
                continue
            x, y, width, height = rect
            if x - 24 <= pivot[0] <= x + width + 24 and y - 24 <= pivot[1] <= y + height + 24:
                targets.append((width * height, obj.get("object_id")))
        targets.sort(key=lambda item: (item[0], item[1]))
        emit("caret_like", [stroke_id], [object_id for _, object_id in targets], {"pivot": {"x": round(pivot[0], 2), "y": round(pivot[1], 2)}}, "caret_geometry_does_not_establish_insertion_without_other_evidence")

    # A bracket-like stroke hugs one side of an object without closing around
    # it. This is useful for grouping or commenting, but never proves either.
    for stroke_id, points in strokes:
        if len(points) < 3:
            continue
        min_x, max_x = min(point[0] for point in points), max(point[0] for point in points)
        min_y, max_y = min(point[1] for point in points), max(point[1] for point in points)
        mark_width, mark_height = max_x - min_x, max_y - min_y
        path = _path_length(points)
        direct = ((points[-1][0] - points[0][0]) ** 2 + (points[-1][1] - points[0][1]) ** 2) ** 0.5
        if mark_height < 28 or mark_width <= 0 or mark_height / mark_width < 1.4 or direct <= 0 or path / direct < 1.15:
            continue
        targets = []
        for obj, rect in indexed:
            if stroke_id in (obj.get("source_strokes") or []):
                continue
            x, y, width, height = rect
            vertical_overlap = max(0.0, min(max_y, y + height) - max(min_y, y)) / height if height else 0
            near_left = abs((min_x + max_x) / 2 - x) <= width * 0.32
            near_right = abs((min_x + max_x) / 2 - (x + width)) <= width * 0.32
            if vertical_overlap >= 0.6 and (near_left or near_right):
                targets.append((width * height, obj.get("object_id")))
        targets.sort(key=lambda item: (item[0], item[1]))
        emit("bracket_like", [stroke_id], [object_id for _, object_id in targets], {"bounds": {"x": round(min_x, 2), "y": round(min_y, 2), "width": round(mark_width, 2), "height": round(mark_height, 2)}}, "bracket_geometry_does_not_establish_grouping_or_comment_scope_without_other_evidence")

    # A question mark normally consists of a hook and a separated dot. We only
    # record the pair when their relative layout is unambiguous; handwriting
    # recognition remains the final arbiter for literal text.
    short_strokes = []
    for stroke_id, points in strokes:
        path = _path_length(points)
        min_x, max_x = min(point[0] for point in points), max(point[0] for point in points)
        min_y, max_y = min(point[1] for point in points), max(point[1] for point in points)
        if path <= 18 and max(max_x - min_x, max_y - min_y) <= 12:
            short_strokes.append((stroke_id, (min_x + max_x) / 2, (min_y + max_y) / 2))
    for hook_id, hook in strokes:
        if len(hook) < 3:
            continue
        min_x, max_x = min(point[0] for point in hook), max(point[0] for point in hook)
        min_y, max_y = min(point[1] for point in hook), max(point[1] for point in hook)
        if max_x - min_x < 12 or max_y - min_y < 20 or _path_length(hook) < 28:
            continue
        for dot_id, dot_x, dot_y in short_strokes:
            if dot_id == hook_id or not (min_x - 16 <= dot_x <= max_x + 16 and max_y + 4 <= dot_y <= max_y + 42):
                continue
            targets = []
            for obj, rect in indexed:
                if {hook_id, dot_id}.intersection(obj.get("source_strokes") or []):
                    continue
                x, y, width, height = rect
                if x - 48 <= dot_x <= x + width + 48 and y - 48 <= (min_y + dot_y) / 2 <= y + height + 48:
                    targets.append((width * height, obj.get("object_id")))
            targets.sort(key=lambda item: (item[0], item[1]))
            emit("question_like", [hook_id, dot_id], [object_id for _, object_id in targets], {"hook_bounds": {"x": round(min_x, 2), "y": round(min_y, 2), "width": round(max_x - min_x, 2), "height": round(max_y - min_y, 2)}}, "question_geometry_does_not_establish_uncertainty_without_other_evidence")

    # Dense self-crossing ink over an object is often a scribble/cross-out.
    for stroke_id, points in strokes:
        if len(points) < 7:
            continue
        direct = ((points[-1][0] - points[0][0]) ** 2 + (points[-1][1] - points[0][1]) ** 2) ** 0.5
        path = _path_length(points)
        if direct <= 0 or path / direct < 2.4:
            continue
        intersections = 0
        for index in range(len(points) - 1):
            for other in range(index + 3, len(points) - 1):
                if _segment_intersection(points[index], points[index + 1], points[other], points[other + 1]):
                    intersections += 1
        turns = 0
        for previous, current, following in zip(points, points[1:], points[2:]):
            first = (current[0] - previous[0], current[1] - previous[1])
            second = (following[0] - current[0], following[1] - current[1])
            first_length = (first[0] ** 2 + first[1] ** 2) ** 0.5
            second_length = (second[0] ** 2 + second[1] ** 2) ** 0.5
            if first_length and second_length and (first[0] * second[0] + first[1] * second[1]) / (first_length * second_length) < 0.45:
                turns += 1
        if intersections < 2 and turns < 2:
            continue
        min_x, max_x = min(point[0] for point in points), max(point[0] for point in points)
        min_y, max_y = min(point[1] for point in points), max(point[1] for point in points)
        targets = []
        for obj, rect in indexed:
            if stroke_id in (obj.get("source_strokes") or []):
                continue
            x, y, width, height = rect
            center_x, center_y = x + width / 2, y + height / 2
            if min_x <= center_x <= max_x and min_y <= center_y <= max_y:
                targets.append((width * height, obj.get("object_id")))
        targets.sort(key=lambda item: (item[0], item[1]))
        emit("scribble_like", [stroke_id], [object_id for _, object_id in targets], {"self_intersection_count": intersections, "sharp_turn_count": turns}, "scribble_geometry_does_not_establish_removal_without_other_evidence")
    return candidates


def _arrowhead_candidates(
    package: dict[str, Any], relation_candidates: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Detect only arrowhead-*like* geometry attached to a valid hand-drawn shaft.

    A visual tip consists of two short strokes meeting the same shaft endpoint
    and pointing back toward its interior.  The ordered shaft trace makes its
    visual orientation inspectable, but this remains an unresolved visual
    observation: neither causality nor the meaning of either endpoint follows.
    """
    traces: dict[str, list[tuple[float, float]]] = {}
    for stroke in package.get("strokes") or []:
        if not isinstance(stroke, dict) or not isinstance(stroke.get("stroke_id"), str):
            continue
        points = [point for point in (_point(raw) for raw in stroke.get("points") or []) if point]
        if len(points) >= 2:
            traces[stroke["stroke_id"]] = points

    candidates = []
    for relation in relation_candidates:
        shaft_id = relation.get("stroke_id")
        shaft = traces.get(shaft_id)
        if not shaft:
            continue
        shaft_start, shaft_end = shaft[0], shaft[-1]
        shaft_length = ((shaft_end[0] - shaft_start[0]) ** 2 + (shaft_end[1] - shaft_start[1]) ** 2) ** 0.5
        if shaft_length <= 0:
            continue
        for endpoint_name, tip, other, direction in (
            ("path_start", shaft_start, shaft_end, "path_end_to_path_start"),
            ("path_end", shaft_end, shaft_start, "path_start_to_path_end"),
        ):
            interior = ((other[0] - tip[0]) / shaft_length, (other[1] - tip[1]) / shaft_length)
            supports = []
            for support_id, support in traces.items():
                if support_id == shaft_id:
                    continue
                support_length = _path_length(support)
                if not 4 <= support_length <= min(90, shaft_length * 0.55):
                    continue
                first_distance = ((support[0][0] - tip[0]) ** 2 + (support[0][1] - tip[1]) ** 2) ** 0.5
                last_distance = ((support[-1][0] - tip[0]) ** 2 + (support[-1][1] - tip[1]) ** 2) ** 0.5
                if min(first_distance, last_distance) > 18:
                    continue
                free = support[-1] if first_distance <= last_distance else support[0]
                vector = (free[0] - tip[0], free[1] - tip[1])
                vector_length = (vector[0] ** 2 + vector[1] ** 2) ** 0.5
                if vector_length <= 0:
                    continue
                # An arrowhead arm leaves the tip toward the shaft interior.
                alignment = (vector[0] * interior[0] + vector[1] * interior[1]) / vector_length
                if alignment < 0.2:
                    continue
                supports.append({"stroke_id": support_id, "vector": vector, "length": support_length})
            for left_index, left in enumerate(supports):
                for right in supports[left_index + 1:]:
                    left_length = (left["vector"][0] ** 2 + left["vector"][1] ** 2) ** 0.5
                    right_length = (right["vector"][0] ** 2 + right["vector"][1] ** 2) ** 0.5
                    cosine = (
                        left["vector"][0] * right["vector"][0]
                        + left["vector"][1] * right["vector"][1]
                    ) / (left_length * right_length)
                    # 15°..145° accepts a visible V while rejecting a doubled line.
                    if not -0.82 <= cosine <= 0.966:
                        continue
                    endpoints = relation.get("endpoint_candidates", {})
                    tip_object_id = endpoints.get("start_object_id" if endpoint_name == "path_start" else "end_object_id")
                    candidates.append(
                        {
                            "arrowhead_id": f"ink_arrow_{len(candidates) + 1:03d}",
                            "type": "unresolved_handdrawn_arrowhead",
                            "shaft_relation_id": relation.get("relation_id"),
                            "shaft_stroke_id": shaft_id,
                            "support_stroke_ids": [left["stroke_id"], right["stroke_id"]],
                            "tip": {"shaft_endpoint": endpoint_name, "object_id": tip_object_id},
                            "candidate_visual_direction": direction,
                            "geometry": {
                                "shaft_direct_distance": round(shaft_length, 2),
                                "support_lengths": [round(left["length"], 2), round(right["length"], 2)],
                                "arm_angle_cosine": round(cosine, 3),
                            },
                            "resolution_status": "unresolved",
                            "assertion_level": "observation",
                            "constraint": "arrowhead_like_geometry_does_not_establish_causal_or_semantic_relation",
                        }
                    )
                    if len(candidates) >= MAX_INK_ARROWHEAD_CANDIDATES:
                        return candidates
            # A common natural drawing is shaft + one continuous V stroke,
            # rather than two separately lifted arrowhead arms. Its middle
            # point is the tip; both outer endpoints point back into the
            # shaft. Preserve that construction detail as geometry evidence.
            for support_id, support in traces.items():
                if support_id == shaft_id or len(support) < 3:
                    continue
                pivot_index = min(
                    range(1, len(support) - 1),
                    key=lambda index: (support[index][0] - tip[0]) ** 2 + (support[index][1] - tip[1]) ** 2,
                )
                pivot = support[pivot_index]
                pivot_distance = ((pivot[0] - tip[0]) ** 2 + (pivot[1] - tip[1]) ** 2) ** 0.5
                if pivot_distance > 18:
                    continue
                left_vector = (support[0][0] - pivot[0], support[0][1] - pivot[1])
                right_vector = (support[-1][0] - pivot[0], support[-1][1] - pivot[1])
                left_length = (left_vector[0] ** 2 + left_vector[1] ** 2) ** 0.5
                right_length = (right_vector[0] ** 2 + right_vector[1] ** 2) ** 0.5
                if min(left_length, right_length) < 6:
                    continue
                left_alignment = (left_vector[0] * interior[0] + left_vector[1] * interior[1]) / left_length
                right_alignment = (right_vector[0] * interior[0] + right_vector[1] * interior[1]) / right_length
                if min(left_alignment, right_alignment) < 0.2:
                    continue
                cosine = (left_vector[0] * right_vector[0] + left_vector[1] * right_vector[1]) / (left_length * right_length)
                if not -0.82 <= cosine <= 0.966:
                    continue
                endpoints = relation.get("endpoint_candidates", {})
                tip_object_id = endpoints.get("start_object_id" if endpoint_name == "path_start" else "end_object_id")
                candidates.append(
                    {
                        "arrowhead_id": f"ink_arrow_{len(candidates) + 1:03d}",
                        "type": "unresolved_handdrawn_arrowhead",
                        "shaft_relation_id": relation.get("relation_id"),
                        "shaft_stroke_id": shaft_id,
                        "support_stroke_ids": [support_id],
                        "tip": {"shaft_endpoint": endpoint_name, "object_id": tip_object_id},
                        "candidate_visual_direction": direction,
                        "geometry": {
                            "shaft_direct_distance": round(shaft_length, 2),
                            "support_lengths": [round(left_length, 2), round(right_length, 2)],
                            "arm_angle_cosine": round(cosine, 3),
                            "construction": "continuous_v",
                        },
                        "resolution_status": "unresolved",
                        "assertion_level": "observation",
                        "constraint": "arrowhead_like_geometry_does_not_establish_causal_or_semantic_relation",
                    }
                )
                if len(candidates) >= MAX_INK_ARROWHEAD_CANDIDATES:
                    return candidates
    return candidates


def _visual_unit_candidates(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group nearby, temporally contiguous raw marks without assigning meaning.

    Handwritten characters, boxes, and diagrams frequently consist of multiple
    tldraw draw shapes. This creates a visual-unit *candidate* layer between
    raw strokes and semantic concepts. Components are deliberately bounded and
    are never treated as text, a concept, or a graph node until a later module
    has evidence to do so.
    """
    nodes = [
        obj for obj in objects
        if obj.get("object_id") and _rect(obj) is not None
    ]
    parent = list(range(len(nodes)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left, right = find(left), find(right)
        if left != right:
            parent[right] = left

    for left_index, left in enumerate(nodes):
        left_rect = _rect(left)
        left_time = int(left.get("timestamp_ms", 0) or 0)
        for right_index in range(left_index + 1, len(nodes)):
            right = nodes[right_index]
            right_time = int(right.get("timestamp_ms", 0) or 0)
            if abs(left_time - right_time) > VISUAL_UNIT_TIME_WINDOW_MS:
                continue
            right_rect = _rect(right)
            lx, ly, lw, lh = left_rect
            rx, ry, rw, rh = right_rect
            gap_x = max(lx - (rx + rw), rx - (lx + lw), 0.0)
            gap_y = max(ly - (ry + rh), ry - (ly + lh), 0.0)
            if (gap_x * gap_x + gap_y * gap_y) ** 0.5 <= VISUAL_UNIT_GAP_PX:
                union(left_index, right_index)

    components: dict[int, list[dict[str, Any]]] = {}
    for index, node in enumerate(nodes):
        components.setdefault(find(index), []).append(node)
    candidates = []
    for members in components.values():
        if len(members) < 2 or len(members) > MAX_VISUAL_UNIT_MEMBERS:
            continue
        rects = [_rect(member) for member in members]
        left = min(rect[0] for rect in rects)
        top = min(rect[1] for rect in rects)
        right = max(rect[0] + rect[2] for rect in rects)
        bottom = max(rect[1] + rect[3] for rect in rects)
        timestamps = [int(member.get("timestamp_ms", 0) or 0) for member in members]
        candidates.append(
            {
                "unit_id": f"visual_unit_{len(candidates) + 1:03d}",
                "member_object_ids": [member["object_id"] for member in members],
                "bounds": {"x": left, "y": top, "width": right - left, "height": bottom - top},
                "time_range_ms": [min(timestamps), max(timestamps)],
                "support": ["spatial_proximity", "temporal_contiguity"],
                "assertion_level": "observation",
                "resolution_status": "unresolved",
                "constraint": "visual_unit_is_not_text_or_semantic_concept",
            }
        )
    return candidates


def compile_process_ir(
    package: dict[str, Any],
    captions: list[dict[str, Any]],
    events: list[dict[str, Any]],
    objects: list[dict[str, Any]],
) -> dict[str, Any]:
    """Compile raw browser export facts into a language-neutral IR."""
    meta = package.get("meta") or {}
    pointer_track = package.get("pointer_track") or {}
    gestures = pointer_track.get("gestures", []) if isinstance(pointer_track, dict) else []
    event_counts = Counter(event.get("event_type", "unknown") for event in events)
    named_count = sum(_label(obj) is not None for obj in objects)
    spatial_relations = _spatial_relations(objects)
    ink_trace_quality = _ink_trace_quality(package)
    legacy_svg_outline = inspect_legacy_svg_outline(package)
    temporal_extent = _temporal_extent(package, captions, events, gestures)
    ocr_observations = _ocr_observations(package)
    raw_ocr_observation_count = sum(
        1 for item in (package.get("ocr_observations") or []) if isinstance(item, dict)
    )
    review_items = package.get("review_items") if isinstance(package.get("review_items"), list) else []
    reference_candidates = _reference_candidates(captions, events, objects, gestures, review_items)
    visual_unit_candidates = _visual_unit_candidates(objects)
    ink_relation_candidates = _ink_relation_candidates(package, objects, visual_unit_candidates)
    ink_circle_candidates = _ink_circle_candidates(package, objects)
    ink_arrowhead_candidates = _arrowhead_candidates(package, ink_relation_candidates)
    ink_cross_candidates = _ink_cross_candidates(package, objects)
    ink_check_candidates = _ink_check_candidates(package, objects)
    paired_symbol_choice_candidates = _paired_symbol_choice_candidates(ink_cross_candidates, ink_check_candidates, objects)
    ink_annotation_candidates = _ink_annotation_candidates(package, objects, ink_circle_candidates)
    layout_transform_observations = _layout_transform_observations(package, objects)
    review_mark_candidates = _review_mark_candidates(package, captions)
    view_transform_observations = _view_transform_observations(package)
    baseline_context = package.get("baseline_context") if isinstance(package.get("baseline_context"), dict) else None
    constraints = [
        "observation_is_not_psychological_state",
        "pause_does_not_imply_uncertainty",
        "pointer_attention_is_weak_signal_only",
        "object_state_requires_auditable_association",
        "handdrawn_relation_requires_multi_point_trace",
        "reported_duration_is_not_process_evidence",
        "view_transform_does_not_establish_attention_or_priority",
    ]
    if not ink_trace_quality["supports_handdrawn_relation_candidates"]:
        constraints.append("handdrawn_relation_geometry_unavailable")
    if legacy_svg_outline["status"] == "recoverable":
        constraints.append("legacy_svg_outline_is_not_pen_trajectory")
    if baseline_context and baseline_context.get("status") in {"partially_included", "omitted"}:
        constraints.append("omitted_baseline_objects_may_limit_cross_round_interpretation")
    transcript = package.get("transcript") if isinstance(package.get("transcript"), dict) else {}
    declared_alignment = transcript.get("alignment_status")
    transcript_alignment_status = "timestamped" if captions and declared_alignment != "unavailable" else "unavailable"

    return {
        "schema_version": SCHEMA_VERSION,
        "source": {
            "package_id": meta.get("package_id") or package.get("package_id"),
            "language": (package.get("transcript") or {}).get("language"),
            "duration_ms": meta.get("duration_ms") or package.get("duration_ms", 0),
            "content_sha256": canonical_package_sha256(package),
            "compiler_version": COMPILER_VERSION,
            "baseline_context": baseline_context,
            "round_kind": meta.get("round_kind"),
            "transcript_alignment_status": transcript_alignment_status,
        },
        "speech_anchors": captions,
        "canvas_actions": events,
        "objects": [
            {
                "object_id": obj.get("object_id", ""),
                "object_type": obj.get("type", "unknown"),
                "timestamp_ms": obj.get("timestamp_ms", 0),
                "bounds": obj.get("bounds"),
                "label": _label(obj),
                "color": (obj.get("properties") or {}).get("color"),
            }
            for obj in objects
        ],
        "spatial_relations": spatial_relations,
        "reference_candidates": reference_candidates,
        "ink_relation_candidates": ink_relation_candidates,
        "ink_circle_candidates": ink_circle_candidates,
        "ink_arrowhead_candidates": ink_arrowhead_candidates,
        "ink_cross_candidates": ink_cross_candidates,
        "ink_check_candidates": ink_check_candidates,
        "paired_symbol_choice_candidates": paired_symbol_choice_candidates,
        "ink_annotation_candidates": ink_annotation_candidates,
        "visual_unit_candidates": visual_unit_candidates,
        "layout_transform_observations": layout_transform_observations,
        "review_mark_candidates": review_mark_candidates,
        "view_transform_observations": view_transform_observations,
        "attention_signals": [
            {
                "gesture_id": gesture.get("gesture_id", ""),
                "gesture_type": gesture.get("gesture_type", "unknown"),
                "start_ms": gesture.get("start_ms", 0),
                "end_ms": gesture.get("end_ms", gesture.get("start_ms", 0)),
                "hit_object_id": gesture.get("hit_object_id"),
            }
            for gesture in gestures
        ],
        "ocr_observations": ocr_observations,
        "quality": {
            "has_timestamped_transcript": transcript_alignment_status == "timestamped",
            "transcript_alignment_status": transcript_alignment_status,
            "has_canvas_actions": bool(events),
            "has_named_objects": named_count > 0,
            "has_canvas_snapshot": bool((package.get("canvas_snapshot") or {}).get("final")),
            "ocr_raw_observation_count": raw_ocr_observation_count,
            "ocr_observation_count": len(ocr_observations),
            "ocr_model_context_policy": OCR_MODEL_CONTEXT_POLICY,
            "event_type_counts": dict(sorted(event_counts.items())),
            "named_object_count": named_count,
            "spatial_relation_count": len(spatial_relations),
            "reference_candidate_count": len(reference_candidates),
            "ink_relation_candidate_count": len(ink_relation_candidates),
            "ink_circle_candidate_count": len(ink_circle_candidates),
            "ink_arrowhead_candidate_count": len(ink_arrowhead_candidates),
            "ink_cross_candidate_count": len(ink_cross_candidates),
            "ink_check_candidate_count": len(ink_check_candidates),
            "paired_symbol_choice_candidate_count": len(paired_symbol_choice_candidates),
            "ink_annotation_candidate_count": len(ink_annotation_candidates),
            "visual_unit_candidate_count": len(visual_unit_candidates),
            "layout_transform_observation_count": len(layout_transform_observations),
            "review_mark_candidate_count": len(review_mark_candidates),
            "view_transform_observation_count": len(view_transform_observations),
            "baseline_context": baseline_context,
            "ink_trace": ink_trace_quality,
            "legacy_svg_outline": legacy_svg_outline,
            "temporal_extent": temporal_extent,
        },
        "interpretation_constraints": constraints,
    }
