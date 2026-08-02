import {
  replaySerializedReviewConfirmationLedger,
  type SerializedReviewConfirmationLedger,
} from './artifact-review-confirmation-ledger'

type UnknownRecord = Record<string, unknown>
type ArtifactReviewKind = 'pdf' | 'pptx'
type RenderDerivative = {
  artifact_kind: 'pdf_derivative'
  source_sha256: string
  page_count: number
  renderer: { name: string; version?: string }
}

export type ArtifactReviewHandoffPayload = {
  package_id: string
  schema_version: 'artifact-review/0.2-draft'
  artifact: {
    artifact_kind: ArtifactReviewKind
    read_only: true
    source_sha256: string
    source_version_id: string
    page_count?: number
    render_derivative?: RenderDerivative
  }
  pages: unknown[]
  annotations: unknown[]
  evidence: unknown[]
  privacy: { processing: 'local_only'; source_bytes_in_export: false }
  review_state: { execution_authorized: false }
}

const PROHIBITED_EXPORT_KEYS = new Set([
  'sourcelocator', 'sourcepath', 'sourcebytes', 'pdfbytes', 'audiobytes', 'recording',
  'recordingurl', 'media', 'mediaurl', 'audiourl', 'blob', 'bloburl', 'dataurl',
  'absolutepath', 'filepath',
])

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasProhibitedExportField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasProhibitedExportField)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, nested]) => (
    PROHIBITED_EXPORT_KEYS.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase())
    || hasProhibitedExportField(nested)
  ))
}

