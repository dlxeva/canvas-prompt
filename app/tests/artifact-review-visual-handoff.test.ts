import { describe, expect, it } from 'vitest'
import { visualEvidencePageNumbers } from '../src/artifact-review-visual-handoff'

describe('Artifact Review visual handoff selection', () => {
  it('archives only marked pages in stable page order', () => {
    expect(visualEvidencePageNumbers({
      3: [{ id: 'ann_3', kind: 'ink', pageNumber: 3, createdAtMs: 0, points: [{ x: 0.1, y: 0.1 }] }],
      1: [{ id: 'ann_1', kind: 'circle', pageNumber: 1, createdAtMs: 0, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }],
      2: [],
    })).toEqual([1, 3])
  })
})

