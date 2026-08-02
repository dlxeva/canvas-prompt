import { describe, expect, it } from 'vitest'
import { latestDraftTimestamp, mergeMarksByPage, mergePageVisits, mergeVoiceSegments, restoreMarksFromExport, restoreReviewDraftFromExport } from '../src/pdf-review-draft'

const sourceHash = 'b'.repeat(64)
const exportedPackage = {
  artifact: { source_sha256: sourceHash },
  pages: [{ page_id: 'page_b_2', page_number: 2 }],
  annotations: [{
    annotation_id: 'ann_restored', kind: 'circle', page_id: 'page_b_2', created_at_ms: 720,
    gesture_points: [{ x_ratio: 0.1, y_ratio: 0.2 }, { x_ratio: 0.4, y_ratio: 0.5 }],
  }],
}

describe('PDF review draft recovery', () => {
  it('restores raw marks only for the matching PDF', () => {
    expect(restoreMarksFromExport(sourceHash, exportedPackage)).toEqual({
      2: [{
        id: 'ann_restored', kind: 'circle', pageNumber: 2, createdAtMs: 720,
        points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }],
      }],
    })
    expect(() => restoreMarksFromExport('c'.repeat(64), exportedPackage)).toThrow('不属于当前打开的 PDF')
  })

  it('merges imported marks without duplicating an existing mark id', () => {
    const restored = restoreMarksFromExport(sourceHash, exportedPackage)
    expect(mergeMarksByPage({ 2: restored[2] }, restored)[2]).toHaveLength(1)
  })

  it('restores voice and page timeline together with the marks', () => {
    const draft = restoreReviewDraftFromExport(sourceHash, {
      ...exportedPackage,
      page_visits: [{ page_number: 2, at_ms: 0 }],
      voice_segments: [{ segment_id: 'voice_restored', start_ms: 200, end_ms: 500, text: '这个地方' }],
      annotations: [{
        ...exportedPackage.annotations[0], binding_status: 'candidate',
        voice_window: { start_ms: 200, end_ms: 500, transcript_segment_ids: ['voice_restored'] },
      }],
    })
    expect(draft.voiceSegments).toEqual([{ segmentId: 'voice_restored', startMs: 200, endMs: 500, text: '这个地方' }])
    expect(draft.pageVisits).toEqual([{ pageNumber: 2, atMs: 0 }])
    expect(draft.marksByPage[2][0]).toEqual(expect.objectContaining({ bindingStatus: 'candidate', voiceWindow: { startMs: 200, endMs: 500, transcriptSegmentIds: ['voice_restored'] } }))
    expect(mergeVoiceSegments(draft.voiceSegments, draft.voiceSegments)).toHaveLength(1)
    expect(mergePageVisits(draft.pageVisits, draft.pageVisits)).toHaveLength(1)
    expect(latestDraftTimestamp(draft)).toBe(720)
  })
})
