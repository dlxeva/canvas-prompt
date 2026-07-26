import sys
import unittest
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from browser_package_to_fixture import adapt, red_markers
from build_compact_package import build_compact_caption_summary
from validators.validate_process_ir import validate_process_ir


class EvidenceContractTests(unittest.TestCase):
    def test_hex_red_annotation_is_detected_as_a_marker(self):
        self.assertEqual(
            ["red_circle"],
            [item["object_id"] for item in red_markers([
                {"object_id": "red_circle", "properties": {"color": "#dc2626"}},
                {"object_id": "orange_note", "properties": {"color": "#f97316"}},
            ])],
        )

    def test_untimestamped_full_transcript_cannot_bind_to_review_marks(self):
        package = {
            "meta": {"package_id": "pp_no_segments"},
            "transcript": {"full_text": "把这里改短一点", "segments": []},
            "timeline": [{"event_id": "evt_1", "timestamp_ms": 1_000, "event_type": "region_create", "target_id": "mark"}],
            "objects": [],
            "review_items": [{"review_id": "review_001", "artifact_object_id": "obj_image", "coordinate_space": "base_artifact", "region": {}, "speech_link_status": "unavailable", "assertion_level": "observation", "resolution_status": "unresolved"}],
        }
        adapted = adapt(package)
        process_ir = adapted["process_ir"]
        self.assertEqual([], adapted["caption_track"])
        self.assertEqual("unavailable", process_ir["source"]["transcript_alignment_status"])
        self.assertFalse(process_ir["quality"]["has_timestamped_transcript"])
        self.assertEqual("unavailable", process_ir["review_mark_candidates"][0]["speech_link_status"])

    def test_segment_ids_remain_resolvable_across_process_ir(self):
        package = {
            "meta": {"package_id": "pp_segment_identity"},
            "transcript": {
                "full_text": "把这里改短一点",
                "alignment_status": "timestamped",
                "segments": [{"segment_id": "seg_001", "start_ms": 100, "end_ms": 900, "text": "把这里改短一点"}],
            },
            "timeline": [],
            "objects": [],
            "review_items": [{
                "review_id": "review_001",
                "artifact_object_id": "obj_image",
                "coordinate_space": "base_artifact",
                "region": {},
                "instruction": "把这里改短一点",
                "evidence_caption_ids": ["seg_001"],
                "speech_link_status": "linked",
                "assertion_level": "observation",
                "resolution_status": "unresolved",
            }],
        }
        adapted = adapt(package)
        self.assertEqual(["seg_001"], [item["caption_id"] for item in adapted["caption_track"]])
        self.assertEqual(["seg_001"], adapted["process_ir"]["review_mark_candidates"][0]["evidence_caption_ids"])
        self.assertEqual([], validate_process_ir(adapted["process_ir"]))
        adapted["process_ir"]["review_mark_candidates"][0]["evidence_caption_ids"] = ["seg_missing"]
        self.assertIn(
            "Review mark evidence_caption_ids must resolve to speech anchors.",
            validate_process_ir(adapted["process_ir"]),
        )

    def test_compact_caption_summary_retains_late_referenced_caption(self):
        captions = [
            {"caption_id": f"seg_{index:03d}", "start_ms": index * 100, "end_ms": index * 100 + 50, "text": str(index)}
            for index in range(1, 12)
        ]
        summary = build_compact_caption_summary(captions, {"seg_011"})
        self.assertIn("seg_011", [item["caption_id"] for item in summary])
        self.assertEqual(11, len(summary))

    def test_far_negation_and_red_marker_do_not_form_rejection(self):
        package = {
            "meta": {"package_id": "pp_far_rejection"},
            "transcript": {
                "full_text": "这个方案不对",
                "alignment_status": "timestamped",
                "segments": [{"segment_id": "seg_001", "start_ms": 1_000, "end_ms": 2_000, "text": "这个方案不对"}],
            },
            "timeline": [{"event_id": "evt_red", "timestamp_ms": 50_000, "event_type": "stroke_start", "target_id": "red"}],
            "objects": [
                {"object_id": "obj_option", "timestamp_ms": 0, "type": "text_block", "bounds": {"x": 0, "y": 0, "width": 100, "height": 100}, "properties": {"label": "旧方案"}},
                {"object_id": "obj_red", "timestamp_ms": 50_000, "type": "diagram_element", "bounds": {"x": 0, "y": 0, "width": 100, "height": 100}, "properties": {"color": "#dc2626"}},
            ],
        }
        adapted = adapt(package)
        self.assertEqual([], [item for item in adapted["semantic_events"] if item["type"] == "reject_path"])
        self.assertEqual([], [item for item in adapted["object_state_track"] if item["state_to"] == "rejected"])

    def test_near_negation_and_unique_red_marker_form_one_rejection_link(self):
        package = {
            "meta": {"package_id": "pp_near_rejection"},
            "transcript": {
                "full_text": "这个方案不对",
                "alignment_status": "timestamped",
                "segments": [{"segment_id": "seg_001", "start_ms": 49_000, "end_ms": 50_000, "text": "这个方案不对"}],
            },
            "timeline": [{"event_id": "evt_red", "timestamp_ms": 50_000, "event_type": "stroke_start", "target_id": "red"}],
            "objects": [
                {"object_id": "obj_option", "timestamp_ms": 0, "type": "text_block", "bounds": {"x": 0, "y": 0, "width": 100, "height": 100}, "properties": {"label": "旧方案"}},
                {"object_id": "obj_red", "timestamp_ms": 50_000, "type": "diagram_element", "bounds": {"x": 0, "y": 0, "width": 100, "height": 100}, "properties": {"color": "#dc2626"}},
            ],
        }
        adapted = adapt(package)
        rejections = [item for item in adapted["semantic_events"] if item["type"] == "reject_path"]
        self.assertEqual(1, len(rejections))
        self.assertEqual("assertion", rejections[0]["assertion_level"])
        self.assertEqual(["evt_red"], rejections[0]["source_canvas_event_ids"])
        rejected_states = [item for item in adapted["object_state_track"] if item["state_to"] == "rejected"]
        self.assertEqual(["evt_red"], rejected_states[0]["source_event_ids"])

    def test_plain_creation_and_derived_pause_do_not_gain_reasoning_importance_or_candidate_state(self):
        package = {
            "meta": {"package_id": "pp_lifecycle_only"},
            "timeline": [
                {"event_id": "evt_create", "timestamp_ms": 1_000, "event_type": "region_create", "target_id": "rect"},
                {"event_id": "evt_later", "timestamp_ms": 12_000, "event_type": "stroke_end", "target_id": "stroke"},
            ],
            "objects": [{"object_id": "obj_rect", "timestamp_ms": 1_000, "type": "shape", "bounds": {}, "properties": {}}],
        }
        adapted = adapt(package)
        self.assertTrue(all("importance" not in event for event in adapted["canvas_event_track"]))
        self.assertEqual([], adapted["object_state_track"])


if __name__ == "__main__":
    unittest.main()
