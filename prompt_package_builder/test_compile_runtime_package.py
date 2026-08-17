import json
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
ROOT = MODULE_DIR.parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))
from compile_runtime_package import compile_runtime_package
VALIDATORS_DIR = ROOT / "validators"
if str(VALIDATORS_DIR) not in sys.path:
    sys.path.insert(0, str(VALIDATORS_DIR))
from validate_process_ir import validate_process_ir
from validate_compact_package import validate_package
from validate_minimal_context_pack import validate_minimal_context_pack
from validate_context_continuity import validate_context_continuity_policy


class RuntimeArtifactPathTests(unittest.TestCase):
    def test_round_compile_publishes_bounded_continuity_artifacts(self):
        fixture_path = MODULE_DIR / "fixtures" / "context-source-canvas-round.json"
        with tempfile.TemporaryDirectory() as directory:
            result = compile_runtime_package(fixture_path, Path(directory) / "engine")
            context_pack = json.loads(Path(result["minimal_context_pack_path"]).read_text(encoding="utf-8"))
            continuity = json.loads(Path(result["continuity_policy_path"]).read_text(encoding="utf-8"))

        self.assertEqual("pp_canvas_round_fixture_001", result["package_id"])
        self.assertEqual("ctx_round_pp_canvas_round_fixture_001", result["context_id"])
        self.assertEqual("pp_canvas_round_fixture_001", context_pack["package_id"])
        self.assertEqual("round_fixture_001", context_pack["round_id"])
        self.assertEqual("round_fixture_001", continuity["identity_receipt"]["round_id"])
        self.assertEqual(context_pack["context_id"], continuity["identity_receipt"]["context_id"])
        self.assertEqual(["observed", "inferred", "unknown"], continuity["answer_strategy"]["opening_sections"])
        self.assertFalse(continuity["execution_authorized"])
        self.assertEqual([], validate_minimal_context_pack(context_pack))
        self.assertEqual([], validate_context_continuity_policy(continuity, context_pack))

        forbidden = {
            "canvas_event_track", "timeline_fusion", "caption_track", "strokes", "stroke_points",
            "audio", "audio_bytes", "raw_audio", "raw_transcript", "full_process_ir", "process_ir",
            "archive", "archive_path", "tool_trace", "tool_calls",
        }

        def find_forbidden(value):
            found = []
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in forbidden:
                        found.append(key)
                    found.extend(find_forbidden(child))
            elif isinstance(value, list):
                for child in value:
                    found.extend(find_forbidden(child))
            return found

        self.assertEqual([], find_forbidden(context_pack))
        self.assertEqual([], find_forbidden(continuity))

    def test_handwritten_anchor_modes_survive_full_runtime_compile(self):
        fixture_path = MODULE_DIR / "fixtures" / "handwriting-visual-anchor-modes.json"
        with tempfile.TemporaryDirectory() as directory:
            result = compile_runtime_package(fixture_path, Path(directory) / "engine")
            process_ir = json.loads(Path(result["process_ir_path"]).read_text(encoding="utf-8"))
            compact = json.loads(Path(result["compact_package_path"]).read_text(encoding="utf-8"))

            self.assertEqual(
                {"free_arrow_shaft", "native_arrow", "box_connector"},
                {item["stroke_id"] for item in process_ir["ink_relation_candidates"]},
            )
            connections = compact["structural_observations"]["handdrawn_connection_candidates"]
            self.assertEqual(3, len(connections))
            self.assertIn("strong", [item["evidence_level"] for item in connections])
            self.assertTrue(any("region_anchor" in item["evidence_sources"] for item in connections))
            self.assertGreaterEqual(len(compact["structural_observations"]["handdrawn_region_candidates"]), 2)
            self.assertEqual([], validate_process_ir(process_ir))
            compact_errors, _warnings = validate_package(compact)
            self.assertEqual([], compact_errors)

    def test_handwriting_relation_fixture_survives_full_runtime_compile(self):
        fixture_path = MODULE_DIR / "fixtures" / "handwriting-relation-regression.json"
        with tempfile.TemporaryDirectory() as directory:
            result = compile_runtime_package(fixture_path, Path(directory) / "engine")
            process_ir = json.loads(Path(result["process_ir_path"]).read_text(encoding="utf-8"))
            compact = json.loads(Path(result["compact_package_path"]).read_text(encoding="utf-8"))

            self.assertEqual(["real_connector"], [
                item["stroke_id"] for item in process_ir["ink_relation_candidates"]
            ])
            self.assertEqual(["ink_rel_001"], [
                item["relation_id"]
                for item in compact["structural_observations"]["handdrawn_connection_candidates"]
            ])
            self.assertEqual("strong", compact["structural_observations"]["handdrawn_connection_candidates"][0]["evidence_level"])
            self.assertEqual([], validate_process_ir(process_ir))
            compact_errors, _warnings = validate_package(compact)
            self.assertEqual([], compact_errors)

    def test_process_ir_is_published_at_stable_engine_path(self):
        source = {
            "meta": {"package_id": "pp_runtime_path", "duration_ms": 0},
            "transcript": {"language": "zh-CN", "segments": []},
            "timeline": [], "objects": [], "strokes": [],
            "canvas_snapshot": {"final": {"url": "", "format": "png", "width": 1, "height": 1}},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "prompt-package.json"
            source_path.write_text(json.dumps(source), encoding="utf-8")
            result = compile_runtime_package(source_path, root / "engine")
            process_path = root / "engine" / "process-ir.json"
            self.assertTrue(process_path.exists())
            self.assertEqual(str(process_path), result["process_ir_path"])
            self.assertEqual("pp_runtime_path", json.loads(process_path.read_text(encoding="utf-8"))["source"]["package_id"])
            self.assertTrue((root / "engine" / "engine-inputs" / "process_ir.json").exists())
            self.assertEqual([], validate_process_ir(json.loads(process_path.read_text(encoding="utf-8"))))
            compact = json.loads((root / "engine" / "compact-package.json").read_text(encoding="utf-8"))
            errors, _warnings = validate_package(compact)
            self.assertEqual([], errors)
            self.assertEqual("process-ir-v0.8", compact["process_ir_summary"]["schema_version"])
            self.assertEqual("2.6", compact["meta"]["version"])

            legacy_compact = deepcopy(compact)
            legacy_compact["meta"]["version"] = "2.2"
            legacy_compact["structural_observations"].pop("handdrawn_circle_candidates")
            legacy_errors, _warnings = validate_package(legacy_compact)
            self.assertEqual([], legacy_errors)


if __name__ == "__main__":
    unittest.main()
