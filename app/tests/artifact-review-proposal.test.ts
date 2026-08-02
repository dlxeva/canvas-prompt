import { describe, expect, it } from 'vitest'
import { compileArtifactReviewProposal } from '../src/artifact-review-proposal'

describe('Artifact Review proposal compiler', () => {
  it('rejects a claimed confirmation without matching explicit confirmation evidence', () => {
    expect(() => compileArtifactReviewProposal({
      artifact: { artifact_id: 'art_demo', source_sha256: 'a'.repeat(64), page_count: 1, read_only: true },
      pages: [{ page_id: 'page_demo_1', page_number: 1 }],
      annotations: [{ annotation_id: 'ann_unproven', page_id: 'page_demo_1', region: { coordinate_space: 'page_normalized_v1' }, binding_status: 'confirmed', evidence_ids: ['ev_ann_unproven'] }],
      evidence: [],
    })).toThrow('缺少显式确认凭据')
  })

  it('accepts a confirmation only with matching explicit evidence and timestamp', () => {
    const packageValue = {
      artifact: { artifact_id: 'art_demo', source_sha256: 'a'.repeat(64), page_count: 1, read_only: true },
      pages: [{ page_id: 'page_demo_1', page_number: 1 }],
      annotations: [{ annotation_id: 'ann_proven', page_id: 'page_demo_1', region: { coordinate_space: 'page_normalized_v1' }, binding_status: 'confirmed', evidence_ids: ['ev_confirm_proven'] }],
      evidence: [{
        evidence_id: 'ev_confirm_proven', kind: 'clarification_response', annotation_id: 'ann_proven',
        assertion_level: 'explicit_user_assertion', time_window_ms: { start_ms: 500, end_ms: 500 },
      }],
    }

    expect(() => compileArtifactReviewProposal(packageValue)).toThrow('缺少显式确认凭据')
    const brief = compileArtifactReviewProposal(packageValue, {
      schema_version: 'artifact-review-confirmation-ledger/0.1-draft',
      candidates: [{ candidateId: 'candidate_proven', pageNumber: 1, annotationId: 'ann_proven', transcriptSegmentIds: [], text: '已确认目标' }],
      actions: [{ actionId: 'action_confirm_proven', candidateId: 'candidate_proven', kind: 'confirm', atMs: 500 }],
    })

    expect(brief.proposal_items[0]).toEqual(expect.objectContaining({ state: 'user_confirmed_target' }))
  })

  it('rejects a unique reference whose page disagrees with its annotation page', () => {
    expect(() => compileArtifactReviewProposal({
      artifact: { artifact_id: 'art_demo', source_sha256: 'a'.repeat(64), page_count: 2, read_only: true },
      pages: [{ page_id: 'page_demo_1', page_number: 1 }, { page_id: 'page_demo_2', page_number: 2 }],
      annotations: [{ annotation_id: 'ann_page_two', page_id: 'page_demo_2', region: { coordinate_space: 'page_normalized_v1' }, binding_status: 'candidate', evidence_ids: ['ev_page_two'] }],
      voice_segments: [{ segment_id: 'voice_page_one', start_ms: 100, end_ms: 200, text: '这里要改' }],
      reference_resolutions: [{ voice_segment_id: 'voice_page_one', page_number: 1, status: 'unique_evidence', annotation_id: 'ann_page_two', evidence_ids: ['ev_page_two'] }],
    })).toThrow('页码与批注不一致')
  })

  it('keeps a unique spatial match tentative and preserves the page and voice evidence', () => {
    const brief = compileArtifactReviewProposal({
      artifact: { artifact_id: 'art_demo', source_sha256: 'a'.repeat(64), page_count: 2, read_only: true },
      pages: [{ page_id: 'page_demo_1', page_number: 1 }],
      annotations: [{ annotation_id: 'ann_one', page_id: 'page_demo_1', region: { coordinate_space: 'page_normalized_v1' }, binding_status: 'candidate', evidence_ids: ['ev_one'] }],
      voice_segments: [{ segment_id: 'voice_one', start_ms: 100, end_ms: 200, text: '这个地方需要调整' }],
      reference_resolutions: [{ voice_segment_id: 'voice_one', page_number: 1, status: 'unique_evidence', annotation_id: 'ann_one', evidence_ids: ['ev_voice_one', 'ev_one'] }],
    })

    expect(brief.execution_authorized).toBe(false)
    expect(brief.execution_gate).toEqual({
      status: 'awaiting_user_confirmation',
      confirmation_required: true,
      confirmation_channel: 'conversation',
      user_visible_internal_ids: false,
      required_summary_sections: ['overall_goal', 'global_changes', 'page_changes', 'preserve', 'uncertainties', 'output'],
      scope_change_requires_reconfirmation: true,
    })
    expect(brief.proposal_items).toEqual([expect.objectContaining({
      annotation_id: 'ann_one', page_number: 1, state: 'evidence_bound_candidate',
      voice_evidence: [{ segment_id: 'voice_one', text: '这个地方需要调整', start_ms: 100, end_ms: 200 }],
    })])
  })

  it('does not manufacture a target when the package requires clarification', () => {
    const brief = compileArtifactReviewProposal({
      artifact: { artifact_id: 'art_demo', source_sha256: 'b'.repeat(64), page_count: 2, read_only: true },
      pages: [{ page_id: 'page_demo_2', page_number: 2 }], annotations: [],
      voice_segments: [{ segment_id: 'voice_two', start_ms: 300, end_ms: 400, text: '这一处要改' }],
      reference_resolutions: [{ voice_segment_id: 'voice_two', page_number: 2, status: 'clarification_required', evidence_ids: ['ev_voice_two'] }],
    })

    expect(brief.proposal_items).toEqual([])
    expect(brief.unresolved_references).toEqual([{ voice_segment_id: 'voice_two', page_number: 2, transcript: '这一处要改', evidence_ids: ['ev_voice_two'], required_action: 'clarify_target' }])
  })
})
