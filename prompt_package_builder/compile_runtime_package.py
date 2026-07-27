#!/usr/bin/env python3
"""Compile one exported browser package into evidence-bound runtime artifacts.

This is deliberately model-free.  It makes the deterministic core pipeline part
of the product export path, while keeping any later LLM explanation as a
separate, validated step.
"""

from __future__ import annotations

import argparse
import json
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
from build_compact_package import build_compact_package, save_json  # noqa: E402
from validate_compact_package import validate_package  # noqa: E402
from validate_process_ir import validate_process_ir  # noqa: E402


def compile_runtime_package(input_path: Path, output_dir: Path) -> dict[str, Any]:
    """Persist Process IR and Compact Package for exactly one exported round."""
    package = read_json(input_path)
    adapted = adapt(package)
    process_ir = adapted["process_ir"]
    process_errors = validate_process_ir(process_ir)
    if process_errors:
        raise ValueError("Process IR validation failed: " + "; ".join(process_errors))

    output_dir.mkdir(parents=True, exist_ok=True)
    fixture_dir = output_dir / "engine-inputs"
    save_fixture(adapted, fixture_dir)
    compact = build_compact_package(fixture_dir)
    compact_errors, compact_warnings = validate_package(compact)
    if compact_errors:
        raise ValueError("Compact Package validation failed: " + "; ".join(compact_errors))

    compact_path = output_dir / "compact-package.json"
    save_json(compact_path, compact)
    # engine-inputs is an implementation fixture directory.  The persisted
    # Process IR is a public round artifact, shared by MCP, handoff and manual
    # inspection, so it must have one stable path beside compact-package.json.
    process_path = output_dir / "process-ir.json"
    save_json(process_path, process_ir)
    provenance = (process_ir.get("source") or {})
    return {
        "ok": True,
        "package_id": provenance.get("package_id"),
        "compiler_version": provenance.get("compiler_version"),
        "content_sha256": provenance.get("content_sha256"),
        "process_ir_path": str(process_path),
        "compact_package_path": str(compact_path),
        "summary": {
            "speech_anchor_count": len(process_ir.get("speech_anchors", [])),
            "canvas_action_count": len(process_ir.get("canvas_actions", [])),
            "object_count": len(process_ir.get("objects", [])),
            "structural_observation_count": sum(
                len(process_ir.get(field, []))
                for field in ("reference_candidates", "ink_relation_candidates", "ink_circle_candidates", "ink_arrowhead_candidates", "ink_cross_candidates", "visual_unit_candidates")
            ),
            "semantic_event_count": len(compact.get("semantic_events", [])),
        },
        "warnings": compact_warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = compile_runtime_package(args.input, args.output_dir)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
