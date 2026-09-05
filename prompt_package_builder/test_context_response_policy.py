import copy
import json
import sys
import unittest
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from build_context_response_policy import (  # noqa: E402
    build_context_response_policy,
    build_understanding_response_policy,
)
from build_minimal_context_pack import build_minimal_context_pack  # noqa: E402
from validate_context_response_policy import validate_context_response_policy  # noqa: E402


FIXTURES = MODULE_DIR / "fixtures"


def load_pack(name: str, context_id: str):
    value = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    return build_minimal_context_pack(value["compact_package"], value["process_ir"], context_id=context_id)


def forbidden_keys(value):
    forbidden = {
        "canvas_event_track",
        "timeline_fusion",
        "caption_track",
        "strokes",
        "stroke_points",
        "audio",
        "audio_bytes",
        "raw_audio",
        "full_process_ir",
        "archive",
        "tool_trace",
    }
    found = []

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


class ContextResponsePolicyTests(unittest.TestCase):
    def test_available_snapshot_opens_gate_and_keeps_layers_separate(self):
        pack = load_pack("minimal-context-pack-positive.json", "ctx_policy_available")
        policy = build_understanding_response_policy(pack)

        self.assertEqual("allow_visual_claims", policy["snapshot_gate"]["decision"])
        self.assertEqual("available", policy["snapshot_gate"]["status"])
        self.assertEqual([], validate_context_response_policy(policy, pack))
        self.assertEqual([], forbidden_keys(policy))
        layers = {item["source_layer"]: item for item in policy["evidence_layers"]}
        self.assertTrue(layers["visual_observation"]["allowed"])
        self.assertTrue(layers["visual_observation"]["claim_ids"])
        self.assertEqual(["clm_speech_001"], layers["user_input"]["claim_ids"])
        self.assertEqual(["rel_001"], layers["compiler_candidate"]["candidate_ids"])
        self.assertEqual("candidate_only", layers["compiler_candidate"]["status"])
        self.assertFalse(policy["execution_authorized"])

    def test_unavailable_snapshot_blocks_visual_claims_but_keeps_speech_as_user_input(self):
        pack = load_pack("minimal-context-pack-response-policy-snapshot-unavailable.json", "ctx_policy_blocked")
        policy = build_understanding_response_policy(pack)

        self.assertEqual("unavailable", policy["snapshot_gate"]["status"])
        self.assertEqual("block_visual_claims", policy["snapshot_gate"]["decision"])
        layers = {item["source_layer"]: item for item in policy["evidence_layers"]}
        self.assertFalse(layers["visual_observation"]["allowed"])
        self.assertEqual([], layers["visual_observation"]["claim_ids"])
        self.assertEqual(["clm_speech_001"], layers["user_input"]["claim_ids"])
        self.assertEqual(["rel_without_snapshot"], layers["compiler_candidate"]["candidate_ids"])
        self.assertEqual("candidate_only", layers["compiler_candidate"]["status"])
        self.assertIn("unres_snapshot_unavailable", layers["unresolved"]["unresolved_ids"])
        self.assertIn("不得输出任何画面", policy["answer_strategy"]["instructions"][0])
        self.assertEqual("blocked", policy["answer_strategy"]["visual_conclusion"])
        self.assertEqual([], validate_context_response_policy(policy, pack))

    def test_confirmation_is_scoped_and_not_promoted_to_nearby_visual_claims(self):
        pack = load_pack("minimal-context-pack-response-policy-confirmation.json", "ctx_policy_confirmation")
        policy = build_context_response_policy(pack, request_kind="复述")

        self.assertEqual("paraphrase", policy["request"]["kind"])
        layers = {item["source_layer"]: item for item in policy["evidence_layers"]}
        self.assertEqual("confirmed_only", layers["confirmation"]["status"])
        self.assertEqual(["clm_compiler_001"], layers["confirmation"]["claim_ids"])
        self.assertNotIn("clm_compiler_001", layers["visual_observation"]["claim_ids"])
        self.assertEqual([], validate_context_response_policy(policy, pack))

    def test_visual_speech_conflict_remains_unresolved_in_strategy(self):
        pack = load_pack("minimal-context-pack-visual-asr-conflict.json", "ctx_policy_conflict")
        policy = build_context_response_policy(pack)
        layers = {item["source_layer"]: item for item in policy["evidence_layers"]}

        self.assertEqual("allow_visual_claims", policy["snapshot_gate"]["decision"])
        self.assertEqual(["rel_conflict"], layers["compiler_candidate"]["candidate_ids"])
        self.assertIn("unres_direction_rel_conflict", layers["unresolved"]["unresolved_ids"])
        self.assertEqual([], validate_context_response_policy(policy, pack))

    def test_validator_rejects_forged_visual_item_when_gate_is_blocked(self):
        pack = load_pack("minimal-context-pack-response-policy-snapshot-unavailable.json", "ctx_policy_forged")
        policy = build_context_response_policy(pack)
        forged = copy.deepcopy(policy)
        forged["evidence_layers"][0]["claim_ids"] = ["clm_visual_object_001"]
        errors = validate_context_response_policy(forged, pack)

        self.assertTrue(any("blocked snapshot gate" in error for error in errors))

    def test_validator_rejects_unknown_policy_evidence_ref(self):
        pack = load_pack("minimal-context-pack-positive.json", "ctx_policy_bad_ref")
        policy = build_context_response_policy(pack)
        policy["evidence_layers"][1]["evidence_refs"] = ["ev_not_in_pack"]
        errors = validate_context_response_policy(policy, pack)

        self.assertTrue(any("unknown evidence ID" in error for error in errors))

    def test_gate_fails_closed_on_explicit_snapshot_evidence_conflict(self):
        pack = load_pack("minimal-context-pack-positive.json", "ctx_policy_snapshot_conflict")
        pack["evidence"].append({
            "evidence_id": "ev_snapshot_final",
            "kind": "final_snapshot",
            "source_ref": "/final_snapshot",
            "availability": "unavailable",
        })
        policy = build_context_response_policy(pack)

        self.assertEqual("unavailable", policy["snapshot_gate"]["status"])
        self.assertEqual("block_visual_claims", policy["snapshot_gate"]["decision"])
        self.assertEqual([], validate_context_response_policy(policy, pack))

    def test_validator_rejects_archive_material_and_execution_upgrade(self):
        pack = load_pack("minimal-context-pack-positive.json", "ctx_policy_invalid")
        policy = build_context_response_policy(pack)
        policy["archive"] = {"full": True}
        policy["execution_authorized"] = True
        errors = validate_context_response_policy(policy, pack)

        self.assertTrue(any("complete-archive" in error for error in errors))
        self.assertTrue(any("execution_authorized" in error for error in errors))

    def test_non_understanding_request_still_blocks_visual_conclusions_without_snapshot(self):
        pack = load_pack("minimal-context-pack-response-policy-snapshot-unavailable.json", "ctx_policy_propose")
        policy = build_context_response_policy(pack, request_kind="propose")

        self.assertFalse(policy["request"]["requires_final_snapshot"])
        self.assertEqual("block_visual_claims", policy["snapshot_gate"]["decision"])
        self.assertEqual("blocked", policy["answer_strategy"]["visual_conclusion"])
        self.assertEqual([], validate_context_response_policy(policy, pack))


if __name__ == "__main__":
    unittest.main()
