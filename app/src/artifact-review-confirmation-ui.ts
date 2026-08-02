import {
  replaySerializedReviewConfirmationLedger,
  serializeReviewConfirmationLedger,
  type ReviewCandidateSeed,
  type ReviewConfirmationAction,
  type SerializedReviewConfirmationLedger,
} from './artifact-review-confirmation-ledger'

type ArtifactReviewPackageShape = {
  pages?: unknown
  annotations?: unknown
  reference_resolutions?: unknown
  voice_segments?: unknown
}

export type ConfirmationCandidate = ReviewCandidateSeed & {
  annotationKind: string
  voiceSegments: Array<{ segmentId: string; text: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Converts only deterministic, already-resolved package evidence into review
 * choices. It deliberately excludes ambiguous references and creates no
 * confirmation action by itself.
 */
export function deriveConfirmationCandidates(value: ArtifactReviewPackageShape): ConfirmationCandidate[] {
  const annotations = new Map<string, { pageNumber: number; kind: string }>()
  const pageNumberByPageId = new Map<string, number>()
  // Package page IDs encode the page number, but annotations are made usable
  // from their explicit `page_id` in the package's page list only.
  const pages: unknown[] = Array.isArray(value.pages) ? value.pages : []
  for (const page of pages) {
    if (isRecord(page) && typeof page.page_id === 'string' && typeof page.page_number === 'number' && Number.isInteger(page.page_number)) pageNumberByPageId.set(page.page_id, page.page_number)
  }
  for (const annotation of Array.isArray(value.annotations) ? value.annotations : []) {
    if (!isRecord(annotation) || typeof annotation.annotation_id !== 'string' || typeof annotation.page_id !== 'string' || typeof annotation.kind !== 'string') continue
    const pageNumber = pageNumberByPageId.get(annotation.page_id)
    if (pageNumber !== undefined) annotations.set(annotation.annotation_id, { pageNumber, kind: annotation.kind })
  }

  const voiceById = new Map<string, { segmentId: string; text: string }>()
  for (const segment of Array.isArray(value.voice_segments) ? value.voice_segments : []) {
    if (isRecord(segment) && typeof segment.segment_id === 'string' && typeof segment.text === 'string') {
      voiceById.set(segment.segment_id, { segmentId: segment.segment_id, text: segment.text })
    }
  }

  const voiceIdsByAnnotation = new Map<string, Set<string>>()
  for (const resolution of Array.isArray(value.reference_resolutions) ? value.reference_resolutions : []) {
    if (
      !isRecord(resolution) || resolution.status !== 'unique_evidence'
      || typeof resolution.annotation_id !== 'string' || typeof resolution.voice_segment_id !== 'string'
      || !Number.isInteger(resolution.page_number)
    ) continue
    const annotation = annotations.get(resolution.annotation_id)
    if (!annotation || annotation.pageNumber !== resolution.page_number || !voiceById.has(resolution.voice_segment_id)) continue
    const ids = voiceIdsByAnnotation.get(resolution.annotation_id) ?? new Set<string>()
    ids.add(resolution.voice_segment_id)
    voiceIdsByAnnotation.set(resolution.annotation_id, ids)
  }

  return [...voiceIdsByAnnotation.entries()]
    .flatMap(([annotationId, ids]) => {
      const annotation = annotations.get(annotationId)
      if (!annotation) return []
      const transcriptSegmentIds = [...ids].sort()
      const voiceSegments = transcriptSegmentIds.map((id) => voiceById.get(id)!).filter(Boolean)
      return [{
        candidateId: `candidate_${annotationId}`,
        annotationId,
        pageNumber: annotation.pageNumber,
        annotationKind: annotation.kind,
        transcriptSegmentIds,
        voiceSegments,
        text: voiceSegments.map((segment) => segment.text).join('\n'),
      }]
    })
    .sort((left, right) => left.pageNumber - right.pageNumber || left.annotationId.localeCompare(right.annotationId))
}

export function createConfirmationLedger(candidates: ConfirmationCandidate[], actions: ReviewConfirmationAction[] = []): SerializedReviewConfirmationLedger {
  return serializeReviewConfirmationLedger(
    candidates.map(({ annotationKind: _annotationKind, voiceSegments: _voiceSegments, ...candidate }) => candidate),
    actions,
  )
}

/** Appends one explicit user action. Rejection remains a rejection in the ledger. */
export function appendConfirmationAction(
  ledger: SerializedReviewConfirmationLedger | null,
  candidates: ConfirmationCandidate[],
  candidateId: string,
  kind: 'confirm' | 'reject',
  actionId: string,
  atMs: number,
): SerializedReviewConfirmationLedger {
  const base = ledger ?? createConfirmationLedger(candidates)
  const candidate = base.candidates.find((item) => item.candidateId === candidateId)
  if (!candidate) throw new Error(`找不到候选：${candidateId}`)
  const action: ReviewConfirmationAction = kind === 'confirm'
    ? { actionId, candidateId, kind, atMs }
    : { actionId, candidateId, kind, atMs }
  return createConfirmationLedger(candidates, [...base.actions, action])
}

export function confirmationDecisionByCandidateId(ledger: SerializedReviewConfirmationLedger | null) {
  const decisions = new Map<string, 'confirm' | 'reject'>()
  if (!ledger) return decisions
  const replay = replaySerializedReviewConfirmationLedger(ledger)
  for (const candidate of Object.values(replay.candidates)) {
    if (candidate.status === 'confirmed') decisions.set(candidate.candidateId, 'confirm')
    if (candidate.status === 'rejected') decisions.set(candidate.candidateId, 'reject')
  }
  return decisions
}

export function areConfirmationCandidatesResolved(
  ledger: SerializedReviewConfirmationLedger | null,
  candidates: ConfirmationCandidate[],
) {
  if (candidates.length === 0) return true
  const decisions = confirmationDecisionByCandidateId(ledger)
  return candidates.every((candidate) => decisions.has(candidate.candidateId))
}
