#!/usr/bin/env python3
"""Compile one exported browser package into evidence-bound runtime artifacts.

This is deliberately model-free.  It makes the deterministic core pipeline part
of the product export path, while keeping any later LLM explanation as a
separate, validated step.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
BUILDER_DIR = ROOT / "prompt_package_builder"
VALIDATORS_DIR = ROOT / "validators"
for directory in (str(BUILDER_DIR), str(VALIDATORS_DIR)):
    if directory not in sys.path:
        sys.path.insert(0, directory)

from browser_package_to_fixture import adapt, read_json, save_fixture  # noqa: E402
from build_compact_package import build_compact_package_from_adapted, save_json  # noqa: E402
from build_context_continuity import build_context_continuity_policy  # noqa: E402
from build_minimal_context_pack import build_minimal_context_pack  # noqa: E402
from validate_compact_package import validate_package  # noqa: E402
from validate_context_continuity import validate_context_continuity_policy  # noqa: E402
from validate_minimal_context_pack import validate_minimal_context_pack  # noqa: E402
from validate_process_ir import validate_process_ir  # noqa: E402


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _stable_context_id(package_id: str | None, content_sha256: str | None) -> str:
    """Give one immutable round a repeatable initial context identity.

    Recompiling a failed round must not make the model believe that a new
    conversation context was delivered.  A later explicit re-read can supply
    a fresh MCPack context ID through the existing continuity adapter.
    """
    raw = package_id or content_sha256 or "round"
    normalized = re.sub(r"[^A-Za-z0-9_-]+", "_", str(raw)).strip("_") or "round"
    return f"ctx_round_{normalized[:96]}"


def _snapshot_index(package: dict[str, Any]) -> int | None:
    snapshot = _record(package.get("canvas_snapshot"))
    final = _record(snapshot.get("final"))
    for container in (package, snapshot, final):
        for key in ("snapshot_index", "final_snapshot_index", "keyframe_index"):
            value = container.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
    return None


def _enrich_round_identity(
    context_pack: dict[str, Any],
    raw_package: dict[str, Any],
    compact_package: dict[str, Any],
    process_ir: dict[str, Any],
) -> dict[str, Any]:
    """Attach existing export identity without changing Process IR semantics."""
    raw_meta = _record(raw_package.get("meta"))
    compact_meta = _record(compact_package.get("meta"))
    process_source = _record(process_ir.get("source"))
    package_id = _optional_string(process_source.get("package_id")) or _optional_string(compact_meta.get("package_id"))
    round_id = (
        _optional_string(raw_meta.get("round_id"))
        or _optional_string(raw_package.get("round_id"))
        or _optional_string(raw_package.get("sessionId"))
        or _optional_string(compact_package.get("round_id"))
        or _optional_string(compact_meta.get("round_id"))
    )
    if round_id:
        context_pack["round_id"] = round_id
        source = _record(context_pack.get("source"))
        source["round_id_source"] = "exported_round_identity"
        context_pack["source"] = source
    snapshot_index = _snapshot_index(raw_package)
    if snapshot_index is not None:
        context_pack["snapshot_index"] = snapshot_index
    captured_at = (
        _optional_string(raw_meta.get("exported_at"))
        or _optional_string(raw_meta.get("created_at"))
        or _optional_string(raw_package.get("exported_at"))
        or _optional_string(raw_package.get("created_at"))
    )
    if captured_at:
        context_pack["captured_at"] = captured_at[:80]
    # Keep the package identity owned by the existing export/compiler chain.
    # The generated compact metadata may have its own implementation ID, but
    # it must never replace the immutable round's package_id.
    if package_id and context_pack.get("package_id") != package_id:
        raise ValueError("Context Pack changed the exported package_id")
    return context_pack


def compile_runtime_package(input_path: Path, output_dir: Path, debug_fixture_dir: Path | None = None) -> dict[str, Any]:
    """Persist bounded runtime artifacts for exactly one exported round.

    The compact builder consumes the adapted tracks in memory.  A fixture tree
    is written only when an explicit debug destination is requested, preserving
    the legacy fixture builder for inspection and archive compatibility.
    """
    package = read_json(input_path)
    adapted = adapt(package)
    process_ir = adapted["process_ir"]
    process_errors = validate_process_ir(process_ir)
    if process_errors:
        raise ValueError("Process IR validation failed: " + "; ".join(process_errors))

    if debug_fixture_dir is not None:
        save_fixture(adapted, debug_fixture_dir)
    compact = build_compact_package_from_adapted(adapted)
    compact_errors, compact_warnings = validate_package(compact)
    if compact_errors:
        raise ValueError("Compact Package validation failed: " + "; ".join(compact_errors))

    output_dir.mkdir(parents=True, exist_ok=True)
    compact_path = output_dir / "compact-package.json"
    save_json(compact_path, compact)
    # The persisted Process IR is a public round artifact, shared by MCP,
    # handoff and manual inspection, so it has one stable path beside the
    # compact package.
    process_path = output_dir / "process-ir.json"
    save_json(process_path, process_ir)
    provenance = (process_ir.get("source") or {})
    package_id = _optional_string(provenance.get("package_id")) or _optional_string(_record(compact.get("meta")).get("package_id"))
    content_sha256 = _optional_string(provenance.get("content_sha256"))
    context_pack = build_minimal_context_pack(
        compact,
        process_ir,
        task={
            "kind": "understand",
            "question": "读取本轮画布上下文，先区分我观察到、我推断和我还不确定。",
        },
        context_id=_stable_context_id(package_id, content_sha256),
    )
    context_pack = _enrich_round_identity(context_pack, package, compact, process_ir)
    context_pack_errors = validate_minimal_context_pack(context_pack)
    if context_pack_errors:
        raise ValueError("Minimal Context Pack validation failed: " + "; ".join(context_pack_errors))

    continuity_policy = build_context_continuity_policy(
        context_pack,
        request_kind="understand",
        question=context_pack["task"]["question"],
    )
    continuity_errors = validate_context_continuity_policy(continuity_policy, context_pack)
    if continuity_errors:
        raise ValueError("Context continuity policy validation failed: " + "; ".join(continuity_errors))

    context_pack_path = output_dir / "minimal-context-pack.json"
    continuity_policy_path = output_dir / "continuity-policy.json"
    save_json(context_pack_path, context_pack)
    save_json(continuity_policy_path, continuity_policy)
    return {
        "ok": True,
        "package_id": package_id,
        "compiler_version": provenance.get("compiler_version"),
        "content_sha256": content_sha256,
        "process_ir_path": str(process_path),
        "compact_package_path": str(compact_path),
        "minimal_context_pack_path": str(context_pack_path),
        "continuity_policy_path": str(continuity_policy_path),
        "context_id": context_pack["context_id"],
        "summary": {
            "speech_anchor_count": len(process_ir.get("speech_anchors", [])),
            "canvas_action_count": len(process_ir.get("canvas_actions", [])),
            "object_count": len(process_ir.get("objects", [])),
            "structural_observation_count": sum(
                len(process_ir.get(field, []))
                for field in ("reference_candidates", "ink_relation_candidates", "ink_circle_candidates", "ink_region_candidates", "ink_arrowhead_candidates", "ink_cross_candidates", "ink_check_candidates", "paired_symbol_choice_candidates", "ink_annotation_candidates", "visual_unit_candidates")
            ),
            "semantic_event_count": len(compact.get("semantic_events", [])),
        },
        "warnings": compact_warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--debug-fixture-dir",
        type=Path,
        default=None,
        help="Explicitly export adapted fixture tracks for inspection or legacy builder comparison.",
    )
    args = parser.parse_args()
    try:
        result = compile_runtime_package(args.input, args.output_dir, args.debug_fixture_dir)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
