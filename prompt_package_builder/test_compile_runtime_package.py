import json
import base64
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
ROOT = MODULE_DIR.parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))
from browser_package_to_fixture import adapt
from build_compact_package import build_compact_package
from compile_runtime_package import compile_runtime_package
VALIDATORS_DIR = ROOT / "validators"
if str(VALIDATORS_DIR) not in sys.path:
    sys.path.insert(0, str(VALIDATORS_DIR))
from validate_process_ir import validate_process_ir
from validate_compact_package import validate_package

PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOx8AAAAASUVORK5CYII="


class RuntimeArtifactPathTests(unittest.TestCase):
    def test_snapshot_availability_is_explicit_across_adapter_and_runtime_compile(self):
        base = {
            "meta": {"package_id": "pp_snapshot_availability"},
            "transcript": {"language": "zh-CN", "segments": []},
            "timeline": [],
            "objects": [],
            "strokes": [],
        }
        variants = {
            "empty_url": ({"url": "", "format": "png", "width": 1, "height": 1}, "unavailable", False),
            "unknown_state": ({"availability": "unknown", "format": "png", "width": 1, "height": 1}, "unknown", False),
            "unavailable_state": ({"availability": "unavailable", "format": "png", "width": 1, "height": 1}, "unavailable", False),
            "metadata_only": ({"format": "png", "width": 1, "height": 1}, "unavailable", False),
            "missing_archive": ({"archive_relative_path": "canvas-snapshot.png", "format": "png", "width": 1, "height": 1}, "unavailable", False),
            # This is the pre-availability-marker shape emitted by older
            # exports.  The compiler must keep supporting its inline bytes.
            "legacy_inline_data": ({"url": "data:image/png;base64," + PNG_BASE64, "format": "png", "width": 1, "height": 1}, "available", True),
            "invalid_image_placeholder": ({"url": "data:image/png;base64,AAEC"}, "unavailable", False),
            "legacy_remote_url": ({"url": "https://example.test/canvas.png", "format": "png", "width": 1, "height": 1}, "unknown", False),
            "optimistic_remote_url": ({"availability": "available", "url": "https://example.test/canvas.png"}, "unknown", False),
            "stripped_without_archive": ({"inline_payload_excluded": True, "requires_external_materialization": True}, "unknown", False),
            "non_image_data": ({"url": "data:text/plain;base64,aGVsbG8="}, "unavailable", False),
        }

        for name, (final_snapshot, expected_state, expected_available) in variants.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = deepcopy(base)
                source["canvas_snapshot"] = {"final": final_snapshot}
                source_path = root / "prompt-package.json"
                source_path.write_text(json.dumps(source), encoding="utf-8")
                source_bytes = source_path.read_bytes()

                adapted = adapt(source, archive_root=root)
                self.assertEqual(final_snapshot, adapted["final_canvas_snapshot"])
                self.assertEqual(expected_available, adapted["process_ir"]["quality"]["has_canvas_snapshot"])
                self.assertEqual(expected_state, adapted["process_ir"]["quality"]["canvas_snapshot_availability"])

                result = compile_runtime_package(source_path, root / "engine")
                process_ir = json.loads(Path(result["process_ir_path"]).read_text(encoding="utf-8"))
                compact = json.loads(Path(result["compact_package_path"]).read_text(encoding="utf-8"))
                self.assertEqual(expected_available, process_ir["quality"]["has_canvas_snapshot"])
                self.assertEqual(expected_state, process_ir["quality"]["canvas_snapshot_availability"])
                self.assertEqual(expected_state, compact["final_canvas_snapshot"]["availability"])
                self.assertEqual([], validate_process_ir(process_ir))
                compact_errors, _warnings = validate_package(compact)
                self.assertEqual([], compact_errors)
                self.assertFalse((root / "engine" / "engine-inputs").exists())
                self.assertEqual(source_bytes, source_path.read_bytes())

    def test_existing_archive_file_can_support_a_stripped_snapshot_but_missing_file_cannot(self):
        source = {
            "meta": {"package_id": "pp_snapshot_archive"},
            "transcript": {"language": "zh-CN", "segments": []},
            "timeline": [],
            "objects": [],
            "strokes": [],
            "canvas_snapshot": {
                "final": {
                    "archive_relative_path": "canvas-snapshot.png",
                    "format": "png",
                    "width": 2,
                    "height": 2,
                }
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "prompt-package.json"
            source_path.write_text(json.dumps(source), encoding="utf-8")

            missing = compile_runtime_package(source_path, root / "missing-engine")
            missing_ir = json.loads(Path(missing["process_ir_path"]).read_text(encoding="utf-8"))
            missing_compact = json.loads(Path(missing["compact_package_path"]).read_text(encoding="utf-8"))
            self.assertFalse(missing_ir["quality"]["has_canvas_snapshot"])
            self.assertEqual("unavailable", missing_compact["final_canvas_snapshot"]["availability"])
            self.assertFalse((root / "missing-engine" / "engine-inputs").exists())

            (root / "canvas-snapshot.png").write_bytes(base64.b64decode(PNG_BASE64))
            present = compile_runtime_package(source_path, root / "present-engine")
            present_ir = json.loads(Path(present["process_ir_path"]).read_text(encoding="utf-8"))
            present_compact = json.loads(Path(present["compact_package_path"]).read_text(encoding="utf-8"))
            self.assertTrue(present_ir["quality"]["has_canvas_snapshot"])
            self.assertEqual("available", present_compact["final_canvas_snapshot"]["availability"])
            self.assertFalse((root / "present-engine" / "engine-inputs").exists())

    def test_snapshot_file_reference_cannot_escape_its_round(self):
        from snapshot_availability import snapshot_availability
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "other-round.png"
            image.write_bytes(base64.b64decode(PNG_BASE64))
            own_round = root / "round"
            own_round.mkdir()
            for reference in (str(image), "../other-round.png", image.as_uri()):
                self.assertEqual("unavailable", snapshot_availability({"archive_path": reference}, own_round))

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
