#!/usr/bin/env python3
"""Validate MCPack-03 source-adapter provenance and MCPack-01 safety."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

try:  # package imports
    from .build_context_source_adapter import (
        ADAPTER_VERSION,
        ARTIFACT_REVIEW_SCHEMA,
        CANVAS_COMPACT_SCHEMA,
        CONTRACT,
        INTERACTION_REVIEW_DRAFT_SCHEMA,
        INTERACTION_REVIEW_I0_SCHEMA,
        SUPPORTED_INPUT_KINDS,
        detect_context_source,
    )
    from .validate_minimal_context_pack import validate_minimal_context_pack
except ImportError:  # existing script-style imports
    from build_context_source_adapter import (  # noqa: F401
        ADAPTER_VERSION,
        ARTIFACT_REVIEW_SCHEMA,
        CANVAS_COMPACT_SCHEMA,
        CONTRACT,
        INTERACTION_REVIEW_DRAFT_SCHEMA,
        INTERACTION_REVIEW_I0_SCHEMA,
        SUPPORTED_INPUT_KINDS,
        detect_context_source,
    )
    from validate_minimal_context_pack import validate_minimal_context_pack


_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _schema(value: Any) -> str | None:
    record = _record(value)
    raw = record.get("schema_version", record.get("schema"))
    return raw if isinstance(raw, str) and raw else None


def _package_id(value: Any) -> str | None:
    raw = _record(value).get("package_id")
    return raw if isinstance(raw, str) and raw else None


def _source_schema_allowed(source_kind: str, schema: Any) -> bool:
    if source_kind == "artifact_review":
        return schema == ARTIFACT_REVIEW_SCHEMA
    if source_kind == "interaction_review":
        return schema in {INTERACTION_REVIEW_DRAFT_SCHEMA, INTERACTION_REVIEW_I0_SCHEMA}
    if source_kind == "canvas_round":
        return schema in {CANVAS_COMPACT_SCHEMA, None} or (isinstance(schema, str) and schema.startswith("compact_"))
    return False


def _validate_provenance(pack: dict[str, Any], errors: list[str]) -> None:
    source = pack.get("source")
    if not isinstance(source, dict):
        errors.append("source must be an object")
        return
    source_kind = source.get("input_kind")
    if source_kind not in SUPPORTED_INPUT_KINDS:
        errors.append("source.input_kind must be a supported MCPack-03 source kind")
        return
    if source.get("adapter_version") != ADAPTER_VERSION:
        errors.append(f"source.adapter_version must equal {ADAPTER_VERSION}")
    if not isinstance(pack.get("package_id"), str) or not pack["package_id"]:
        errors.append("adapter output package_id must preserve a non-empty source identity")
    input_schema = source.get("input_schema_version")
    if not _source_schema_allowed(source_kind, input_schema):
        errors.append("source.input_schema_version does not match source.input_kind")
    if source.get("package_id") != pack.get("package_id"):
        errors.append("source.package_id must preserve the existing package_id")
    if source.get("source_sha256") is not None and not _SHA256_RE.match(str(source.get("source_sha256"))):
        errors.append("source.source_sha256 must be a lower-case SHA-256 when present")

    if source_kind == "artifact_review":
        if not isinstance(source.get("artifact_id"), str) or not source["artifact_id"]:
            errors.append("Artifact Review projection must preserve artifact_id")
        if not isinstance(source.get("source_version_id"), str) or not source["source_version_id"]:
            errors.append("Artifact Review projection must preserve source_version_id")
        elif source["source_version_id"].startswith("/") or "://" in source["source_version_id"]:
            errors.append("Artifact Review source_version_id must not be a path or URL")
        if source.get("page_normalized_v1") is not True:
            errors.append("Artifact Review projection must declare page_normalized_v1")
        if source.get("input_source_bytes_in_export") is not False:
            errors.append("Artifact Review projection must declare source bytes excluded")
        if not isinstance(source.get("input_page_count"), int) or source["input_page_count"] < 1:
            errors.append("Artifact Review projection must preserve a positive page count")
    elif source_kind == "interaction_review":
        if input_schema == INTERACTION_REVIEW_DRAFT_SCHEMA:
            if not isinstance(source.get("input_source_sha256"), str) or not _SHA256_RE.match(source["input_source_sha256"]):
                errors.append("Interaction Review draft projection must preserve source.sha256")
            if source.get("input_source_bytes_in_export") is not False:
                errors.append("Interaction Review draft projection must exclude source bytes")
            entry_path = source.get("input_entry_path")
            if entry_path is not None and (not isinstance(entry_path, str) or entry_path.startswith("/") or ".." in entry_path.split("/")):
                errors.append("Interaction Review draft projection must keep entry_path relative")
        if input_schema == INTERACTION_REVIEW_I0_SCHEMA:
            if not isinstance(source.get("input_session_id"), str) or not source["input_session_id"]:
                errors.append("Interaction Review I0 projection must preserve capture.session_id")
            if source.get("input_agent_boundary") != "proposal-only":
                errors.append("Interaction Review I0 projection must remain proposal-only")
            if isinstance(source.get("input_source_version"), str) and (source["input_source_version"].startswith("/") or "://" in source["input_source_version"]):
                errors.append("Interaction Review source_version must not be a path or URL")
            if not isinstance(source.get("input_allowed_routes"), list) or not source["input_allowed_routes"]:
                errors.append("Interaction Review I0 projection must preserve allowed routes")
            elif any(not isinstance(route, str) or not re.fullmatch(r"/[A-Za-z0-9/_-]*", route) for route in source["input_allowed_routes"]):
                errors.append("Interaction Review I0 projection contains an unsafe route")
    elif source_kind == "canvas_round":
        if source.get("input_shape") not in {"compiled_pair", "compact_alias_pair", "exported_round"}:
            errors.append("Canvas round projection must record its existing bridge shape")


def _compare_source_input(pack: dict[str, Any], source_input: Any, errors: list[str]) -> None:
    try:
        detected = detect_context_source(source_input)
    except Exception as error:
        errors.append(f"source input is unsupported: {error}")
        return
    source = _record(pack.get("source"))
    if source.get("input_kind") != detected:
        errors.append("source.input_kind does not match the supplied source package")
    source_package_id = _package_id(source_input)
    if detected == "canvas_round":
        record = _record(source_input)
        compact = _record(record.get("compact_package", record.get("compact")))
        process_ir = _record(record.get("process_ir"))
        source_package_id = (
            _package_id(_record(compact.get("meta")))
            or _package_id(_record(process_ir.get("source")))
            or _package_id(_record(record.get("meta")))
            or source_package_id
        )
    if source_package_id and source_package_id != pack.get("package_id"):
        errors.append("adapted package_id does not match the supplied source package")
    schema = _schema(source_input)
    if detected == "canvas_round":
        record = _record(source_input)
        compact = _record(record.get("compact_package", record.get("compact")))
        schema = _record(compact.get("meta")).get("format") or CANVAS_COMPACT_SCHEMA
    if not _source_schema_allowed(detected, schema):
        errors.append("supplied source schema does not match the adapted source kind")

    if detected == "artifact_review":
        artifact = _record(source_input).get("artifact")
        artifact = _record(artifact)
        for key in ("artifact_id", "source_version_id", "source_sha256"):
            if artifact.get(key) != source.get(key):
                errors.append(f"source.{key} does not preserve Artifact Review identity")
    elif detected == "interaction_review" and schema == INTERACTION_REVIEW_I0_SCHEMA:
        capture = _record(_record(source_input).get("capture"))
        if capture.get("session_id") != source.get("input_session_id"):
            errors.append("source.input_session_id does not preserve Interaction Review lineage")


def validate_context_source_pack(value: Any, source_input: Any | None = None) -> list[str]:
    """Return structural, identity and archive-safety errors for MCPack-03."""
    errors = validate_minimal_context_pack(value)
    if not isinstance(value, dict):
        return errors
    _validate_provenance(value, errors)
    if value.get("execution_authorized") is not False:
        errors.append("adapter output execution_authorized must be false")
    if _record(value.get("constraints")).get("execution_authorized") is not False:
        errors.append("adapter output constraints.execution_authorized must be false")
    if source_input is not None:
        _compare_source_input(value, source_input, errors)
    return errors


# Compatibility names for evaluator callers and the stable import surface.
validate_minimal_context_pack_source = validate_context_source_pack
validate_source_context_pack = validate_context_source_pack
validate_adapter_output = validate_context_source_pack


def validate_package(value: Any, source_input: Any | None = None) -> tuple[list[str], list[str]]:
    return validate_context_source_pack(value, source_input), []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args(argv)
    try:
        value = json.loads(args.path.read_text(encoding="utf-8"))
        source = json.loads(args.source.read_text(encoding="utf-8")) if args.source else None
    except Exception as error:  # pragma: no cover - CLI guard
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    errors = validate_context_source_pack(value, source)
    if errors:
        print("FAIL")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
