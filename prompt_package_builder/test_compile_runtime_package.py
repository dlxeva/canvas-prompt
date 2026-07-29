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


class RuntimeArtifactPathTests(unittest.TestCase):
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
