#!/usr/bin/env python3
"""Extend the MCPack-02 response policy with a trusted handoff receipt.

This module is intentionally an additive policy adapter.  It keeps the
MCPack-02 ``contract`` and its evidence-layer selection intact, then adds a
small identity receipt, an observed/inferred/unknown opening, an explicit
confirmation gate, and bounded re-read/reconcile lineage.  It never reads the
round archive, calls a model, mutates Prompt Package/Process IR, or authorizes
an external action.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any, Iterable

try:  # package import
    from .build_context_response_policy import (  # type: ignore
        CONTRACT,
        build_context_response_policy,
    )
except ImportError:  # existing script-style imports
    from build_context_response_policy import CONTRACT, build_context_response_policy  # type: ignore


CONTINUITY_VERSION = "0.1-draft"
READ_MODES = {"initial", "re_read"}
CONTINUITY_STATUSES = {"current", "reconciled", "needs_re_read", "identity_mismatch", "superseded"}
RECONCILIATION_STATUSES = {
    "not_applicable",
    "reconciled",
    "same_context",
    "identity_mismatch",
    "previous_superseded",
}
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

_MAX_EVIDENCE_REFS = 5
_MAX_TEXT = 500
MAX_CORRECTION_HISTORY = 5
MAX_CONTEXT_LINEAGE = 8


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _items(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _unique_strings(values: Iterable[Any], limit: int | None = None) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str) or not value or value in seen:
            continue
        result.append(value)
        seen.add(value)
        if limit is not None and len(result) >= limit:
            break
    return result


def _bounded_text(value: Any) -> str:
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    return " ".join(value.split())[:_MAX_TEXT]


def _bounded_text_with_status(value: Any) -> tuple[str, bool]:
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    normalized = " ".join(value.split())
    return normalized[:_MAX_TEXT], len(normalized) > _MAX_TEXT


def _evidence_refs(item: dict[str, Any]) -> list[str]:
    return _unique_strings(item.get("evidence_refs", []), _MAX_EVIDENCE_REFS)


def _claim_ids(items: Iterable[dict[str, Any]]) -> list[str]:
    return _unique_strings(item.get("claim_id") for item in items)


def _candidate_ids(items: Iterable[dict[str, Any]]) -> list[str]:
    return _unique_strings(item.get("candidate_id") for item in items)


def _unresolved_ids(items: Iterable[dict[str, Any]]) -> list[str]:
    return _unique_strings(item.get("id") for item in items)


def _refs(items: Iterable[dict[str, Any]]) -> list[str]:
    return _unique_strings(
        (
            ref
            for item in items
            for ref in _evidence_refs(item)
        ),
        _MAX_EVIDENCE_REFS,
    )


def _walk_forbidden(value: Any, path: str = "$") -> list[str]:
    errors: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in FORBIDDEN_KEYS:
                errors.append(f"{path}.{key} is complete-archive material and cannot enter continuity policy")
            errors.extend(_walk_forbidden(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            errors.extend(_walk_forbidden(child, f"{path}[{index}]"))
    return errors


def _numeric_window(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, dict):
        return None
    start, end = value.get("start_ms"), value.get("end_ms")
    if not isinstance(start, (int, float)) or isinstance(start, bool):
        return None
    if not isinstance(end, (int, float)) or isinstance(end, bool):
        return None
    if start > end:
        return None
    return float(start), float(end)


def _pack_time_window(context_pack: dict[str, Any]) -> dict[str, Any]:
    windows: list[tuple[float, float]] = []
    evidence_refs: list[str] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            window = _numeric_window(value.get("time_window_ms"))
            if window is not None:
                windows.append(window)
                evidence_id = value.get("evidence_id")
                if isinstance(evidence_id, str) and evidence_id:
                    evidence_refs.append(evidence_id)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    # Claims/evidence are the bounded material already present in the pack.
    # Do not inspect or copy raw package tracks while deriving a receipt.
    visit(context_pack.get("claims"))
    visit(context_pack.get("relation_candidates"))
    visit(context_pack.get("unresolved"))
    visit(context_pack.get("evidence"))
    if not windows:
        return {"status": "unknown", "window_ms": None, "source": "unavailable", "evidence_refs": []}
    start = min(window[0] for window in windows)
    end = max(window[1] for window in windows)
    return {
        "status": "available",
        "window_ms": {
            "start_ms": int(start) if start.is_integer() else start,
            "end_ms": int(end) if end.is_integer() else end,
        },
        "source": "bounded_evidence_time_window",
        "evidence_refs": _unique_strings(evidence_refs, _MAX_EVIDENCE_REFS),
    }


def _snapshot_index(context_pack: dict[str, Any]) -> int | None:
    source = _record(context_pack.get("source"))
    quality = _record(context_pack.get("quality"))
    for container in (context_pack, source, quality):
        for key in ("snapshot_index", "final_snapshot_index", "keyframe_index"):
            value = container.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
    return None


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _identity_receipt(context_pack: dict[str, Any], snapshot_gate: dict[str, Any]) -> dict[str, Any]:
    source = _record(context_pack.get("source"))
    package_id = _optional_string(context_pack.get("package_id"))
    round_id = _optional_string(context_pack.get("round_id"))
    context_id = _optional_string(context_pack.get("context_id"))
    snapshot_index = _snapshot_index(context_pack)
    receipt: dict[str, Any] = {
        "package_id": package_id,
        "round_id": round_id,
        "context_id": context_id,
        "parent_context_id": _optional_string(context_pack.get("parent_context_id")),
        "context_version": _optional_string(context_pack.get("context_version")),
        "package_version": _optional_string(context_pack.get("package_version")),
        "round_id_status": "available" if round_id else "unknown",
        "snapshot": {
            "status": snapshot_gate.get("status"),
            "index": snapshot_index,
            "index_status": "available" if snapshot_index is not None else "unknown",
            "evidence_refs": _unique_strings(snapshot_gate.get("evidence_refs", []), _MAX_EVIDENCE_REFS),
        },
        "time": _pack_time_window(context_pack),
        "source": {
            "package_schema": _optional_string(source.get("package_schema")),
            "process_ir_schema_version": _optional_string(source.get("process_ir_schema_version")),
            "compiler_version": _optional_string(source.get("compiler_version")),
            "content_sha256": _optional_string(source.get("content_sha256")),
            "round_id_source": _optional_string(source.get("round_id_source")) or "unknown",
        },
    }
    # Artifact/Interaction Review identities are already bounded MCPack source
    # metadata.  Copy only scalar identity fields; no source bytes or paths.
    for key in ("artifact_id", "source_version_id", "source_sha256", "page_normalized_v1", "input_kind", "adapter_version"):
        value = source.get(key)
        if isinstance(value, (str, bool)) and value not in ("", None):
            receipt["source"][key] = value
    for key in ("created_at", "exported_at", "captured_at"):
        value = source.get(key) or context_pack.get(key)
        if isinstance(value, str) and value:
            receipt["captured_at"] = value[:80]
            break
    return receipt


def _identity_from_value(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    receipt = _record(value.get("identity_receipt"))
    if receipt:
        return receipt
    source = _record(value.get("source"))
    return {
        "package_id": _optional_string(value.get("package_id")),
        "round_id": _optional_string(value.get("round_id")),
        "context_id": _optional_string(value.get("context_id")),
        "parent_context_id": _optional_string(value.get("parent_context_id")),
        "context_version": _optional_string(value.get("context_version")),
        "package_version": _optional_string(value.get("package_version")),
        "source": {
            "content_sha256": _optional_string(source.get("content_sha256")),
            "compiler_version": _optional_string(source.get("compiler_version")),
        },
    }


def _identity_key(identity: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    source = _record(identity.get("source"))
    return (
        _optional_string(identity.get("package_id")),
        _optional_string(identity.get("round_id")),
        _optional_string(source.get("content_sha256")),
    )


def _same_source_identity(current: dict[str, Any], previous: dict[str, Any]) -> bool:
    current_key = _identity_key(current)
    previous_key = _identity_key(previous)
    if not current_key[0] or not previous_key[0] or current_key[0] != previous_key[0]:
        return False
    if current_key[1] and previous_key[1] and current_key[1] != previous_key[1]:
        return False
    if current_key[2] and previous_key[2] and current_key[2] != previous_key[2]:
        return False
    return True


def _understanding(context_pack: dict[str, Any], *, visual_allowed: bool) -> dict[str, Any]:
    claims = _items(context_pack.get("claims"))
    candidates = _items(context_pack.get("relation_candidates"))
    unresolved = _items(context_pack.get("unresolved"))
    all_observed_claims = [
        item for item in claims
        if item.get("source_layer") == "visual_observation" and item.get("status") == "observed"
    ]
    observed_claims = all_observed_claims if visual_allowed else []
    inferred_claims = [item for item in claims if item.get("status") == "inferred"]
    compiler_candidates = [item for item in candidates if item.get("status") in {"unresolved", "confirmed"}]
    unavailable_claims = [item for item in claims if item.get("source_layer") == "unavailable"]
    confirmation_claims = [
        item for item in claims
        if item.get("source_layer") == "confirmation" or item.get("status") == "confirmed"
    ]
    unresolved_candidate_ids = _candidate_ids([item for item in compiler_candidates if item.get("status") == "unresolved"])
    unresolved_refs = _refs(unresolved)
    unavailable_refs = _refs(unavailable_claims)
    unknown_refs = _unique_strings([*unresolved_refs, *unavailable_refs], _MAX_EVIDENCE_REFS)

    return {
        "observed": {
            "label": "我观察到",
            "source_layer": "visual_observation",
            "source_layers": ["visual_observation"],
            "status": "observed",
            "claim_ids": _claim_ids(observed_claims),
            "candidate_ids": [],
            "unresolved_ids": [],
            "evidence_refs": _refs(observed_claims),
        },
        "inferred": {
            "label": "我推断",
            "source_layer": "compiler_candidate",
            "source_layers": _unique_strings(
                ["compiler_candidate", *[item.get("source_layer") for item in inferred_claims]],
            ),
            "status": "inferred",
            "claim_ids": _claim_ids(inferred_claims),
            "candidate_ids": _candidate_ids(compiler_candidates),
            "unresolved_ids": [],
            "evidence_refs": _unique_strings(
                [*_refs(inferred_claims), *_refs(compiler_candidates)],
                _MAX_EVIDENCE_REFS,
            ),
            "candidate_boundary": "candidate_only_not_a_user_decision",
        },
        "unknown": {
            "label": "我还不确定",
            "source_layer": "unresolved",
            "source_layers": ["unresolved", "unavailable"],
            "status": "unknown",
            "claim_ids": [],
            # An unresolved compiler candidate is both an inference candidate
            # and an explicit unknown; retaining its ID here prevents a
            # consumer from mistaking the candidate section for a decision.
            "candidate_ids": unresolved_candidate_ids,
            "unresolved_ids": _unresolved_ids(unresolved),
            "unresolved_candidate_ids": unresolved_candidate_ids,
            "unavailable_claim_ids": _claim_ids(unavailable_claims),
            "blocked_visual_claim_ids": [] if visual_allowed else _claim_ids(all_observed_claims),
            "evidence_refs": unknown_refs,
            "notes": [
                "缺失证据不等于事情不存在。",
                *([] if visual_allowed else ["最终快照门未打开，视觉候选只保留为待核对项。"]),
            ],
        },
        "confirmed": {
            "label": "用户已明确确认",
            "source_layer": "confirmation",
            "source_layers": ["confirmation"],
            "status": "confirmed" if confirmation_claims else "empty",
            "claim_ids": _claim_ids(confirmation_claims),
            "candidate_ids": [],
            "unresolved_ids": [],
            "evidence_refs": _refs(confirmation_claims),
            "scope": "explicit_claim_only",
        },
    }


def _confirmation_gate(context_pack: dict[str, Any]) -> dict[str, Any]:
    claims = _items(context_pack.get("claims"))
    confirmations = [
        item for item in claims
        if item.get("source_layer") == "confirmation" or item.get("status") == "confirmed"
    ]
    has_confirmation = bool(confirmations)
    return {
        "status": "confirmed_scope_only" if has_confirmation else "awaiting_user_confirmation",
        "requires_explicit_confirmation": True,
        "confirmation_scope": "explicit_claim_only",
        "confirmation_claim_ids": _claim_ids(confirmations),
        "evidence_refs": _refs(confirmations),
        "execution_authorized": False,
        "blocked_actions": [
            "external_file_write",
            "material_canvas_change",
            "send_or_publish",
        ],
    }


def _normalise_correction(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, str):
        text, text_truncated = _bounded_text_with_status(value)
        if not text:
            return None
        return {
            "status": "user_stated",
            "source_layer": "user_input",
            "text": text,
            "claim_ids": [],
            "evidence_refs": [],
            "provenance": "explicit_user_correction",
            "text_truncated": text_truncated,
        }
    if not isinstance(value, dict):
        raise TypeError("correction must be bounded text or an object")
    text, text_truncated = _bounded_text_with_status(value.get("text") or value.get("content"))
    if not text:
        raise ValueError("correction object requires bounded text")
    return {
        "status": "user_stated",
        "source_layer": "user_input",
        "text": text,
        "claim_ids": _unique_strings(value.get("claim_ids", [])),
        "evidence_refs": _unique_strings(value.get("evidence_refs", []), _MAX_EVIDENCE_REFS),
        "provenance": "explicit_user_correction",
        "text_truncated": text_truncated,
    }


def _history_entry(value: Any) -> dict[str, Any] | None:
    """Keep only bounded, explicitly user-authored correction history.

    History is carried between recovery receipts, so it must never include
    compiler candidates, old claims, or evidence IDs that belong to a prior
    Context Pack.  Those references are intentionally omitted here.
    """
    if not isinstance(value, dict) or value.get("status") == "none":
        return None
    # Check the original provenance before normalising text.  Normalisation
    # intentionally emits the safe user-input shape, so checking afterwards
    # would let an inferred/compiler candidate be rewritten into fake user
    # correction history.
    if value.get("status") != "user_stated" or value.get("source_layer") != "user_input":
        return None
    if value.get("provenance") != "explicit_user_correction":
        return None
    try:
        normalized = _normalise_correction(value)
    except (TypeError, ValueError):
        return None
    if not normalized:
        return None
    return {
        "status": "user_stated",
        "source_layer": "user_input",
        "text": normalized["text"],
        "provenance": "explicit_user_correction",
        "text_truncated": bool(value.get("text_truncated")) or bool(normalized.get("text_truncated")),
    }


def _correction_history(
    previous_policy: dict[str, Any] | None,
    correction: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], bool]:
    previous_reconciliation = _record(_record(previous_policy).get("continuity")).get("reconciliation")
    previous_reconciliation = _record(previous_reconciliation)
    raw_history = previous_reconciliation.get("correction_history")
    values = raw_history if isinstance(raw_history, list) else [previous_reconciliation.get("correction")]
    history = [entry for entry in (_history_entry(value) for value in values) if entry is not None]
    current_entry = _history_entry(correction)
    if current_entry is not None:
        history.append(current_entry)
    inherited_truncation = previous_reconciliation.get("correction_history_truncated") is True
    truncated = inherited_truncation or len(history) > MAX_CORRECTION_HISTORY
    return history[-MAX_CORRECTION_HISTORY:], truncated


def _context_lineage(
    previous_policy: dict[str, Any] | None,
    previous_context_id: str | None,
    current_context_id: str | None,
    *,
    carry_previous: bool,
) -> tuple[list[str], bool]:
    """Build a bounded explicit context chain; never infer hidden history."""
    values: list[str] = []
    if carry_previous:
        previous_continuity = _record(_record(previous_policy).get("continuity"))
        prior_lineage = previous_continuity.get("context_lineage")
        if isinstance(prior_lineage, list):
            values.extend(item for item in prior_lineage if isinstance(item, str) and item)
        if previous_context_id and previous_context_id not in values:
            values.append(previous_context_id)
    if current_context_id:
        values.append(current_context_id)
    deduped: list[str] = []
    for value in values:
        if value not in deduped:
            deduped.append(value)
    inherited_truncation = _record(_record(previous_policy).get("continuity")).get("context_lineage_truncated") is True
    truncated = inherited_truncation or len(deduped) > MAX_CONTEXT_LINEAGE
    return deduped[-MAX_CONTEXT_LINEAGE:], truncated


def _previous_identity(
    previous_policy: dict[str, Any] | None,
    previous_context_pack: dict[str, Any] | None,
) -> dict[str, Any]:
    if isinstance(previous_context_pack, dict):
        # A previous MCPack is richer than a response policy and provides the
        # source hash needed to distinguish same-round reread from a new round.
        gate = _record(previous_policy).get("snapshot_gate") if isinstance(previous_policy, dict) else {}
        return _identity_receipt(previous_context_pack, _record(gate))
    return _identity_from_value(previous_policy)


def _previous_inputs_mismatch(
    previous_policy: dict[str, Any] | None,
    previous_context_pack: dict[str, Any] | None,
) -> bool:
    """Detect a recovery receipt whose policy and pack are not one context."""
    if not isinstance(previous_policy, dict) or not isinstance(previous_context_pack, dict):
        return False
    policy_identity = _identity_from_value(previous_policy)
    gate = _record(previous_policy.get("snapshot_gate"))
    pack_identity = _identity_receipt(previous_context_pack, gate)
    policy_context_id = _optional_string(policy_identity.get("context_id"))
    pack_context_id = _optional_string(pack_identity.get("context_id"))
    if policy_context_id and pack_context_id and policy_context_id != pack_context_id:
        return True
    return not _same_source_identity(policy_identity, pack_identity)


def _superseded_record(identity: dict[str, Any], *, reason: str) -> dict[str, Any]:
    return {
        "context_id": _optional_string(identity.get("context_id")),
        "package_id": _optional_string(identity.get("package_id")),
        "round_id": _optional_string(identity.get("round_id")),
        "status": "superseded",
        "reason": reason,
    }


def _continuity(
    context_pack: dict[str, Any],
    identity_receipt: dict[str, Any],
    *,
    previous_policy: dict[str, Any] | None,
    previous_context_pack: dict[str, Any] | None,
    read_mode: str,
    correction: Any,
) -> dict[str, Any]:
    current_id = _optional_string(context_pack.get("context_id"))
    current_identity = identity_receipt
    previous_identity = _previous_identity(previous_policy, previous_context_pack)
    previous_id = _optional_string(previous_identity.get("context_id"))
    correction_value = _normalise_correction(correction)
    correction_history, correction_history_truncated = _correction_history(
        previous_policy if read_mode != "initial" else None,
        correction_value,
    )
    previous_inputs_mismatch = _previous_inputs_mismatch(previous_policy, previous_context_pack)

    def result(
        *,
        status: str,
        response_decision: str,
        reconciliation_status: str,
        identity_match: bool | None,
        lineage: str,
        supersedes: list[dict[str, Any]],
        lineage_context_id: str | None = previous_id,
        carry_previous_lineage: bool = False,
        previous_context_id: str | None = previous_id,
    ) -> dict[str, Any]:
        context_lineage, context_lineage_truncated = _context_lineage(
            previous_policy,
            lineage_context_id,
            current_id,
            carry_previous=carry_previous_lineage,
        )
        return {
            "version": CONTINUITY_VERSION,
            "read_mode": "initial" if read_mode == "initial" else "re_read",
            "status": status,
            "response_decision": response_decision,
            "current_context_id": current_id,
            "parent_context_id": _optional_string(context_pack.get("parent_context_id")),
            "context_lineage": context_lineage,
            "context_lineage_truncated": context_lineage_truncated,
            "supersedes": supersedes,
            "reconciliation": {
                "status": reconciliation_status,
                "previous_context_id": previous_context_id,
                "current_context_id": current_id,
                "identity_match": identity_match,
                "lineage": lineage,
                "correction": correction_value or {"status": "none"},
                "correction_history": correction_history,
                "correction_history_limit": MAX_CORRECTION_HISTORY,
                "correction_history_truncated": correction_history_truncated,
                "reuse_superseded_context": False,
            },
        }

    if read_mode == "initial":
        return result(
            status="current",
            response_decision="answer_current_context",
            reconciliation_status="not_applicable",
            identity_match=None,
            lineage="initial",
            supersedes=[],
            lineage_context_id=None,
            carry_previous_lineage=False,
            previous_context_id=None,
        )

    if not previous_id:
        # A recovery without an explicit previous receipt is not allowed to
        # silently become an initial context.  The CLI normally rejects this
        # earlier; keep the pure policy builder fail-closed for direct callers.
        return result(
            status="needs_re_read",
            response_decision="block_until_new_context",
            reconciliation_status="previous_superseded",
            identity_match=False,
            lineage="missing_previous_context",
            supersedes=[],
            lineage_context_id=None,
            carry_previous_lineage=False,
        )

    if previous_policy and _record(previous_policy.get("continuity")).get("status") == "superseded":
        return result(
            status="needs_re_read",
            response_decision="block_until_new_context",
            reconciliation_status="previous_superseded",
            identity_match=False,
            lineage="blocked",
            supersedes=[],
            carry_previous_lineage=False,
        )

    if previous_inputs_mismatch:
        return result(
            status="identity_mismatch",
            response_decision="block_cross_context_reconciliation",
            reconciliation_status="identity_mismatch",
            identity_match=False,
            lineage="previous_receipt_mismatch",
            supersedes=[_superseded_record(previous_identity, reason="previous_receipt_mismatch")],
            carry_previous_lineage=False,
        )

    if current_id and current_id == previous_id:
        return result(
            status="needs_re_read",
            response_decision="block_until_new_context",
            reconciliation_status="same_context",
            identity_match=False,
            lineage="same_context",
            supersedes=[],
            carry_previous_lineage=False,
        )

    if not _same_source_identity(current_identity, previous_identity):
        return result(
            status="identity_mismatch",
            response_decision="block_cross_context_reconciliation",
            reconciliation_status="identity_mismatch",
            identity_match=False,
            lineage="source_identity_mismatch",
            supersedes=[_superseded_record(previous_identity, reason="new_source_not_reconciled")],
            carry_previous_lineage=False,
        )

    parent_id = _optional_string(context_pack.get("parent_context_id"))
    if parent_id and parent_id != previous_id:
        return result(
            status="identity_mismatch",
            response_decision="block_cross_context_reconciliation",
            reconciliation_status="identity_mismatch",
            identity_match=False,
            lineage="parent_context_mismatch",
            supersedes=[_superseded_record(previous_identity, reason="parent_context_mismatch")],
            carry_previous_lineage=False,
        )

    return result(
        status="reconciled",
        response_decision="answer_current_context_only",
        reconciliation_status="reconciled",
        identity_match=True,
        lineage="explicit" if parent_id else "not_recorded",
        supersedes=[_superseded_record(previous_identity, reason="re_read")],
        carry_previous_lineage=True,
    )


def build_context_continuity_policy(
    context_pack: dict[str, Any],
    *,
    request_kind: str | None = None,
    question: str | None = None,
    previous_policy: dict[str, Any] | None = None,
    previous_context_pack: dict[str, Any] | None = None,
    read_mode: str | None = None,
    correction: str | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build one MCPack-02 policy with trusted continuation metadata.

    ``previous_policy``/``previous_context_pack`` are read-only references.
    A re-read gets a new current context ID from the caller's MCPack-01 pack;
    the old context is represented only by a bounded ``superseded`` receipt.
    """
    if not isinstance(context_pack, dict):
        raise TypeError("context_pack must be a JSON object")
    if previous_policy is not None and not isinstance(previous_policy, dict):
        raise TypeError("previous_policy must be a JSON object when supplied")
    if previous_context_pack is not None and not isinstance(previous_context_pack, dict):
        raise TypeError("previous_context_pack must be a JSON object when supplied")
    mode = read_mode or ("re_read" if previous_policy is not None or previous_context_pack is not None else "initial")
    if mode not in READ_MODES:
        raise ValueError(f"unsupported continuity read mode: {mode!r}")
    policy = build_context_response_policy(
        context_pack,
        request_kind=request_kind,
        question=question,
    )
    identity_receipt = _identity_receipt(context_pack, _record(policy.get("snapshot_gate")))
    continuity = _continuity(
        context_pack,
        identity_receipt,
        previous_policy=previous_policy,
        previous_context_pack=previous_context_pack,
        read_mode=mode,
        correction=correction,
    )
    if mode == "re_read" and continuity["read_mode"] != "re_read":
        continuity["read_mode"] = "re_read"
    policy["identity_receipt"] = identity_receipt
    policy["understanding"] = _understanding(
        context_pack,
        visual_allowed=policy["snapshot_gate"].get("decision") == "allow_visual_claims",
    )
    policy["confirmation_gate"] = _confirmation_gate(context_pack)
    policy["continuity"] = continuity
    policy["constraints"]["continuity_recovery"] = "superseded_contexts_are_not_reusable"
    policy["answer_strategy"]["opening_sections"] = ["observed", "inferred", "unknown"]
    policy["answer_strategy"]["rule_ids"] = [
        *policy["answer_strategy"].get("rule_ids", []),
        "identity_receipt_precedes_answer",
        "observed_inferred_unknown_are_labelled",
        "re_read_requires_new_context_id",
        "superseded_context_is_not_reused",
        "confirmation_precedes_execution",
    ]
    policy["execution_authorized"] = False
    policy["constraints"]["execution_authorized"] = False
    return policy


