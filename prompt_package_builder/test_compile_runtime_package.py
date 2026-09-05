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
from build_compact_package import build_compact_package
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
        self.assertEqual(["observed", "user_stated", "inferred", "unknown"], continuity["answer_strategy"]["opening_sections"])
        self.assertEqual(
            ["identity_receipt", "observed", "user_stated", "inferred", "unknown", "confirmed"],
            continuity["answer_strategy"]["response_sequence"],
        )
        self.assertTrue(continuity["answer_strategy"]["answer_contract"]["identity_receipt"]["required"])
        self.assertEqual(
            ["round_id", "context_id", "snapshot.status"],
            continuity["answer_strategy"]["answer_contract"]["identity_receipt"]["user_visible"]["fields"],
        )
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

    def test_snapshot_availability_is_preserved_at_formal_compile_boundary(self):
        source = json.loads(
            (MODULE_DIR / "fixtures" / "context-source-canvas-round.json").read_text(encoding="utf-8")
        )
        variants = {
            "unavailable": ({"availability": "unavailable", "reason": "image missing"}, "unavailable"),
            "not_found_note": ({"note": "snapshot not found"}, "unavailable"),
            "metadata_only": ({"format": "png", "width": 640, "height": 360}, "unavailable"),
            "degraded": ({"availability": "degraded", "format": "png", "width": 640, "height": 360}, "degraded"),
            "conflicting": ({"availability": "conflicting", "format": "png", "width": 640, "height": 360}, "conflicting"),
            "parent_unavailable_nested_available": (
                {"availability": "unavailable", "final": {"availability": "available", "url": "data:image/png;base64,excluded"}},
                "conflicting",
            ),
            "available_url": ({"url": "data:image/png;base64,excluded", "format": "png", "width": 640, "height": 360}, "available"),
        }

        for name, (snapshot, expected_state) in variants.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                candidate = deepcopy(source)
                candidate["canvas_snapshot"]["final"] = snapshot
                source_path = Path(directory) / "prompt-package.json"
                source_path.write_text(json.dumps(candidate), encoding="utf-8")
                result = compile_runtime_package(source_path, Path(directory) / "engine")
                context_pack = json.loads(Path(result["minimal_context_pack_path"]).read_text(encoding="utf-8"))
                continuity = json.loads(Path(result["continuity_policy_path"]).read_text(encoding="utf-8"))

                self.assertEqual(expected_state, context_pack["quality"]["layers"]["final_snapshot"])
                self.assertEqual(expected_state, continuity["snapshot_gate"]["status"])
                self.assertEqual(
                    "allow_visual_claims" if expected_state == "available" else "block_visual_claims",
                    continuity["snapshot_gate"]["decision"],
                )
                self.assertEqual("available", context_pack["quality"]["layers"]["speech"])
                self.assertTrue(any(item["source_layer"] == "user_input" for item in context_pack["claims"]))
                self.assertFalse(context_pack["execution_authorized"])
                self.assertFalse(context_pack["constraints"]["execution_authorized"])
                self.assertEqual([], validate_minimal_context_pack(context_pack))
                self.assertEqual([], validate_context_continuity_policy(continuity, context_pack))
                self.assertNotIn("canvas_event_track", context_pack)

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
            self.assertFalse((root / "engine" / "engine-inputs").exists())
            self.assertEqual([], validate_process_ir(json.loads(process_path.read_text(encoding="utf-8"))))
            compact = json.loads((root / "engine" / "compact-package.json").read_text(encoding="utf-8"))
            errors, _warnings = validate_package(compact)
            self.assertEqual([], errors)
            self.assertEqual("process-ir-v0.8", compact["process_ir_summary"]["schema_version"])
            self.assertEqual("2.6", compact["meta"]["version"])
            self.assertEqual("in-memory", compact["meta"]["source_fixture"])

            legacy_compact = deepcopy(compact)
            legacy_compact["meta"]["version"] = "2.2"
            legacy_compact["structural_observations"].pop("handdrawn_circle_candidates")
            legacy_errors, _warnings = validate_package(legacy_compact)
            self.assertEqual([], legacy_errors)

    def test_explicit_debug_fixture_export_matches_legacy_builder(self):
        fixture_path = MODULE_DIR / "fixtures" / "handwriting-relation-regression.json"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            debug_fixture_dir = root / "debug-fixture"
            result = compile_runtime_package(
                fixture_path,
                root / "engine",
                debug_fixture_dir=debug_fixture_dir,
            )

            self.assertTrue((debug_fixture_dir / "process_ir.json").exists())
            self.assertFalse((root / "engine" / "engine-inputs").exists())
            compiled = json.loads(Path(result["compact_package_path"]).read_text(encoding="utf-8"))
            legacy = build_compact_package(debug_fixture_dir)

            def comparable(package):
                normalized = deepcopy(package)
                for field in ("package_id", "created_at", "source_fixture"):
                    normalized["meta"].pop(field, None)
                return normalized

            self.assertEqual(comparable(legacy), comparable(compiled))


if __name__ == "__main__":
    unittest.main()
