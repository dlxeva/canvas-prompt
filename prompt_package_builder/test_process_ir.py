import sys
import unittest
from copy import deepcopy
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))
VALIDATORS_DIR = MODULE_DIR.parent / "validators"
if str(VALIDATORS_DIR) not in sys.path:
    sys.path.insert(0, str(VALIDATORS_DIR))
from build_compact_package import build_structural_observations
from process_ir import _ink_circle_candidates, _layout_transform_observations, _reference_candidates
from process_ir import compile_process_ir
from validate_process_ir import validate_process_ir


class LayoutTransformObservationTests(unittest.TestCase):
    def test_recognizes_english_deictic_forms_without_resolving_them(self):
        captions = [{
            "caption_id": "seg_english", "start_ms": 1_000, "end_ms": 3_000,
            "text": "Keep this one, remove the one on the right, and move that over here.",
        }]
        objects = [{"object_id": "obj_left", "timestamp_ms": 0, "bounds": {"x": 0, "y": 0, "width": 100, "height": 100}}]

        candidates = _reference_candidates(captions, [], objects, [])

        self.assertEqual(1, len(candidates))
        self.assertEqual("seg_english", candidates[0]["caption_id"])
        self.assertEqual("unresolved", candidates[0]["resolution_status"])

    def test_records_closed_ink_loop_as_unresolved_circle_evidence(self):
        package = {
            "strokes": [{
                "stroke_id": "stroke_circle",
                "points": [
                    {"x": 0, "y": 0}, {"x": 140, "y": 0}, {"x": 140, "y": 120},
                    {"x": 0, "y": 120}, {"x": 0, "y": 60}, {"x": 0, "y": 0},
                ],
            }],
        }
        objects = [
            {"object_id": "obj_target", "timestamp_ms": 0, "bounds": {"x": 20, "y": 20, "width": 80, "height": 60}},
            {"object_id": "obj_loop", "timestamp_ms": 0, "bounds": {"x": 0, "y": 0, "width": 140, "height": 120}, "source_strokes": ["stroke_circle"]},
        ]

        candidates = _ink_circle_candidates(package, objects)

        self.assertEqual(1, len(candidates))
        self.assertEqual(["obj_target"], candidates[0]["candidate_object_ids"])
        self.assertEqual("unresolved_handdrawn_circle", candidates[0]["relation"])
        self.assertEqual("unresolved", candidates[0]["resolution_status"])
        self.assertEqual("observation", candidates[0]["assertion_level"])

    def test_circle_contract_is_versioned_without_rejecting_legacy_v04(self):
        package = {"meta": {"package_id": "pp_circle"}, "strokes": []}
        current = compile_process_ir(package, [], [], [])
        self.assertEqual("process-ir-v0.5", current["schema_version"])
        self.assertEqual("process-ir-compiler-v0.4", current["source"]["compiler_version"])
        self.assertEqual([], validate_process_ir(current))

        legacy = deepcopy(current)
        legacy["schema_version"] = "process-ir-v0.4"
        legacy.pop("ink_circle_candidates")
        self.assertEqual([], validate_process_ir(legacy))

    def test_reference_candidates_keep_ordered_pointer_dwell_evidence(self):
        captions = [{"caption_id": "seg_001", "start_ms": 1_000, "end_ms": 4_000, "text": "这里和这里只能留一个"}]
        objects = [
            {"object_id": "obj_left", "timestamp_ms": 0, "bounds": {"x": 0, "y": 0, "width": 100, "height": 100}},
            {"object_id": "obj_right", "timestamp_ms": 0, "bounds": {"x": 200, "y": 0, "width": 100, "height": 100}},
        ]
        gestures = [
            {"gesture_id": "gesture_right", "start_ms": 3_100, "end_ms": 3_900, "dwell_ms": 800, "hit_object_id": "obj_right"},
            {"gesture_id": "gesture_left", "start_ms": 1_200, "end_ms": 2_000, "dwell_ms": 800, "hit_object_id": "obj_left"},
        ]

        candidates = _reference_candidates(captions, [], objects, gestures)
        self.assertEqual(["obj_left", "obj_right"], [item["object_id"] for item in candidates[0]["candidate_objects"]])
        self.assertEqual("gesture_left", candidates[0]["candidate_objects"][0]["pointer_evidence"][0]["gesture_id"])
        self.assertEqual(800, candidates[0]["candidate_objects"][1]["pointer_evidence"][0]["dwell_ms"])
        self.assertEqual("unresolved", candidates[0]["resolution_status"])

    def test_deictic_caption_keeps_the_marked_material_as_an_unresolved_candidate(self):
        captions = [{"caption_id": "seg_here", "start_ms": 1_000, "end_ms": 2_000, "text": "把这里改短一点"}]
        objects = [{"object_id": "obj_material", "timestamp_ms": 0, "bounds": {"x": 0, "y": 0, "width": 500, "height": 300}}]
        review_items = [{
            "artifact_object_id": "obj_material",
            "evidence_caption_ids": ["seg_here"],
            "speech_link_status": "linked",
            "assertion_level": "observation",
            "resolution_status": "unresolved",
        }]

        candidates = _reference_candidates(captions, [], objects, [], review_items)

        self.assertEqual(["obj_material"], [item["object_id"] for item in candidates[0]["candidate_objects"]])
        self.assertIn("material_relative_mark", candidates[0]["candidate_objects"][0]["support"])
        self.assertEqual("unresolved", candidates[0]["resolution_status"])

    def test_keeps_individual_transform_and_adds_batch_observation(self):
        package = {
            "transformations": [
                {
                    "object_id": "a", "timestamp_ms": 3_000,
                    "before_bounds": {"x": 0, "y": 0, "width": 100, "height": 100},
                    "after_bounds": {"x": 30, "y": 0, "width": 100, "height": 100},
                },
                {
                    "object_id": "b", "timestamp_ms": 3_050,
                    "before_bounds": {"x": 200, "y": 0, "width": 100, "height": 100},
                    "after_bounds": {"x": 230, "y": 0, "width": 100, "height": 100},
                },
            ],
        }
        objects = [
            {"object_id": "obj_a", "timestamp_ms": 0, "bounds": {"x": 0, "y": 0, "width": 100, "height": 100}},
            {"object_id": "obj_b", "timestamp_ms": 0, "bounds": {"x": 200, "y": 0, "width": 100, "height": 100}},
        ]
        observations = _layout_transform_observations(package, objects)
        individual = [item for item in observations if item["type"] == "object_layout_transform"]
        batches = [item for item in observations if item["type"] == "batch_layout_transform"]

        self.assertEqual(2, len(individual))
        self.assertEqual("obj_a", individual[0]["object_id"])
        self.assertEqual({"x": 30.0, "y": 0.0}, individual[0]["delta"])
        self.assertEqual("layout_change_does_not_establish_priority_or_intent", individual[0]["constraint"])
        self.assertEqual(1, len(batches))
        self.assertNotIn("prominence_direction", batches[0])

        compact = build_structural_observations({"layout_transform_observations": observations, "objects": objects})
        self.assertEqual(2, len(compact["individual_layout_transforms"]))
        self.assertEqual(1, len(compact["batch_layout_transforms"]))

        process_ir = compile_process_ir({"meta": {"package_id": "pp_layout"}, "transformations": package["transformations"]}, [], [], objects)
        self.assertEqual([], validate_process_ir(process_ir))

    def test_filters_immediate_creation_growth_and_small_movement(self):
        package = {
            "transformations": [
                {
                    "object_id": "a", "timestamp_ms": 500,
                    "before_bounds": {"x": 0, "y": 0, "width": 10, "height": 10},
                    "after_bounds": {"x": 30, "y": 0, "width": 10, "height": 10},
                },
                {
                    "object_id": "a", "timestamp_ms": 3_000,
                    "before_bounds": {"x": 30, "y": 0, "width": 10, "height": 10},
                    "after_bounds": {"x": 33, "y": 0, "width": 10, "height": 10},
                },
            ],
        }
        objects = [{"object_id": "obj_a", "timestamp_ms": 0, "bounds": {"x": 0, "y": 0, "width": 10, "height": 10}}]
        self.assertEqual([], _layout_transform_observations(package, objects))

    def test_declares_omitted_baseline_context_as_a_cross_round_limit(self):
        package = {
            "meta": {"package_id": "pp_test"},
            "baseline_context": {
                "scene_sha256": "abc", "object_count": 5, "image_count": 1,
                "included_object_count": 1, "status": "partially_included",
            },
        }
        process_ir = compile_process_ir(package, [], [], [])
        self.assertEqual("partially_included", process_ir["source"]["baseline_context"]["status"])
        self.assertIn("omitted_baseline_objects_may_limit_cross_round_interpretation", process_ir["interpretation_constraints"])

    def test_keeps_review_and_viewport_evidence_without_semantic_upgrade(self):
        package = {
            "meta": {"package_id": "pp_test", "round_kind": "image_review"},
            "review_items": [{
                "review_id": "review_001", "artifact_object_id": "obj_image", "coordinate_space": "base_artifact",
                "region": {"x_ratio": 0.1, "y_ratio": 0.2, "width_ratio": 0.3, "height_ratio": 0.4},
                "instruction": None, "evidence_caption_ids": [], "speech_link_status": "unavailable",
                "assertion_level": "observation", "resolution_status": "unresolved",
            }],
            "view_transformations": [{
                "observation_id": "view_transform_001", "type": "view_transform", "time_range_ms": [10, 80], "kind": "zoom",
                "before": {"timestamp_ms": 10, "zoom": 1, "scroll_x": 0, "scroll_y": 0},
                "after": {"timestamp_ms": 80, "zoom": 1.2, "scroll_x": 0, "scroll_y": 0},
                "sample_count": 1, "coordinate_space": "viewport_transform", "assertion_level": "observation",
            }],
        }
        process_ir = compile_process_ir(package, [], [], [])
        self.assertEqual("image_review", process_ir["source"]["round_kind"])
        self.assertEqual("unavailable", process_ir["review_mark_candidates"][0]["speech_link_status"])
        self.assertEqual("viewport_transform", process_ir["view_transform_observations"][0]["coordinate_space"])
        self.assertIn("view_transform_does_not_establish_attention_or_priority", process_ir["interpretation_constraints"])


if __name__ == "__main__":
    unittest.main()
