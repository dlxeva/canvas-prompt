#!/usr/bin/env python3
"""Validate the additive MCPack-02 continuity/recovery policy fields."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

try:  # package import
    from .build_context_continuity import (  # type: ignore
        CONTINUITY_STATUSES,
        CONTINUITY_VERSION,
        ANSWER_CONTRACT_VERSION,
        ANSWER_OPENING_SECTIONS,
        ANSWER_SECTION_ORDER,
        FORBIDDEN_KEYS,
        IDENTITY_RECEIPT_FIELDS,
        USER_VISIBLE_RECEIPT_FIELDS,
        MAX_CONTEXT_LINEAGE,
        MAX_CORRECTION_HISTORY,
        READ_MODES,
        RECONCILIATION_STATUSES,
    )
    from .validate_context_response_policy import validate_context_response_policy  # type: ignore
except ImportError:  # existing script-style imports
    from build_context_continuity import (  # noqa: F401
        CONTINUITY_STATUSES,
        CONTINUITY_VERSION,
        ANSWER_CONTRACT_VERSION,
        ANSWER_OPENING_SECTIONS,
        ANSWER_SECTION_ORDER,
        FORBIDDEN_KEYS,
        IDENTITY_RECEIPT_FIELDS,
        USER_VISIBLE_RECEIPT_FIELDS,
        MAX_CONTEXT_LINEAGE,
        MAX_CORRECTION_HISTORY,
        READ_MODES,
        RECONCILIATION_STATUSES,
    )
    from validate_context_response_policy import validate_context_response_policy  # noqa: F401


SOURCE_LAYERS = {"visual_observation", "user_input", "compiler_candidate", "confirmation", "unresolved", "unavailable"}
SNAPSHOT_STATES = {"available", "degraded", "unavailable", "conflicting"}
REQUIRED_FIELDS = {"identity_receipt", "understanding", "confirmation_gate", "continuity"}
SECTION_NAMES = set(ANSWER_SECTION_ORDER)
MAX_EVIDENCE_REFS = 5


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _items(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


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


def _strings(value: Any, path: str, errors: list[str], *, max_items: int | None = None) -> list[str]:
    if not isinstance(value, list):
        errors.append(f"{path} must be a list")
        return []
    if max_items is not None and len(value) > max_items:
        errors.append(f"{path} exceeds {max_items}")
    result: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item:
            errors.append(f"{path}[{index}] must be a non-empty string")
            continue
        if item in seen:
            errors.append(f"{path} must not contain duplicate IDs")
        seen.add(item)
        result.append(item)
    return result


def _ids_from_pack(context_pack: dict[str, Any] | None) -> tuple[set[str], set[str], set[str], set[str]]:
    if not isinstance(context_pack, dict):
        return set(), set(), set(), set()
    claims = {
        item.get("claim_id")
        for item in _items(context_pack.get("claims"))
        if isinstance(item.get("claim_id"), str)
    }
    candidates = {
        item.get("candidate_id")
        for item in _items(context_pack.get("relation_candidates"))
        if isinstance(item.get("candidate_id"), str)
    }
    unresolved = {
        item.get("id")
        for item in _items(context_pack.get("unresolved"))
        if isinstance(item.get("id"), str)
    }
    evidence = {
        item.get("evidence_id")
        for item in _items(context_pack.get("evidence"))
        if isinstance(item.get("evidence_id"), str)
    }
    return claims, candidates, unresolved, evidence


def _context_identity(value: dict[str, Any], context_pack: dict[str, Any] | None, errors: list[str]) -> None:
    receipt = _record(value.get("identity_receipt"))
    for field in ("context_id", "package_id", "round_id", "context_version", "package_version"):
        if field in value and field in receipt and receipt.get(field) != value.get(field):
            errors.append(f"identity_receipt.{field} must match policy.{field}")
        if isinstance(context_pack, dict) and field in context_pack and receipt.get(field) != context_pack.get(field):
            errors.append(f"identity_receipt.{field} must match source Context Pack")
    source = _record(receipt.get("source"))
    pack_source = _record(context_pack.get("source")) if isinstance(context_pack, dict) else {}
    for field in ("content_sha256", "compiler_version"):
        if isinstance(context_pack, dict) and pack_source.get(field) not in (None, "") and source.get(field) != pack_source.get(field):
            errors.append(f"identity_receipt.source.{field} must match source Context Pack")


def _validate_identity_receipt(value: dict[str, Any], context_pack: dict[str, Any] | None, errors: list[str]) -> None:
    receipt = value.get("identity_receipt")
    if not isinstance(receipt, dict):
        errors.append("identity_receipt must be an object")
        return
    for field in ("context_id", "package_id", "context_version"):
        if not isinstance(receipt.get(field), str) or not receipt[field]:
            errors.append(f"identity_receipt.{field} must be non-empty text")
    if receipt.get("round_id") is not None and not isinstance(receipt.get("round_id"), str):
        errors.append("identity_receipt.round_id must be text or null")
    if receipt.get("round_id_status") not in {"available", "unknown"}:
        errors.append("identity_receipt.round_id_status is invalid")
    if receipt.get("round_id_status") == "available" and not receipt.get("round_id"):
        errors.append("identity_receipt.round_id_status=available requires round_id")
    if receipt.get("round_id_status") == "unknown" and receipt.get("round_id"):
        errors.append("identity_receipt.round_id_status=unknown cannot include round_id")
    for field in ("parent_context_id", "package_version", "captured_at"):
        if receipt.get(field) is not None and not isinstance(receipt.get(field), str):
            errors.append(f"identity_receipt.{field} must be text or null")

    snapshot = receipt.get("snapshot")
    if not isinstance(snapshot, dict):
        errors.append("identity_receipt.snapshot must be an object")
        snapshot = {}
    if snapshot.get("status") not in SNAPSHOT_STATES:
        errors.append("identity_receipt.snapshot.status is invalid")
    if snapshot.get("index") is not None and (
        not isinstance(snapshot.get("index"), int) or isinstance(snapshot.get("index"), bool) or snapshot["index"] < 0
    ):
        errors.append("identity_receipt.snapshot.index must be a non-negative integer or null")
    if snapshot.get("index_status") not in {"available", "unknown"}:
        errors.append("identity_receipt.snapshot.index_status is invalid")
    if snapshot.get("index_status") == "available" and snapshot.get("index") is None:
        errors.append("identity_receipt.snapshot.index_status=available requires index")
    if snapshot.get("index_status") == "unknown" and snapshot.get("index") is not None:
        errors.append("identity_receipt.snapshot.index_status=unknown cannot include index")
    snapshot_refs = _strings(snapshot.get("evidence_refs"), "identity_receipt.snapshot.evidence_refs", errors, max_items=MAX_EVIDENCE_REFS)

    time = receipt.get("time")
    if not isinstance(time, dict):
        errors.append("identity_receipt.time must be an object")
        time = {}
    if time.get("status") not in {"available", "unknown"}:
        errors.append("identity_receipt.time.status is invalid")
    window = time.get("window_ms")
    if time.get("status") == "unknown" and window is not None:
        errors.append("identity_receipt.time unknown status cannot include window_ms")
    if time.get("status") == "available":
        if not isinstance(window, dict) or not isinstance(window.get("start_ms"), (int, float)) or not isinstance(window.get("end_ms"), (int, float)):
            errors.append("identity_receipt.time available status requires numeric window_ms")
        elif window["start_ms"] > window["end_ms"]:
            errors.append("identity_receipt.time.window_ms start_ms must not exceed end_ms")
    time_refs = _strings(time.get("evidence_refs"), "identity_receipt.time.evidence_refs", errors, max_items=MAX_EVIDENCE_REFS)
    source = receipt.get("source")
    if not isinstance(source, dict):
        errors.append("identity_receipt.source must be an object")
    _context_identity(value, context_pack, errors)
    _, _, _, evidence_ids = _ids_from_pack(context_pack)
    if evidence_ids:
        for ref in snapshot_refs:
            if ref not in evidence_ids:
                errors.append(f"identity_receipt.snapshot.evidence_refs contains unknown evidence ID {ref}")
        for ref in time_refs:
            if ref not in evidence_ids:
                errors.append(f"identity_receipt.time.evidence_refs contains unknown evidence ID {ref}")


def _validate_answer_contract(value: dict[str, Any], errors: list[str]) -> None:
    """Validate the response sequence shared by policy and read-round skill."""
    strategy = _record(value.get("answer_strategy"))
    contract = strategy.get("answer_contract")
    if not isinstance(contract, dict):
        errors.append("answer_strategy.answer_contract must be an object")
        return
    if contract.get("version") != ANSWER_CONTRACT_VERSION:
        errors.append("answer_strategy.answer_contract.version is invalid")
    expected_sequence = ["identity_receipt", *ANSWER_SECTION_ORDER]
    if contract.get("response_sequence") != expected_sequence:
        errors.append("answer_strategy.answer_contract.response_sequence must start with identity_receipt and preserve source order")
    receipt_contract = contract.get("identity_receipt")
    if not isinstance(receipt_contract, dict):
        errors.append("answer_strategy.answer_contract.identity_receipt must be an object")
    else:
        if receipt_contract.get("required") is not True:
            errors.append("answer_strategy.answer_contract.identity_receipt.required must be true")
        if receipt_contract.get("placement") != "first":
            errors.append("answer_strategy.answer_contract.identity_receipt.placement must be first")
        fields = _strings(
            receipt_contract.get("fields"),
            "answer_strategy.answer_contract.identity_receipt.fields",
            errors,
        )
        if fields != list(IDENTITY_RECEIPT_FIELDS):
            errors.append("answer_strategy.answer_contract.identity_receipt.fields are invalid")
        user_visible = receipt_contract.get("user_visible")
        if not isinstance(user_visible, dict):
            errors.append("answer_strategy.answer_contract.identity_receipt.user_visible must be an object")
        else:
            if user_visible.get("required") is not True:
                errors.append("answer_strategy.answer_contract.identity_receipt.user_visible.required must be true")
            if user_visible.get("placement") != "first":
                errors.append("answer_strategy.answer_contract.identity_receipt.user_visible.placement must be first")
            visible_fields = _strings(
                user_visible.get("fields"),
                "answer_strategy.answer_contract.identity_receipt.user_visible.fields",
                errors,
            )
            if visible_fields != list(USER_VISIBLE_RECEIPT_FIELDS):
                errors.append("answer_strategy.answer_contract.identity_receipt.user_visible.fields are invalid")
    sections = contract.get("sections")
    if not isinstance(sections, dict):
        errors.append("answer_strategy.answer_contract.sections must be an object")
    else:
        expected_layers = {
            "observed": "visual_observation",
            "user_stated": "user_input",
            "inferred": "compiler_candidate",
            "unknown": "unresolved",
            "confirmed": "confirmation",
        }
        if set(sections) != set(expected_layers):
            errors.append("answer_strategy.answer_contract.sections must cover every answer section exactly once")
        for name, source_layer in expected_layers.items():
            section = sections.get(name)
            if not isinstance(section, dict):
                errors.append(f"answer_strategy.answer_contract.sections.{name} must be an object")
                continue
            if section.get("source_layer") != source_layer:
                errors.append(f"answer_strategy.answer_contract.sections.{name}.source_layer must equal {source_layer}")
    if contract.get("correction_section") != "user_stated":
        errors.append("answer_strategy.answer_contract.correction_section must be user_stated")
    if contract.get("user_input_not_inferred") is not True:
        errors.append("answer_strategy.answer_contract.user_input_not_inferred must be true")
    if contract.get("omit_empty_sections") is not True:
        errors.append("answer_strategy.answer_contract.omit_empty_sections must be true")
    if contract.get("execution_authorized") is not False:
        errors.append("answer_strategy.answer_contract.execution_authorized must be false")

    if strategy.get("opening_sections") != list(ANSWER_OPENING_SECTIONS):
        errors.append("answer_strategy.opening_sections must keep user_stated separate from inferred")
    if strategy.get("response_sequence") != expected_sequence:
        errors.append("answer_strategy.response_sequence must start with identity_receipt")
    if strategy.get("identity_receipt_required") is not True:
        errors.append("answer_strategy.identity_receipt_required must be true")
    if strategy.get("identity_receipt_placement") != "first":
        errors.append("answer_strategy.identity_receipt_placement must be first")
    if strategy.get("user_stated_section") != "user_stated":
        errors.append("answer_strategy.user_stated_section must be user_stated")


def _validate_section(
    section: Any,
    name: str,
    errors: list[str],
    *,
    claims: set[str],
    candidates: set[str],
    unresolved: set[str],
    evidence: set[str],
    source_available: bool,
    claim_index: dict[str, dict[str, Any]],
    candidate_index: dict[str, dict[str, Any]],
    unresolved_index: dict[str, dict[str, Any]],
) -> tuple[list[str], list[str], list[str]]:
    path = f"understanding.{name}"
    if not isinstance(section, dict):
        errors.append(f"{path} must be an object")
        return [], [], []
    if not isinstance(section.get("label"), str) or not section["label"].strip():
        errors.append(f"{path}.label must be non-empty text")
    expected_layer = {
        "observed": "visual_observation",
        "user_stated": "user_input",
        "inferred": "compiler_candidate",
        "unknown": "unresolved",
        "confirmed": "confirmation",
    }[name]
    if section.get("source_layer") != expected_layer:
        errors.append(f"{path}.source_layer must equal {expected_layer}")
    source_layers = _strings(section.get("source_layers"), f"{path}.source_layers", errors)
    if any(layer not in SOURCE_LAYERS for layer in source_layers):
        errors.append(f"{path}.source_layers contains an invalid source layer")
    if section.get("status") not in {"observed", "user_stated", "inferred", "unknown", "confirmed", "empty"}:
        errors.append(f"{path}.status is invalid")
    claim_ids = _strings(section.get("claim_ids"), f"{path}.claim_ids", errors)
    candidate_ids = _strings(section.get("candidate_ids"), f"{path}.candidate_ids", errors)
    unresolved_ids = _strings(section.get("unresolved_ids"), f"{path}.unresolved_ids", errors)
    unresolved_candidate_ids = _strings(section.get("unresolved_candidate_ids", []), f"{path}.unresolved_candidate_ids", errors)
    unavailable_claim_ids = _strings(section.get("unavailable_claim_ids", []), f"{path}.unavailable_claim_ids", errors)
    blocked_visual_claim_ids = _strings(section.get("blocked_visual_claim_ids", []), f"{path}.blocked_visual_claim_ids", errors)
    refs = _strings(section.get("evidence_refs"), f"{path}.evidence_refs", errors, max_items=MAX_EVIDENCE_REFS)
    if source_available:
        for ref in refs:
            if ref not in evidence:
                errors.append(f"{path}.evidence_refs contains unknown evidence ID {ref}")
    for claim_id in claim_ids:
        if source_available and claim_id not in claims:
            errors.append(f"{path}.claim_ids contains unknown claim ID {claim_id}")
            continue
        if source_available:
            claim = claim_index[claim_id]
            if name == "observed" and not (claim.get("source_layer") == "visual_observation" and claim.get("status") == "observed"):
                errors.append(f"{path}.claim_ids contains a non-observed claim {claim_id}")
            if name == "user_stated" and not (claim.get("source_layer") == "user_input" and claim.get("status") == "user_stated"):
                errors.append(f"{path}.claim_ids contains a non-user-stated claim {claim_id}")
            if name == "inferred" and claim.get("status") != "inferred":
                errors.append(f"{path}.claim_ids contains a non-inferred claim {claim_id}")
            if name == "confirmed" and not (claim.get("source_layer") == "confirmation" or claim.get("status") == "confirmed"):
                errors.append(f"{path}.claim_ids contains a non-confirmation claim {claim_id}")
    for candidate_id in candidate_ids:
        if source_available and candidate_id not in candidates:
            errors.append(f"{path}.candidate_ids contains unknown candidate ID {candidate_id}")
    for candidate_id in unresolved_candidate_ids:
        if candidate_id not in candidate_ids:
            errors.append(f"{path}.unresolved_candidate_ids must be a subset of candidate_ids")
        if source_available and candidate_id in candidate_index and candidate_index[candidate_id].get("status") != "unresolved":
            errors.append(f"{path}.unresolved_candidate_ids must point to unresolved candidates")
    for unresolved_id in unresolved_ids:
        if source_available and unresolved_id not in unresolved:
            errors.append(f"{path}.unresolved_ids contains unknown unresolved ID {unresolved_id}")
    for claim_id in unavailable_claim_ids:
        if source_available and (claim_id not in claims or claim_index[claim_id].get("source_layer") != "unavailable"):
            errors.append(f"{path}.unavailable_claim_ids must point to unavailable claims")
    if name != "unknown" and blocked_visual_claim_ids:
        errors.append(f"{path}.blocked_visual_claim_ids are only allowed in unknown")
    for claim_id in blocked_visual_claim_ids:
        if source_available and (claim_id not in claims or claim_index[claim_id].get("source_layer") != "visual_observation"):
            errors.append(f"{path}.blocked_visual_claim_ids must point to visual observations")
    if name == "user_stated":
        if candidate_ids or unresolved_ids or unresolved_candidate_ids or unavailable_claim_ids or blocked_visual_claim_ids:
            errors.append(f"{path} must not carry inference or unresolved IDs")
        corrections = section.get("correction_history")
        if not isinstance(corrections, list):
            errors.append(f"{path}.correction_history must be a list")
        elif len(corrections) > MAX_CORRECTION_HISTORY:
            errors.append(f"{path}.correction_history exceeds {MAX_CORRECTION_HISTORY}")
        else:
            allowed_keys = {"status", "source_layer", "text", "provenance", "text_truncated"}
            for correction_index, correction in enumerate(corrections):
                correction_path = f"{path}.correction_history[{correction_index}]"
                if not isinstance(correction, dict):
                    errors.append(f"{correction_path} must be an object")
                    continue
                if set(correction) - allowed_keys:
                    errors.append(f"{correction_path} must contain only bounded user correction fields")
                if correction.get("status") != "user_stated" or correction.get("source_layer") != "user_input":
                    errors.append(f"{correction_path} must remain user_input/user_stated")
                if correction.get("provenance") != "explicit_user_correction":
                    errors.append(f"{correction_path}.provenance must be explicit_user_correction")
                if not isinstance(correction.get("text"), str) or not correction["text"].strip():
                    errors.append(f"{correction_path}.text must be non-empty")
                elif len(correction["text"]) > 500:
                    errors.append(f"{correction_path}.text exceeds the bounded correction text length")
                if not isinstance(correction.get("text_truncated"), bool):
                    errors.append(f"{correction_path}.text_truncated must be boolean")
    elif "correction_history" in section:
        errors.append(f"{path}.correction_history is only allowed in user_stated")
    return claim_ids, candidate_ids, unresolved_ids


def _validate_understanding(value: dict[str, Any], context_pack: dict[str, Any] | None, errors: list[str]) -> None:
    understanding = value.get("understanding")
    if not isinstance(understanding, dict):
        errors.append("understanding must be an object")
        return
    missing = SECTION_NAMES - set(understanding)
    errors.extend(f"understanding is missing {name}" for name in sorted(missing))
    raw_claims = _items(context_pack.get("claims")) if isinstance(context_pack, dict) else []
    raw_candidates = _items(context_pack.get("relation_candidates")) if isinstance(context_pack, dict) else []
    raw_unresolved = _items(context_pack.get("unresolved")) if isinstance(context_pack, dict) else []
    claims, candidates, unresolved, evidence = _ids_from_pack(context_pack)
    source_available = isinstance(context_pack, dict)
    claim_index = {item.get("claim_id"): item for item in raw_claims if isinstance(item.get("claim_id"), str)}
    candidate_index = {item.get("candidate_id"): item for item in raw_candidates if isinstance(item.get("candidate_id"), str)}
    unresolved_index = {item.get("id"): item for item in raw_unresolved if isinstance(item.get("id"), str)}
    seen_claims: set[str] = set()
    for name in sorted(SECTION_NAMES):
        claim_ids, _, _ = _validate_section(
            understanding.get(name), name, errors,
            claims=claims,
            candidates=candidates,
            unresolved=unresolved,
            evidence=evidence,
            source_available=source_available,
            claim_index=claim_index,
            candidate_index=candidate_index,
            unresolved_index=unresolved_index,
        )
        for claim_id in claim_ids:
            if claim_id in seen_claims:
                errors.append(f"understanding repeats claim ID {claim_id} across sections")
            seen_claims.add(claim_id)
    inferred = _record(understanding.get("inferred"))
    unknown = _record(understanding.get("unknown"))
    inferred_candidates = set(inferred.get("candidate_ids", [])) if isinstance(inferred.get("candidate_ids"), list) else set()
    unknown_candidates = set(unknown.get("unresolved_candidate_ids", [])) if isinstance(unknown.get("unresolved_candidate_ids"), list) else set()
    if not unknown_candidates.issubset(inferred_candidates):
        errors.append("understanding.unknown.unresolved_candidate_ids must be a subset of inferred.candidate_ids")


def _validate_confirmation_gate(value: dict[str, Any], context_pack: dict[str, Any] | None, errors: list[str]) -> None:
    gate = value.get("confirmation_gate")
    if not isinstance(gate, dict):
        errors.append("confirmation_gate must be an object")
        return
    if gate.get("status") not in {"awaiting_user_confirmation", "confirmed_scope_only"}:
        errors.append("confirmation_gate.status is invalid")
    if gate.get("requires_explicit_confirmation") is not True:
        errors.append("confirmation_gate.requires_explicit_confirmation must be true")
    if gate.get("confirmation_scope") != "explicit_claim_only":
        errors.append("confirmation_gate.confirmation_scope must be explicit_claim_only")
    if gate.get("execution_authorized") is not False:
        errors.append("confirmation_gate.execution_authorized must be false")
    claim_ids = _strings(gate.get("confirmation_claim_ids"), "confirmation_gate.confirmation_claim_ids", errors)
    refs = _strings(gate.get("evidence_refs"), "confirmation_gate.evidence_refs", errors, max_items=MAX_EVIDENCE_REFS)
    claims, _, _, evidence = _ids_from_pack(context_pack)
    if evidence:
        for ref in refs:
            if ref not in evidence:
                errors.append(f"confirmation_gate.evidence_refs contains unknown evidence ID {ref}")
    if context_pack:
        claim_index = {item.get("claim_id"): item for item in _items(context_pack.get("claims")) if isinstance(item.get("claim_id"), str)}
        for claim_id in claim_ids:
            if claim_id not in claims:
                errors.append(f"confirmation_gate contains unknown claim ID {claim_id}")
            elif claim_index[claim_id].get("source_layer") != "confirmation" and claim_index[claim_id].get("status") != "confirmed":
                errors.append(f"confirmation_gate contains non-confirmation claim {claim_id}")


def _validate_correction(correction: Any, context_pack: dict[str, Any] | None, errors: list[str]) -> None:
    if not isinstance(correction, dict):
        errors.append("continuity.reconciliation.correction must be an object")
        return
    if correction.get("status") == "none":
        return
    if correction.get("status") != "user_stated" or correction.get("source_layer") != "user_input":
        errors.append("continuity correction must remain user_input/user_stated")
    if not isinstance(correction.get("text"), str) or not correction["text"].strip():
        errors.append("continuity correction text must be non-empty")
    if "text_truncated" in correction and not isinstance(correction.get("text_truncated"), bool):
        errors.append("continuity correction text_truncated must be boolean")
    claim_ids = _strings(correction.get("claim_ids"), "continuity.reconciliation.correction.claim_ids", errors)
    refs = _strings(correction.get("evidence_refs"), "continuity.reconciliation.correction.evidence_refs", errors, max_items=MAX_EVIDENCE_REFS)
    claims, _, _, evidence = _ids_from_pack(context_pack)
    for claim_id in claim_ids:
        if isinstance(context_pack, dict) and claim_id not in claims:
            errors.append(f"continuity correction contains unknown claim ID {claim_id}")
    for ref in refs:
        if isinstance(context_pack, dict) and ref not in evidence:
            errors.append(f"continuity correction contains unknown evidence ID {ref}")


def _validate_correction_history(reconciliation: dict[str, Any], errors: list[str]) -> None:
    history = reconciliation.get("correction_history")
    if not isinstance(history, list):
        errors.append("continuity.reconciliation.correction_history must be a list")
        history = []
    if len(history) > MAX_CORRECTION_HISTORY:
        errors.append(f"continuity.reconciliation.correction_history exceeds {MAX_CORRECTION_HISTORY}")
    if reconciliation.get("correction_history_limit") != MAX_CORRECTION_HISTORY:
        errors.append("continuity.reconciliation.correction_history_limit is invalid")
    if not isinstance(reconciliation.get("correction_history_truncated"), bool):
        errors.append("continuity.reconciliation.correction_history_truncated must be boolean")
    allowed_keys = {"status", "source_layer", "text", "provenance", "text_truncated"}
    for index, item in enumerate(history):
        path = f"continuity.reconciliation.correction_history[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{path} must be an object")
            continue
        if set(item) - allowed_keys:
            errors.append(f"{path} must not carry claims, candidates, or prior evidence references")
        if item.get("status") != "user_stated" or item.get("source_layer") != "user_input":
            errors.append(f"{path} must remain user_input/user_stated")
        if item.get("provenance") != "explicit_user_correction":
            errors.append(f"{path}.provenance must be explicit_user_correction")
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            errors.append(f"{path}.text must be non-empty")
        elif len(text) > 500:
            errors.append(f"{path}.text exceeds the bounded correction text length")
        if not isinstance(item.get("text_truncated"), bool):
            errors.append(f"{path}.text_truncated must be boolean")


def _validate_continuity(
    value: dict[str, Any],
    errors: list[str],
    context_pack: dict[str, Any] | None = None,
) -> None:
    continuity = value.get("continuity")
    if not isinstance(continuity, dict):
        errors.append("continuity must be an object")
        return
    if continuity.get("version") != CONTINUITY_VERSION:
        errors.append(f"continuity.version must equal {CONTINUITY_VERSION}")
    if continuity.get("read_mode") not in READ_MODES:
        errors.append("continuity.read_mode is invalid")
    if continuity.get("status") not in CONTINUITY_STATUSES:
        errors.append("continuity.status is invalid")
    decision = continuity.get("response_decision")
    if decision not in {
        "answer_current_context",
        "answer_current_context_only",
        "block_until_new_context",
        "block_cross_context_reconciliation",
        "do_not_reuse",
    }:
        errors.append("continuity.response_decision is invalid")
    if continuity.get("current_context_id") != value.get("context_id"):
        errors.append("continuity.current_context_id must match policy.context_id")
    lineage = continuity.get("context_lineage")
    if not isinstance(lineage, list) or not lineage:
        errors.append("continuity.context_lineage must be a non-empty list")
        lineage = []
    elif len(lineage) > MAX_CONTEXT_LINEAGE:
        errors.append(f"continuity.context_lineage exceeds {MAX_CONTEXT_LINEAGE}")
    valid_lineage = [item for item in lineage if isinstance(item, str) and item]
    if len(valid_lineage) != len(lineage):
        errors.append("continuity.context_lineage must contain non-empty context IDs")
    if len(set(valid_lineage)) != len(valid_lineage):
        errors.append("continuity.context_lineage must not repeat context IDs")
    if lineage and lineage[-1] != value.get("context_id"):
        errors.append("continuity.context_lineage must end at the current context")
    if not isinstance(continuity.get("context_lineage_truncated"), bool):
        errors.append("continuity.context_lineage_truncated must be boolean")
    parent = continuity.get("parent_context_id")
    if parent is not None and not isinstance(parent, str):
        errors.append("continuity.parent_context_id must be text or null")
    supersedes = continuity.get("supersedes")
    if not isinstance(supersedes, list):
        errors.append("continuity.supersedes must be a list")
        supersedes = []
    seen: set[str] = set()
    for index, item in enumerate(supersedes):
        path = f"continuity.supersedes[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{path} must be an object")
            continue
        context_id = item.get("context_id")
        if not isinstance(context_id, str) or not context_id:
            errors.append(f"{path}.context_id must be non-empty text")
        elif context_id in seen:
            errors.append(f"{path}.context_id is duplicated")
        else:
            seen.add(context_id)
        if item.get("status") != "superseded":
            errors.append(f"{path}.status must be superseded")
        if context_id == value.get("context_id"):
            errors.append(f"{path}.context_id cannot be current context")
    reconciliation = continuity.get("reconciliation")
    if not isinstance(reconciliation, dict):
        errors.append("continuity.reconciliation must be an object")
        return
    if reconciliation.get("status") not in RECONCILIATION_STATUSES:
        errors.append("continuity.reconciliation.status is invalid")
    if reconciliation.get("current_context_id") != value.get("context_id"):
        errors.append("continuity.reconciliation.current_context_id must match policy.context_id")
    if not isinstance(reconciliation.get("reuse_superseded_context"), bool) or reconciliation.get("reuse_superseded_context") is not False:
        errors.append("continuity.reconciliation.reuse_superseded_context must be false")
    if reconciliation.get("identity_match") not in {True, False, None}:
        errors.append("continuity.reconciliation.identity_match must be boolean or null")
    _validate_correction(reconciliation.get("correction"), context_pack, errors)
    _validate_correction_history(reconciliation, errors)
    status = continuity.get("status")
    rec_status = reconciliation.get("status")
    expected_decisions = {
        "current": "answer_current_context",
        "reconciled": "answer_current_context_only",
        "needs_re_read": "block_until_new_context",
        "identity_mismatch": "block_cross_context_reconciliation",
        "superseded": "do_not_reuse",
    }
    if status in expected_decisions and decision != expected_decisions[status]:
        errors.append("continuity.response_decision does not match continuity.status")
    if status == "current" and (continuity.get("read_mode") != "initial" or rec_status != "not_applicable" or supersedes):
        errors.append("current continuity must be an initial, non-reconciled context")
    if status == "reconciled":
        if continuity.get("read_mode") != "re_read" or rec_status != "reconciled" or not supersedes:
            errors.append("reconciled continuity requires re_read, reconciled status, and a superseded context")
        if reconciliation.get("identity_match") is not True:
            errors.append("reconciled continuity requires identity_match=true")
        if continuity.get("parent_context_id") != reconciliation.get("previous_context_id"):
            errors.append("reconciled continuity parent_context_id must point to previous_context_id")
    if status == "identity_mismatch" and rec_status != "identity_mismatch":
        errors.append("identity_mismatch continuity requires identity_mismatch reconciliation")
    if status == "needs_re_read" and rec_status not in {"same_context", "previous_superseded"}:
        errors.append("needs_re_read continuity requires a blocked reread reason")
    if status == "superseded" and rec_status != "not_applicable":
        errors.append("superseded continuity must not be reconciled")


def validate_context_continuity_policy(value: Any, context_pack: Any | None = None) -> list[str]:
    """Return structural, provenance, recovery, and execution-gate errors."""
    if not isinstance(value, dict):
        return ["continuity policy must be a JSON object"]
    errors = _walk_forbidden(value)
    errors.extend(validate_context_response_policy(value, context_pack))
    missing = sorted(REQUIRED_FIELDS - set(value))
    errors.extend(f"Missing required field: {field}" for field in missing)
    if isinstance(context_pack, dict):
        _context_identity(value, context_pack, errors)
    _validate_identity_receipt(value, context_pack if isinstance(context_pack, dict) else None, errors)
    _validate_answer_contract(value, errors)
    _validate_understanding(value, context_pack if isinstance(context_pack, dict) else None, errors)
    _validate_confirmation_gate(value, context_pack if isinstance(context_pack, dict) else None, errors)
    _validate_continuity(value, errors, context_pack if isinstance(context_pack, dict) else None)
    if value.get("execution_authorized") is not False:
        errors.append("continuity policy execution_authorized must be false")
    constraints = _record(value.get("constraints"))
    if constraints.get("execution_authorized") is not False:
        errors.append("continuity policy constraints.execution_authorized must be false")
    if constraints.get("continuity_recovery") != "superseded_contexts_are_not_reusable":
        errors.append("constraints.continuity_recovery must prohibit superseded context reuse")
    return list(dict.fromkeys(errors))


def validate_context_handoff(value: Any, context_pack: Any | None = None) -> list[str]:
    return validate_context_continuity_policy(value, context_pack)


validate_continuity_policy = validate_context_continuity_policy
validate_reconciled_response_policy = validate_context_continuity_policy


def validate_package(value: Any, context_pack: Any | None = None) -> tuple[list[str], list[str]]:
    return validate_context_continuity_policy(value, context_pack), []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("policy", type=Path)
    parser.add_argument("--context-pack", type=Path)
    args = parser.parse_args(argv)
    try:
        policy = json.loads(args.policy.read_text(encoding="utf-8"))
        context_pack = json.loads(args.context_pack.read_text(encoding="utf-8")) if args.context_pack else None
    except (OSError, json.JSONDecodeError) as error:  # pragma: no cover - CLI guard
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    errors = validate_context_continuity_policy(policy, context_pack)
    if errors:
        print("FAIL")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI guard
    raise SystemExit(main())
