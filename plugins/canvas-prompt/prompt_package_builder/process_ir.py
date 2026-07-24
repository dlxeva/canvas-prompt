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
SCHEMA_VERSION = "process-ir-v0.3"
COMPILER_VERSION = "process-ir-compiler-v0.3"
MAX_SPATIAL_RELATIONS = 300
MAX_INK_RELATION_CANDIDATES = 100
MAX_INK_ARROWHEAD_CANDIDATES = 100
MAX_VISUAL_UNIT_MEMBERS = 12
# A visual unit is an immediate construction burst.  A longer pause is a
# boundary signal for grouping only; it never means a cognitive state.  The
# prior 2.5 s window merged a later connector into a nearby hand-drawn frame.
VISUAL_UNIT_TIME_WINDOW_MS = 1_200
VISUAL_UNIT_GAP_PX = 24
REFERENCE_RE = re.compile(
    r"(?:\bthis\b|\bthat\b|\bthese\b|\bthose\b|\bit\b|这个|那个|这边|那边|这里|那里|上述|前面|后面)",
    re.IGNORECASE,
)


def _label(obj: dict[str, Any]) -> str | None:
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
) -> list[dict[str, Any]]:
    """Expose deictic speech as unresolved, inspectable candidate associations.

    This is deliberately not a resolver.  A user saying “这个” might mean an
    off-canvas concept, a line, or a cluster; time adjacency and a pointer hit
    merely produce candidates.  The candidates do not alter object state or
    semantic events until a separately evaluated resolver earns that right.
    """
    object_ids = {obj.get("object_id") for obj in objects if obj.get("object_id")}
    candidates = []
    for index, caption in enumerate(captions, start=1):
        text = caption.get("text", "")
        if not isinstance(text, str) or not REFERENCE_RE.search(text):
            continue
        start = int(caption.get("start_ms", 0) or 0)
        end = int(caption.get("end_ms", start) or start)
        midpoint = (start + end) // 2
        support: dict[str, set[str]] = {}

        for gesture in gestures:
            hit_id = gesture.get("hit_object_id")
            gesture_time = int(gesture.get("end_ms", gesture.get("start_ms", 0)) or 0)
            if hit_id in object_ids and abs(gesture_time - midpoint) <= 4_000:
                support.setdefault(hit_id, set()).add("pointer_hit")
        for event in events:
            object_id = event.get("object_id")
            event_time = int(event.get("timestamp_ms", 0) or 0)
            if object_id in object_ids and abs(event_time - midpoint) <= 4_000:
                support.setdefault(object_id, set()).add("nearby_canvas_action")
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


def _path_length(points: list[tuple[float, float]]) -> float:
    return sum(
        ((right[0] - left[0]) ** 2 + (right[1] - left[1]) ** 2) ** 0.5
        for left, right in zip(points, points[1:])
    )


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
    reference_candidates = _reference_candidates(captions, events, objects, gestures)
    visual_unit_candidates = _visual_unit_candidates(objects)
    ink_relation_candidates = _ink_relation_candidates(package, objects, visual_unit_candidates)
    ink_arrowhead_candidates = _arrowhead_candidates(package, ink_relation_candidates)
    constraints = [
        "observation_is_not_psychological_state",
        "pause_does_not_imply_uncertainty",
        "pointer_attention_is_weak_signal_only",
        "object_state_requires_auditable_association",
        "handdrawn_relation_requires_multi_point_trace",
        "reported_duration_is_not_process_evidence",
    ]
    if not ink_trace_quality["supports_handdrawn_relation_candidates"]:
        constraints.append("handdrawn_relation_geometry_unavailable")
    if legacy_svg_outline["status"] == "recoverable":
        constraints.append("legacy_svg_outline_is_not_pen_trajectory")

    return {
        "schema_version": SCHEMA_VERSION,
        "source": {
            "package_id": meta.get("package_id") or package.get("package_id"),
            "language": (package.get("transcript") or {}).get("language"),
            "duration_ms": meta.get("duration_ms") or package.get("duration_ms", 0),
            "content_sha256": canonical_package_sha256(package),
            "compiler_version": COMPILER_VERSION,
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
        "ink_arrowhead_candidates": ink_arrowhead_candidates,
        "visual_unit_candidates": visual_unit_candidates,
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
            "has_timestamped_transcript": bool(captions),
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
            "ink_arrowhead_candidate_count": len(ink_arrowhead_candidates),
            "visual_unit_candidate_count": len(visual_unit_candidates),
            "ink_trace": ink_trace_quality,
            "legacy_svg_outline": legacy_svg_outline,
            "temporal_extent": temporal_extent,
        },
        "interpretation_constraints": constraints,
    }

