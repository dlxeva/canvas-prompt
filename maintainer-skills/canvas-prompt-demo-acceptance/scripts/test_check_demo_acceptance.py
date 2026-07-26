import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("check_demo_acceptance.py")
SPEC = importlib.util.spec_from_file_location("check_demo_acceptance", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_round(project: Path, package_id: str, image_count: int, review_marks: bool = False) -> None:
    root = project / ".canvas-prompt" / "rounds" / package_id
    (root / "engine").mkdir(parents=True)
    (root / "prompt-package.json").write_text(json.dumps({
        "meta": {"package_id": package_id},
        "baseline_context": {"image_count": image_count},
        "strokes": [{"stroke_id": "stroke_1"}],
    }), encoding="utf-8")
    (root / "handoff.json").write_text(json.dumps({"status": "accepted"}), encoding="utf-8")
    (root / "engine" / "process-ir.json").write_text(json.dumps({
        "review_mark_candidates": [{"review_id": "review_1"}] if review_marks else [],
    }), encoding="utf-8")
    (root / "engine" / "compact-package.json").write_text("{}", encoding="utf-8")


class DemoAcceptanceTests(unittest.TestCase):
    def test_accepts_valid_blank_and_review_rounds(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            write_round(project, "blank", 0)
            write_round(project, "review", 1, review_marks=True)
            self.assertTrue(MODULE.check_round(project, "blank", "blank")["passed"])
            self.assertTrue(MODULE.check_round(project, "review", "review")["passed"])

    def test_rejects_failed_handoff(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            write_round(project, "blank", 0)
            receipt = project / ".canvas-prompt" / "rounds" / "blank" / "handoff.json"
            receipt.write_text(json.dumps({"status": "failed"}), encoding="utf-8")
            result = MODULE.check_round(project, "blank", "blank")
            self.assertFalse(result["passed"])
            self.assertIn("handoff is not accepted or delivered: 'failed'", result["errors"])


if __name__ == "__main__":
    unittest.main()
