import { describe, expect, it } from 'vitest'
import { replayReviewConfirmationLedger, replaySerializedReviewConfirmationLedger, serializeReviewConfirmationLedger } from '../src/artifact-review-confirmation-ledger'
import type { ReviewCandidateSeed, ReviewConfirmationAction } from '../src/artifact-review-confirmation-ledger'

const seed: ReviewCandidateSeed = {
  candidateId: 'candidate_1',
  pageNumber: 1,
  annotationId: 'ann_1',
  transcriptSegmentIds: ['voice_1'],
  text: '这里需要调整',
}

describe('Artifact Review confirmation ledger', () => {
  it('starts every machine-produced candidate as pending', () => {
    const result = replayReviewConfirmationLedger([seed], [])
    expect(result.candidates.candidate_1).toEqual(expect.objectContaining({ status: 'pending', pageNumber: 1 }))
  })

  it('replays rewrite, rebind and explicit confirmation in order', () => {
    const actions: ReviewConfirmationAction[] = [
      { actionId: 'action_rewrite', candidateId: 'candidate_1', kind: 'rewrite', text: '标题需要缩短', atMs: 10 },
      { actionId: 'action_rebind', candidateId: 'candidate_1', kind: 'rebind', pageNumber: 2, annotationId: 'ann_2', atMs: 20 },
      { actionId: 'action_confirm', candidateId: 'candidate_1', kind: 'confirm', atMs: 30 },
    ]
    const result = replayReviewConfirmationLedger([seed], actions)
    expect(result.candidates.candidate_1).toEqual(expect.objectContaining({
      status: 'confirmed', text: '标题需要缩短', pageNumber: 2, annotationId: 'ann_2', lastActionId: 'action_confirm',
    }))
    expect(result.effectiveActions.map((action) => action.actionId)).toEqual(['action_rewrite', 'action_rebind', 'action_confirm'])
  })

  it('splits one candidate into two pending children without losing provenance', () => {
    const result = replayReviewConfirmationLedger([seed], [{
      actionId: 'action_split', candidateId: 'candidate_1', kind: 'split', atMs: 10,
      parts: [{ candidateId: 'candidate_1a', text: '调整标题' }, { candidateId: 'candidate_1b', text: '移动配图' }],
    }])
    expect(result.candidates.candidate_1.status).toBe('split')
    expect(result.candidates.candidate_1a).toEqual(expect.objectContaining({ status: 'pending', parentCandidateId: 'candidate_1', text: '调整标题', annotationId: 'ann_1' }))
    expect(result.candidates.candidate_1b).toEqual(expect.objectContaining({ status: 'pending', parentCandidateId: 'candidate_1', text: '移动配图', transcriptSegmentIds: ['voice_1'] }))
  })

  it('keeps rejection terminal', () => {
    const actions: ReviewConfirmationAction[] = [
      { actionId: 'action_reject', candidateId: 'candidate_1', kind: 'reject', reason: '识别错误', atMs: 10 },
      { actionId: 'action_confirm', candidateId: 'candidate_1', kind: 'confirm', atMs: 20 },
    ]
    expect(() => replayReviewConfirmationLedger([seed], actions)).toThrow('已拒绝')
  })

  it('undoes only the latest effective action and restores the prior state', () => {
    const result = replayReviewConfirmationLedger([seed], [
      { actionId: 'action_rewrite', candidateId: 'candidate_1', kind: 'rewrite', text: '改写后的意见', atMs: 10 },
      { actionId: 'action_confirm', candidateId: 'candidate_1', kind: 'confirm', atMs: 20 },
      { actionId: 'action_undo', kind: 'undo', targetActionId: 'action_confirm', atMs: 30 },
    ])
    expect(result.candidates.candidate_1).toEqual(expect.objectContaining({ status: 'revised', text: '改写后的意见' }))
    expect(result.undoneActionIds).toEqual(['action_confirm'])
  })

  it('rejects an undo that targets older history', () => {
    expect(() => replayReviewConfirmationLedger([seed], [
      { actionId: 'action_rewrite', candidateId: 'candidate_1', kind: 'rewrite', text: '新文本', atMs: 10 },
      { actionId: 'action_confirm', candidateId: 'candidate_1', kind: 'confirm', atMs: 20 },
      { actionId: 'action_undo', kind: 'undo', targetActionId: 'action_rewrite', atMs: 30 },
    ])).toThrow('只能撤销最近一个')
  })

  it('rejects duplicate identifiers, reversed time and split collisions', () => {
    expect(() => replayReviewConfirmationLedger([seed, seed], [])).toThrow('重复的候选 ID')
    expect(() => replayReviewConfirmationLedger([seed], [
      { actionId: 'action_1', candidateId: 'candidate_1', kind: 'confirm', atMs: 20 },
      { actionId: 'action_2', kind: 'undo', targetActionId: 'action_1', atMs: 10 },
    ])).toThrow('非递减')
    expect(() => replayReviewConfirmationLedger([seed], [{
      actionId: 'action_split', candidateId: 'candidate_1', kind: 'split', atMs: 10,
      parts: [{ candidateId: 'candidate_1', text: '冲突' }, { candidateId: 'candidate_2', text: '第二项' }],
    }])).toThrow('ID 冲突')
  })

  it('does not mutate caller-owned seeds or actions', () => {
    const seeds = [structuredClone(seed)]
    const actions: ReviewConfirmationAction[] = [{ actionId: 'action_confirm', candidateId: 'candidate_1', kind: 'confirm', atMs: 10 }]
    const beforeSeeds = structuredClone(seeds)
    const beforeActions = structuredClone(actions)
    replayReviewConfirmationLedger(seeds, actions)
    expect(seeds).toEqual(beforeSeeds)
    expect(actions).toEqual(beforeActions)
  })

  it('serializes only a replayable confirmation credential', () => {
    const ledger = serializeReviewConfirmationLedger([seed], [{ actionId: 'action_confirm', candidateId: 'candidate_1', kind: 'confirm', atMs: 10 }])
    expect(replaySerializedReviewConfirmationLedger(structuredClone(ledger)).candidates.candidate_1.status).toBe('confirmed')
    expect(() => replaySerializedReviewConfirmationLedger({ ...ledger, schema_version: 'forged' })).toThrow('凭据格式无效')
  })
})
