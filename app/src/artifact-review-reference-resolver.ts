import type { ArtifactReviewVoiceSegment, ReviewMark } from './artifact-review-package'

export type PdfPageVisit = { pageNumber: number; atMs: number }

export type ReferenceResolution = {
  resolutionId: string
  voiceSegmentId: string
  pageNumber: number
  status: 'unique_evidence' | 'clarification_required'
  annotationId?: string
  evidenceIds: string[]
}

const DEICTIC_PATTERN = /这(?:个|里|儿|张|段|部分|边|一块|地方)?|那(?:个|里|儿|张|段|部分|边|一块|地方)?|上面|下面|刚才/
export const MARK_TIME_WINDOW_MS = 8_000

function activePageAt(pageVisits: PdfPageVisit[], atMs: number) {
  return [...pageVisits]
    .sort((left, right) => left.atMs - right.atMs)
    .filter((visit) => visit.atMs <= atMs)
    .at(-1)?.pageNumber
}

function changesPageDuring(pageVisits: PdfPageVisit[], startMs: number, endMs: number, startPage: number) {
  return pageVisits.some((visit) => (
    visit.atMs > startMs && visit.atMs <= endMs && visit.pageNumber !== startPage
  ))
}

/** The candidate set is evidence, never an implicit choice. */
export function findPdfReferenceCandidates(
  marks: ReviewMark[],
  pageVisits: PdfPageVisit[],
  segment: ArtifactReviewVoiceSegment,
) {
  const pageNumber = activePageAt(pageVisits, segment.startMs)
  return {
    pageNumber,
    marks: pageNumber === undefined ? [] : marks.filter((mark) => (
      mark.pageNumber === pageNumber && Math.abs(mark.createdAtMs - segment.startMs) <= MARK_TIME_WINDOW_MS
    )),
  }
}

/**
 * Deterministic D-087 candidate generation. It can prove spatial evidence is
 * unique, but never turns that proof into a user confirmation or an edit.
 */
export function resolvePdfDeicticReferences(
  marks: ReviewMark[],
  voiceSegments: ArtifactReviewVoiceSegment[],
  pageVisits: PdfPageVisit[],
): ReferenceResolution[] {
  return voiceSegments
    .filter((segment) => DEICTIC_PATTERN.test(segment.text))
    .flatMap((segment) => {
      const { pageNumber, marks: candidates } = findPdfReferenceCandidates(marks, pageVisits, segment)
      if (pageNumber === undefined) return []
      const evidenceIds = [`ev_${segment.segmentId}`]
      if (changesPageDuring(pageVisits, segment.startMs, segment.endMs, pageNumber)) {
        return {
          resolutionId: `ref_${segment.segmentId.slice('voice_'.length)}`,
          voiceSegmentId: segment.segmentId,
          pageNumber,
          status: 'clarification_required' as const,
          evidenceIds,
        }
      }
      if (candidates.length === 1 && pageNumber !== undefined) {
        const annotation = candidates[0]
        return {
          resolutionId: `ref_${segment.segmentId.slice('voice_'.length)}`,
          voiceSegmentId: segment.segmentId,
          pageNumber,
          status: 'unique_evidence' as const,
          annotationId: annotation.id,
          evidenceIds: [...evidenceIds, `ev_${annotation.id.slice('ann_'.length)}`],
        }
      }
      return {
        resolutionId: `ref_${segment.segmentId.slice('voice_'.length)}`,
        voiceSegmentId: segment.segmentId,
        pageNumber,
        status: 'clarification_required' as const,
        evidenceIds,
      }
    })
}
