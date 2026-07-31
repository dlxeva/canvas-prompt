/**
 * Synthetic, source-byte-free review trace used to lock the AR-02 export
 * boundary. It deliberately covers two pages and two anchor outcomes.
 */
export const fixedArtifactReviewInput = {
  sourceHash: '1'.repeat(64),
  createdAt: new Date('2026-07-31T00:00:00.000Z'),
  pages: [
    { pageNumber: 1, width: 612, height: 792, rotationDegrees: 0 as const },
    { pageNumber: 2, width: 612, height: 792, rotationDegrees: 0 as const },
  ],
  pageVisits: [
    { pageNumber: 1, atMs: 0 },
    { pageNumber: 2, atMs: 4_000 },
  ],
  marksByPage: {
    1: [{
      id: 'ann_page_one', kind: 'circle' as const, pageNumber: 1, createdAtMs: 1_000,
      points: [{ x: 0.12, y: 0.18 }, { x: 0.32, y: 0.38 }],
    }],
    2: [{
      id: 'ann_page_two', kind: 'arrow' as const, pageNumber: 2, createdAtMs: 5_000,
      points: [{ x: 0.60, y: 0.25 }, { x: 0.82, y: 0.45 }],
    }],
  },
  voiceSegments: [{
    segmentId: 'voice_page_two', startMs: 5_300, endMs: 6_100, text: '这一处需要补充依据', confidence: 0.88,
  }],
}
