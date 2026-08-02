import {
  replaySerializedReviewConfirmationLedger,
  type SerializedReviewConfirmationLedger,
} from './artifact-review-confirmation-ledger'
import { resolvePdfDeicticReferences } from './artifact-review-reference-resolver'

export type ReviewTool = 'ink' | 'circle' | 'arrow'
export type ArtifactReviewKind = 'pdf' | 'pptx'

export type PagePoint = { x: number; y: number }

export type ReviewMark = {
  id: string
  kind: ReviewTool
  pageNumber: number
  points: PagePoint[]
  createdAtMs: number
  voiceWindow?: {
    startMs: number
    endMs: number
    transcriptSegmentIds: string[]
  }
  bindingStatus?: 'confirmed' | 'candidate' | 'clarification_required'
  /** Local timestamp of an explicit spatial confirmation, never inferred. */
  confirmedAtMs?: number
}

export type ArtifactReviewVoiceSegment = {
  segmentId: string
  startMs: number
  endMs: number
  text: string
  confidence?: number
}

export type ArtifactReviewPageVisit = { pageNumber: number; atMs: number }

export type ArtifactReviewPage = {
  pageNumber: number
  width: number
  height: number
  rotationDegrees: 0 | 90 | 180 | 270
}

type BuildOptions = {
  sourceHash: string
  artifactKind?: ArtifactReviewKind
  renderDerivative?: {
    sha256: string
    pageCount: number
    rendererName: string
    rendererVersion?: string
  }
  pages: ArtifactReviewPage[]
  marksByPage: Record<number, ReviewMark[]>
  voiceSegments?: ArtifactReviewVoiceSegment[]
  pageVisits?: ArtifactReviewPageVisit[]
  /** A replayable explicit-user-action credential; mark flags alone are not trusted. */
  confirmationLedger?: SerializedReviewConfirmationLedger
  createdAt?: Date
}

function pageId(sourceHash: string, pageNumber: number) {
  return `page_${sourceHash.slice(0, 16)}_${pageNumber}`
}

function regionFromPoints(points: PagePoint[]) {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minimumSpan = 0.002
  let x = Math.max(0, Math.min(...xs))
  let y = Math.max(0, Math.min(...ys))
  const width = Math.max(minimumSpan, Math.max(...xs) - x)
  const height = Math.max(minimumSpan, Math.max(...ys) - y)
  x = Math.min(x, 1 - width)
  y = Math.min(y, 1 - height)
  return {
    coordinate_space: 'page_normalized_v1',
    x_ratio: x,
    y_ratio: y,
    width_ratio: width,
    height_ratio: height,
  }
}

/**
 * Produces evidence-only, source-byte-free JSON for a manual review session.
 * Unique spatial evidence remains a candidate. A target becomes confirmed
 * only after an explicit user action recorded on the mark itself.
 */
