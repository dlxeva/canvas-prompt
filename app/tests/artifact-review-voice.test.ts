import { describe, expect, it } from 'vitest'
import { findVoiceTargetCandidate } from '../src/artifact-review-voice'

describe('voice target candidates', () => {
  it('offers only the nearest prior mark on the active page as a candidate', () => {
    const candidate = findVoiceTargetCandidate([
      { id: 'ann_old', kind: 'circle', pageNumber: 1, points: [], createdAtMs: 3_000 },
      { id: 'ann_other_page', kind: 'circle', pageNumber: 2, points: [], createdAtMs: 24_000 },
      { id: 'ann_near', kind: 'arrow', pageNumber: 1, points: [], createdAtMs: 24_500 },
    ], 1, { startMs: 25_000, endMs: 27_000 })

    expect(candidate?.id).toBe('ann_near')
  })

  it('does not invent a target when no nearby mark exists', () => {
    expect(findVoiceTargetCandidate([
      { id: 'ann_old', kind: 'circle', pageNumber: 1, points: [], createdAtMs: 1 },
    ], 1, { startMs: 30_000, endMs: 31_000 })).toBeUndefined()
  })
})
