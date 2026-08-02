import {
  replaySerializedReviewConfirmationLedger,
  type SerializedReviewConfirmationLedger,
} from './artifact-review-confirmation-ledger'

type UnknownRecord = Record<string, unknown>

type ProposalState = 'user_confirmed_target' | 'evidence_bound_candidate' | 'evidence_only'

export type ArtifactReviewProposal = {
  schema_version: 'artifact-review-proposal/0.1-draft'
  artifact: { artifact_id: string; source_sha256: string; page_count: number; read_only: true }
  execution_authorized: false
  execution_gate: {
    status: 'awaiting_user_confirmation'
    confirmation_required: true
    confirmation_channel: 'conversation'
    user_visible_internal_ids: false
    required_summary_sections: ['overall_goal', 'global_changes', 'page_changes', 'preserve', 'uncertainties', 'output']
    scope_change_requires_reconfirmation: true
  }
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
export function compileArtifactReviewProposal(value: unknown, confirmationLedger?: SerializedReviewConfirmationLedger): ArtifactReviewProposal {
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
  const pageNumberByAnnotationId = new Map<string, number>()
  for (const annotation of value.annotations) {
    if (!isRecord(annotation) || typeof annotation.annotation_id !== 'string' || typeof annotation.page_id !== 'string') continue
    const pageNumber = pageNumberById.get(annotation.page_id)
    if (pageNumber !== undefined) pageNumberByAnnotationId.set(annotation.annotation_id, pageNumber)
  }
  const voiceById = new Map<string, { text: string; startMs: number; endMs: number }>()
  for (const segment of Array.isArray(value.voice_segments) ? value.voice_segments : []) {
    if (isRecord(segment) && typeof segment.segment_id === 'string' && typeof segment.text === 'string' && typeof segment.start_ms === 'number' && typeof segment.end_ms === 'number') {
      voiceById.set(segment.segment_id, { text: segment.text, startMs: segment.start_ms, endMs: segment.end_ms })
    }
  }

  const resolutions = (Array.isArray(value.reference_resolutions) ? value.reference_resolutions : []).filter(isRecord)
  const evidence = (Array.isArray(value.evidence) ? value.evidence : []).filter(isRecord)
  const confirmationActionByAnnotationId = new Map<string, { candidateId: string; atMs: number }>()
  if (confirmationLedger) {
    const replay = replaySerializedReviewConfirmationLedger(confirmationLedger)
    const actionById = new Map(replay.effectiveActions.map((action) => [action.actionId, action]))
    for (const candidate of Object.values(replay.candidates)) {
      if (candidate.status !== 'confirmed' || !candidate.annotationId || !candidate.lastActionId) continue
      const action = actionById.get(candidate.lastActionId)
      if (
        action?.kind === 'confirm'
        && action.candidateId === candidate.candidateId
        && candidate.pageNumber === pageNumberByAnnotationId.get(candidate.annotationId)
        && candidate.transcriptSegmentIds.every((segmentId) => voiceById.has(segmentId))
      ) {
        confirmationActionByAnnotationId.set(candidate.annotationId, { candidateId: candidate.candidateId, atMs: action.atMs })
      }
    }
  }
  const uniqueVoiceIdsByAnnotation = new Map<string, string[]>()
  const unresolvedReferences: ArtifactReviewProposal['unresolved_references'] = []
  for (const resolution of resolutions) {
    const voiceSegmentId = resolution.voice_segment_id
    const pageNumber = resolution.page_number
    if (typeof voiceSegmentId !== 'string' || typeof pageNumber !== 'number') continue
    if (resolution.status === 'unique_evidence' && typeof resolution.annotation_id === 'string') {
      const annotationPageNumber = pageNumberByAnnotationId.get(resolution.annotation_id)
      if (annotationPageNumber === undefined || annotationPageNumber !== pageNumber) {
        throw new Error(`Artifact Review 指代 ${voiceSegmentId} 的页码与批注不一致。`)
      }
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
    const annotationEvidenceIds = new Set(asStringArray(annotation.evidence_ids))
    const expectedConfirmationEvidenceId = `ev_confirm_${annotation.annotation_id.slice('ann_'.length)}`
    const confirmation = confirmationActionByAnnotationId.get(annotation.annotation_id)
    const hasExplicitConfirmation = confirmation !== undefined && evidence.some((item) => (
      item.kind === 'clarification_response'
      && item.annotation_id === annotation.annotation_id
      && item.assertion_level === 'explicit_user_assertion'
      && item.evidence_id === expectedConfirmationEvidenceId
      && annotationEvidenceIds.has(expectedConfirmationEvidenceId)
      && isRecord(item.time_window_ms)
      && Number.isFinite(item.time_window_ms.start_ms)
      && item.time_window_ms.start_ms === confirmation.atMs
      && item.time_window_ms.end_ms === confirmation.atMs
    ))
    if (annotation.binding_status === 'confirmed' && !hasExplicitConfirmation) {
      throw new Error(`Artifact Review 批注 ${annotation.annotation_id} 缺少显式确认凭据。`)
    }
    const state: ProposalState = annotation.binding_status === 'confirmed' && hasExplicitConfirmation
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
    execution_gate: {
      status: 'awaiting_user_confirmation',
      confirmation_required: true,
      confirmation_channel: 'conversation',
      user_visible_internal_ids: false,
      required_summary_sections: ['overall_goal', 'global_changes', 'page_changes', 'preserve', 'uncertainties', 'output'],
      scope_change_requires_reconfirmation: true,
    },
    proposal_items: proposalItems.sort((left, right) => left.page_number - right.page_number || left.annotation_id.localeCompare(right.annotation_id)),
    unresolved_references: unresolvedReferences,
  }
}