function hasValidRenderDerivative(artifact: UnknownRecord) {
  const derivative = artifact.render_derivative
  if (derivative === undefined) return true
  if (artifact.artifact_kind !== 'pptx' || !isRecord(derivative)) return false
  const renderer = derivative.renderer
  if (!isRecord(renderer) || typeof renderer.name !== 'string' || renderer.name.trim().length === 0) return false
  if (renderer.version !== undefined && typeof renderer.version !== 'string') return false
  if (
    derivative.artifact_kind !== 'pdf_derivative'
    || typeof derivative.source_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(derivative.source_sha256)
    || !Number.isInteger(derivative.page_count)
    || Number(derivative.page_count) < 1
  ) return false
  return artifact.page_count === undefined || artifact.page_count === derivative.page_count
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

function isNormalizedRegion(value: unknown) {
  if (!isRecord(value) || value.coordinate_space !== 'page_normalized_v1') return false
  const x = value.x_ratio
  const y = value.y_ratio
  const width = value.width_ratio
  const height = value.height_ratio
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1
    && typeof y === 'number' && Number.isFinite(y) && y >= 0 && y <= 1
    && typeof width === 'number' && Number.isFinite(width) && width > 0 && width <= 1
    && typeof height === 'number' && Number.isFinite(height) && height > 0 && height <= 1
    && x + width <= 1
    && y + height <= 1
}

function asRecordArray(value: unknown): UnknownRecord[] | null {
  if (!Array.isArray(value) || !value.every(isRecord)) return null
  return value
}

function hasValidSemanticGraph(value: UnknownRecord, artifact: UnknownRecord) {
  const pageCount = artifact.page_count
  const pages = asRecordArray(value.pages)
  const annotations = asRecordArray(value.annotations)
  const evidence = asRecordArray(value.evidence)
  if (!Number.isInteger(pageCount) || Number(pageCount) < 1 || !pages || !annotations || !evidence || pages.length !== pageCount) return false

  const pageIds = new Set<string>()
  const pageNumbers = new Set<number>()
  for (const page of pages) {
    if (
      typeof page.page_id !== 'string'
      || !/^page_[A-Za-z0-9_-]+$/.test(page.page_id)
      || !Number.isInteger(page.page_number)
      || Number(page.page_number) < 1
      || Number(page.page_number) > Number(pageCount)
      || pageIds.has(page.page_id)
      || pageNumbers.has(Number(page.page_number))
    ) return false
    pageIds.add(page.page_id)
    pageNumbers.add(Number(page.page_number))
  }

  const annotationById = new Map<string, UnknownRecord>()
  for (const annotation of annotations) {
    if (
      typeof annotation.annotation_id !== 'string'
      || !/^ann_[A-Za-z0-9_-]+$/.test(annotation.annotation_id)
      || annotationById.has(annotation.annotation_id)
      || typeof annotation.page_id !== 'string'
      || !pageIds.has(annotation.page_id)
      || !isNormalizedRegion(annotation.region)
      || !isNonNegativeInteger(annotation.created_at_ms)
      || !['confirmed', 'candidate', 'clarification_required'].includes(String(annotation.binding_status))
      || !Array.isArray(annotation.evidence_ids)
      || !annotation.evidence_ids.every((id) => typeof id === 'string')
    ) return false
    annotationById.set(annotation.annotation_id, annotation)
  }

  const evidenceById = new Map<string, UnknownRecord>()
  for (const item of evidence) {
    if (
      typeof item.evidence_id !== 'string'
      || !/^ev_[A-Za-z0-9_-]+$/.test(item.evidence_id)
      || evidenceById.has(item.evidence_id)
      || (item.page_id !== undefined && (typeof item.page_id !== 'string' || !pageIds.has(item.page_id)))
      || (item.annotation_id !== undefined && (typeof item.annotation_id !== 'string' || !annotationById.has(item.annotation_id)))
    ) return false
    if (item.time_window_ms !== undefined) {
      if (!isRecord(item.time_window_ms) || !isNonNegativeInteger(item.time_window_ms.start_ms) || !isNonNegativeInteger(item.time_window_ms.end_ms) || item.time_window_ms.start_ms > item.time_window_ms.end_ms) return false
    }
    evidenceById.set(item.evidence_id, item)
  }

  const voiceSegments = asRecordArray(value.voice_segments ?? [])
  if (!voiceSegments) return false
  const voiceIds = new Set<string>()
  for (const segment of voiceSegments) {
    if (
      typeof segment.segment_id !== 'string'
      || !/^voice_[A-Za-z0-9_-]+$/.test(segment.segment_id)
      || voiceIds.has(segment.segment_id)
      || !isNonNegativeInteger(segment.start_ms)
      || !isNonNegativeInteger(segment.end_ms)
      || segment.start_ms > segment.end_ms
    ) return false
    voiceIds.add(segment.segment_id)
  }

  for (const annotation of annotations) {
    const evidenceIds = annotation.evidence_ids as string[]
    if (evidenceIds.some((id) => !evidenceById.has(id))) return false
    if (annotation.voice_window !== undefined) {
      if (!isRecord(annotation.voice_window) || !isNonNegativeInteger(annotation.voice_window.start_ms) || !isNonNegativeInteger(annotation.voice_window.end_ms) || annotation.voice_window.start_ms > annotation.voice_window.end_ms) return false
      const segmentIds = annotation.voice_window.transcript_segment_ids ?? []
      if (!Array.isArray(segmentIds) || segmentIds.some((id) => typeof id !== 'string' || !voiceIds.has(id))) return false
    }
    if (annotation.binding_status === 'confirmed') {
      const expectedId = `ev_confirm_${String(annotation.annotation_id).slice('ann_'.length)}`
      const confirmation = evidenceById.get(expectedId)
      if (
        !evidenceIds.includes(expectedId)
        || !confirmation
        || confirmation.kind !== 'clarification_response'
        || confirmation.annotation_id !== annotation.annotation_id
        || confirmation.assertion_level !== 'explicit_user_assertion'
        || !isRecord(confirmation.time_window_ms)
        || confirmation.time_window_ms.start_ms !== confirmation.time_window_ms.end_ms
      ) return false
    }
  }

  const resolutions = asRecordArray(value.reference_resolutions ?? [])
  if (!resolutions) return false
  const resolutionIds = new Set<string>()
  for (const resolution of resolutions) {
    if (
      typeof resolution.resolution_id !== 'string'
      || resolutionIds.has(resolution.resolution_id)
      || typeof resolution.voice_segment_id !== 'string'
      || !voiceIds.has(resolution.voice_segment_id)
      || !Number.isInteger(resolution.page_number)
      || !pageNumbers.has(Number(resolution.page_number))
      || !Array.isArray(resolution.evidence_ids)
      || resolution.evidence_ids.some((id) => typeof id !== 'string' || !evidenceById.has(id))
    ) return false
    resolutionIds.add(resolution.resolution_id)
    if (resolution.status === 'unique_evidence') {
      if (typeof resolution.annotation_id !== 'string') return false
      const annotation = annotationById.get(resolution.annotation_id)
      const page = pages.find((candidate) => candidate.page_id === annotation?.page_id)
      if (!annotation || page?.page_number !== resolution.page_number) return false
    } else if (resolution.status !== 'clarification_required' || resolution.annotation_id !== undefined) return false
  }

  const visits = asRecordArray(value.page_visits ?? [])
  if (!visits || visits.some((visit) => !pageNumbers.has(Number(visit.page_number)) || !isNonNegativeInteger(visit.at_ms))) return false

  const reviewState = value.review_state
  if (!isRecord(reviewState) || reviewState.execution_authorized !== false || !['evidence_only', 'clarification_required', 'user_confirmed'].includes(String(reviewState.interpretation_status))) return false
  const allConfirmed = annotations.length > 0 && annotations.every((annotation) => annotation.binding_status === 'confirmed')
  if ((reviewState.interpretation_status === 'user_confirmed') !== allConfirmed) return false
  return true
}

function hasVerifiedConfirmationCredentials(value: UnknownRecord, ledger?: SerializedReviewConfirmationLedger) {
  const annotations = asRecordArray(value.annotations) ?? []
  const confirmed = annotations.filter((annotation) => annotation.binding_status === 'confirmed')
  if (confirmed.length === 0) return true
  if (!ledger) return false
  try {
    const replay = replaySerializedReviewConfirmationLedger(ledger)
    const pages = asRecordArray(value.pages) ?? []
    const pageNumberById = new Map(pages.map((page) => [page.page_id, page.page_number]))
    const evidence = asRecordArray(value.evidence) ?? []
    const effectiveById = new Map(replay.effectiveActions.map((action) => [action.actionId, action]))
    const voiceIds = new Set((asRecordArray(value.voice_segments ?? []) ?? []).map((segment) => segment.segment_id))
    return confirmed.every((annotation) => {
      const candidate = Object.values(replay.candidates).find((item) => item.status === 'confirmed' && item.annotationId === annotation.annotation_id)
      if (!candidate || candidate.pageNumber !== pageNumberById.get(annotation.page_id) || !candidate.lastActionId) return false
      const action = effectiveById.get(candidate.lastActionId)
      const evidenceId = `ev_confirm_${String(annotation.annotation_id).slice('ann_'.length)}`
      const credential = evidence.find((item) => item.evidence_id === evidenceId)
      return action?.kind === 'confirm'
        && action.candidateId === candidate.candidateId
        && candidate.transcriptSegmentIds.every((segmentId) => voiceIds.has(segmentId))
        && isRecord(credential?.time_window_ms)
        && credential.time_window_ms.start_ms === action.atMs
        && credential.time_window_ms.end_ms === action.atMs
    })
  } catch {
    return false
  }
}

/** Rejects private bytes and structurally or semantically inconsistent review graphs. */
export function isArtifactReviewHandoffPayload(value: unknown, confirmationLedger?: SerializedReviewConfirmationLedger): value is ArtifactReviewHandoffPayload {
  if (!isRecord(value) || hasProhibitedExportField(value)) return false
  const artifact = value.artifact
  const privacy = value.privacy
  return value.schema_version === 'artifact-review/0.2-draft'
    && typeof value.package_id === 'string'
    && /^arp_[A-Za-z0-9_-]+$/.test(value.package_id)
    && isRecord(artifact)
    && (artifact.artifact_kind === 'pdf' || artifact.artifact_kind === 'pptx')
    && artifact.read_only === true
    && typeof artifact.source_sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(artifact.source_sha256)
    && artifact.source_version_id === `sha256:${artifact.source_sha256}`
    && hasValidRenderDerivative(artifact)
    && hasValidSemanticGraph(value, artifact)
    && hasVerifiedConfirmationCredentials(value, confirmationLedger)
    && isRecord(privacy)
    && privacy.processing === 'local_only'
    && privacy.source_bytes_in_export === false
    && (privacy.retention === 'session_only' || privacy.retention === 'private_local_until_deleted')
}