export function buildArtifactReviewPackage({ sourceHash, artifactKind = 'pdf', renderDerivative, pages, marksByPage, voiceSegments = [], pageVisits = [], confirmationLedger, createdAt = new Date() }: BuildOptions) {
  if (renderDerivative && artifactKind !== 'pptx') {
    throw new Error('只有 PPTX 批阅可以声明本地 PDF 渲染衍生物。')
  }
  if (renderDerivative && renderDerivative.pageCount !== pages.length) {
    throw new Error('PPTX 渲染页数必须与批阅页面数量一致。')
  }
  const marks = Object.values(marksByPage).flat()
  const markById = new Map(marks.map((mark) => [mark.id, mark]))
  const voiceIds = new Set(voiceSegments.map((segment) => segment.segmentId))
  const confirmationActionByMarkId = new Map<string, { actionId: string; atMs: number }>()
  if (confirmationLedger) {
    const replay = replaySerializedReviewConfirmationLedger(confirmationLedger)
    const actionById = new Map(replay.effectiveActions.map((action) => [action.actionId, action]))
    for (const candidate of Object.values(replay.candidates)) {
      if (candidate.status !== 'confirmed' || !candidate.annotationId || !candidate.lastActionId) continue
      const action = actionById.get(candidate.lastActionId)
      const mark = markById.get(candidate.annotationId)
      if (
        !action || action.kind !== 'confirm' || action.candidateId !== candidate.candidateId
        || !mark || mark.pageNumber !== candidate.pageNumber
        || candidate.transcriptSegmentIds.some((segmentId) => !voiceIds.has(segmentId))
      ) throw new Error(`确认账本凭据无法验证候选 ${candidate.candidateId}。`)
      confirmationActionByMarkId.set(mark.id, { actionId: action.actionId, atMs: action.atMs })
    }
  }
  const isExplicitlyConfirmed = (mark: ReviewMark) => confirmationActionByMarkId.has(mark.id)
  const referenceResolutions = resolvePdfDeicticReferences(marks, voiceSegments, pageVisits).map((resolution) => {
    const confirmedMark = marks.find((mark) => (
      isExplicitlyConfirmed(mark)
      && mark.pageNumber === resolution.pageNumber
      && mark.voiceWindow?.transcriptSegmentIds.includes(resolution.voiceSegmentId)
    ))
    if (!confirmedMark) return resolution
    return {
      ...resolution,
      status: 'unique_evidence' as const,
      annotationId: confirmedMark.id,
      evidenceIds: [...new Set([...resolution.evidenceIds, `ev_confirm_${confirmedMark.id.slice(4)}`])],
    }
  })
  const voiceById = new Map(voiceSegments.map((segment) => [segment.segmentId, segment]))
  const packageSuffix = `${sourceHash.slice(0, 16)}_${createdAt.getTime()}`
  const annotations = marks.map((mark) => {
    const linkedSegments = referenceResolutions
      .filter((resolution: { status: string; annotationId?: string }) => resolution.status === 'unique_evidence' && resolution.annotationId === mark.id)
      .map((resolution: { voiceSegmentId: string }) => voiceById.get(resolution.voiceSegmentId))
      .filter((segment: ArtifactReviewVoiceSegment | undefined): segment is ArtifactReviewVoiceSegment => segment !== undefined)
    const voiceWindow = mark.voiceWindow ?? (linkedSegments.length > 0 ? {
      startMs: Math.min(...linkedSegments.map((segment) => segment.startMs)),
      endMs: Math.max(...linkedSegments.map((segment) => segment.endMs)),
      transcriptSegmentIds: linkedSegments.map((segment) => segment.segmentId),
    } : undefined)
    return {
    annotation_id: mark.id,
    page_id: pageId(sourceHash, mark.pageNumber),
    kind: mark.kind,
    region: regionFromPoints(mark.points),
    gesture_points: mark.points.map((point) => ({ x_ratio: point.x, y_ratio: point.y })),
    created_at_ms: mark.createdAtMs,
    binding_status: isExplicitlyConfirmed(mark)
      ? 'confirmed'
      : mark.bindingStatus === 'confirmed'
        ? 'clarification_required'
        : mark.bindingStatus ?? (linkedSegments.length > 0 ? 'candidate' : 'clarification_required'),
    ...(voiceWindow ? {
      voice_window: {
        start_ms: voiceWindow.startMs,
        end_ms: voiceWindow.endMs,
        transcript_segment_ids: voiceWindow.transcriptSegmentIds,
      },
    } : {}),
    evidence_ids: [
      `ev_${mark.id.slice(4)}`,
      ...(voiceWindow?.transcriptSegmentIds.map((segmentId) => `ev_${segmentId}`) ?? []),
      ...(isExplicitlyConfirmed(mark) ? [`ev_confirm_${mark.id.slice(4)}`] : []),
    ],
  }})

  const interpretationStatus = annotations.length > 0 && annotations.every((annotation) => annotation.binding_status === 'confirmed')
    ? 'user_confirmed'
    : 'clarification_required'

  return {
    schema_version: 'artifact-review/0.2-draft',
    package_id: `arp_${packageSuffix}`,
    created_at: createdAt.toISOString(),
    artifact: {
      artifact_id: `art_${sourceHash.slice(0, 16)}`,
      artifact_kind: artifactKind,
      source_version_id: `sha256:${sourceHash}`,
      source_sha256: sourceHash,
      page_count: pages.length,
      read_only: true,
      ...(renderDerivative ? {
        render_derivative: {
          artifact_kind: 'pdf_derivative',
          source_sha256: renderDerivative.sha256,
          page_count: renderDerivative.pageCount,
          renderer: {
            name: renderDerivative.rendererName,
            ...(renderDerivative.rendererVersion ? { version: renderDerivative.rendererVersion } : {}),
          },
        },
      } : {}),
    },
    pages: pages.map((page) => ({
      page_id: pageId(sourceHash, page.pageNumber),
      page_number: page.pageNumber,
      render_box: { width: page.width, height: page.height, unit: 'pdf_point' },
      rotation_degrees: page.rotationDegrees,
    })),
    page_visits: pageVisits.map((visit) => ({ page_number: visit.pageNumber, at_ms: visit.atMs })),
    annotations,
    voice_segments: voiceSegments.map((segment) => ({
      segment_id: segment.segmentId,
      start_ms: segment.startMs,
      end_ms: segment.endMs,
      text: segment.text,
      ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
    })),
    reference_resolutions: referenceResolutions.map((resolution: { resolutionId: string; voiceSegmentId: string; pageNumber: number; status: string; annotationId?: string; evidenceIds: string[] }) => ({
      resolution_id: resolution.resolutionId,
      voice_segment_id: resolution.voiceSegmentId,
      page_number: resolution.pageNumber,
      status: resolution.status,
      ...(resolution.annotationId ? { annotation_id: resolution.annotationId } : {}),
      evidence_ids: resolution.evidenceIds,
    })),
    evidence: [
      ...annotations.map((annotation) => ({
        evidence_id: `ev_${annotation.annotation_id.slice(4)}`,
        kind: 'annotation',
        page_id: annotation.page_id,
        annotation_id: annotation.annotation_id,
        assertion_level: 'observation',
        time_window_ms: { start_ms: annotation.created_at_ms, end_ms: annotation.created_at_ms },
      })),
      ...voiceSegments.map((segment) => ({
        evidence_id: `ev_${segment.segmentId}`,
        kind: 'voice_segment',
        assertion_level: 'raw',
        time_window_ms: { start_ms: segment.startMs, end_ms: segment.endMs },
      })),
      ...marks.flatMap((mark) => isExplicitlyConfirmed(mark) ? [{
        evidence_id: `ev_confirm_${mark.id.slice(4)}`,
        kind: 'clarification_response',
        annotation_id: mark.id,
        assertion_level: 'explicit_user_assertion',
        time_window_ms: {
          start_ms: confirmationActionByMarkId.get(mark.id)!.atMs,
          end_ms: confirmationActionByMarkId.get(mark.id)!.atMs,
        },
      }] : []),
    ],
    privacy: {
      processing: 'local_only',
      source_bytes_in_export: false,
      retention: 'private_local_until_deleted',
      redaction_status: 'not_reviewed',
    },
    review_state: {
      interpretation_status: interpretationStatus,
      execution_authorized: false,
    },
  }
}
