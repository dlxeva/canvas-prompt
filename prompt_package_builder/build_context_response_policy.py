#!/usr/bin/env python3
"""Build a bounded, evidence-layered response policy for a Context Pack.

MCPack-02 is deliberately a read-only policy layer.  It does not produce a
model answer, read the archive, call a model, or mutate Prompt Package,
Process IR, or the Context Pack.  Its most important invariant is fail-closed:
an understanding/paraphrase response may use visual claims only when the
Context Pack explicitly reports an available final canvas snapshot.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable


CONTRACT = "canvas-prompt/context-response-policy/0.1-draft"
POLICY_VERSION = "0.1-draft"

SOURCE_LAYERS = (
    "visual_observation",
    "user_input",
    "compiler_candidate",
    "confirmation",
    "unresolved",
)
ANSWER_ORDER = (
    "confirmation",
    "visual_observation",
    "user_input",
    "compiler_candidate",
    "unresolved",
)
REQUEST_KINDS = {"understand", "summarize", "propose", "review", "paraphrase"}
SNAPSHOT_GATED_REQUEST_KINDS = {"understand", "summarize", "review", "paraphrase"}
SNAPSHOT_STATES = {"available", "degraded", "unavailable", "conflicting"}
LAYER_STATUSES = {"available", "blocked", "candidate_only", "confirmed_only", "always_include", "empty"}

# Keep the policy as small as the Context Pack.  These are archive/raw-media
# names, and rejecting them here prevents a caller from hiding an archive in a
# strategy object or in an instruction payload.
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

_REQUEST_ALIASES = {
    "理解": "understand",
    "复述": "paraphrase",
    "总结": "summarize",
    "概括": "summarize",
    "审阅": "review",
    "提案": "propose",
    "restatement": "paraphrase",
    "recap": "summarize",
}


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[dict[str, Any]]:
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


def _claim_id(item: dict[str, Any]) -> str | None:
    value = item.get("claim_id")
    return value if isinstance(value, str) and value else None


def _candidate_id(item: dict[str, Any]) -> str | None:
    value = item.get("candidate_id")
    return value if isinstance(value, str) and value else None


def _unresolved_id(item: dict[str, Any]) -> str | None:
    value = item.get("id")
    return value if isinstance(value, str) and value else None


def _item_refs(item: dict[str, Any]) -> list[str]:
    return _unique_strings(item.get("evidence_refs", []))


def _normalise_request_kind(context_pack: dict[str, Any], request_kind: str | None) -> str:
    task = _as_dict(context_pack.get("task"))
    raw = request_kind if request_kind is not None else task.get("kind")
    value = str(raw or "understand").strip().casefold()
    value = _REQUEST_ALIASES.get(value, value)
    if value not in REQUEST_KINDS:
        raise ValueError(f"unsupported response-policy request kind: {raw!r}")
    return value


def _snapshot_gate(context_pack: dict[str, Any], request_kind: str) -> dict[str, Any]:
    quality = _as_dict(context_pack.get("quality"))
    layers = _as_dict(quality.get("layers"))
    quality_state = layers.get("final_snapshot")
    evidence = _as_list(context_pack.get("evidence"))

    # MCPack-01 exposes final snapshot availability in quality.  A custom
    # envelope may additionally expose a bounded final_snapshot evidence item;
    # an explicitly unavailable item always wins so the policy cannot open the
    # gate on contradictory metadata.
    snapshot_evidence = [
        item for item in evidence
        if item.get("kind") == "final_snapshot"
        or item.get("evidence_id") in {"ev_final_snapshot", "ev_snapshot_final"}
        or "final_snapshot" in str(item.get("evidence_id", ""))
    ]
    unavailable_evidence = [
        item for item in snapshot_evidence if item.get("availability") != "available"
    ]
    available_evidence = [
        item for item in snapshot_evidence if item.get("availability") == "available"
    ]

    if quality_state not in SNAPSHOT_STATES:
        if available_evidence and not unavailable_evidence:
            status = "available"
            evidence_source = "evidence.final_snapshot"
        else:
            status = "unavailable"
            evidence_source = "quality.layers.final_snapshot"
    elif unavailable_evidence:
        status = "unavailable"
        evidence_source = "quality_and_evidence_conflict"
    else:
        status = quality_state
        evidence_source = "quality.layers.final_snapshot"

    required = request_kind in SNAPSHOT_GATED_REQUEST_KINDS
    allowed = status == "available"
    if allowed:
        reason = "final_snapshot_available"
        decision = "allow_visual_claims"
    else:
        reason = "final_snapshot_required_but_unavailable" if required else "visual_claims_require_final_snapshot"
        decision = "block_visual_claims"
    return {
        "required": required,
        "read": "final_snapshot",
        "status": status,
        "decision": decision,
        "reason": reason,
        "evidence_source": evidence_source,
        "evidence_refs": _unique_strings(
            [item.get("evidence_id") for item in available_evidence],
            limit=5,
        ) if allowed else [],
    }


def _collect_refs(
    items: Iterable[dict[str, Any]],
    *,
    limit: int = 5,
) -> list[str]:
    refs: list[str] = []
    for item in items:
        refs.extend(_item_refs(item))
    return _unique_strings(refs, limit=limit)


def _layer(
    source_layer: str,
    *,
    allowed: bool,
    status: str,
    claim_ids: Iterable[str] = (),
    candidate_ids: Iterable[str] = (),
    unresolved_candidate_ids: Iterable[str] = (),
    unresolved_ids: Iterable[str] = (),
    unavailable_claim_ids: Iterable[str] = (),
    evidence_refs: Iterable[str] = (),
    instruction: str,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "source_layer": source_layer,
        "allowed": allowed,
        "status": status,
        "claim_ids": _unique_strings(claim_ids),
        "candidate_ids": _unique_strings(candidate_ids),
        "unresolved_candidate_ids": _unique_strings(unresolved_candidate_ids),
        "unresolved_ids": _unique_strings(unresolved_ids),
        "evidence_refs": _unique_strings(evidence_refs, limit=5),
        "instruction": instruction,
    }
    unavailable_ids = _unique_strings(unavailable_claim_ids)
    if unavailable_ids:
        result["unavailable_claim_ids"] = unavailable_ids
    return result


def _instructions(snapshot_available: bool) -> list[str]:
    if snapshot_available:
        return [
            "先复述 confirmation 的明确范围；确认只覆盖被明确确认的主张，"
            "不向邻近候选扩张。",
            "仅把 visual_observation/status=observed 作为最终快照中可见的画面事实；"
            "不得把它升级为用户意图或语义关系。",
            "原样区分 user_input/user_stated 与 compiler_candidate/inferred；"
            "候选不是事实，也不是执行指令。",
            "保留 unresolved、冲突和不可用状态；需要决定方向或绑定时先请求澄清。",
        ]
    return [
        "最终画布快照不可用：不得输出任何画面、位置、笔画、对象可见性或视觉关系"
        "结论。",
        "可以复述 user_input/user_stated 的原话，但不得把用户说到的画面内容改写成"
        "visual_observation。",
        "compiler_candidate 只能作为待核对候选提及，不得升级为事实、方向、关系或"
        "执行指令。",
        "保留 unresolved 并请求读取最终快照或让用户澄清；"
        "不要用缺失证据推断‘没有发生’。",
    ]


def build_context_response_policy(
    context_pack: dict[str, Any],
    *,
    request_kind: str | None = None,
    question: str | None = None,
) -> dict[str, Any]:
    """Build a read-only layered answer strategy for one Context Pack.

    The returned object is a policy/selection plan, not a natural-language
    answer.  Visual claims are selected only when the final snapshot gate is
    open.  Other layers remain explicitly labelled so a consumer cannot
    silently promote speech or compiler candidates into visual facts.
    """
    if not isinstance(context_pack, dict):
        raise TypeError("context_pack must be a JSON object")
    kind = _normalise_request_kind(context_pack, request_kind)
    gate = _snapshot_gate(context_pack, kind)
    snapshot_available = gate["decision"] == "allow_visual_claims"

    claims = _as_list(context_pack.get("claims"))
    candidates = _as_list(context_pack.get("relation_candidates"))
    unresolved = _as_list(context_pack.get("unresolved"))
    claims_by_layer: dict[str, list[dict[str, Any]]] = {
        layer: [] for layer in SOURCE_LAYERS if layer != "unresolved"
    }
    # ``unavailable`` is an MCPack-01 source-layer value, while MCPack-02
    # presents it as unresolved state rather than a sixth answer layer.
    claims_by_layer["unavailable"] = []
    for claim in claims:
        layer = claim.get("source_layer")
        if layer in claims_by_layer:
            claims_by_layer[layer].append(claim)

    candidate_ids = [candidate_id for candidate in candidates if (candidate_id := _candidate_id(candidate))]
    unresolved_candidate_ids = [
        candidate_id for candidate in candidates
        if candidate.get("status") == "unresolved" and (candidate_id := _candidate_id(candidate))
    ]
    unresolved_ids = [unresolved_id for item in unresolved if (unresolved_id := _unresolved_id(item))]
    unavailable_claim_ids = [
        claim_id for claim in claims_by_layer.get("unavailable", []) if (claim_id := _claim_id(claim))
    ]

    visual_claims = claims_by_layer.get("visual_observation", [])
    user_claims = claims_by_layer.get("user_input", [])
    compiler_claims = claims_by_layer.get("compiler_candidate", [])
    confirmation_claims = claims_by_layer.get("confirmation", [])

    visual_selected = visual_claims if snapshot_available else []
    visual_refs = _collect_refs(visual_selected)
    user_refs = _collect_refs(user_claims)
    compiler_refs = _collect_refs([*compiler_claims, *candidates])
    confirmation_refs = _collect_refs(confirmation_claims)
    unresolved_refs = _collect_refs(unresolved)

    layers = [
        _layer(
            "visual_observation",
            allowed=snapshot_available,
            status=(
                "available"
                if snapshot_available and visual_selected
                else "empty"
                if snapshot_available
                else "blocked"
            ),
            claim_ids=[claim_id for claim in visual_selected if (claim_id := _claim_id(claim))],
            evidence_refs=visual_refs,
            instruction=(
                "可复述快照中直接可见的观察，不扩展成意图或语义关系。"
                if snapshot_available
                else "最终快照门未打开；这一层不得进入回答。"
            ),
        ),
        _layer(
            "user_input",
            allowed=True,
            status="available" if user_claims else "empty",
            claim_ids=[claim_id for claim in user_claims if (claim_id := _claim_id(claim))],
            evidence_refs=user_refs,
            instruction="保留用户原话及时间窗，不能用视觉猜测改写或替换原话。",
        ),
        _layer(
            "compiler_candidate",
            allowed=True,
            status="candidate_only" if compiler_claims or candidates else "empty",
            claim_ids=[claim_id for claim in compiler_claims if (claim_id := _claim_id(claim))],
            candidate_ids=candidate_ids,
            unresolved_candidate_ids=unresolved_candidate_ids,
            evidence_refs=compiler_refs,
            instruction=(
                "只报告候选及其证据范围；不得把候选升级为事实、方向、绑定或执行指令。"
            ),
        ),
        _layer(
            "confirmation",
            allowed=True,
            status="confirmed_only" if confirmation_claims else "empty",
            claim_ids=[claim_id for claim in confirmation_claims if (claim_id := _claim_id(claim))],
            evidence_refs=confirmation_refs,
            instruction="只复述用户明确确认/修正的具体主张，确认范围不得外推。",
        ),
        _layer(
            "unresolved",
            allowed=True,
            status="always_include" if unresolved_ids or unavailable_claim_ids or unresolved_candidate_ids else "empty",
            unresolved_ids=unresolved_ids,
            unavailable_claim_ids=unavailable_claim_ids,
            evidence_refs=unresolved_refs,
            instruction="保留不可用、冲突、降级和未决项；缺失证据不等于事情不存在。",
        ),
    ]

    task = _as_dict(context_pack.get("task"))
    bounded_question = question if question is not None else task.get("question")
    bounded_question = str(bounded_question or "复述本轮可验证的理解。").strip()[:500]
    answer_strategy = {
        "answer_order": list(ANSWER_ORDER),
        "visual_conclusion": "allowed" if snapshot_available else "blocked",
        "instructions": _instructions(snapshot_available),
        "rule_ids": [
            "confirmation_scope_is_explicit",
            "visual_claims_require_final_snapshot",
            "user_input_is_not_visual_observation",
            "compiler_candidates_stay_candidates",
            "unresolved_is_preserved",
        ],
        "execution_authorized": False,
    }
    policy: dict[str, Any] = {
        "contract": CONTRACT,
        "policy_version": POLICY_VERSION,
        "context_id": context_pack.get("context_id"),
        "package_id": context_pack.get("package_id"),
        "round_id": context_pack.get("round_id"),
        "request": {
            "kind": kind,
            "question": bounded_question,
            "requires_final_snapshot": kind in SNAPSHOT_GATED_REQUEST_KINDS,
        },
        "snapshot_gate": gate,
        "evidence_layers": layers,
        "answer_strategy": answer_strategy,
        "constraints": {
            "execution_authorized": False,
            "visual_conclusions_require_final_snapshot": True,
            "confirmation_scope": "explicit_claim_only",
        },
        "execution_authorized": False,
        "budget": {
            "claim_count": len(claims),
            "candidate_count": len(candidates),
            "unresolved_count": len(unresolved),
            "max_layer_evidence_refs": 5,
        },
    }
    return policy


# Descriptive aliases keep this adapter easy to discover from existing package
# terminology while retaining one implementation and one contract.
build_understanding_response_policy = build_context_response_policy
build_layered_answer_policy = build_context_response_policy
build_evidence_layered_response_policy = build_context_response_policy
build_response_policy = build_context_response_policy
adapt = build_context_response_policy


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="MCPack-01 Context Pack JSON")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--request-kind")
    args = parser.parse_args(argv)
    try:
        policy = build_context_response_policy(read_json(args.input), request_kind=args.request_kind)
        write_json(args.output, policy)
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI guard
    raise SystemExit(main())
