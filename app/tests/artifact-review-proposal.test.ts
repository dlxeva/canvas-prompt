import { describe, expect, it } from 'vitest'
import { compileArtifactReviewProposal } from '../src/artifact-review-proposal'

describe('Artifact Review proposal compiler', () => {
  it('keeps a unique spatial match tentative and preserves the page and voice evidence', () => {
    const brief = compileArtifactReviewProposal({
      artifact: { artifact_id: 'art_demo', source_sha256: 'a'.repeat(64), page_count: 2, read_only: true },
      pages: [{ page_id: 'page_demo_1', page_number: 1 }],
      annotations: [{ annotation_id: 'ann_one', page_id: 'page_demo_1', region: { coordinate_space: 'page_normalized_v1' }, binding_status: 'candidate', evidence_ids: ['ev_one'] }],
      voice_segments: [{ segment_id: 'voice_one', start_ms: 100, end_ms: 200, text: '这个地方需要调整' }],
      reference_resolutions: [{ voice_segment_id: 'voice_one', page_number: 1, status: 'unique_evidence', annotation_id: 'ann_one', evidence_ids: ['ev_voice_one', 'ev_one'] }],
    })

    expect(brief.execution_authorized).toBe(false)
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
