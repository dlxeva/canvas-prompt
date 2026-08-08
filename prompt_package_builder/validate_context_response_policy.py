#!/usr/bin/env python3
"""Validate the MCPack-02 evidence-layered response policy."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

try:  # package import
    from .build_context_response_policy import (  # type: ignore
        ANSWER_ORDER,
        CONTRACT,
        FORBIDDEN_KEYS,
        LAYER_STATUSES,
        REQUEST_KINDS,
        SNAPSHOT_GATED_REQUEST_KINDS,
        SNAPSHOT_STATES,
        SOURCE_LAYERS,
    )
except ImportError:  # existing script-style imports
    from build_context_response_policy import (  # noqa: F401
        ANSWER_ORDER,
        CONTRACT,
        FORBIDDEN_KEYS,
        LAYER_STATUSES,
        REQUEST_KINDS,
        SNAPSHOT_GATED_REQUEST_KINDS,
        SNAPSHOT_STATES,
        SOURCE_LAYERS,
    )


REQUIRED_FIELDS = {
    "contract",
    "policy_version",
    "context_id",
    "request",
    "snapshot_gate",
    "evidence_layers",
    "answer_strategy",
    "constraints",
    "execution_authorized",
    "budget",
}
_ID_RE = re.compile(r"^ctx_[A-Za-z0-9_-]+$")


def _walk_for_forbidden(value: Any, path: str = "$") -> list[str]:
    errors: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in FORBIDDEN_KEYS:
                errors.append(f"{path}.{key} is complete-archive material and cannot enter a response policy")
            errors.extend(_walk_for_forbidden(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            errors.extend(_walk_for_forbidden(child, f"{path}[{index}]"))
    return errors


def _strings(value: Any, prefix: str, errors: list[str], *, max_items: int | None = None) -> list[str]:
    if not isinstance(value, list):
        errors.append(f"{prefix} must be a list")
        return []
    if max_items is not None and len(value) > max_items:
        errors.append(f"{prefix} exceeds {max_items}")
    result: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item:
            errors.append(f"{prefix}[{index}] must be a non-empty string")
            continue
        if item in seen:
            errors.append(f"{prefix} must not contain duplicate IDs")
        seen.add(item)
        result.append(item)
    return result


def _indexes(
    context_pack: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    raw_claims = context_pack.get("claims") if isinstance(context_pack.get("claims"), list) else []
    raw_candidates = (
        context_pack.get("relation_candidates")
        if isinstance(context_pack.get("relation_candidates"), list)
        else []
    )
    raw_unresolved = context_pack.get("unresolved") if isinstance(context_pack.get("unresolved"), list) else []
    claims = {
        item.get("claim_id"): item
        for item in raw_claims
        if isinstance(item, dict) and isinstance(item.get("claim_id"), str)
    }
    candidates = {
        item.get("candidate_id"): item
        for item in raw_candidates
        if isinstance(item, dict) and isinstance(item.get("candidate_id"), str)
    }
    unresolved = {
        item.get("id"): item
        for item in raw_unresolved
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    return claims, candidates, unresolved


def _context_identity(value: Any, context_pack: dict[str, Any], errors: list[str]) -> None:
    for field in ("context_id", "package_id", "round_id"):
        if field in context_pack and value.get(field) != context_pack.get(field):
            errors.append(f"{field} must match the source Context Pack")


def _validate_layer(
    layer: Any,
    index: int,
    errors: list[str],
    *,
    claims: dict[str, dict[str, Any]] | None,
    candidates: dict[str, dict[str, Any]] | None,
    unresolved: dict[str, dict[str, Any]] | None,
    seen_claim_ids: set[str],
    seen_candidate_ids: set[str],
    seen_unresolved_ids: set[str],
    evidence_ids: set[str] | None,
) -> None:
    prefix = f"evidence_layers[{index}]"
    if not isinstance(layer, dict):
        errors.append(f"{prefix} must be an object")
        return
    source_layer = layer.get("source_layer")
    if source_layer not in SOURCE_LAYERS:
        errors.append(f"{prefix}.source_layer is invalid")
    if not isinstance(layer.get("allowed"), bool):
        errors.append(f"{prefix}.allowed must be boolean")
    if layer.get("status") not in LAYER_STATUSES:
        errors.append(f"{prefix}.status is invalid")
    if not isinstance(layer.get("instruction"), str) or not layer.get("instruction").strip():
        errors.append(f"{prefix}.instruction must be non-empty text")

    claim_ids = _strings(layer.get("claim_ids"), f"{prefix}.claim_ids", errors)
    candidate_ids = _strings(layer.get("candidate_ids"), f"{prefix}.candidate_ids", errors)
    unresolved_candidate_ids = _strings(
        layer.get("unresolved_candidate_ids"),
        f"{prefix}.unresolved_candidate_ids",
        errors,
    )
    unresolved_ids = _strings(layer.get("unresolved_ids"), f"{prefix}.unresolved_ids", errors)
    unavailable_claim_ids = _strings(
        layer.get("unavailable_claim_ids", []),
        f"{prefix}.unavailable_claim_ids",
        errors,
    )
    layer_evidence_refs = _strings(layer.get("evidence_refs"), f"{prefix}.evidence_refs", errors, max_items=5)
    if evidence_ids is not None:
        for evidence_id in layer_evidence_refs:
            if evidence_id not in evidence_ids:
                errors.append(f"{prefix}.evidence_refs contains unknown evidence ID {evidence_id}")

    for claim_id in claim_ids:
        if claim_id in seen_claim_ids:
            errors.append(f"{prefix}.claim_ids repeats {claim_id} across layers")
        seen_claim_ids.add(claim_id)
        if claims is not None:
            claim = claims.get(claim_id)
            if claim is None:
                errors.append(f"{prefix}.claim_ids contains unknown claim ID {claim_id}")
            elif source_layer not in {claim.get("source_layer"), "unresolved"}:
                errors.append(f"{prefix}.claim_ids source layer does not match {claim_id}")

    for claim_id in unavailable_claim_ids:
        if claim_id in seen_claim_ids:
            errors.append(f"{prefix}.unavailable_claim_ids repeats {claim_id} across layers")
        seen_claim_ids.add(claim_id)
        if claims is not None:
            claim = claims.get(claim_id)
            if claim is None:
                errors.append(f"{prefix}.unavailable_claim_ids contains unknown claim ID {claim_id}")
            elif claim.get("source_layer") != "unavailable":
                errors.append(f"{prefix}.unavailable_claim_ids must point to unavailable claims")

    for candidate_id in candidate_ids:
        if candidate_id in seen_candidate_ids:
            errors.append(f"{prefix}.candidate_ids repeats {candidate_id} across layers")
        seen_candidate_ids.add(candidate_id)
        if source_layer != "compiler_candidate":
            errors.append(f"{prefix}.candidate_ids are only allowed in compiler_candidate")
        if candidates is not None and candidate_id not in candidates:
            errors.append(f"{prefix}.candidate_ids contains unknown candidate ID {candidate_id}")

    for candidate_id in unresolved_candidate_ids:
        if candidate_id not in candidate_ids:
            errors.append(f"{prefix}.unresolved_candidate_ids must be a subset of candidate_ids")
        if source_layer != "compiler_candidate":
            errors.append(f"{prefix}.unresolved_candidate_ids are only allowed in compiler_candidate")
        if candidates is not None:
            candidate = candidates.get(candidate_id)
            if candidate is None:
                errors.append(f"{prefix}.unresolved_candidate_ids contains unknown candidate ID {candidate_id}")
            elif candidate.get("status") != "unresolved":
                errors.append(f"{prefix}.unresolved_candidate_ids must point to unresolved candidates")

    for unresolved_id in unresolved_ids:
        if unresolved_id in seen_unresolved_ids:
            errors.append(f"{prefix}.unresolved_ids repeats {unresolved_id} across layers")
        seen_unresolved_ids.add(unresolved_id)
        if source_layer != "unresolved":
            errors.append(f"{prefix}.unresolved_ids are only allowed in unresolved")
        if unresolved is not None and unresolved_id not in unresolved:
            errors.append(f"{prefix}.unresolved_ids contains unknown unresolved ID {unresolved_id}")

    if unavailable_claim_ids and source_layer != "unresolved":
        errors.append(f"{prefix}.unavailable_claim_ids are only allowed in unresolved")


def validate_context_response_policy(value: Any, context_pack: Any | None = None) -> list[str]:
    """Return structural and hard-gate errors for one response policy.

    ``context_pack`` is optional so a stored policy can be checked on its own.
    Supplying the source pack additionally checks every claim/candidate ID and
    identity binding without requiring a model or archive read.
    """
    errors: list[str] = []
    if not isinstance(value, dict):
        return ["response policy must be a JSON object"]
    errors.extend(_walk_for_forbidden(value))
    missing = sorted(REQUIRED_FIELDS - set(value))
    errors.extend(f"Missing required field: {field}" for field in missing)
    if value.get("contract") != CONTRACT:
        errors.append(f"contract must equal {CONTRACT}")
    if not isinstance(value.get("policy_version"), str) or not value.get("policy_version"):
        errors.append("policy_version must be a non-empty string")
    if not isinstance(value.get("context_id"), str) or not _ID_RE.match(value["context_id"]):
        errors.append("context_id must be a ctx_ identifier")
    if value.get("execution_authorized") is not False:
        errors.append("top-level execution_authorized must be false")

    request = value.get("request")
    if not isinstance(request, dict):
        errors.append("request must be an object")
        request = {}
    request_kind = request.get("kind")
    if request_kind not in REQUEST_KINDS:
        errors.append("request.kind is invalid")
    if not isinstance(request.get("question"), str) or not request.get("question").strip():
        errors.append("request.question must be non-empty bounded text")
    if not isinstance(request.get("requires_final_snapshot"), bool):
        errors.append("request.requires_final_snapshot must be boolean")
    elif (
        request_kind in REQUEST_KINDS
        and request["requires_final_snapshot"] != (request_kind in SNAPSHOT_GATED_REQUEST_KINDS)
    ):
        errors.append("request.requires_final_snapshot does not match request.kind")

    gate = value.get("snapshot_gate")
    if not isinstance(gate, dict):
        errors.append("snapshot_gate must be an object")
        gate = {}
    if not isinstance(gate.get("required"), bool):
        errors.append("snapshot_gate.required must be boolean")
    elif request_kind in REQUEST_KINDS and gate["required"] != (request_kind in SNAPSHOT_GATED_REQUEST_KINDS):
        errors.append("snapshot_gate.required does not match request.kind")
    if gate.get("read") != "final_snapshot":
        errors.append("snapshot_gate.read must be final_snapshot")
    if gate.get("status") not in SNAPSHOT_STATES:
        errors.append("snapshot_gate.status is invalid")
    if gate.get("decision") not in {"allow_visual_claims", "block_visual_claims"}:
        errors.append("snapshot_gate.decision is invalid")
    expected_decision = "allow_visual_claims" if gate.get("status") == "available" else "block_visual_claims"
    if gate.get("decision") != expected_decision:
        errors.append("snapshot_gate.decision violates final snapshot hard gate")
    if not isinstance(gate.get("reason"), str) or not gate.get("reason").strip():
        errors.append("snapshot_gate.reason must be non-empty text")
    if not isinstance(gate.get("evidence_source"), str) or not gate.get("evidence_source").strip():
        errors.append("snapshot_gate.evidence_source must be non-empty text")
    gate_refs = _strings(gate.get("evidence_refs"), "snapshot_gate.evidence_refs", errors, max_items=5)
    if gate.get("status") != "available" and gate_refs:
        errors.append("blocked snapshot gate must not expose final snapshot evidence refs")

    source_pack = context_pack if isinstance(context_pack, dict) else None
    claims: dict[str, dict[str, Any]] | None = None
    candidates: dict[str, dict[str, Any]] | None = None
    unresolved: dict[str, dict[str, Any]] | None = None
    evidence_ids: set[str] | None = None
    if source_pack is not None:
        _context_identity(value, source_pack, errors)
        claims, candidates, unresolved = _indexes(source_pack)
        raw_evidence = source_pack.get("evidence") if isinstance(source_pack.get("evidence"), list) else []
        evidence_ids = {
            item.get("evidence_id")
            for item in raw_evidence
            if isinstance(item, dict) and isinstance(item.get("evidence_id"), str)
        }
        for evidence_id in gate_refs:
            if evidence_id not in evidence_ids:
                errors.append(f"snapshot_gate.evidence_refs contains unknown evidence ID {evidence_id}")

    layers = value.get("evidence_layers")
    if not isinstance(layers, list):
        errors.append("evidence_layers must be a list")
        layers = []
    seen_layers: set[str] = set()
    seen_claim_ids: set[str] = set()
    seen_candidate_ids: set[str] = set()
    seen_unresolved_ids: set[str] = set()
    for index, layer in enumerate(layers):
        if isinstance(layer, dict):
            source_layer = layer.get("source_layer")
            if source_layer in seen_layers:
                errors.append(f"evidence_layers contains duplicate source layer {source_layer}")
            seen_layers.add(source_layer)
        _validate_layer(
            layer,
            index,
            errors,
            claims=claims,
            candidates=candidates,
            unresolved=unresolved,
            seen_claim_ids=seen_claim_ids,
            seen_candidate_ids=seen_candidate_ids,
            seen_unresolved_ids=seen_unresolved_ids,
            evidence_ids=evidence_ids,
        )
    if seen_layers != set(SOURCE_LAYERS):
        errors.append("evidence_layers must contain exactly the five required source/state layers")

    layer_by_name = {
        layer.get("source_layer"): layer
        for layer in layers
        if isinstance(layer, dict) and isinstance(layer.get("source_layer"), str)
    }
    visual_layer = layer_by_name.get("visual_observation", {})
    if gate.get("decision") == "block_visual_claims":
        if visual_layer.get("allowed") is not False:
            errors.append("blocked snapshot gate requires visual_observation.allowed=false")
        for key in ("claim_ids", "candidate_ids", "unresolved_candidate_ids", "unresolved_ids", "evidence_refs"):
            if visual_layer.get(key):
                errors.append(f"blocked snapshot gate requires visual_observation.{key} to be empty")
        if visual_layer.get("status") != "blocked":
            errors.append("blocked snapshot gate requires visual_observation.status=blocked")
    elif gate.get("decision") == "allow_visual_claims":
        if visual_layer.get("allowed") is not True:
            errors.append("available final snapshot requires visual_observation.allowed=true")
        if visual_layer.get("status") == "blocked":
            errors.append("available final snapshot cannot leave visual_observation blocked")

    answer_strategy = value.get("answer_strategy")
    if not isinstance(answer_strategy, dict):
        errors.append("answer_strategy must be an object")
        answer_strategy = {}
    order = answer_strategy.get("answer_order")
    if order != list(ANSWER_ORDER):
        errors.append(
            "answer_strategy.answer_order must preserve confirmation, direct evidence, candidates, unresolved order"
        )
    if answer_strategy.get("visual_conclusion") != (
        "allowed" if gate.get("decision") == "allow_visual_claims" else "blocked"
    ):
        errors.append("answer_strategy.visual_conclusion must mirror the snapshot gate")
    instructions = answer_strategy.get("instructions")
    if (
        not isinstance(instructions, list)
        or not instructions
        or any(not isinstance(item, str) or not item.strip() for item in instructions)
    ):
        errors.append("answer_strategy.instructions must contain non-empty text")
    rule_ids = _strings(answer_strategy.get("rule_ids"), "answer_strategy.rule_ids", errors)
    required_rules = {
        "confirmation_scope_is_explicit",
        "visual_claims_require_final_snapshot",
        "user_input_is_not_visual_observation",
        "compiler_candidates_stay_candidates",
        "unresolved_is_preserved",
    }
    if not required_rules.issubset(set(rule_ids)):
        errors.append("answer_strategy.rule_ids must include all evidence-layer safety rules")
    if answer_strategy.get("execution_authorized") is not False:
        errors.append("answer_strategy.execution_authorized must be false")

    constraints = value.get("constraints")
    if not isinstance(constraints, dict):
        errors.append("constraints must be an object")
    else:
        if constraints.get("execution_authorized") is not False:
            errors.append("constraints.execution_authorized must be false")
        if constraints.get("visual_conclusions_require_final_snapshot") is not True:
            errors.append("constraints.visual_conclusions_require_final_snapshot must be true")
        if constraints.get("confirmation_scope") != "explicit_claim_only":
            errors.append("constraints.confirmation_scope must be explicit_claim_only")

    budget = value.get("budget")
    if not isinstance(budget, dict):
        errors.append("budget must be an object")
    else:
        for field in ("claim_count", "candidate_count", "unresolved_count", "max_layer_evidence_refs"):
            if not isinstance(budget.get(field), int) or budget[field] < 0:
                errors.append(f"budget.{field} must be a non-negative integer")
        if budget.get("max_layer_evidence_refs") != 5:
            errors.append("budget.max_layer_evidence_refs must be 5")
        if source_pack is not None:
            raw_claims = source_pack.get("claims") if isinstance(source_pack.get("claims"), list) else []
            raw_candidates = (
                source_pack.get("relation_candidates")
                if isinstance(source_pack.get("relation_candidates"), list)
                else []
            )
            raw_unresolved = source_pack.get("unresolved") if isinstance(source_pack.get("unresolved"), list) else []
            if budget.get("claim_count") != len(raw_claims):
                errors.append("budget.claim_count must equal source Context Pack claims")
            if budget.get("candidate_count") != len(raw_candidates):
                errors.append("budget.candidate_count must equal source Context Pack candidates")
            if budget.get("unresolved_count") != len(raw_unresolved):
                errors.append("budget.unresolved_count must equal source Context Pack unresolved")

    return errors


def validate_response_policy(value: Any, context_pack: Any | None = None) -> list[str]:
    return validate_context_response_policy(value, context_pack)


validate_layered_answer_policy = validate_context_response_policy
validate_policy = validate_context_response_policy


def validate_package(value: Any, context_pack: Any | None = None) -> tuple[list[str], list[str]]:
    """Match the existing validator's ``(errors, warnings)`` adapter shape."""
    return validate_context_response_policy(value, context_pack), []


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
    errors = validate_context_response_policy(policy, context_pack)
    if errors:
        print("FAIL")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI guard
    raise SystemExit(main())