def reconcile_context_response(
    previous_policy: dict[str, Any],
    current_context_pack: dict[str, Any],
    *,
    previous_context_pack: dict[str, Any] | None = None,
    request_kind: str | None = None,
    question: str | None = None,
    correction: str | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Re-read a current pack and mark the previous context as superseded."""
    return build_context_continuity_policy(
        current_context_pack,
        request_kind=request_kind,
        question=question,
        previous_policy=previous_policy,
        previous_context_pack=previous_context_pack,
        read_mode="re_read",
        correction=correction,
    )


def build_context_reconciliation(
    previous_context_pack: dict[str, Any],
    current_context_pack: dict[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    """Convenience alias for pack-to-pack re-read/reconcile."""
    return build_context_continuity_policy(
        current_context_pack,
        previous_context_pack=previous_context_pack,
        read_mode="re_read",
        **kwargs,
    )


def mark_context_response_superseded(
    policy: dict[str, Any],
    *,
    superseded_by_context_id: str,
    reason: str = "re_read",
    context_pack: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return a copy of a response policy that cannot be reused downstream."""
    if not isinstance(policy, dict):
        raise TypeError("policy must be a JSON object")
    new_context_id = _bounded_text(superseded_by_context_id)
    if not new_context_id:
        raise ValueError("superseded_by_context_id must be non-empty")
    result = copy.deepcopy(policy)
    if "identity_receipt" not in result:
        if isinstance(context_pack, dict):
            rebuilt = build_context_continuity_policy(
                context_pack,
                request_kind=_record(result.get("request")).get("kind"),
                question=_record(result.get("request")).get("question"),
            )
            if rebuilt.get("context_id") != result.get("context_id"):
                raise ValueError("context_pack context_id must match the policy being superseded")
            result = rebuilt
        else:
            # A base MCPack-02 policy has no source pack from which to derive
            # richer identity.  Keep the fallback explicitly unknown rather
            # than pretending it has a package version, snapshot index, or
            # timestamp that were never supplied.
            identity = _identity_from_value(result)
            if not _optional_string(identity.get("context_version")):
                identity["context_version"] = "unknown"
            identity.setdefault("package_version", None)
            identity.setdefault("round_id_status", "available" if identity.get("round_id") else "unknown")
            gate = _record(result.get("snapshot_gate"))
            identity.setdefault("snapshot", {
                "status": gate.get("status", "unavailable"),
                "index": None,
                "index_status": "unknown",
                "evidence_refs": _unique_strings(gate.get("evidence_refs", []), _MAX_EVIDENCE_REFS),
            })
            identity.setdefault("time", {"status": "unknown", "window_ms": None, "source": "unavailable", "evidence_refs": []})
            source = _record(identity.get("source"))
            source.setdefault("round_id_source", "unknown")
            identity["source"] = source
            result["identity_receipt"] = identity
            layers = {
                item.get("source_layer"): item
                for item in _items(result.get("evidence_layers"))
                if isinstance(item.get("source_layer"), str)
            }

            def fallback_section(name: str, layer: str, status: str) -> dict[str, Any]:
                item = _record(layers.get(layer))
                return {
                    "label": {"observed": "我观察到", "inferred": "我推断", "unknown": "我还不确定", "confirmed": "用户已明确确认"}[name],
                    "source_layer": layer,
                    "source_layers": [layer],
                    "status": status,
                    "claim_ids": _unique_strings(item.get("claim_ids", [])),
                    "candidate_ids": _unique_strings(item.get("candidate_ids", [])),
                    "unresolved_ids": _unique_strings(item.get("unresolved_ids", [])),
                    "unresolved_candidate_ids": _unique_strings(item.get("unresolved_candidate_ids", [])),
                    "unavailable_claim_ids": _unique_strings(item.get("unavailable_claim_ids", [])),
                    "blocked_visual_claim_ids": [],
                    "evidence_refs": _unique_strings(item.get("evidence_refs", []), _MAX_EVIDENCE_REFS),
                }

            result["understanding"] = {
                "observed": fallback_section("observed", "visual_observation", "observed"),
                "inferred": fallback_section("inferred", "compiler_candidate", "inferred"),
                "unknown": fallback_section("unknown", "unresolved", "unknown"),
                "confirmed": fallback_section("confirmed", "confirmation", "empty"),
            }
            confirmation = result["understanding"]["confirmed"]
            result["confirmation_gate"] = {
                "status": "confirmed_scope_only" if confirmation["claim_ids"] else "awaiting_user_confirmation",
                "requires_explicit_confirmation": True,
                "confirmation_scope": "explicit_claim_only",
                "confirmation_claim_ids": confirmation["claim_ids"],
                "evidence_refs": confirmation["evidence_refs"],
                "execution_authorized": False,
                "blocked_actions": ["external_file_write", "material_canvas_change", "send_or_publish"],
            }
    current_id = _optional_string(result.get("context_id"))
    old_continuity = _record(result.get("continuity"))
    correction_history, correction_history_truncated = _correction_history(result, None)
    context_lineage, context_lineage_truncated = _context_lineage(
        result,
        current_id,
        current_id,
        carry_previous=True,
    )
    old_reconciliation = _record(old_continuity.get("reconciliation"))
    result["continuity"] = {
        "version": CONTINUITY_VERSION,
        "read_mode": "re_read",
        "status": "superseded",
        "response_decision": "do_not_reuse",
        "current_context_id": current_id,
        "parent_context_id": None,
        "context_lineage": context_lineage,
        "context_lineage_truncated": context_lineage_truncated,
        "supersedes": [],
        "reconciliation": {
            "status": "not_applicable",
            "previous_context_id": current_id,
            "current_context_id": current_id,
            "identity_match": False,
            "lineage": "superseded",
            "superseded_by_context_id": new_context_id,
            "reason": _bounded_text(reason) or "re_read",
            "correction": old_reconciliation.get("correction") or {"status": "none"},
            "correction_history": correction_history,
            "correction_history_limit": MAX_CORRECTION_HISTORY,
            "correction_history_truncated": correction_history_truncated,
            "reuse_superseded_context": False,
        },
    }
    result["constraints"] = _record(result.get("constraints"))
    result["constraints"]["execution_authorized"] = False
    result["constraints"]["continuity_recovery"] = "superseded_contexts_are_not_reusable"
    result["execution_authorized"] = False
    result["answer_strategy"] = _record(result.get("answer_strategy"))
    rules = _unique_strings(result["answer_strategy"].get("rule_ids", []))
    if "superseded_context_is_not_reused" not in rules:
        rules.append("superseded_context_is_not_reused")
    result["answer_strategy"]["rule_ids"] = rules
    return result


# Descriptive aliases preserve one implementation and make the recovery gate
# discoverable without creating another context protocol.
build_continuity_response_policy = build_context_continuity_policy
build_context_handoff = build_context_continuity_policy
reconcile_context_pack = build_context_reconciliation
build_reconciled_response_policy = reconcile_context_response


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="MCPack-01 Context Pack JSON")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--previous-context-pack", type=Path)
    parser.add_argument("--previous-policy", type=Path)
    parser.add_argument("--request-kind")
    parser.add_argument("--read-mode")
    parser.add_argument("--correction")
    args = parser.parse_args(argv)
    try:
        policy = build_context_continuity_policy(
            read_json(args.input),
            previous_context_pack=read_json(args.previous_context_pack) if args.previous_context_pack else None,
            previous_policy=read_json(args.previous_policy) if args.previous_policy else None,
            request_kind=args.request_kind,
            read_mode=args.read_mode,
            correction=args.correction,
        )
        write_json(args.output, policy)
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI guard
    raise SystemExit(main())
