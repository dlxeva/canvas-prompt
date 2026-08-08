import json
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
ROOT = MODULE_DIR.parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from build_minimal_context_pack import build_minimal_context_pack  # noqa: E402
from compile_runtime_package import compile_runtime_package  # noqa: E402
from validate_minimal_context_pack import validate_minimal_context_pack  # noqa: E402


FIXTURES = MODULE_DIR / "fixtures"


def load_fixture(name: str) -> tuple[dict, dict]:
    value = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    return value["compact_package"], value["process_ir"]


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


class MinimalContextPackTests(unittest.TestCase):
    def test_positive_projection_preserves_identity_and_candidate_boundary(self):
        compact, process_ir = load_fixture("minimal-context-pack-positive.json")
        pack = build_minimal_context_pack(compact, process_ir, context_id="ctx_test_positive")

        self.assertEqual("ctx_test_positive", pack["context_id"])
        self.assertEqual("pp_mcpack_positive", pack["package_id"])
        self.assertEqual("pp_mcpack_positive", pack["source"]["package_id"])
        self.assertFalse(pack["constraints"]["execution_authorized"])
        self.assertFalse(pack["execution_authorized"])
        self.assertEqual([], validate_minimal_context_pack(pack))
        self.assertEqual([], forbidden_keys(pack))
        self.assertEqual({"visual_observation", "user_input"}, {item["source_layer"] for item in pack["claims"]})
        self.assertIn("user_stated", {item["status"] for item in pack["claims"]})
        self.assertEqual(1, len(pack["relation_candidates"]))
        self.assertEqual("unresolved", pack["relation_candidates"][0]["status"])
        self.assertEqual(0, len([item for item in pack["relation_candidates"] if item["status"] == "confirmed"]))
        self.assertLessEqual(max(len(item["evidence_refs"]) for item in pack["claims"]), 5)
        self.assertIn("text_token_estimate", pack["budget"])
        self.assertIn("json_bytes", pack["budget"])

    def test_dense_handwriting_keeps_geometric_observation_out_of_relation_candidates(self):
        compact, process_ir = load_fixture("minimal-context-pack-dense-handwriting.json")
        pack = build_minimal_context_pack(compact, process_ir, context_id="ctx_test_dense")

        self.assertEqual([], pack["relation_candidates"])
        self.assertEqual([], [item for item in pack["relation_candidates"] if item.get("candidate_type") in {"connects_to", "depends_on"}])
        self.assertEqual("degraded", pack["quality"]["overall"])
        self.assertTrue(any(item["reason"] == "unavailable" and "OCR" in item["text"] for item in pack["unresolved"]))
        self.assertFalse(pack["execution_authorized"])
        self.assertEqual([], validate_minimal_context_pack(pack))
        self.assertEqual([], forbidden_keys(pack))

    def test_visual_asr_conflict_is_unresolved_and_retains_both_layers(self):
        compact, process_ir = load_fixture("minimal-context-pack-visual-asr-conflict.json")
        pack = build_minimal_context_pack(compact, process_ir, context_id="ctx_test_conflict")

        self.assertEqual("conflicting", pack["quality"]["overall"])
        self.assertTrue(any(item.get("reason") == "conflicting" for item in pack["unresolved"]))
        self.assertTrue(any("conflicting" in item.get("failure_flags", []) for item in pack["relation_candidates"]))
        self.assertEqual(0, len([item for item in pack["relation_candidates"] if item["status"] == "confirmed"]))
        layers = {item["source_layer"] for item in pack["claims"]}
        self.assertIn("visual_observation", layers)
        self.assertIn("user_input", layers)
        self.assertEqual([], validate_minimal_context_pack(pack))

    def test_existing_compact_pipeline_can_feed_adapter_without_archive_material(self):
        fixture_path = MODULE_DIR / "fixtures" / "handwriting-relation-regression.json"
        with tempfile.TemporaryDirectory() as directory:
            result = compile_runtime_package(fixture_path, Path(directory) / "engine")
            compact = json.loads(Path(result["compact_package_path"]).read_text(encoding="utf-8"))
            process_ir = json.loads(Path(result["process_ir_path"]).read_text(encoding="utf-8"))
            pack = build_minimal_context_pack(compact, process_ir, context_id="ctx_existing_pipeline")

        self.assertEqual("pp_handwriting_relation_regression", pack["package_id"])
        self.assertEqual([], validate_minimal_context_pack(pack))
        self.assertEqual([], forbidden_keys(pack))
        self.assertTrue(pack["relation_candidates"])
        self.assertTrue(all(item["status"] == "unresolved" for item in pack["relation_candidates"]))

    def test_validator_rejects_archive_and_execution_upgrade(self):
        compact, process_ir = load_fixture("minimal-context-pack-positive.json")
        pack = build_minimal_context_pack(compact, process_ir, context_id="ctx_test_invalid")
        pack["canvas_event_track"] = [{"secret": "full trace"}]
        pack["execution_authorized"] = True
        errors = validate_minimal_context_pack(pack)
        self.assertTrue(any("complete-archive" in error for error in errors))
        self.assertTrue(any("execution_authorized" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
