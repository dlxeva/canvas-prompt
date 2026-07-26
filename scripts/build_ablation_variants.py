#!/usr/bin/env python3
"""Build blinded context variants from one local Canvas Prompt export.

This tool never calls a model and never writes into the repository. It produces
local treatment folders so independent agents can answer the same task without
being told whether they received speech, a final canvas, or process evidence.

Example:
  python3 scripts/build_ablation_variants.py \
    --input /path/to/prompt-package.json --output-dir /tmp/canvas-ablation
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
from typing import Any


TRANSFORM_SESSION_GAP_MS = 250
DRAW_CONSTRUCTION_WINDOW_MS = 1500


TASK = """Read the supplied local context and answer these five questions.

1. What was the person working on?
2. Which facts, relationships, or changes are directly supported?
3. What remains uncertain or unsupported?
4. How did the work develop over time, if the supplied context supports that?
5. What is the most useful next collaborative move?

Separate observations from inferences. Do not invent object labels, intent,
causality, or priority from position, colour, scale, or silence alone.
"""


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Prompt Package must be a JSON object.")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_data_image(value: Any, path: Path) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not isinstance(value.get("url"), str):
        return None
    url = value["url"]
    if not url.startswith("data:image/") or ";base64," not in url:
        return None
    header, encoded = url.split(",", 1)
    suffix = "png" if "image/png" in header else "jpg" if "image/jpeg" in header else "webp"
    output = path.with_suffix(f".{suffix}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(base64.b64decode(encoded))
    # The evaluator receives only context.json, so a relative path would make
    # a visual-only arm silently lose its image. Keep the local absolute path;
    # this directory is intentionally outside the repository and never shared.
    return {"path": str(output.resolve()), "format": suffix, "width": value.get("width"), "height": value.get("height")}


def event_without_time(event: Any) -> Any:
    if not isinstance(event, dict):
        return event
    return {key: event_without_time(value) for key, value in event.items() if key not in {"timestamp_ms", "time_range_ms", "start_ms", "end_ms"}}


def compact_events(package: dict[str, Any], with_time: bool) -> list[Any]:
    """Return semantic event boundaries, never raw render/update frames.

    Older exports record a transform for nearly every pointer update. A blind
    evaluator receiving that stream is testing context overload, not the value
    of process evidence. Keep creation/deletion markers and coalesce transforms
    into object-level sessions. Sessions that are merely the immediate geometry
    construction of a newly drawn stroke are excluded: the stroke_start already
    represents that fact.
    """
    timeline = package.get("timeline") if isinstance(package.get("timeline"), list) else []
    transform_rows = package.get("transformations") if isinstance(package.get("transformations"), list) else []
    events = [
        event
        for event in timeline
        if isinstance(event, dict) and event.get("event_type") in {"stroke_start", "delete"}
    ]
    stroke_start_ms = {
        event.get("target_id"): event.get("timestamp_ms")
        for event in events
        if event.get("event_type") == "stroke_start" and isinstance(event.get("target_id"), str)
    }
    sessions: list[dict[str, Any]] = []
    open_sessions: dict[str, dict[str, Any]] = {}
    for row in transform_rows:
        if not isinstance(row, dict) or not isinstance(row.get("object_id"), str) or not isinstance(row.get("timestamp_ms"), (int, float)):
            continue
        timestamp = int(row["timestamp_ms"])
        object_id = row["object_id"]
        current = open_sessions.get(object_id)
        if (
            current is None
            or timestamp - current["end_ms"] > TRANSFORM_SESSION_GAP_MS
        ):
            if current is not None:
                sessions.append(current)
            open_sessions[object_id] = {
                "event_type": "transform_session",
                "target_id": object_id,
                "object_type": row.get("object_type"),
                "start_ms": timestamp,
                "end_ms": timestamp,
                "before_bounds": row.get("before_bounds"),
                "after_bounds": row.get("after_bounds"),
                "sample_count": 1,
            }
        else:
            current["end_ms"] = timestamp
            current["after_bounds"] = row.get("after_bounds")
            current["sample_count"] += 1
    sessions.extend(open_sessions.values())

    meaningful_sessions: list[dict[str, Any]] = []
    for session in sessions:
        created_at = stroke_start_ms.get(session["target_id"])
        if created_at is not None and session["start_ms"] - created_at <= DRAW_CONSTRUCTION_WINDOW_MS:
            continue
        meaningful_sessions.append(session)

    # A multi-select move emits one identical transform stream per object. It is
    # one cognitive action, so expose it as one batch with the affected IDs.
    batches: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for session in meaningful_sessions:
        signature = (session["start_ms"], session["end_ms"])
        batches.setdefault(signature, []).append(session)

    for (start_ms, end_ms), batch in batches.items():
        deltas = []
        scales = []
        for session in batch:
            before = session.get("before_bounds") or {}
            after = session.get("after_bounds") or {}
            dx = round(float(after.get("x", 0)) - float(before.get("x", 0)), 2)
            dy = round(float(after.get("y", 0)) - float(before.get("y", 0)), 2)
            deltas.append({"x": dx, "y": dy})
            before_width = float(before.get("width", 0))
            before_height = float(before.get("height", 0))
            scales.append({
                "x": round(float(after.get("width", 0)) / before_width, 3) if before_width else None,
                "y": round(float(after.get("height", 0)) / before_height, 3) if before_height else None,
            })
        same_delta = len({(item["x"], item["y"]) for item in deltas}) == 1
        same_scale = len({(item["x"], item["y"]) for item in scales}) == 1
        event: dict[str, Any] = {
            "event_type": "transform_batch",
            "target_ids": [session["target_id"] for session in batch],
            "metadata": {
                "object_count": len(batch),
                "delta": deltas[0] if same_delta else "varied",
                "scale": scales[0] if same_scale else "varied",
                "sample_count": sum(session["sample_count"] for session in batch),
            },
        }
        if with_time:
            event["time_range_ms"] = {"start_ms": start_ms, "end_ms": end_ms}
        events.append(event)
    events.sort(key=lambda event: event.get("timestamp_ms", event.get("time_range_ms", {}).get("start_ms", 0)))
    return events if with_time else [event_without_time(event) for event in events]


def transcript(package: dict[str, Any], with_time: bool) -> dict[str, Any]:
    source = package.get("transcript") if isinstance(package.get("transcript"), dict) else {}
    if with_time:
        return {"full_text": source.get("full_text", ""), "segments": source.get("segments", [])}
    return {"full_text": source.get("full_text", ""), "segments": [event_without_time(item) for item in source.get("segments", [])]}


def build_variant(package: dict[str, Any], flags: set[str], assets_dir: Path) -> dict[str, Any]:
    snapshot = package.get("canvas_snapshot") if isinstance(package.get("canvas_snapshot"), dict) else {}
    result: dict[str, Any] = {"context_version": "canvas-prompt-ablation-v0.1"}
    if "speech" in flags:
        result["transcript"] = transcript(package, "time" in flags)
    if "events" in flags:
        result["canvas_events"] = compact_events(package, "time" in flags)
        result["objects"] = package.get("objects", [])
    if "image" in flags:
        image = write_data_image(snapshot.get("final"), assets_dir / "final")
        if image:
            result["final_canvas_image"] = image
    if "state_frames" in flags:
        frames = []
        for index, frame in enumerate(snapshot.get("keyframes", [])[:8], start=1):
            if not isinstance(frame, dict):
                continue
            image = write_data_image(frame.get("image"), assets_dir / f"state-{index:02d}")
            if image:
                frames.append({"timestamp_ms": frame.get("timestamp_ms"), "image": image})
        if frames:
            result["state_frames"] = frames
    if "process_evidence" in flags:
        # These are observations, not semantic labels. The full treatment must
        # include them so an ablation measures their marginal value instead of
        # silently treating an older, incomplete process representation as H.
        result["view_transformations"] = package.get("view_transformations", [])
        result["review_items"] = package.get("review_items", [])
        result["baseline_context"] = package.get("baseline_context")
        result["layout_transformations"] = package.get("transformations", [])
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    package = read_json(args.input)
    arms = {
        "a": {"speech"},
        "b": {"image"},
        "c": {"speech", "image"},
        "d": {"events"},
        "e": {"events", "image"},
        "f": {"events", "speech"},
        "g": {"events", "speech", "image"},
        "h": {"events", "speech", "image", "time", "state_frames", "process_evidence"},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"package_id": (package.get("meta") or {}).get("package_id"), "arms": {}}
    for arm, flags in arms.items():
        arm_dir = args.output_dir / arm
        write_json(arm_dir / "context.json", build_variant(package, flags, arm_dir / "assets"))
        (arm_dir / "task.txt").write_text(TASK, encoding="utf-8")
        # Keep treatment semantics in the local manifest, never in agent input.
        manifest["arms"][arm] = sorted(flags)
    write_json(args.output_dir / "experiment-manifest.local.json", manifest)
    print(json.dumps({"ok": True, "output_dir": str(args.output_dir), "arm_count": len(arms)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
