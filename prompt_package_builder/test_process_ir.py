import json
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
from process_ir import _arrowhead_candidates, _ink_annotation_candidates, _ink_check_candidates, _ink_circle_candidates, _ink_cross_candidates, _layout_transform_observations, _paired_symbol_choice_candidates, _reference_candidates
from process_ir import compile_process_ir
from validate_process_ir import validate_process_ir


class LayoutTransformObservationTests(unittest.TestCase):
    def test_real_handwritten_anchor_modes_preserve_arrow_and_region_evidence(self):
        fixture_path = MODULE_DIR / "fixtures" / "handwriting-visual-anchor-modes.json"
        package = json.loads(fixture_path.read_text(encoding="utf-8"))
        process_ir = compile_process_ir(package, [], [], package["objects"])

        relations = {item["stroke_id"]: item for item in process_ir["ink_relation_candidates"]}
        self.assertEqual({"free_arrow_shaft", "native_arrow", "box_connector"}, set(relations))
        self.assertEqual("strong", relations["free_arrow_shaft"]["evidence_level"])
        self.assertIn("visual_unit_anchor", relations["free_arrow_shaft"]["evidence_sources"])
        self.assertIn("arrow_geometry", relations["free_arrow_shaft"]["evidence_sources"])
        self.assertEqual("strong", relations["native_arrow"]["evidence_level"])
        self.assertIn("handwritten_object_anchor", relations["native_arrow"]["evidence_sources"])
        self.assertEqual("explicit", relations["box_connector"]["evidence_level"])
        self.assertIn("region_anchor", relations["box_connector"]["evidence_sources"])
        self.assertEqual([], [item for item in process_ir["ink_relation_candidates"] if item["stroke_id"] == "unknown_stroke"])
        self.assertGreaterEqual(len(process_ir["ink_region_candidates"]), 2)
        self.assertEqual([], validate_process_ir(process_ir))

    def test_dense_handwriting_stays_out_of_relations_but_bound_connector_survives(self):
        fixture_path = MODULE_DIR / "fixtures" / "handwriting-relation-regression.json"
        package = json.loads(fixture_path.read_text(encoding="utf-8"))
        process_ir = compile_process_ir(package, [], [], package["objects"])

        relations = process_ir["ink_relation_candidates"]
        self.assertEqual(["real_connector"], [item["stroke_id"] for item in relations])
        self.assertEqual("obj_start", relations[0]["endpoint_candidates"]["start_object_id"])
        self.assertEqual("obj_end", relations[0]["endpoint_candidates"]["end_object_id"])
        self.assertEqual("strong", relations[0]["evidence_level"])
        self.assertIn("circle_anchor", relations[0]["evidence_sources"])
        compact = build_structural_observations(process_ir)
        self.assertEqual("strong", compact["handdrawn_connection_candidates"][0]["evidence_level"])
        self.assertEqual(2, len(process_ir["ink_circle_candidates"]))
        self.assertEqual(1, len(process_ir["ink_arrowhead_candidates"]))
        self.assertEqual("real_connector", process_ir["ink_arrowhead_candidates"][0]["shaft_stroke_id"])
        self.assertEqual("strong", process_ir["ink_arrowhead_candidates"][0]["evidence_level"])
        self.assertEqual("strong", relations[0]["evidence_level"])
        self.assertEqual([], validate_process_ir(process_ir))

    def test_dense_handwriting_without_connector_has_no_relation(self):
        fixture_path = MODULE_DIR / "fixtures" / "handwriting-relation-regression.json"
        package = json.loads(fixture_path.read_text(encoding="utf-8"))
        package["strokes"] = [stroke for stroke in package["strokes"] if stroke["stroke_id"].startswith("hand_")]
        package["objects"] = [obj for obj in package["objects"] if obj["object_id"].startswith("obj_hand_")]

        process_ir = compile_process_ir(package, [], [], package["objects"])

        self.assertEqual([], process_ir["ink_relation_candidates"])

    def test_circled_connector_with_relation_speech_is_multimodal_and_traceable(self):
        fixture_path = MODULE_DIR / "fixtures" / "handwriting-relation-regression.json"
        package = json.loads(fixture_path.read_text(encoding="utf-8"))
        package["strokes"] = [
            stroke for stroke in package["strokes"] if stroke["stroke_id"] != "real_arrowhead"
        ]
        captions = [{
            "caption_id": "seg_relation",
            "start_ms": 1_500,
            "end_ms": 2_100,
            "text": "这个导致那个，它们有关",
        }]
        process_ir = compile_process_ir(package, captions, [], package["objects"])
        relation = next(item for item in process_ir["ink_relation_candidates"] if item["stroke_id"] == "real_connector")

        self.assertEqual("multimodal_candidate", relation["evidence_level"])
        self.assertIn("speech_alignment", relation["evidence_sources"])
        self.assertEqual(["seg_relation"], [item["caption_id"] for item in relation["speech_evidence"]])
        self.assertEqual(1600, relation["temporal_evidence"]["connection_timestamp_ms"])
        self.assertEqual([], validate_process_ir(process_ir))

    def test_circled_connector_without_arrow_is_explicit_candidate(self):
        fixture_path = MODULE_DIR / "fixtures" / "handwriting-relation-regression.json"
        package = json.loads(fixture_path.read_text(encoding="utf-8"))
        package["strokes"] = [
            stroke for stroke in package["strokes"] if stroke["stroke_id"] != "real_arrowhead"
        ]

        process_ir = compile_process_ir(package, [], [], package["objects"])
        relation = next(item for item in process_ir["ink_relation_candidates"] if item["stroke_id"] == "real_connector")

        self.assertEqual("explicit", relation["evidence_level"])
        self.assertIn("object_binding", relation["evidence_sources"])
        self.assertIn("circle_anchor", relation["evidence_sources"])
        self.assertEqual([], validate_process_ir(process_ir))

    def test_circled_connector_can_bind_existing_baseline_anchors(self):
        fixture_path = MODULE_DIR / "fixtures" / "handwriting-relation-regression.json"
        package = json.loads(fixture_path.read_text(encoding="utf-8"))
        package["strokes"] = [
            stroke for stroke in package["strokes"] if stroke["stroke_id"] in {
                "circle_start", "circle_end", "real_connector",
            }
        ]
        for object_id in ("obj_start", "obj_end"):
            obj = next(item for item in package["objects"] if item["object_id"] == object_id)
            obj["type"] = "diagram_element"
            obj.pop("semantic_content", None)
            obj["properties"] = {"baseline_anchor": True, "evidence_source": "round_start_scene"}

        process_ir = compile_process_ir(package, [], [], package["objects"])
        relation = next(item for item in process_ir["ink_relation_candidates"] if item["stroke_id"] == "real_connector")

        self.assertEqual("obj_start", relation["endpoint_candidates"]["start_object_id"])
        self.assertEqual("obj_end", relation["endpoint_candidates"]["end_object_id"])
        self.assertIn("circle_anchor", relation["evidence_sources"])
        self.assertEqual([], validate_process_ir(process_ir))

    def test_native_arrow_between_stable_objects_is_strong(self):
        package = {
            "meta": {"package_id": "pp_native_arrow"},
            "strokes": [],
            "arrows": [{
                "arrow_id": "native_arrow",
                "timestamp_ms": 1_000,
                "from": {"type": "point", "ref": {"x": 60, "y": 100}},
                "to": {"type": "point", "ref": {"x": 260, "y": 100}},
            }],
            "objects": [
                {"object_id": "obj_start", "type": "text_block", "bounds": {"x": 30, "y": 70, "width": 60, "height": 60}},
                {"object_id": "obj_end", "type": "shape", "bounds": {"x": 230, "y": 70, "width": 60, "height": 60}},
            ],
        }

        process_ir = compile_process_ir(package, [], [], package["objects"])
        relation = next(item for item in process_ir["ink_relation_candidates"] if item["stroke_id"] == "native_arrow")

        self.assertEqual("strong", relation["evidence_level"])
        self.assertIn("arrow_geometry", relation["evidence_sources"])
        self.assertEqual("native_arrow", relation["arrow_id"])
        self.assertEqual([], validate_process_ir(process_ir))

    def test_relation_speech_without_visual_endpoints_does_not_fabricate_a_connection(self):
        captions = [{
            "caption_id": "seg_relation_only",
            "start_ms": 1_000,
            "end_ms": 1_600,
            "text": "这个导致那个，它们有关",
        }]
        process_ir = compile_process_ir(
            {
                "meta": {"package_id": "pp_relation_speech_only"},
                "strokes": [{
                    "stroke_id": "unbound_stroke",
                    "timestamp_ms": 1_200,
                    "points": [{"x": 0, "y": 0}, {"x": 100, "y": 0}],
                }],
                "objects": [{
                    "object_id": "obj_unbound_stroke",
                    "type": "diagram_element",
                    "bounds": {"x": 0, "y": 0, "width": 100, "height": 1},
                    "source_strokes": ["unbound_stroke"],
                }],
            },
            captions,
            [],
            [{
                "object_id": "obj_unbound_stroke",
                "type": "diagram_element",
                "bounds": {"x": 0, "y": 0, "width": 100, "height": 1},
                "source_strokes": ["unbound_stroke"],
            }],
        )

        self.assertEqual([], process_ir["ink_relation_candidates"])
        self.assertEqual(["seg_relation_only"], [item["caption_id"] for item in process_ir["speech_anchors"]])

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

    def test_records_two_intersecting_strokes_over_a_baseline_anchor_as_cross_evidence(self):
        package = {
            "strokes": [
                {"stroke_id": "slash_a", "points": [{"x": 20, "y": 20}, {"x": 100, "y": 100}]},
                {"stroke_id": "slash_b", "points": [{"x": 100, "y": 20}, {"x": 20, "y": 100}]},
            ],
        }
        objects = [
            {"object_id": "obj_text", "timestamp_ms": 0, "bounds": {"x": 10, "y": 10, "width": 100, "height": 100}, "properties": {"baseline_anchor": True}},
            {"object_id": "obj_slash_a", "timestamp_ms": 1, "bounds": {"x": 20, "y": 20, "width": 80, "height": 80}, "source_strokes": ["slash_a"]},
            {"object_id": "obj_slash_b", "timestamp_ms": 2, "bounds": {"x": 20, "y": 20, "width": 80, "height": 80}, "source_strokes": ["slash_b"]},
        ]

        candidates = _ink_cross_candidates(package, objects)

        self.assertEqual(1, len(candidates))
        self.assertEqual("unresolved_intersecting_stroke_pair", candidates[0]["type"])
        self.assertEqual(["obj_text"], candidates[0]["candidate_object_ids"])
        self.assertEqual("unresolved", candidates[0]["resolution_status"])

    def test_circle_contract_is_versioned_without_rejecting_legacy_v04(self):
        package = {"meta": {"package_id": "pp_circle"}, "strokes": []}
        current = compile_process_ir(package, [], [], [])
        self.assertEqual("process-ir-v0.8", current["schema_version"])
        self.assertEqual("process-ir-compiler-v0.7", current["source"]["compiler_version"])
        self.assertEqual([], validate_process_ir(current))

        legacy = deepcopy(current)
        legacy["schema_version"] = "process-ir-v0.4"
        legacy.pop("ink_circle_candidates")
        legacy.pop("ink_cross_candidates")
        legacy.pop("ink_check_candidates")
        legacy.pop("paired_symbol_choice_candidates")
        legacy.pop("ink_annotation_candidates")
        self.assertEqual([], validate_process_ir(legacy))

    def test_pairs_x_and_checklike_strokes_on_peer_objects_without_executing_them(self):
        package = {
            "strokes": [
                {"stroke_id": "slash_a", "points": [{"x": 20, "y": 20}, {"x": 100, "y": 100}]},
                {"stroke_id": "slash_b", "points": [{"x": 100, "y": 20}, {"x": 20, "y": 100}]},
                {"stroke_id": "check", "points": [{"x": 160, "y": 40}, {"x": 185, "y": 90}, {"x": 280, "y": 15}]},
            ],
        }
        objects = [
            {"object_id": "obj_left", "bounds": {"x": 10, "y": 10, "width": 110, "height": 110}},
            {"object_id": "obj_right", "bounds": {"x": 140, "y": 10, "width": 150, "height": 110}},
            {"object_id": "obj_slash_a", "bounds": {"x": 20, "y": 20, "width": 80, "height": 80}, "source_strokes": ["slash_a"]},
            {"object_id": "obj_slash_b", "bounds": {"x": 20, "y": 20, "width": 80, "height": 80}, "source_strokes": ["slash_b"]},
            {"object_id": "obj_check", "bounds": {"x": 160, "y": 15, "width": 120, "height": 75}, "source_strokes": ["check"]},
        ]

        crosses = _ink_cross_candidates(package, objects)
        checks = _ink_check_candidates(package, objects)
        pairs = _paired_symbol_choice_candidates(crosses, checks, objects)

        self.assertEqual(1, len(checks))
        self.assertEqual(["obj_right"], checks[0]["candidate_object_ids"])
        self.assertEqual(1, len(pairs))
        self.assertEqual("obj_left", pairs[0]["candidate_outcome_mapping"]["negative_object_id"])
        self.assertEqual("obj_right", pairs[0]["candidate_outcome_mapping"]["positive_object_id"])
        self.assertEqual("unresolved", pairs[0]["resolution_status"])

    def test_recognizes_a_continuous_v_arrowhead_attached_to_a_shaft(self):
        package = {"strokes": [
            {"stroke_id": "shaft", "points": [{"x": 0, "y": 50}, {"x": 100, "y": 50}]},
            {"stroke_id": "tip", "points": [{"x": 80, "y": 30}, {"x": 100, "y": 50}, {"x": 80, "y": 70}]},
        ]}
        relations = [{
            "relation_id": "ink_rel_001", "stroke_id": "shaft",
            "endpoint_candidates": {"start_object_id": "obj_a", "end_object_id": "obj_b"},
        }]

        candidates = _arrowhead_candidates(package, relations)

        self.assertEqual(1, len(candidates))
        self.assertEqual(["tip"], candidates[0]["support_stroke_ids"])
        self.assertEqual("path_start_to_path_end", candidates[0]["candidate_visual_direction"])
        self.assertEqual("continuous_v", candidates[0]["geometry"]["construction"])

    def test_records_target_bound_strike_underline_plus_caret_and_scribble_shapes(self):
        package = {"strokes": [
            {"stroke_id": "strike", "points": [{"x": 0, "y": 50}, {"x": 100, "y": 50}]},
            {"stroke_id": "underline", "points": [{"x": 140, "y": 104}, {"x": 240, "y": 104}]},
            {"stroke_id": "plus_h", "points": [{"x": 270, "y": 50}, {"x": 350, "y": 50}]},
            {"stroke_id": "plus_v", "points": [{"x": 310, "y": 10}, {"x": 310, "y": 90}]},
            {"stroke_id": "caret", "points": [{"x": 390, "y": 80}, {"x": 420, "y": 35}, {"x": 450, "y": 80}]},
            {"stroke_id": "scribble", "points": [{"x": 500, "y": 20}, {"x": 560, "y": 80}, {"x": 500, "y": 80}, {"x": 560, "y": 20}, {"x": 500, "y": 50}, {"x": 560, "y": 50}, {"x": 550, "y": 40}]},
        ]}
        objects = [
            {"object_id": "obj_strike", "bounds": {"x": 0, "y": 20, "width": 100, "height": 60}},
            {"object_id": "obj_underline", "bounds": {"x": 140, "y": 40, "width": 100, "height": 60}},
            {"object_id": "obj_plus", "bounds": {"x": 270, "y": 10, "width": 80, "height": 80}},
            {"object_id": "obj_caret", "bounds": {"x": 390, "y": 35, "width": 60, "height": 60}},
            {"object_id": "obj_scribble", "bounds": {"x": 500, "y": 20, "width": 60, "height": 60}},
        ]

        candidates = _ink_annotation_candidates(package, objects, [])
        observed = {(item["kind"], tuple(item["candidate_object_ids"])) for item in candidates}

        self.assertIn(("strikethrough_like", ("obj_strike",)), observed)
        self.assertIn(("underline_like", ("obj_underline",)), observed)
        self.assertIn(("plus_like", ("obj_plus",)), observed)
        self.assertIn(("caret_like", ("obj_caret",)), observed)
        self.assertIn(("scribble_like", ("obj_scribble",)), observed)

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
