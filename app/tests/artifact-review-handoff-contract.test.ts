import { describe, expect, it } from 'vitest'
import { isArtifactReviewHandoffPayload } from '../src/artifact-review-handoff-contract'
import { buildArtifactReviewPackage } from '../src/artifact-review-package'

const sourceHash = 'a'.repeat(64)
const cleanPayload = {
  schema_version: 'artifact-review/0.2-draft', package_id: 'arp_clean_001',
  artifact: { artifact_id: 'art_clean', artifact_kind: 'pdf', read_only: true, source_sha256: sourceHash, source_version_id: `sha256:${sourceHash}`, page_count: 1 },
  pages: [{ page_id: 'page_clean_1', page_number: 1 }], annotations: [], evidence: [],
  privacy: { processing: 'local_only', source_bytes_in_export: false, retention: 'session_only' },
  review_state: { interpretation_status: 'clarification_required', execution_authorized: false },
}

describe('Artifact Review handoff boundary', () => {
  it('accepts a source-byte-free local PDF process package', () => {
    expect(isArtifactReviewHandoffPayload(cleanPayload)).toBe(true)
  })

  it('accepts a generated package with confirmed voice and spatial evidence', () => {
    const generated = buildArtifactReviewPackage({
      sourceHash,
      pages: [{ pageNumber: 1, width: 595, height: 842, rotationDegrees: 0 }],
      pageVisits: [{ pageNumber: 1, atMs: 0 }],
      marksByPage: { 1: [{
        id: 'ann_generated', kind: 'circle', pageNumber: 1, createdAtMs: 1_000,
        points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
        bindingStatus: 'confirmed', confirmedAtMs: 2_000,
        voiceWindow: { startMs: 1_100, endMs: 1_500, transcriptSegmentIds: ['voice_generated'] },
      }] },
      voiceSegments: [{ segmentId: 'voice_generated', startMs: 1_100, endMs: 1_500, text: '这个地方要改' }],
      confirmationLedger: {
        schema_version: 'artifact-review-confirmation-ledger/0.1-draft',
        candidates: [{ candidateId: 'candidate_generated', pageNumber: 1, annotationId: 'ann_generated', transcriptSegmentIds: ['voice_generated'], text: '这个地方要改' }],
        actions: [{ actionId: 'action_confirm_generated', candidateId: 'candidate_generated', kind: 'confirm', atMs: 2_000 }],
      },
    })

    expect(isArtifactReviewHandoffPayload(generated)).toBe(false)
    expect(isArtifactReviewHandoffPayload(generated, {
      schema_version: 'artifact-review-confirmation-ledger/0.1-draft',
      candidates: [{ candidateId: 'candidate_generated', pageNumber: 1, annotationId: 'ann_generated', transcriptSegmentIds: ['voice_generated'], text: '这个地方要改' }],
      actions: [{ actionId: 'action_confirm_generated', candidateId: 'candidate_generated', kind: 'confirm', atMs: 2_000 }],
    })).toBe(true)
  })

  it('accepts a source-byte-free local PPTX process package', () => {
    expect(isArtifactReviewHandoffPayload({
      ...cleanPayload,
      artifact: {
        ...cleanPayload.artifact,
        artifact_kind: 'pptx',
        page_count: 2,
        render_derivative: {
          artifact_kind: 'pdf_derivative',
          source_sha256: 'b'.repeat(64),
          page_count: 2,
          renderer: { name: 'LibreOffice', version: 'test' },
        },
      },
      pages: [{ page_id: 'page_clean_1', page_number: 1 }, { page_id: 'page_clean_2', page_number: 2 }],
    })).toBe(true)
  })

  it('rejects a render derivative presented as the original review artifact', () => {
    expect(isArtifactReviewHandoffPayload({
      ...cleanPayload,
      artifact: { ...cleanPayload.artifact, artifact_kind: 'pdf_derivative' },
    })).toBe(false)
  })

  it.each([
    ['source bytes', { source_bytes: 'private' }],
    ['camel-case source bytes', { debug: { sourceBytes: 'private' } }],
    ['recording URL', { voice_segments: [{ recording_url: 'blob:private' }] }],
    ['camel-case recording URL', { voice_segments: [{ recordingUrl: 'blob:private' }] }],
    ['source location', { artifact: { ...cleanPayload.artifact, source_locator: '/Users/hu/private.pdf' } }],
    ['nested file path', { debug: { filePath: '/Users/hu/private.pdf' } }],
    ['malformed source hash', { artifact: { ...cleanPayload.artifact, source_sha256: 'not-a-sha256' } }],
    ['mismatched source version', { artifact: { ...cleanPayload.artifact, source_version_id: 'sha256:' + 'b'.repeat(64) } }],
  ])('rejects a package carrying %s', (_label, addition) => {
    expect(isArtifactReviewHandoffPayload({ ...cleanPayload, ...addition })).toBe(false)
  })

  it.each([
    ['a derivative under PDF', {
      ...cleanPayload.artifact,
      render_derivative: { artifact_kind: 'pdf_derivative', source_sha256: 'b'.repeat(64), page_count: 1, renderer: { name: 'test' } },
    }],
    ['the wrong derivative kind', {
      ...cleanPayload.artifact,
      artifact_kind: 'pptx',
      render_derivative: { artifact_kind: 'pdf', source_sha256: 'b'.repeat(64), page_count: 1, renderer: { name: 'test' } },
    }],
    ['a malformed derivative hash', {
      ...cleanPayload.artifact,
      artifact_kind: 'pptx',
      render_derivative: { artifact_kind: 'pdf_derivative', source_sha256: 'bad', page_count: 1, renderer: { name: 'test' } },
    }],
    ['a derivative page-count mismatch', {
      ...cleanPayload.artifact,
      artifact_kind: 'pptx',
      page_count: 2,
      render_derivative: { artifact_kind: 'pdf_derivative', source_sha256: 'b'.repeat(64), page_count: 1, renderer: { name: 'test' } },
    }],
  ])('rejects %s at the shared handoff boundary', (_label, artifact) => {
    expect(isArtifactReviewHandoffPayload({ ...cleanPayload, artifact })).toBe(false)
  })

  it.each([
    ['page-count drift', { ...cleanPayload, artifact: { ...cleanPayload.artifact, page_count: 2 } }],
    ['duplicate page number', { ...cleanPayload, artifact: { ...cleanPayload.artifact, page_count: 2 }, pages: [{ page_id: 'page_a', page_number: 1 }, { page_id: 'page_b', page_number: 1 }] }],
    ['unknown annotation page', { ...cleanPayload, annotations: [{ annotation_id: 'ann_bad_page', page_id: 'page_missing', region: { coordinate_space: 'page_normalized_v1', x_ratio: 0, y_ratio: 0, width_ratio: 0.2, height_ratio: 0.2 }, created_at_ms: 0, binding_status: 'candidate', evidence_ids: [] }] }],
    ['out-of-bounds region', { ...cleanPayload, annotations: [{ annotation_id: 'ann_bad_region', page_id: 'page_clean_1', region: { coordinate_space: 'page_normalized_v1', x_ratio: 0.9, y_ratio: 0, width_ratio: 0.2, height_ratio: 0.2 }, created_at_ms: 0, binding_status: 'candidate', evidence_ids: [] }] }],
    ['unknown evidence reference', { ...cleanPayload, annotations: [{ annotation_id: 'ann_bad_evidence', page_id: 'page_clean_1', region: { coordinate_space: 'page_normalized_v1', x_ratio: 0, y_ratio: 0, width_ratio: 0.2, height_ratio: 0.2 }, created_at_ms: 0, binding_status: 'candidate', evidence_ids: ['ev_missing'] }] }],
    ['unproven confirmation', { ...cleanPayload, annotations: [{ annotation_id: 'ann_unproven', page_id: 'page_clean_1', region: { coordinate_space: 'page_normalized_v1', x_ratio: 0, y_ratio: 0, width_ratio: 0.2, height_ratio: 0.2 }, created_at_ms: 0, binding_status: 'confirmed', evidence_ids: [] }], review_state: { interpretation_status: 'user_confirmed', execution_authorized: false } }],
  ])('rejects a semantic graph with %s', (_label, payload) => {
    expect(isArtifactReviewHandoffPayload(payload)).toBe(false)
  })
})
