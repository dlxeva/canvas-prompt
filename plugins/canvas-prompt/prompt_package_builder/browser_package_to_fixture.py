#!/usr/bin/env python3
"""Adapt a browser Prompt Package into the fixture tracks used by the evaluator.

The adapter is deliberately evidence-first: a pause is never labelled
``uncertainty`` without language evidence, and a rejected object requires both
negation language and a nearby visual mark.
"""

import argparse
import json
import sys
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from process_ir import compile_process_ir
from language_adapter import (
    COEXISTENCE_RE,
    CONFIRM_RE,
    EVALUATION_RE,
    FOCUS_RE,
    ITERATIVE_RE,
    is_interrogative,
    NEGATION_RE,
    NEXT_STEP_RE,
    REVISION_RE,
    REFRAME_RE,
    SELECTION_RE,
    VERSION_RE,
)


PAUSE_THRESHOLD_MS = 5_000
CHINESE_VERSION = {"一": 1, "二": 2, "三": 3, "四": 4}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalized_captions(package):
    transcript = package.get("transcript") or {}
    segments = transcript.get("segments", []) if isinstance(transcript, dict) else []
    return [
        {
            "caption_id": f"cap_{index:03d}",
            "start_ms": segment.get("start_ms", 0),
            "end_ms": segment.get("end_ms", segment.get("start_ms", 0)),
            "text": segment.get("text", "").strip(),
            "speaker": "user",
        }
        for index, segment in enumerate(segments, start=1)
        if segment.get("text", "").strip()
    ]


def normalized_events(package):
    events = []
    for index, event in enumerate(package.get("timeline", []), start=1):
        timestamp = event.get("timestamp_ms", 0)
        target_id = event.get("target_id") or ""
        event_type = event.get("event_type", "unknown")
        if event_type == "pause":
            continue
        events.append(
            {
                "event_id": event.get("event_id") or f"evt_{event_type}_{index:03d}",
                "event_type": event_type,
                "timestamp_ms": timestamp,
                "object_id": f"obj_{target_id}" if target_id else "",
                "metadata": event.get("metadata", {}),
                "importance": event.get("importance", "low"),
            }
        )

    events.sort(key=lambda item: item["timestamp_ms"])
    actions = [event for event in events if event["timestamp_ms"] > 0]
    for previous, following in zip(actions, actions[1:]):
        duration = following["timestamp_ms"] - previous["timestamp_ms"]
        if duration >= PAUSE_THRESHOLD_MS:
            events.append(
                {
                    "event_id": f"evt_pause_{previous['timestamp_ms']}_{following['timestamp_ms']}",
                    "event_type": "pause",
                    "timestamp_ms": previous["timestamp_ms"],
                    "duration_ms": duration,
                    "object_id": "",
                    "metadata": {"derived": True, "next_event_id": following["event_id"]},
                    "importance": "medium",
                }
            )
    return sorted(events, key=lambda item: (item["timestamp_ms"], item["event_type"] != "pause"))


def raw_objects(package):
    return sorted(package.get("objects", []), key=lambda item: item.get("timestamp_ms", 0))


def captions_matching(captions, pattern):
    return [
        caption for caption in captions
        if pattern.search(caption["text"]) and not is_interrogative(caption["text"])
    ]


def negation_captions(captions):
    """Explicit rejection, excluding statements that preserve multiple options."""
    return [
        caption for caption in captions
        if (
            NEGATION_RE.search(caption["text"])
            and not COEXISTENCE_RE.search(caption["text"])
            and not is_interrogative(caption["text"])
        )
    ]


def version_mentions(captions):
    """Extract version anchors even when ASR merges several versions into one caption."""
    mentions = []
    for caption in captions:
        text = caption["text"]
        if is_interrogative(text):
            continue
        duration = max(0, caption["end_ms"] - caption["start_ms"])
        for match in VERSION_RE.finditer(text):
            raw = match.group(1) or match.group(2) or match.group(3) or match.group(4)
            english_versions = {"first": 1, "second": 2, "third": 3, "fourth": 4}
            version = CHINESE_VERSION.get(raw, english_versions.get(str(raw).lower(), int(raw) if str(raw).isdigit() else 0))
            timestamp = caption["start_ms"] + round(duration * match.start() / max(1, len(text)))
            mentions.append({"version": version, "timestamp_ms": timestamp, "caption_id": caption["caption_id"]})

    # People often say the first version without calling it "v1". If later versions
    # are explicit, the opening caption is a conservative v1 anchor.
    known = {mention["version"] for mention in mentions}
    if 1 not in known and any(version in known for version in (2, 3, 4)) and captions:
        mentions.append({"version": 1, "timestamp_ms": captions[0]["start_ms"], "caption_id": captions[0]["caption_id"]})

    unique = {}
    for mention in sorted(mentions, key=lambda item: item["timestamp_ms"]):
        unique.setdefault(mention["version"], mention)
    return [unique[version] for version in sorted(unique)]


