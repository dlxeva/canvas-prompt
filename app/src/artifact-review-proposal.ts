type UnknownRecord = Record<string, unknown>

type ProposalState = 'user_confirmed_target' | 'evidence_bound_candidate' | 'evidence_only'

export type ArtifactReviewProposal = {
  schema_version: 'artifact-review-proposal/0.1-draft'
  artifact: { artifact_id: string; source_sha256: string; page_count: number; read_only: true }
  execution_authorized: false
  proposal_items: Array<{
    annotation_id: string
    page_number: number
    region: UnknownRecord
    state: ProposalState
    voice_evidence: Array<{ segment_id: string; text: string; start_ms: number; end_ms: number }>
    evidence_ids: string[]
  }>
  unresolved_references: Array<{
    voice_segment_id: string
    page_number: number
    transcript: string
    evidence_ids: string[]
    required_action: 'clarify_target'
  }>
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Converts source evidence into a deliberately non-executing reading brief.
 * It preserves voice words verbatim and never invents an edit or target.
 */
export function compileArtifactReviewProposal(value: unknown): ArtifactReviewProposal {
  if (!isRecord(value) || !isRecord(value.artifact) || !Array.isArray(value.pages) || !Array.isArray(value.annotations)) {
    throw new Error('Artifact Review 过程包缺少必要的工件、页面或批注。')
  }
  const artifact = value.artifact
  if (typeof artifact.artifact_id !== 'string' || typeof artifact.source_sha256 !== 'string' || typeof artifact.page_count !== 'number' || artifact.read_only !== true) {
    throw new Error('Artifact Review 工件身份不完整或不是只读来源。')
  }

  const pageNumberById = new Map<string, number>()
  for (const page of value.pages) {
    if (isRecord(page) && typeof page.page_id === 'string' && typeof page.page_number === 'number') pageNumberById.set(page.page_id, page.page_number)
  }
  const voiceById = new Map<string, { text: string; startMs: number; endMs: number }>()
  for (const segment of Array.isArray(value.voice_segments) ? value.voice_segments : []) {
    if (isRecord(segment) && typeof segment.segment_id === 'string' && typeof segment.text === 'string' && typeof segment.start_ms === 'number' && typeof segment.end_ms === 'number') {
      voiceById.set(segment.segment_id, { text: segment.text, startMs: segment.start_ms, endMs: segment.end_ms })
    }
  }

  const resolutions = (Array.isArray(value.reference_resolutions) ? value.reference_resolutions : []).filter(isRecord)
  const uniqueVoiceIdsByAnnotation = new Map<string, string[]>()
  const unresolvedReferences: ArtifactReviewProposal['unresolved_references'] = []
  for (const resolution of resolutions) {
    const voiceSegmentId = resolution.voice_segment_id
    const pageNumber = resolution.page_number
    if (typeof voiceSegmentId !== 'string' || typeof pageNumber !== 'number') continue
    if (resolution.status === 'unique_evidence' && typeof resolution.annotation_id === 'string') {
      uniqueVoiceIdsByAnnotation.set(resolution.annotation_id, [...(uniqueVoiceIdsByAnnotation.get(resolution.annotation_id) ?? []), voiceSegmentId])
    }
    if (resolution.status === 'clarification_required') {
      unresolvedReferences.push({
        voice_segment_id: voiceSegmentId,
        page_number: pageNumber,
        transcript: voiceById.get(voiceSegmentId)?.text ?? '',
        evidence_ids: asStringArray(resolution.evidence_ids),
        required_action: 'clarify_target',
      })
    }
  }

  const proposalItems: ArtifactReviewProposal['proposal_items'] = []
  for (const annotation of value.annotations) {
    if (!isRecord(annotation) || typeof annotation.annotation_id !== 'string' || typeof annotation.page_id !== 'string' || !isRecord(annotation.region)) continue
    const pageNumber = pageNumberById.get(annotation.page_id)
    if (pageNumber === undefined) continue
    const voiceIds = [...new Set([
      ...asStringArray(isRecord(annotation.voice_window) ? annotation.voice_window.transcript_segment_ids : undefined),
      ...(uniqueVoiceIdsByAnnotation.get(annotation.annotation_id) ?? []),
    ])]
    const state: ProposalState = annotation.binding_status === 'confirmed'
      ? 'user_confirmed_target'
      : voiceIds.length > 0 ? 'evidence_bound_candidate' : 'evidence_only'
    proposalItems.push({
      annotation_id: annotation.annotation_id,
      page_number: pageNumber,
      region: annotation.region,
      state,
      voice_evidence: voiceIds.flatMap((segmentId) => {
        const segment = voiceById.get(segmentId)
        return segment ? [{ segment_id: segmentId, text: segment.text, start_ms: segment.startMs, end_ms: segment.endMs }] : []
      }),
      evidence_ids: asStringArray(annotation.evidence_ids),
    })
  }

  return {
    schema_version: 'artifact-review-proposal/0.1-draft',
    artifact: { artifact_id: artifact.artifact_id, source_sha256: artifact.source_sha256, page_count: artifact.page_count, read_only: true },
    execution_authorized: false,
    proposal_items: proposalItems.sort((left, right) => left.page_number - right.page_number || left.annotation_id.localeCompare(right.annotation_id)),
    unresolved_references: unresolvedReferences,
  }
}
