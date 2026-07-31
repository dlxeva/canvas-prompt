import { describe, expect, it } from 'vitest'
import { resolvePdfDeicticReferences } from '../src/artifact-review-reference-resolver'

const marks = [
  { id: 'ann_page_1', kind: 'circle' as const, pageNumber: 1, createdAtMs: 10_000, points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }] },
  { id: 'ann_page_2', kind: 'arrow' as const, pageNumber: 2, createdAtMs: 12_000, points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }] },
]

describe('PDF deictic reference resolver', () => {
  it('binds only a unique same-page, time-adjacent mark as evidence', () => {
    expect(resolvePdfDeicticReferences(marks, [
      { segmentId: 'voice_one', startMs: 10_500, endMs: 11_000, text: '这个地方要改' },
    ], [{ pageNumber: 1, atMs: 0 }])).toEqual([expect.objectContaining({
      status: 'unique_evidence', annotationId: 'ann_page_1', pageNumber: 1,
    })])
  })

  it('does not bind a page-1 mark after the user has moved to page 2', () => {
    expect(resolvePdfDeicticReferences(marks, [
      { segmentId: 'voice_two', startMs: 12_500, endMs: 13_000, text: '这里太吵了' },
    ], [{ pageNumber: 1, atMs: 0 }, { pageNumber: 2, atMs: 11_500 }])[0]).toEqual(expect.objectContaining({
      status: 'unique_evidence', annotationId: 'ann_page_2', pageNumber: 2,
    }))
  })

  it('requires clarification whenever two marks could fit the same reference', () => {
    const crowded = [...marks, { id: 'ann_page_1_second', kind: 'ink' as const, pageNumber: 1, createdAtMs: 10_200, points: [{ x: 0.4, y: 0.4 }, { x: 0.5, y: 0.5 }] }]
    expect(resolvePdfDeicticReferences(crowded, [
      { segmentId: 'voice_three', startMs: 10_500, endMs: 11_000, text: '这块不对' },
    ], [{ pageNumber: 1, atMs: 0 }])[0]).toEqual(expect.objectContaining({ status: 'clarification_required' }))
  })

  it('requires clarification instead of reaching back to an old mark', () => {
    expect(resolvePdfDeicticReferences(marks, [
      { segmentId: 'voice_four', startMs: 30_000, endMs: 30_400, text: '这个需要改' },
    ], [{ pageNumber: 1, atMs: 0 }])[0]).toEqual(expect.objectContaining({ status: 'clarification_required', pageNumber: 1 }))
  })

  it('does not fabricate a reference for ordinary non-deictic speech', () => {
    expect(resolvePdfDeicticReferences(marks, [
      { segmentId: 'voice_five', startMs: 10_500, endMs: 11_000, text: '标题层级需要更清楚' },
    ], [{ pageNumber: 1, atMs: 0 }])).toEqual([])
  })
})
