import { describe, expect, it } from 'vitest'
import { appendConfirmationAction, areConfirmationCandidatesResolved, confirmationDecisionByCandidateId, createConfirmationLedger, deriveConfirmationCandidates } from '../src/artifact-review-confirmation-ui'

const packageData = {
  pages: [{ page_id: 'page_a_2', page_number: 2 }],
  annotations: [{ annotation_id: 'ann_2', page_id: 'page_a_2', kind: 'circle' }],
  voice_segments: [
    { segment_id: 'voice_b', text: '这个标题需要缩短' },
    { segment_id: 'voice_a', text: '这里的图也要调整' },
  ],
  reference_resolutions: [
    { status: 'unique_evidence', annotation_id: 'ann_2', voice_segment_id: 'voice_b', page_number: 2 },
    { status: 'unique_evidence', annotation_id: 'ann_2', voice_segment_id: 'voice_a', page_number: 2 },
    { status: 'clarification_required', voice_segment_id: 'voice_a', page_number: 2 },
  ],
}

describe('Artifact Review confirmation UI model', () => {
  it('derives one stable candidate only from an explicit annotation identity', () => {
    const candidates = deriveConfirmationCandidates(packageData)
    expect(candidates).toEqual([expect.objectContaining({
      candidateId: 'candidate_ann_2', annotationId: 'ann_2', pageNumber: 2,
      transcriptSegmentIds: ['voice_a', 'voice_b'], text: '这里的图也要调整\n这个标题需要缩短',
    })])
  })

  it('drops a resolution with a missing annotation or mismatched page', () => {
    expect(deriveConfirmationCandidates({ ...packageData, reference_resolutions: [
      { status: 'unique_evidence', annotation_id: 'ann_missing', voice_segment_id: 'voice_a', page_number: 2 },
      { status: 'unique_evidence', annotation_id: 'ann_2', voice_segment_id: 'voice_b', page_number: 1 },
    ] })).toEqual([])
  })

  it('appends explicit confirmation and rejection as distinct actions', () => {
    const candidates = deriveConfirmationCandidates(packageData)
    const confirmed = appendConfirmationAction(createConfirmationLedger(candidates), candidates, 'candidate_ann_2', 'confirm', 'action_confirm', 10)
    expect(confirmed.actions).toEqual([expect.objectContaining({ kind: 'confirm', candidateId: 'candidate_ann_2' })])
    const rejected = appendConfirmationAction(createConfirmationLedger(candidates), candidates, 'candidate_ann_2', 'reject', 'action_reject', 10)
    expect(rejected.actions).toEqual([expect.objectContaining({ kind: 'reject', candidateId: 'candidate_ann_2' })])
  })

  it('does not consider a candidate resolved until an explicit decision replays', () => {
    const candidates = deriveConfirmationCandidates(packageData)
    const pending = createConfirmationLedger(candidates)
    expect(areConfirmationCandidatesResolved(pending, candidates)).toBe(false)
    expect(confirmationDecisionByCandidateId(pending).size).toBe(0)

    const confirmed = appendConfirmationAction(pending, candidates, 'candidate_ann_2', 'confirm', 'action_confirm', 10)
    expect(areConfirmationCandidatesResolved(confirmed, candidates)).toBe(true)
    expect(confirmationDecisionByCandidateId(confirmed).get('candidate_ann_2')).toBe('confirm')
  })
})
