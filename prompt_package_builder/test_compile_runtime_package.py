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


class RuntimeArtifactPathTests(unittest.TestCase):
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
