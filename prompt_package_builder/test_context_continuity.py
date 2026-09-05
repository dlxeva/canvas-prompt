import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from build_context_continuity import (  # noqa: E402
    build_context_continuity_policy,
    mark_context_response_superseded,
    reconcile_context_response,
)
from build_context_source_adapter import adapt_canvas_round  # noqa: E402
from build_minimal_context_pack import build_minimal_context_pack  # noqa: E402
from compile_runtime_package import compile_runtime_package  # noqa: E402
from validate_context_continuity import validate_context_continuity_policy  # noqa: E402
from validate_minimal_context_pack import validate_minimal_context_pack  # noqa: E402


FIXTURES = MODULE_DIR / "fixtures"


def load_json(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def pack_from(name: str, context_id: str, *, parent_context_id: str | None = None) -> dict:
    value = load_json(name)
    return build_minimal_context_pack(
        value["compact_package"],
        value["process_ir"],
        context_id=context_id,
        parent_context_id=parent_context_id,
    )


def walk_keys(value, forbidden: set[str]) -> list[str]:
    found: list[str] = []

    def walk(node, path="$"):
        if isinstance(node, dict):
            for key, child in node.items():
                if key in forbidden:
                    found.append(f"{path}.{key}")
                walk(child, f"{path}.{key}")
        elif isinstance(node, list):
            for index, child in enumerate(node):
                walk(child, f"{path}[{index}]")

    walk(value)
    return found


class ContextContinuityTests(unittest.TestCase):
    def test_runtime_compile_round_to_mcpack_to_response_chain(self):
        with tempfile.TemporaryDirectory() as directory:
            result = compile_runtime_package(
                FIXTURES / "context-source-canvas-round.json",
                Path(directory) / "engine",
            )
            compact = json.loads(Path(result["compact_package_path"]).read_text(encoding="utf-8"))
            process_ir = json.loads(Path(result["process_ir_path"]).read_text(encoding="utf-8"))
        pack = build_minimal_context_pack(compact, process_ir, context_id="ctx_compiled_chain")
        policy = build_context_continuity_policy(pack)

        self.assertEqual(result["package_id"], pack["package_id"])
        self.assertEqual([], validate_context_continuity_policy(policy, pack))
        self.assertEqual(pack["package_id"], policy["identity_receipt"]["package_id"])
        self.assertEqual(pack["round_id"], policy["identity_receipt"]["round_id"])

    def test_real_round_to_mcpack_to_response_receipt_is_bounded(self):
        fixture = load_json("context-source-canvas-round.json")
        pack = adapt_canvas_round(fixture, context_id="ctx_round_receipt")
        policy = build_context_continuity_policy(pack)

        self.assertEqual([], validate_minimal_context_pack(pack))
        self.assertEqual([], validate_context_continuity_policy(policy, pack))
        receipt = policy["identity_receipt"]
        self.assertEqual("pp_canvas_round_fixture_001", receipt["package_id"])
        self.assertEqual("round_fixture_001", receipt["round_id"])
        self.assertEqual("ctx_round_receipt", receipt["context_id"])
        self.assertEqual("available", receipt["snapshot"]["status"])
        self.assertEqual("available", receipt["time"]["status"])
        self.assertEqual(["observed", "user_stated", "inferred", "unknown"], policy["answer_strategy"]["opening_sections"])
        self.assertEqual(
            ["identity_receipt", "observed", "user_stated", "inferred", "unknown", "confirmed"],
            policy["answer_strategy"]["response_sequence"],
        )
        self.assertTrue(policy["answer_strategy"]["identity_receipt_required"])
        self.assertFalse(policy["execution_authorized"])
        self.assertEqual([], walk_keys(policy, {
            "canvas_event_track", "timeline_fusion", "caption_track", "strokes", "stroke_points",
            "audio", "audio_bytes", "raw_audio", "raw_transcript", "full_process_ir", "process_ir",
            "archive", "tool_trace",
        }))

    def test_opening_separates_observation_inference_and_unknown(self):
        pack = pack_from("minimal-context-pack-positive.json", "ctx_opening")
        policy = build_context_continuity_policy(pack)
        sections = policy["understanding"]

        self.assertIn("clm_visual_object_001", sections["observed"]["claim_ids"])
        self.assertIn("rel_001", sections["inferred"]["candidate_ids"])
        self.assertIn("rel_001", sections["unknown"]["candidate_ids"])
        self.assertIn("unres_ocr_unavailable", sections["unknown"]["unresolved_ids"])
        self.assertEqual("candidate_only_not_a_user_decision", sections["inferred"]["candidate_boundary"])
        self.assertEqual([], validate_context_continuity_policy(policy, pack))

    def test_opening_keeps_user_statements_and_corrections_out_of_inference(self):
        pack = pack_from("minimal-context-pack-positive.json", "ctx_user_stated")
        initial = build_context_continuity_policy(pack)
        sections = initial["understanding"]

        self.assertEqual("user_input", sections["user_stated"]["source_layer"])
        self.assertIn("clm_speech_001", sections["user_stated"]["claim_ids"])
        self.assertNotIn("clm_speech_001", sections["inferred"]["claim_ids"])
        self.assertEqual([], sections["user_stated"]["candidate_ids"])
        self.assertEqual([], sections["user_stated"]["correction_history"])

        current = pack_from(
            "minimal-context-pack-positive.json",
            "ctx_user_stated_reread",
            parent_context_id=pack["context_id"],
        )
        reread = reconcile_context_response(
            initial,
            current,
            previous_context_pack=pack,
            correction="用户纠正：这只是待看标记，不是采用决定。",
        )
        user_section = reread["understanding"]["user_stated"]
        self.assertEqual(
            ["用户纠正：这只是待看标记，不是采用决定。"],
            [item["text"] for item in user_section["correction_history"]],
        )
        self.assertEqual([], reread["understanding"]["inferred"].get("correction_history", []))
        self.assertEqual([], validate_context_continuity_policy(reread, current))

    def test_validator_rejects_inference_ids_in_user_stated_section(self):
        pack = pack_from("minimal-context-pack-positive.json", "ctx_user_stated_invalid")
        policy = build_context_continuity_policy(pack)
        policy["understanding"]["user_stated"]["candidate_ids"] = ["rel_001"]

        errors = validate_context_continuity_policy(policy, pack)
        self.assertTrue(any("must not carry inference" in error for error in errors))

    def test_re_read_reconciles_same_round_and_supersedes_old_context(self):
        fixture = load_json("context-continuity-recovery.json")["same_round_reread"]
        source = load_json(fixture["source_fixture"])
        previous = adapt_canvas_round(source, context_id=fixture["previous_context_id"])
        current = adapt_canvas_round(
            source,
            context_id=fixture["current_context_id"],
            parent_context_id=fixture["parent_context_id"],
        )
        previous_policy = build_context_continuity_policy(previous)
        policy = reconcile_context_response(
            previous_policy,
            current,
            previous_context_pack=previous,
            correction=fixture["correction"],
        )

        self.assertEqual("re_read", policy["continuity"]["read_mode"])
        self.assertEqual("reconciled", policy["continuity"]["status"])
        self.assertEqual("answer_current_context_only", policy["continuity"]["response_decision"])
        self.assertEqual("reconciled", policy["continuity"]["reconciliation"]["status"])
        self.assertTrue(policy["continuity"]["reconciliation"]["identity_match"])
        self.assertEqual("superseded", policy["continuity"]["supersedes"][0]["status"])
        self.assertEqual(fixture["previous_context_id"], policy["continuity"]["supersedes"][0]["context_id"])
        correction = policy["continuity"]["reconciliation"]["correction"]
        self.assertEqual("user_input", correction["source_layer"])
        self.assertEqual("user_stated", correction["status"])
        self.assertFalse(policy["confirmation_gate"]["execution_authorized"])
        self.assertFalse(policy["execution_authorized"])
        self.assertEqual([], validate_context_continuity_policy(policy, current))

    def test_re_read_carries_bounded_user_correction_history_and_context_lineage(self):
        source = load_json("context-source-canvas-round.json")
        initial = adapt_canvas_round(source, context_id="ctx_chain_initial")
        first = adapt_canvas_round(
            source,
            context_id="ctx_chain_first",
            parent_context_id=initial["context_id"],
        )
        second = adapt_canvas_round(
            source,
            context_id="ctx_chain_second",
            parent_context_id=first["context_id"],
        )
        initial_policy = build_context_continuity_policy(initial)
        first_policy = reconcile_context_response(
            initial_policy,
            first,
            previous_context_pack=initial,
            correction="第一条纠正：保留用户原话，不要把候选当结论。",
        )
        second_policy = reconcile_context_response(
            first_policy,
            second,
            previous_context_pack=first,
            correction="第二条纠正：只按当前 round 的证据继续。",
        )

        continuity = second_policy["continuity"]
        reconciliation = continuity["reconciliation"]
        self.assertEqual("reconciled", continuity["status"])
        self.assertEqual(first["context_id"], continuity["parent_context_id"])
        self.assertEqual(
            [initial["context_id"], first["context_id"], second["context_id"]],
            continuity["context_lineage"],
        )
        self.assertEqual(first["context_id"], reconciliation["previous_context_id"])
        self.assertEqual(
            [
                "第一条纠正：保留用户原话，不要把候选当结论。",
                "第二条纠正：只按当前 round 的证据继续。",
            ],
            [item["text"] for item in reconciliation["correction_history"]],
        )
        self.assertFalse(reconciliation["correction_history_truncated"])
        self.assertTrue(all(
            item["status"] == "user_stated"
            and item["source_layer"] == "user_input"
            and "claim_ids" not in item
            and "evidence_refs" not in item
            for item in reconciliation["correction_history"]
        ))
        self.assertFalse(second_policy["execution_authorized"])
        self.assertEqual([], validate_context_continuity_policy(second_policy, second))

    def test_re_read_drops_inferred_entries_from_inherited_correction_history(self):
        source = load_json("context-source-canvas-round.json")
        initial = adapt_canvas_round(source, context_id="ctx_history_initial")
        first = adapt_canvas_round(source, context_id="ctx_history_first", parent_context_id=initial["context_id"])
        second = adapt_canvas_round(source, context_id="ctx_history_second", parent_context_id=first["context_id"])
        initial_policy = build_context_continuity_policy(initial)
        first_policy = reconcile_context_response(
            initial_policy,
            first,
            previous_context_pack=initial,
            correction="保留第一条用户纠正。",
        )
        first_policy["continuity"]["reconciliation"]["correction_history"].append({
            "status": "inferred",
            "source_layer": "compiler_candidate",
            "text": "模型推断不可进入用户纠正历史",
            "provenance": "model_output",
            "text_truncated": False,
        })
        second_policy = reconcile_context_response(
            first_policy,
            second,
            previous_context_pack=first,
            correction="保留第二条用户纠正。",
        )

        history = second_policy["continuity"]["reconciliation"]["correction_history"]
        self.assertEqual(
            ["保留第一条用户纠正。", "保留第二条用户纠正。"],
            [item["text"] for item in history],
        )
        self.assertEqual([], validate_context_continuity_policy(second_policy, second))

    def test_correction_history_is_bounded_and_marks_truncation(self):
        source = load_json("context-source-canvas-round.json")
        previous = adapt_canvas_round(source, context_id="ctx_budget_000")
        previous_policy = build_context_continuity_policy(previous)
        for index in range(1, 7):
            current = adapt_canvas_round(
                source,
                context_id=f"ctx_budget_{index:03d}",
                parent_context_id=previous["context_id"],
            )
            previous_policy = reconcile_context_response(
                previous_policy,
                current,
                previous_context_pack=previous,
                correction=f"第 {index} 条纠正。",
            )
            previous = current

        reconciliation = previous_policy["continuity"]["reconciliation"]
        self.assertEqual(5, len(reconciliation["correction_history"]))
        self.assertTrue(reconciliation["correction_history_truncated"])
        self.assertEqual(
            ["第 2 条纠正。", "第 3 条纠正。", "第 4 条纠正。", "第 5 条纠正。", "第 6 条纠正。"],
            [item["text"] for item in reconciliation["correction_history"]],
        )
        self.assertEqual([], validate_context_continuity_policy(previous_policy, previous))

    def test_overlong_correction_is_bounded_and_explicitly_marked(self):
        source = load_json("context-source-canvas-round.json")
        previous = adapt_canvas_round(source, context_id="ctx_text_initial")
        current = adapt_canvas_round(source, context_id="ctx_text_current", parent_context_id=previous["context_id"])
        policy = reconcile_context_response(
            build_context_continuity_policy(previous),
            current,
            previous_context_pack=previous,
            correction="x" * 700,
        )

        correction = policy["continuity"]["reconciliation"]["correction"]
        history = policy["continuity"]["reconciliation"]["correction_history"]
        self.assertEqual(500, len(correction["text"]))
        self.assertTrue(correction["text_truncated"])
        self.assertEqual(500, len(history[0]["text"]))
        self.assertTrue(history[0]["text_truncated"])
        self.assertEqual([], validate_context_continuity_policy(policy, current))

        next_pack = adapt_canvas_round(source, context_id="ctx_text_next", parent_context_id=current["context_id"])
        chained = reconcile_context_response(
            policy,
            next_pack,
            previous_context_pack=current,
            correction="第二条短纠正。",
        )
        self.assertTrue(chained["continuity"]["reconciliation"]["correction_history"][0]["text_truncated"])
        self.assertEqual([], validate_context_continuity_policy(chained, next_pack))

    def test_same_context_reread_fails_closed_until_new_context_receipt(self):
        previous = pack_from("minimal-context-pack-positive.json", "ctx_same")
        previous_policy = build_context_continuity_policy(previous)
        policy = reconcile_context_response(previous_policy, previous, previous_context_pack=previous)

        self.assertEqual("needs_re_read", policy["continuity"]["status"])
        self.assertEqual("block_until_new_context", policy["continuity"]["response_decision"])
        self.assertEqual("same_context", policy["continuity"]["reconciliation"]["status"])
        self.assertEqual([], policy["continuity"]["supersedes"])
        self.assertEqual([], validate_context_continuity_policy(policy, previous))

    def test_source_identity_mismatch_is_visible_and_does_not_reconcile_old_claims(self):
        previous = pack_from("minimal-context-pack-positive.json", "ctx_old_source")
        current = pack_from(
            "minimal-context-pack-response-policy-snapshot-unavailable.json",
            "ctx_new_source",
            parent_context_id="ctx_old_source",
        )
        previous_policy = build_context_continuity_policy(previous)
        policy = reconcile_context_response(
            previous_policy,
            current,
            previous_context_pack=previous,
            correction="先确认 round 身份，不要沿用旧理解。",
        )

        self.assertEqual("identity_mismatch", policy["continuity"]["status"])
        self.assertEqual("block_cross_context_reconciliation", policy["continuity"]["response_decision"])
        self.assertEqual("identity_mismatch", policy["continuity"]["reconciliation"]["status"])
        self.assertFalse(policy["continuity"]["reconciliation"]["identity_match"])
        self.assertEqual("superseded", policy["continuity"]["supersedes"][0]["status"])
        self.assertEqual([], validate_context_continuity_policy(policy, current))

    def test_unavailable_snapshot_keeps_visual_gate_closed_in_continuity_policy(self):
        pack = pack_from("minimal-context-pack-response-policy-snapshot-unavailable.json", "ctx_no_snapshot")
        policy = build_context_continuity_policy(pack)

        self.assertEqual("block_visual_claims", policy["snapshot_gate"]["decision"])
        self.assertEqual([], policy["understanding"]["observed"]["claim_ids"])
        self.assertIn("unres_snapshot_unavailable", policy["understanding"]["unknown"]["unresolved_ids"])
        self.assertFalse(policy["execution_authorized"])
        self.assertEqual([], validate_context_continuity_policy(policy, pack))

    def test_validator_rejects_superseded_reuse_and_execution_upgrade(self):
        pack = pack_from("minimal-context-pack-positive.json", "ctx_validator")
        policy = build_context_continuity_policy(pack)
        forged = copy.deepcopy(policy)
        forged["execution_authorized"] = True
        forged["continuity"]["supersedes"] = [{
            "context_id": policy["context_id"],
            "package_id": policy["package_id"],
            "round_id": policy["round_id"],
            "status": "superseded",
        }]
        errors = validate_context_continuity_policy(forged, pack)

        self.assertTrue(any("execution_authorized" in error for error in errors))
        self.assertTrue(any("cannot be current context" in error for error in errors))

    def test_existing_policy_can_be_explicitly_marked_superseded(self):
        pack = pack_from("minimal-context-pack-positive.json", "ctx_mark_old")
        policy = build_context_continuity_policy(pack)
        superseded = mark_context_response_superseded(policy, superseded_by_context_id="ctx_mark_new")

        self.assertEqual("superseded", superseded["continuity"]["status"])
        self.assertEqual("do_not_reuse", superseded["continuity"]["response_decision"])
        self.assertEqual("ctx_mark_new", superseded["continuity"]["reconciliation"]["superseded_by_context_id"])
        self.assertFalse(superseded["execution_authorized"])
        self.assertEqual([], validate_context_continuity_policy(superseded, pack))


if __name__ == "__main__":
    unittest.main()
