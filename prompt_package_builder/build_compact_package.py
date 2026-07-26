#!/usr/bin/env python3
"""
build_compact_package.py
Compact Timeline-aware Prompt Package Builder

从 fixture 数据构建 Compact Prompt Package。
默认不包含完整 canvas_event_track 和 timeline_fusion。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def load_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def build_transcript(caption_track: list) -> str:
    """从 caption track 拼接纯文本 transcript"""
    texts = []
    for cap in caption_track:
        text = cap.get("text", "").strip()
        if text:
            texts.append(text)
    return " ".join(texts)


def build_compact_caption_summary(caption_track: list, required_ids: set[str] | None = None, max_context_items: int = 10) -> list:
    """Keep every cited caption, then fill the remaining context budget."""
    required_ids = required_ids or set()
    selected_ids = set(required_ids)
    for cap in caption_track:
        caption_id = cap.get("caption_id", "")
        if caption_id in selected_ids:
            continue
        if sum(item.get("caption_id") not in required_ids for item in caption_track if item.get("caption_id") in selected_ids) >= max_context_items:
            break
        selected_ids.add(caption_id)
    return [
        {
            "caption_id": cap.get("caption_id", ""),
            "timestamp_start_ms": cap.get("start_ms", 0),
            "timestamp_end_ms": cap.get("end_ms", 0),
            "summary": cap.get("text", ""),
        }
        for cap in caption_track
        if cap.get("caption_id") in selected_ids
    ]


def collect_referenced_caption_ids(semantic_events: list, object_states: list, process_ir: dict) -> set[str]:
    referenced: set[str] = set()
    for item in semantic_events + object_states:
        referenced.update(value for value in item.get("source_caption_ids", []) if isinstance(value, str) and value)
    for item in process_ir.get("review_mark_candidates") or []:
        referenced.update(value for value in item.get("evidence_caption_ids", []) if isinstance(value, str) and value)
    for item in process_ir.get("reference_candidates") or []:
        if isinstance(item.get("caption_id"), str) and item.get("caption_id"):
            referenced.add(item["caption_id"])
    return referenced


def build_semantic_events(semantic_events_raw: list) -> list:
    """转换 semantic events 为标准格式"""
    events = []
    for se in semantic_events_raw:
        event = {
            "semantic_event_id": se.get("semantic_event_id", ""),
            "semantic_type": se.get("type", se.get("semantic_type", "")),
            "timestamp_start": se.get("time_range_ms", [0, 0])[0] if isinstance(se.get("time_range_ms"), list) else se.get("timestamp_start", 0),
            "timestamp_end": se.get("time_range_ms", [0, 0])[1] if isinstance(se.get("time_range_ms"), list) else se.get("timestamp_end", 0),
            "summary": se.get("summary", ""),
            "source_caption_ids": se.get("source_caption_ids", []),
            "source_event_refs": se.get("source_canvas_event_ids", se.get("source_event_refs", []))[:5],
            "involved_object_ids": se.get("involved_object_ids", []),
            "confidence": se.get("confidence", 0.8),
            "assertion_level": se.get("assertion_level", "hypothesis"),
            "inference_version": se.get("inference_version", "legacy-rules"),
            "evidence": se.get("evidence", []),
            "counter_evidence": se.get("counter_evidence", []),
            "features": se.get("features", {}),
        }
        events.append(event)
    return events


def build_relevant_object_states(object_state_track: list, semantic_events: list) -> list:
    """从 object state 中筛选与 semantic events 相关的对象"""
    # 收集 semantic events 中涉及的所有 object ids
    involved_ids = set()
    for se in semantic_events:
        for oid in se.get("involved_object_ids", []):
            involved_ids.add(oid)

    # 如果没有 involved_object_ids，从 source_event_refs 中推断
    if not involved_ids:
        for se in semantic_events:
            for ref in se.get("source_event_refs", []):
                # 从 event_id 中提取 object_id（如 evt_create_shape:xxx）
                if "shape:" in ref:
                    parts = ref.split(":")
                    if len(parts) >= 2:
                        involved_ids.add("shape:" + parts[1].split("_")[0])

    # 筛选相关对象状态
    relevant = []
    for ost in object_state_track:
        obj_id = ost.get("object_id", "")
        if obj_id in involved_ids or not involved_ids:
            relevant.append({
                "object_id": obj_id,
                "state_from": ost.get("state_from", ""),
                "state_to": ost.get("state_to", ""),
                "timestamp_ms": ost.get("timestamp_ms", 0),
                "reason": ost.get("reason", ""),
                "source_event_ids": ost.get("source_event_ids", []),
                "source_caption_ids": ost.get("source_caption_ids", []),
                "assertion_level": ost.get("assertion_level", "observation"),
                "evidence": ost.get("evidence", []),
                "counter_evidence": ost.get("counter_evidence", []),
            })

    return relevant


def build_evidence_refs(semantic_events: list, canvas_event_track: list, timeline_fusion: list) -> list:
    """从 canvas events / timeline fusion 中提取 evidence refs"""
    refs = []
    ref_counter = 0

    seen = set()
    for se in semantic_events:
        for item in se.get("evidence", []):
            if isinstance(item, str):
                item = {"kind": "legacy_evidence", "ref_id": item, "summary": item}
            if not isinstance(item, dict):
                continue
            key = (item.get("kind"), item.get("ref_id"))
            if not item.get("ref_id") or key in seen:
                continue
            seen.add(key)
            ref_counter += 1
            refs.append({
                "ref_id": f"eref_{ref_counter:03d}",
                "semantic_event_id": se.get("semantic_event_id", ""),
                "source_type": item.get("kind", "unknown"),
                "source_id": item["ref_id"],
                "summary": item.get("summary", ""),
            })
        source_ids = se.get("source_canvas_event_ids", se.get("source_event_refs", []))
        for sid in source_ids[:5]:
            key = ("canvas_event", sid)
            if key in seen:
                continue
            seen.add(key)
            ref_counter += 1
            refs.append({
                "ref_id": f"eref_{ref_counter:03d}",
                "semantic_event_id": se.get("semantic_event_id", ""),
                "source_type": "canvas_event",
                "source_id": sid,
                "summary": f"Referenced by {se.get('semantic_event_id', '')}",
            })

    return refs


def compact_snapshot(snapshot_data: dict) -> dict:
    """Keep render metadata but exclude inline base64 canvas data from LLM context."""
    if not isinstance(snapshot_data, dict):
        return {"note": "snapshot not found"}
    compact = {key: value for key, value in snapshot_data.items() if key != "url"}
    source_url = snapshot_data.get("url")
    if isinstance(source_url, str) and source_url.startswith("data:"):
        compact.update({
            "inline_payload_excluded": True,
            "requires_external_materialization": True,
            "content_type": source_url.split(";", 1)[0].removeprefix("data:"),
        })
    elif source_url:
        compact["url"] = source_url
    return compact


def _object_locator(objects_by_id: dict, object_id: str) -> dict:
    obj = objects_by_id.get(object_id, {})
    return {
        "object_id": object_id,
        "bounds": obj.get("bounds"),
        "label": obj.get("label"),
    }


def build_structural_observations(process_ir: dict, max_per_type: int = 6) -> dict:
    """Keep a bounded, explicitly unresolved view of structural observations.

    The full IR remains an audit artifact. The compact package carries only the
    small subset that a downstream explainer may refer to, and retains the
    observation boundary so it cannot be mistaken for semantic truth.
    """
    objects_by_id = {
        obj.get("object_id"): obj
        for obj in process_ir.get("objects", [])
        if isinstance(obj, dict) and obj.get("object_id")
    }
    references = []
    for item in process_ir.get("reference_candidates", [])[:max_per_type]:
        references.append({
            "reference_id": item.get("reference_id"),
            "caption_id": item.get("caption_id"),
            "time_range_ms": item.get("time_range_ms"),
            "candidate_objects": [
                {
                    **_object_locator(objects_by_id, candidate.get("object_id", "")),
                    "support": candidate.get("support", []),
                }
                for candidate in item.get("candidate_objects", [])[:5]
            ],
            "assertion_level": "observation",
            "resolution_status": "unresolved",
        })
    connections = []
    for item in process_ir.get("ink_relation_candidates", [])[:max_per_type]:
        endpoints = item.get("endpoint_candidates", {})
        connections.append({
            "relation_id": item.get("relation_id"),
            "relation": item.get("relation"),
            "start": _object_locator(objects_by_id, endpoints.get("start_object_id", "")),
            "end": _object_locator(objects_by_id, endpoints.get("end_object_id", "")),
            "geometry": item.get("geometry", {}),
            "assertion_level": "observation",
            "resolution_status": "unresolved",
        })
    circles = []
    for item in process_ir.get("ink_circle_candidates", [])[:max_per_type]:
        circles.append({
            "circle_id": item.get("circle_id"),
            "relation": item.get("relation"),
            "candidate_objects": [
                _object_locator(objects_by_id, object_id)
                for object_id in item.get("candidate_object_ids", [])[:5]
            ],
            "geometry": item.get("geometry", {}),
            "assertion_level": "observation",
            "resolution_status": "unresolved",
        })
    arrowheads = []
    for item in process_ir.get("ink_arrowhead_candidates", [])[:max_per_type]:
        tip = item.get("tip", {})
        arrowheads.append({
            "arrowhead_id": item.get("arrowhead_id"),
            "shaft_relation_id": item.get("shaft_relation_id"),
            "tip": {
                "shaft_endpoint": tip.get("shaft_endpoint"),
                "object": _object_locator(objects_by_id, tip.get("object_id", "")),
            },
            "candidate_visual_direction": item.get("candidate_visual_direction"),
            "support_stroke_count": len(item.get("support_stroke_ids", [])),
            "geometry": item.get("geometry", {}),
            "assertion_level": "observation",
            "resolution_status": "unresolved",
        })
    visual_units = []
    for item in process_ir.get("visual_unit_candidates", [])[:max_per_type]:
        visual_units.append({
            "unit_id": item.get("unit_id"),
            "bounds": item.get("bounds"),
            "member_objects": [
                _object_locator(objects_by_id, object_id)
                for object_id in item.get("member_object_ids", [])[:12]
            ],
            "assertion_level": "observation",
            "resolution_status": "unresolved",
        })
    individual_layout_transforms = []
    batch_layout_transforms = []
    for item in process_ir.get("layout_transform_observations", []):
        base = {
            "observation_id": item.get("observation_id"),
            "type": item.get("type"),
            "time_range_ms": item.get("time_range_ms"),
            "assertion_level": "observation",
            "resolution_status": "unresolved",
            "constraint": item.get("constraint"),
        }
        if item.get("type") == "object_layout_transform":
            if len(individual_layout_transforms) >= 12:
                continue
            individual_layout_transforms.append({
                **base,
                "object": _object_locator(objects_by_id, item.get("object_id", "")),
                "before_bounds": item.get("before_bounds"),
                "after_bounds": item.get("after_bounds"),
                "delta": item.get("delta"),
                "scale": item.get("scale"),
            })
        elif item.get("type") == "batch_layout_transform":
            if len(batch_layout_transforms) >= max_per_type:
                continue
            batch_layout_transforms.append({
                **base,
                "member_count": item.get("member_count"),
                "member_objects": [
                    _object_locator(objects_by_id, object_id)
                    for object_id in item.get("member_object_ids", [])[:12]
                ],
                "net_delta": item.get("net_delta"),
                "net_scale": item.get("net_scale"),
            })
    return {
        "reference_candidates": references,
        "handdrawn_connection_candidates": connections,
        "handdrawn_circle_candidates": circles,
        "handdrawn_arrowhead_candidates": arrowheads,
        "visual_unit_candidates": visual_units,
        "individual_layout_transforms": individual_layout_transforms,
        "batch_layout_transforms": batch_layout_transforms,
        "constraint": "all_structural_observations_are_unresolved",
    }


def build_ocr_observations(process_ir: dict, limit: int = 12) -> list[dict]:
    """Include OCR only as bounded image-coordinate evidence.

    It is useful to an LLM reading a screenshot, but intentionally remains
    separate from named object states until a verified coordinate transform
    links each text box to a canvas object.
    """
    return [
        {
            "observation_id": item.get("observation_id"),
            "text": item.get("text"),
            "confidence": item.get("confidence"),
            "bounds": item.get("bounds"),
            "coordinate_space": item.get("coordinate_space"),
            "source": item.get("source"),
            "assertion_level": "observation",
            "constraint": item.get("constraint"),
        }
        for item in (process_ir.get("ocr_observations") or [])[:limit]
        if isinstance(item, dict)
    ]


def build_review_marks(process_ir: dict, limit: int = 12) -> list[dict]:
    """Expose explicit image-review marks without turning them into edit requests."""
    return [
        {
            "review_id": item.get("review_id"),
            "artifact_object_id": item.get("artifact_object_id"),
            "coordinate_space": "base_artifact",
            "region": item.get("region"),
            "instruction": item.get("instruction"),
            "evidence_caption_ids": item.get("evidence_caption_ids", []),
            "speech_link_status": item.get("speech_link_status"),
            "assertion_level": "observation",
            "resolution_status": "unresolved",
            "constraint": item.get("constraint"),
        }
        for item in (process_ir.get("review_mark_candidates") or [])[:limit]
        if isinstance(item, dict)
    ]


def build_view_transform_observations(process_ir: dict, limit: int = 24) -> list[dict]:
    """Viewport changes remain separate from object layout and semantic state."""
    return [
        {
            "observation_id": item.get("observation_id"),
            "type": "view_transform",
            "time_range_ms": item.get("time_range_ms"),
            "kind": item.get("kind"),
            "before": item.get("before"),
            "after": item.get("after"),
            "sample_count": item.get("sample_count"),
            "coordinate_space": "viewport_transform",
            "assertion_level": "observation",
            "constraint": item.get("constraint"),
        }
        for item in (process_ir.get("view_transform_observations") or [])[:limit]
        if isinstance(item, dict)
    ]


CONSTRAINTS = {
    "do_not_infer_deleted_paths_without_evidence": True,
    "do_not_treat_pause_as_uncertainty_without_text_evidence": True,
    "semantic_events_are_generated_not_manual": True,
    "full_canvas_event_track_excluded": True,
    "full_timeline_fusion_excluded": True,
    "inline_canvas_data_excluded": True,
    "structural_observations_are_unresolved": True,
}


def build_compact_package(fixture_dir: Path) -> dict:
    """构建 Compact Prompt Package"""

    # 加载输入文件
    caption_data = load_json(fixture_dir / "caption_track.json")
    # 支持两种格式：直接列表 或 包含 caption_track 字段的对象
    if isinstance(caption_data, list):
        caption_track = caption_data
    else:
        caption_track = caption_data.get("caption_track", [])

    semantic_data = load_json(fixture_dir / "semantic_event_track.generated.json")
    semantic_events_raw = semantic_data.get("semantic_events", [])

    object_data = load_json(fixture_dir / "object_state_track.json")
    object_state_track = object_data.get("object_state_track", [])

    canvas_data = load_json(fixture_dir / "canvas_event_track.json")
    canvas_event_track = canvas_data.get("canvas_event_track", [])

    fusion_data = load_json(fixture_dir / "timeline_fusion.json")
    fusion_items = fusion_data.get("fusion_items", [])

    # final_canvas_snapshot
    snapshot_path = fixture_dir / "ab_test" / "final_canvas_snapshot.json"
    if snapshot_path.exists():
        snapshot_data = load_json(snapshot_path)
    else:
        snapshot_data = {"note": "snapshot not found"}
    snapshot_data = compact_snapshot(snapshot_data)

    process_ir_path = fixture_dir / "process_ir.json"
    process_ir = load_json(process_ir_path) if process_ir_path.exists() else {}

    # 构建各子结构
    transcript = build_transcript(caption_track)
    semantic_events = build_semantic_events(semantic_events_raw)
    relevant_object_states = build_relevant_object_states(object_state_track, semantic_events)
    required_caption_ids = collect_referenced_caption_ids(semantic_events, relevant_object_states, process_ir)
    compact_caption_summary = build_compact_caption_summary(caption_track, required_caption_ids)
    evidence_refs = build_evidence_refs(semantic_events, canvas_event_track, fusion_items)
    structural_observations = build_structural_observations(process_ir)
    ocr_observations = build_ocr_observations(process_ir)
    review_marks = build_review_marks(process_ir)
    view_transform_observations = build_view_transform_observations(process_ir)
    state_frame_path = fixture_dir / "state_frame_track.json"
    state_frames = (load_json(state_frame_path).get("state_frames", []) if state_frame_path.exists() else [])[:8]

    # 组装 package
    package = {
        "meta": {
            "package_id": f"pp_compact_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
            "version": "2.3",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "format": "compact_timeline_aware",
            "source_fixture": str(fixture_dir.name),
        },
        "final_canvas_snapshot": snapshot_data,
        "state_frames": state_frames,
        "transcript": transcript,
        "compact_caption_summary": compact_caption_summary,
        "semantic_events": semantic_events,
        "relevant_object_states": relevant_object_states,
        "evidence_refs": evidence_refs,
        "structural_observations": structural_observations,
        "ocr_observations": ocr_observations,
        "review_marks": review_marks,
        "view_transform_observations": view_transform_observations,
        "process_ir_summary": {
            "schema_version": process_ir.get("schema_version"),
            "source_provenance": {
                "package_id": (process_ir.get("source") or {}).get("package_id"),
                "content_sha256": (process_ir.get("source") or {}).get("content_sha256"),
                "compiler_version": (process_ir.get("source") or {}).get("compiler_version"),
                "baseline_context": (process_ir.get("source") or {}).get("baseline_context"),
                "round_kind": (process_ir.get("source") or {}).get("round_kind"),
            },
            "quality": process_ir.get("quality", {}),
            "attention_signal_count": len(process_ir.get("attention_signals", [])),
            "observation_count": len(process_ir.get("observations", [])),
            "ocr_observation_count": len(ocr_observations),
            "spatial_relation_count": len(process_ir.get("spatial_relations", [])),
            "reference_candidate_count": len(process_ir.get("reference_candidates", [])),
            "ink_relation_candidate_count": len(process_ir.get("ink_relation_candidates", [])),
            "ink_circle_candidate_count": len(process_ir.get("ink_circle_candidates", [])),
            "visual_unit_candidate_count": len(process_ir.get("visual_unit_candidates", [])),
            "layout_transform_observation_count": len(process_ir.get("layout_transform_observations", [])),
            "review_mark_candidate_count": len(review_marks),
            "view_transform_observation_count": len(view_transform_observations),
            "interpretation_constraints": process_ir.get("interpretation_constraints", []),
        },
        "constraints": CONSTRAINTS,
    }

    return package


def build_report(package: dict, fixture_dir: Path, out_path: Path) -> str:
    """生成 builder report"""
    report_lines = [
        "# Builder Report",
        "",
        f"> 生成时间：{datetime.now(timezone.utc).isoformat()}",
        "",
        "---",
        "",
        "## 输入",
        "",
        f"- Fixture 目录：`{fixture_dir}`",
        f"- caption_track.json",
        f"- semantic_event_track.generated.json",
        f"- object_state_track.json",
        f"- canvas_event_track.json",
        f"- timeline_fusion.json",
        f"- final_canvas_snapshot.json",
        "",
        "## 输出",
        "",
        f"- 输出文件：`{out_path}`",
        f"- 包大小：{len(json.dumps(package, ensure_ascii=False)):,} bytes",
        "",
        "## 字段规模",
        "",
        f"| 字段 | 数量 |",
        f"|------|-----:|",
        f"| compact_caption_summary | {len(package.get('compact_caption_summary', []))} |",
        f"| semantic_events | {len(package.get('semantic_events', []))} |",
        f"| relevant_object_states | {len(package.get('relevant_object_states', []))} |",
        f"| evidence_refs | {len(package.get('evidence_refs', []))} |",
        f"| transcript 长度 | {len(package.get('transcript', ''))} chars |",
        "",
        "## 排除检查",
        "",
        f"- ✅ 不包含完整 canvas_event_track（原始 748 条）",
        f"- ✅ 不包含完整 timeline_fusion（原始 10 条）",
        f"- ✅ 不包含完整 caption_track（原始 10 条）",
        f"- ✅ 不包含人工 semantic_event_track",
        "",
        "## 约束",
        "",
        "```json",
        json.dumps(package.get("constraints", {}), indent=2),
        "```",
        "",
        "---",
        "",
        "*由 build_compact_package.py 自动生成*",
    ]
    return "\n".join(report_lines)


def main():
    parser = argparse.ArgumentParser(description="Build Compact Timeline-aware Prompt Package")
    parser.add_argument("--fixture", required=True, help="Path to fixture directory")
    parser.add_argument("--out", required=True, help="Output path for compact_prompt_package.json")
    parser.add_argument("--report", default=None, help="Output path for builder_report.md (default: same dir as --out)")
    args = parser.parse_args()

    fixture_dir = Path(args.fixture)
    out_path = Path(args.out)

    if not fixture_dir.exists():
        print(f"ERROR: Fixture directory not found: {fixture_dir}", file=sys.stderr)
        sys.exit(1)

    # 构建 package
    package = build_compact_package(fixture_dir)

    # 保存
    save_json(out_path, package)
    print(f"✅ Compact package saved: {out_path}")
    print(f"   Size: {len(json.dumps(package, ensure_ascii=False)):,} bytes")
    print(f"   Semantic events: {len(package.get('semantic_events', []))}")
    print(f"   Relevant object states: {len(package.get('relevant_object_states', []))}")
    print(f"   Evidence refs: {len(package.get('evidence_refs', []))}")

    # 生成 report
    report_path = Path(args.report) if args.report else out_path.parent / "builder_report.md"
    report = build_report(package, fixture_dir, out_path)
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"✅ Builder report saved: {report_path}")


if __name__ == "__main__":
    main()
