import copy
import json
import sys
import unittest
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
FIXTURES = MODULE_DIR / "fixtures"
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from build_context_source_adapter import (  # noqa: E402
    adapt_artifact_review_package,
    adapt_canvas_round,
    adapt_context_source,
    adapt_interaction_review_package,
    detect_context_source,
)
from validate_context_source_adapter import validate_context_source_pack  # noqa: E402


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


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
        "raw_transcript",
        "full_process_ir",
        "process_ir",
        "archive",
        "archive_path",
        "tool_trace",
        "tool_calls",
        "model_trace",
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


class ContextSourceAdapterTests(unittest.TestCase):
    def assert_valid(self, source, pack):
        self.assertEqual([], validate_context_source_pack(pack, source))
        self.assertFalse(pack["execution_authorized"])
        self.assertFalse(pack["constraints"]["execution_authorized"])
        self.assertEqual([], forbidden_keys(pack))
        self.assertEqual(pack["package_id"], pack["source"]["package_id"])

    def test_adapter_does_not_mutate_source_package(self):
        for name in (
            "context-source-artifact-review.json",
            "context-source-interaction-review-draft.json",
            "context-source-interaction-review-i0.json",
            "context-source-canvas-round.json",
        ):
            source = load_fixture(name)
            before = copy.deepcopy(source)
            adapt_context_source(source, context_id="ctx_read_only")
            self.assertEqual(before, source, name)

    def test_artifact_review_reuses_identity_and_keeps_page_evidence_layered(self):
        source = load_fixture("context-source-artifact-review.json")
        pack = adapt_artifact_review_package(source, context_id="ctx_artifact_fixture")

        self.assertEqual("artifact_review", detect_context_source(source))
        self.assertEqual("arp_fixture_review_001", pack["package_id"])
        self.assertEqual("art_fixture_review_001", pack["source"]["artifact_id"])
        self.assertEqual(source["artifact"]["source_version_id"], pack["source"]["source_version_id"])
        self.assertEqual(source["artifact"]["source_sha256"], pack["source"]["source_sha256"])
        self.assertTrue(pack["source"]["page_normalized_v1"])
        self.assertEqual("page_normalized_v1", pack["source"]["input_coordinate_space"])
        self.assertEqual("unavailable", pack["quality"]["layers"]["final_snapshot"])
        self.assertTrue(any(item["source_layer"] == "user_input" for item in pack["claims"]))
        confirmed = [item for item in pack["claims"] if item["status"] == "confirmed"]
        self.assertEqual(1, len(confirmed))
        self.assertEqual("confirmation", confirmed[0]["source_layer"])
        self.assertTrue(any(item["candidate_type"] == "reference_candidate" for item in pack["relation_candidates"]))
        self.assertTrue(all(item["status"] == "unresolved" for item in pack["relation_candidates"]))
        self.assertTrue(any("ev_confirm_confirmed_001" in item.get("source_evidence_ids", []) for item in pack["evidence"]))
        self.assertTrue(any("ev_ann_candidate_001" in item.get("source_evidence_ids", []) for item in pack["evidence"]))
        self.assert_valid(source, pack)

    def test_artifact_binding_flag_without_confirmation_evidence_cannot_upgrade(self):
        source = load_fixture("context-source-artifact-review.json")
        tampered = copy.deepcopy(source)
        tampered["annotations"][0]["binding_status"] = "confirmed"
        pack = adapt_artifact_review_package(tampered, context_id="ctx_artifact_no_ledger")
        self.assertFalse(any(
            item["status"] == "confirmed" and "ann_candidate_001" in item["content"]["text"]
            for item in pack["claims"]
        ))
        self.assert_valid(tampered, pack)

    def test_interaction_review_draft_keeps_viewport_observation_and_no_confirmation(self):
        source = load_fixture("context-source-interaction-review-draft.json")
        pack = adapt_interaction_review_package(source, context_id="ctx_interaction_draft")

        self.assertEqual("interaction_review", detect_context_source(source))
        self.assertEqual(source["package_id"], pack["package_id"])
        self.assertEqual(source["source"]["sha256"], pack["source"]["source_sha256"])
        self.assertEqual("interaction_viewport_v1", pack["source"]["input_coordinate_space"])
        self.assertEqual(2, len(pack["source"]["input_state_observations"]))
        self.assertEqual("/generate", pack["source"]["input_state_observations"][0]["route"])
        self.assertTrue(any(item["source_layer"] == "user_input" for item in pack["claims"]))
        self.assertTrue(any(item["source_layer"] == "visual_observation" for item in pack["claims"]))
        self.assertFalse(any(item["status"] == "confirmed" for item in pack["claims"]))
        self.assertEqual("unavailable", pack["quality"]["layers"]["final_snapshot"])
        self.assert_valid(source, pack)

    def test_interaction_review_i0_preserves_session_lineage_and_proposal_boundary(self):
        source = load_fixture("context-source-interaction-review-i0.json")
        pack = adapt_interaction_review_package(source, context_id="ctx_interaction_i0")

        self.assertEqual("irp_fixture_001", pack["package_id"])
        self.assertEqual("fixture_001", pack["round_id"])
        self.assertEqual("i0-controlled-web", pack["source"]["input_adapter_id"])
        self.assertEqual("i0-synthetic-2026-08-08", pack["source"]["input_source_version"])
        self.assertEqual("proposal-only", pack["source"]["input_agent_boundary"])
        self.assertEqual(["generation"], pack["source"]["input_state_observations"][0]["state_keys"])
        self.assertTrue(any(item["source_layer"] == "confirmation" for item in pack["claims"]))
        proposals = [item for item in pack["claims"] if "提案" in item["content"]["text"]]
        self.assertEqual(1, len(proposals))
        self.assertEqual("compiler_candidate", proposals[0]["source_layer"])
        self.assertEqual("inferred", proposals[0]["status"])
        self.assertTrue(any("ev_fb_001" in item.get("source_evidence_ids", []) for item in pack["evidence"]))
        self.assertTrue(any(item["candidate_type"] == "reference_candidate" for item in pack["relation_candidates"]))
        self.assert_valid(source, pack)

    def test_i0_accepted_proposal_is_scoped_confirmation(self):
        source = load_fixture("context-source-interaction-review-i0.json")
        accepted = copy.deepcopy(source)
        accepted["proposals"][0]["confirmation"]["status"] = "accepted"
        pack = adapt_interaction_review_package(accepted, context_id="ctx_interaction_accepted")
        accepted_claims = [item for item in pack["claims"] if "提案" in item["content"]["text"]]
        self.assertEqual(1, len(accepted_claims))
        self.assertEqual("confirmation", accepted_claims[0]["source_layer"])
        self.assertEqual("confirmed", accepted_claims[0]["status"])
        self.assert_valid(accepted, pack)

    def test_i0_rejected_proposal_is_explicit_scoped_confirmation(self):
        source = load_fixture("context-source-interaction-review-i0.json")
        rejected = copy.deepcopy(source)
        rejected["proposals"][0]["confirmation"]["status"] = "rejected"
        pack = adapt_interaction_review_package(rejected, context_id="ctx_interaction_rejected")
        rejected_claims = [item for item in pack["claims"] if "拒绝" in item["content"]["text"]]
        self.assertEqual(1, len(rejected_claims))
        self.assertEqual("confirmation", rejected_claims[0]["source_layer"])
        self.assertEqual("confirmed", rejected_claims[0]["status"])
        self.assert_valid(rejected, pack)

    def test_canvas_round_compiled_pair_and_raw_export_reuse_existing_identity(self):
        compiled = load_fixture("minimal-context-pack-positive.json")
        pack = adapt_canvas_round(compiled, context_id="ctx_canvas_compiled")
        self.assertEqual("pp_mcpack_positive", pack["package_id"])
        self.assertEqual("compiled_pair", pack["source"]["input_shape"])
        self.assertEqual([], validate_context_source_pack(pack, compiled))
        split_pack = adapt_canvas_round(compiled["compact_package"], compiled["process_ir"], context_id="ctx_canvas_split")
        self.assertEqual(pack["package_id"], split_pack["package_id"])

        raw = load_fixture("context-source-canvas-round.json")
        raw_pack = adapt_canvas_round(raw, context_id="ctx_canvas_raw")
        self.assertEqual("pp_canvas_round_fixture_001", raw_pack["package_id"])
        self.assertEqual("round_fixture_001", raw_pack["round_id"])
        self.assertEqual("exported_round", raw_pack["source"]["input_shape"])
        self.assertEqual("available", raw_pack["quality"]["layers"]["final_snapshot"])
        self.assert_valid(raw, raw_pack)

    def test_explicit_kind_mismatch_and_identity_tamper_fail_closed(self):
        source = load_fixture("context-source-artifact-review.json")
        with self.assertRaises(ValueError):
            adapt_context_source(source, source_kind="canvas_round")

        pack = adapt_artifact_review_package(source, context_id="ctx_tamper")
        tampered = copy.deepcopy(pack)
        tampered["package_id"] = "arp_other_package"
        errors = validate_context_source_pack(tampered, source)
        self.assertTrue(any("package_id" in error for error in errors))

    def test_validator_rejects_archive_material_and_execution_upgrade(self):
        source = load_fixture("context-source-interaction-review-i0.json")
        pack = adapt_interaction_review_package(source, context_id="ctx_invalid")
        pack["archive"] = {"full": "trace"}
        pack["execution_authorized"] = True
        errors = validate_context_source_pack(pack, source)
        self.assertTrue(any("complete-archive" in error for error in errors))
        self.assertTrue(any("execution_authorized" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