def event_refs_near(events, timestamp, window_ms=6_000, limit=5):
    candidates = [
        event["event_id"]
        for event in events
        if event["object_id"] and abs(event["timestamp_ms"] - timestamp) <= window_ms
    ]
    return candidates[:limit]


def red_markers(objects):
    return [
        obj for obj in objects
        if "red" in str((obj.get("properties") or {}).get("color", "")).lower()
    ]


def _bounds(obj):
    bounds = obj.get("bounds") or {}
    try:
        return (
            float(bounds["x"]),
            float(bounds["y"]),
            max(0.0, float(bounds["width"])),
            max(0.0, float(bounds["height"])),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _rect_gap(left, right):
    lx, ly, lw, lh = left
    rx, ry, rw, rh = right
    gap_x = max(lx - (rx + rw), rx - (lx + lw), 0.0)
    gap_y = max(ly - (ry + rh), ry - (ly + lh), 0.0)
    return (gap_x * gap_x + gap_y * gap_y) ** 0.5


def geometric_marker_target(objects, marker, max_gap_px=18):
    """Bind a visual mark only when its geometry supports the association."""
    marker_bounds = _bounds(marker)
    marker_time = marker.get("timestamp_ms", 0)
    if marker_bounds is None:
        return None
    candidates = []
    for obj in objects:
        if obj.get("object_id") == marker.get("object_id") or not object_has_explicit_label(obj):
            continue
        if obj.get("timestamp_ms", 0) > marker_time:
            continue
        bounds = _bounds(obj)
        if bounds is None:
            continue
        gap = _rect_gap(marker_bounds, bounds)
        if gap <= max_gap_px:
            candidates.append((gap, obj))
    return min(candidates, key=lambda item: (item[0], -item[1].get("timestamp_ms", 0)))[1] if candidates else None


def explicitly_mentioned_target(objects, caption):
    """Return one named object only when its literal label appears in speech."""
    text = str(caption.get("text", "")).casefold()
    matches = []
    for obj in objects:
        props = obj.get("properties") or {}
        labels = [str(props.get(key, "")).strip() for key in ("text", "label", "title", "content", "name")]
        if any(len(label) >= 2 and label.casefold() in text for label in labels):
            matches.append(obj)
    return matches[0] if len(matches) == 1 else None


def object_has_explicit_label(obj):
    """Whether an object can be linked to a human-readable concept.

    A draw stroke ID and colour are not an identity. State transitions are only
    safe when an upstream source supplied an actual text/label/title/content.
    """
    props = obj.get("properties") or {}
    for key in ("text", "label", "title", "content", "name"):
        value = props.get(key)
        if isinstance(value, str) and value.strip():
            return True
    return False


def object_states(captions, objects, negation_caps, confirmation_caps, selection_caps, markers, versions):
    states = [
        {
            "object_id": obj.get("object_id", ""),
            "state_from": "draft",
            "state_to": "candidate",
            "timestamp_ms": obj.get("timestamp_ms", 0),
            "reason": "object_created",
            "source_event_ids": [],
            "source_caption_ids": [],
        }
        for obj in objects
    ]

    # Visual marks alone do not reject a path. Require an explicit negation.
    if negation_caps and markers:
        negation = negation_caps[0]
        marker = markers[0]
        target = geometric_marker_target(objects, marker)
        if target:
            states.append(
                {
                    "object_id": target["object_id"],
                    "state_from": "candidate",
                    "state_to": "rejected",
                    "timestamp_ms": marker.get("timestamp_ms", negation["start_ms"]),
                    "reason": "negation_text_plus_geometric_visual_mark",
                    "source_event_ids": [],
                    "source_caption_ids": [negation["caption_id"]],
                }
            )

    promotion_caps = confirmation_caps or selection_caps
    if promotion_caps and len(versions) < 3:
        confirmation = promotion_caps[-1]
        target = explicitly_mentioned_target(objects, confirmation)
        if target:
            states.append(
                {
                    "object_id": target["object_id"],
                    "state_from": "candidate",
                    "state_to": "promoted",
                    "timestamp_ms": confirmation["start_ms"],
                    "reason": "confirmation_text",
                    "source_event_ids": [],
                    "source_caption_ids": [confirmation["caption_id"]],
                }
            )

    # Iterative refinement is replacement, not rejection. Require at least three
    # version anchors before emitting these stronger state transitions.
    if len(versions) >= 3:
        caption_by_id = {caption["caption_id"]: caption for caption in captions}
        selected_ids = set()
        version_objects = []
        for mention in versions:
            target = explicitly_mentioned_target(objects, caption_by_id.get(mention["caption_id"], {}))
            if target and target.get("object_id") in selected_ids:
                target = None
            if target:
                selected_ids.add(target["object_id"])
                version_objects.append((mention, target))
        for (mention, target), (next_mention, _) in zip(version_objects, version_objects[1:]):
            states.append(
                {
                    "object_id": target["object_id"],
                    "state_from": "candidate",
                    "state_to": "superseded",
                    "timestamp_ms": next_mention["timestamp_ms"],
                    "reason": "later_version_refinement",
                    "source_event_ids": [],
                    "source_caption_ids": [mention["caption_id"], next_mention["caption_id"]],
                }
            )
        if version_objects:
            mention, target = version_objects[-1]
            states.append(
                {
                    "object_id": target["object_id"],
                    "state_from": "candidate",
                    "state_to": "promoted",
                    "timestamp_ms": (confirmation_caps[-1]["start_ms"] if confirmation_caps else mention["timestamp_ms"]),
                    "reason": "final_version_confirmation",
                    "source_event_ids": [],
                    "source_caption_ids": [mention["caption_id"]],
                }
            )
    return states


def semantic_events(captions, events, objects, negation_caps, confirmation_caps, selection_caps, reframe_caps, markers, versions):
    generated = []
    actions = [event for event in events if event["event_type"] != "pause" and event["timestamp_ms"] > 0]
    for index, pause in enumerate((event for event in events if event["event_type"] == "pause"), start=1):
        pause_end = pause["timestamp_ms"] + pause.get("duration_ms", 0)
        following_negation = next(
            (caption for caption in negation_caps if pause["timestamp_ms"] < caption["start_ms"] < pause_end),
            None,
        )
        end = following_negation["start_ms"] if following_negation else pause_end
        generated.append(
            {
                "semantic_event_id": f"sem_pause_{index:03d}",
                "type": "pause_observed",
                "time_range_ms": [pause["timestamp_ms"], end],
                "summary": "观察到绘制停顿；不据此推断心理状态。",
                "source_caption_ids": [],
                "source_canvas_event_ids": [pause["event_id"]],
                "involved_object_ids": [],
                "confidence": 0.9,
            }
        )

    coexistence_caps = captions_matching(captions, COEXISTENCE_RE)
    if coexistence_caps:
        coexistence = coexistence_caps[0]
        generated.append(
            {
                "semantic_event_id": "sem_parallel_001",
                "type": "parallel_explore",
                "time_range_ms": [coexistence["start_ms"], coexistence["end_ms"]],
                "summary": "用户明确将多个方案视为可组合的并行候选，而非互相否定。",
                "source_caption_ids": [coexistence["caption_id"]],
                "source_canvas_event_ids": event_refs_near(events, coexistence["start_ms"]),
                "involved_object_ids": [],
                "confidence": 0.9,
            }
        )
    if reframe_caps:
        reframe = reframe_caps[0]
        generated.append(
            {
                "semantic_event_id": "sem_reframe_001",
                "type": "reframe_problem",
                "time_range_ms": [reframe["start_ms"], reframe["end_ms"]],
                "summary": "用户明确提出重新理解当前问题；该候选不等于否定任一具体白板对象。",
                "source_caption_ids": [reframe["caption_id"]],
                "source_canvas_event_ids": event_refs_near(events, reframe["start_ms"]),
                "involved_object_ids": [],
                "confidence": 0.7,
            }
        )
    if negation_caps and markers:
        start = negation_caps[0]["start_ms"]
        end = markers[-1].get("timestamp_ms", start)
        target = geometric_marker_target(objects, markers[0])
        generated.append(
            {
                "semantic_event_id": "sem_reject_001",
                "type": "reject_path",
                "time_range_ms": [start, max(start, end)],
                "summary": "用户明确否定先前表述，并用视觉标记回看该路径。",
                "source_caption_ids": [caption["caption_id"] for caption in negation_caps],
                "source_canvas_event_ids": event_refs_near(events, end),
                "involved_object_ids": [target["object_id"]] if target and object_has_explicit_label(target) else [],
                "confidence": 0.8,
            }
        )

    if selection_caps:
        selection = selection_caps[0]
        target = explicitly_mentioned_target(objects, selection)
        generated.append(
            {
                "semantic_event_id": "sem_converge_001",
                "type": "converge_decision",
                "time_range_ms": [selection["start_ms"], selection["end_ms"]],
                "summary": "用户从并行候选中明确选定当前优先主线。",
                "source_caption_ids": [selection["caption_id"]],
                "source_canvas_event_ids": event_refs_near(events, selection["end_ms"]),
                "involved_object_ids": [target["object_id"]] if target and object_has_explicit_label(target) else [],
                "confidence": 0.86,
            }
        )

    next_step_caps = captions_matching(captions, NEXT_STEP_RE)
    if next_step_caps:
        next_step = next_step_caps[0]
        generated.append(
            {
                "semantic_event_id": "sem_next_001",
                "type": "plan_next_step",
                "time_range_ms": [next_step["start_ms"], next_step["end_ms"]],
                "summary": "用户说明主线后的下一步衔接，而非否定其他候选。",
                "source_caption_ids": [next_step["caption_id"]],
                "source_canvas_event_ids": event_refs_near(events, next_step["start_ms"]),
                "involved_object_ids": [],
                "confidence": 0.82,
            }
        )

    focus_caps = captions_matching(captions, FOCUS_RE)
    if focus_caps:
        focus = focus_caps[-1]
        target = explicitly_mentioned_target(objects, focus)
        generated.append(
            {
                "semantic_event_id": "sem_focus_001",
                "type": "emphasize_focus",
                "time_range_ms": [focus["start_ms"], focus["end_ms"]],
                "summary": "用户明确强调当前部分的重要性；若对象未具名，不把该强调绑定到具体白板元素。",
                "source_caption_ids": [focus["caption_id"]],
                "source_canvas_event_ids": event_refs_near(events, focus["end_ms"]),
                "involved_object_ids": [target["object_id"]] if target and object_has_explicit_label(target) else [],
                "confidence": 0.0,
            }
        )

    if len(versions) >= 3:
        first, last = versions[0], versions[-1]
        version_objects = []
        used_ids = set()
        caption_by_id = {caption["caption_id"]: caption for caption in captions}
        for mention in versions:
            target = explicitly_mentioned_target(objects, caption_by_id.get(mention["caption_id"], {}))
            if target and target.get("object_id") in used_ids:
                target = None
            if target:
                used_ids.add(target["object_id"])
                version_objects.append(target["object_id"])
        generated.append(
            {
                "semantic_event_id": "sem_iterative_001",
                "type": "iterative_refine",
                "time_range_ms": [first["timestamp_ms"], last["timestamp_ms"]],
                "summary": "用户连续提出多个版本并逐步精炼表达，不是推倒重来的拒绝路径。",
                "source_caption_ids": [mention["caption_id"] for mention in versions],
                "source_canvas_event_ids": event_refs_near(events, last["timestamp_ms"]),
                "involved_object_ids": version_objects,
                "confidence": 0.82,
            }
        )
        for index, mention in enumerate(versions[:-1], start=1):
            generated.append(
                {
                    "semantic_event_id": f"sem_evaluate_{index:03d}",
                    "type": "evaluate_object",
                    "time_range_ms": [mention["timestamp_ms"], versions[index]["timestamp_ms"]],
                    "summary": f"版本 {mention['version']} 被后续表述进一步精炼。",
                    "source_caption_ids": [mention["caption_id"]],
                    "source_canvas_event_ids": event_refs_near(events, mention["timestamp_ms"]),
                    "involved_object_ids": [version_objects[index - 1]] if index <= len(version_objects) else [],
                    "confidence": 0.75,
                }
            )

    revision_caps = captions_matching(captions, REVISION_RE)
    if negation_caps and revision_caps:
        start = revision_caps[0]["start_ms"]
        end = confirmation_caps[-1]["start_ms"] if confirmation_caps else revision_caps[-1]["end_ms"]
        target = explicitly_mentioned_target(objects, revision_caps[0])
        generated.append(
            {
                "semantic_event_id": "sem_revise_001",
                "type": "revise_path",
                "time_range_ms": [start, max(start, end)],
                "summary": "用户在否定旧表述后提出并写入更准确的表述。",
                "source_caption_ids": [caption["caption_id"] for caption in revision_caps],
                "source_canvas_event_ids": event_refs_near(events, start),
                "involved_object_ids": [target["object_id"]] if target and object_has_explicit_label(target) else [],
                "confidence": 0.78,
            }
        )

    if confirmation_caps:
        confirmation = confirmation_caps[-1]
        target = explicitly_mentioned_target(objects, confirmation)
        generated.append(
            {
                "semantic_event_id": "sem_confirm_001",
                "type": "confirm_mainline",
                "time_range_ms": [confirmation["start_ms"], confirmation["end_ms"]],
                "summary": "用户明确确认当前表述为最终结论。",
                "source_caption_ids": [confirmation["caption_id"]],
                "source_canvas_event_ids": event_refs_near(events, confirmation["start_ms"]),
                "involved_object_ids": [target["object_id"]] if target and object_has_explicit_label(target) else [],
                "confidence": 0.9,
            }
        )
    return generated


def _evidence_items(event, captions, objects):
    caption_by_id = {caption["caption_id"]: caption for caption in captions}
    object_by_id = {obj.get("object_id", ""): obj for obj in objects}
    evidence = []
    for caption_id in event.get("source_caption_ids", []):
        caption = caption_by_id.get(caption_id)
        if caption:
            evidence.append({
                "kind": "speech",
                "ref_id": caption_id,
                "summary": caption["text"],
            })
    for event_id in event.get("source_canvas_event_ids", [])[:5]:
        evidence.append({
            "kind": "canvas_action",
            "ref_id": event_id,
            "summary": "发生相关画布操作",
        })
    for object_id in event.get("involved_object_ids", []):
        obj = object_by_id.get(object_id)
        if obj:
            label = (obj.get("properties") or {}).get("label") or (obj.get("properties") or {}).get("text")
            evidence.append({
                "kind": "named_object",
                "ref_id": object_id,
                "summary": label or "对象已关联但无可读标签",
            })
    return evidence


def _candidate_features(event, evidence):
    """Stable numeric features for calibration now and learned rankers later."""
    speech_count = sum(item["kind"] == "speech" for item in evidence)
    action_count = sum(item["kind"] == "canvas_action" for item in evidence)
    named_object_count = sum(
        item["kind"] == "named_object" and "无可读标签" not in item["summary"]
        for item in evidence
    )
    start, end = event.get("time_range_ms", [0, 0])
    return {
        "schema_version": "candidate-features-v0.1",
        "explicit_speech_anchor_count": speech_count,
        "canvas_action_ref_count": action_count,
        "named_object_ref_count": named_object_count,
        "visual_marker_required": event["type"] == "reject_path",
        "time_span_ms": max(0, end - start),
    }


def _calibrate_candidate(event, features):
    """Make confidence a reproducible evidence score rather than a constant."""
    event_type = event["type"]
    if event_type == "pause_observed":
        return 0.98, "observation", [{
            "kind": "scope_limit",
            "summary": "停顿只证明动作间隔，不证明犹豫、困惑或否定。",
        }]

    has_speech = features["explicit_speech_anchor_count"] > 0
    has_action = features["canvas_action_ref_count"] > 0
    has_named_object = features["named_object_ref_count"] > 0
    confidence = 0.15 + (0.45 if has_speech else 0) + (0.2 if has_action else 0) + (0.2 if has_named_object else 0)
    counter_evidence = []
    if not has_named_object:
        counter_evidence.append({
            "kind": "missing_object_identity",
            "summary": "未建立具名对象关联；不能把结论绑定到特定白板元素。",
        })
    if not has_action:
        counter_evidence.append({
            "kind": "missing_canvas_association",
            "summary": "没有足够的画布动作关联；结论主要来自语言。",
        })
    if event_type == "reframe_problem":
        counter_evidence.append({
            "kind": "scope_limit",
            "summary": "仅确认用户提出重新审视问题，未建立对任何具体白板对象的否定或替换关系。",
        })
        return round(min(confidence, 0.8), 2), "hypothesis", counter_evidence
    return round(min(confidence, 0.95), 2), ("assertion" if confidence >= 0.8 else "hypothesis"), counter_evidence


def enrich_candidates(generated, captions, objects):
    """Attach auditable evidence, counter-evidence, and calibrated confidence."""
    enriched = []
    for event in generated:
        event = dict(event)
        evidence = _evidence_items(event, captions, objects)
        features = _candidate_features(event, evidence)
        confidence, assertion_level, counter_evidence = _calibrate_candidate(event, features)
        event.update({
            "inference_version": "rules-v3",
            "assertion_level": assertion_level,
            "evidence": evidence,
            "counter_evidence": counter_evidence,
            "features": features,
            "confidence": confidence,
        })
        enriched.append(event)
    return enriched


def adapt(package):
    captions = normalized_captions(package)
    events = normalized_events(package)
    objects = raw_objects(package)
    negation_caps = negation_captions(captions)
    confirmation_caps = captions_matching(captions, CONFIRM_RE)
    selection_caps = captions_matching(captions, SELECTION_RE)
    reframe_caps = captions_matching(captions, REFRAME_RE)
    versions = version_mentions(captions)
    markers = red_markers(objects)
    candidates = enrich_candidates(
        semantic_events(captions, events, objects, negation_caps, confirmation_caps, selection_caps, reframe_caps, markers, versions),
        captions,
        objects,
    )
    observations = [candidate for candidate in candidates if candidate["assertion_level"] == "observation"]
    semantic = [candidate for candidate in candidates if candidate["assertion_level"] != "observation"]
    process_ir = compile_process_ir(package, captions, events, objects)
    process_ir["observations"] = observations
    states = object_states(captions, objects, negation_caps, confirmation_caps, selection_caps, markers, versions)
    fusion = [
        {
            "fusion_id": event["semantic_event_id"].replace("sem_", "fusion_"),
            "time_range_ms": event["time_range_ms"],
            "summary": event["summary"],
            "semantic_event_id": event["semantic_event_id"],
        }
        for event in semantic
    ]
    return {
        "caption_track": captions,
        "canvas_event_track": events,
        "object_state_track": states,
        "semantic_events": semantic,
        "timeline_fusion": fusion,
        "final_canvas_snapshot": (package.get("canvas_snapshot") or {}).get("final", {}),
        "process_ir": process_ir,
    }


def save_fixture(adapted, fixture_dir: Path):
    write_json(fixture_dir / "caption_track.json", adapted["caption_track"])
    write_json(fixture_dir / "canvas_event_track.json", {"canvas_event_track": adapted["canvas_event_track"]})
    write_json(fixture_dir / "object_state_track.json", {"object_state_track": adapted["object_state_track"]})
    write_json(fixture_dir / "semantic_event_track.generated.json", {"semantic_events": adapted["semantic_events"]})
    write_json(fixture_dir / "timeline_fusion.json", {"fusion_items": adapted["timeline_fusion"]})
    write_json(fixture_dir / "ab_test" / "final_canvas_snapshot.json", adapted["final_canvas_snapshot"])
    write_json(fixture_dir / "process_ir.json", adapted["process_ir"])


def main():
    parser = argparse.ArgumentParser(description="Adapt browser Prompt Package to fixture tracks")
    parser.add_argument("--input", required=True, help="Browser-exported Prompt Package JSON")
    parser.add_argument("--fixture", required=True, help="Destination fixture directory")
    args = parser.parse_args()

    adapted = adapt(read_json(Path(args.input)))
    save_fixture(adapted, Path(args.fixture))
    print(f"✅ Fixture tracks saved: {args.fixture}")
    print(f"   captions={len(adapted['caption_track'])} events={len(adapted['canvas_event_track'])}")
    print(f"   states={len(adapted['object_state_track'])} semantic={len(adapted['semantic_events'])}")


if __name__ == "__main__":
    main()

