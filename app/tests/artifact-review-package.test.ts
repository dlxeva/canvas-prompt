import Ajv2020 from 'ajv/dist/2020.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildArtifactReviewPackage } from '../src/artifact-review-package'

const artifactReviewSchema = JSON.parse(readFileSync(new URL('../../spec/artifact-review-package-v0.2.schema.json', import.meta.url), 'utf8'))

describe('Artifact Review process package', () => {
  it('exports page-normalized manual marks without source bytes or execution authority', () => {
    const sourceHash = 'a'.repeat(64)
    const result = buildArtifactReviewPackage({
      sourceHash,
      createdAt: new Date('2026-07-30T00:00:00.000Z'),
      pages: [{ pageNumber: 1, width: 595, height: 842, rotationDegrees: 0 }],
      marksByPage: {
        1: [{
          id: 'ann_mark_001', kind: 'ink', pageNumber: 1, createdAtMs: 1_240,
          points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }],
        }],
      },
    })

    expect(result.artifact).toEqual(expect.objectContaining({ source_sha256: sourceHash, read_only: true, page_count: 1 }))
    expect(result.annotations).toEqual([expect.objectContaining({
      page_id: 'page_aaaaaaaaaaaaaaaa_1',
      kind: 'ink',
      binding_status: 'clarification_required',
      gesture_points: [{ x_ratio: 0.2, y_ratio: 0.3 }, { x_ratio: 0.4, y_ratio: 0.5 }],
      region: { coordinate_space: 'page_normalized_v1', x_ratio: 0.2, y_ratio: 0.3, width_ratio: 0.2, height_ratio: 0.2 },
    })])
    expect(result).toEqual(expect.objectContaining({
      privacy: expect.objectContaining({ source_bytes_in_export: false }),
      review_state: { interpretation_status: 'clarification_required', execution_authorized: false },
    }))

    const validate = new Ajv2020({ strict: false }).compile(artifactReviewSchema)
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true)
  })

  it('preserves an original PPTX as the authoritative read-only review artifact', () => {
    const sourceHash = '9'.repeat(64)
    const result = buildArtifactReviewPackage({
      sourceHash,
      artifactKind: 'pptx',
      renderDerivative: {
        sha256: '8'.repeat(64),
        pageCount: 2,
        rendererName: 'LibreOffice',
        rendererVersion: '26.8.0.0.alpha0',
      },
      createdAt: new Date('2026-07-31T00:00:00.000Z'),
      pages: [
        { pageNumber: 1, width: 960, height: 540, rotationDegrees: 0 },
        { pageNumber: 2, width: 960, height: 540, rotationDegrees: 0 },
      ],
      marksByPage: {
        2: [{
          id: 'ann_pptx_page_002',
          kind: 'arrow',
          pageNumber: 2,
          createdAtMs: 2_500,
          points: [{ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.4 }],
        }],
      },
    })

    expect(result.artifact).toEqual({
      artifact_id: 'art_9999999999999999',
      artifact_kind: 'pptx',
      source_version_id: `sha256:${sourceHash}`,
      source_sha256: sourceHash,
      page_count: 2,
      read_only: true,
      render_derivative: {
        artifact_kind: 'pdf_derivative',
        source_sha256: '8'.repeat(64),
        page_count: 2,
        renderer: { name: 'LibreOffice', version: '26.8.0.0.alpha0' },
      },
    })
    expect(result.annotations[0]).toEqual(expect.objectContaining({
      page_id: 'page_9999999999999999_2',
      kind: 'arrow',
    }))
    expect(JSON.stringify(result)).not.toContain('pptx_bytes')

    const validate = new Ajv2020({ strict: false }).compile(artifactReviewSchema)
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true)
  })

  it('rejects a PPTX render derivative whose page count drifts from the review pages', () => {
    expect(() => buildArtifactReviewPackage({
      sourceHash: '7'.repeat(64),
      artifactKind: 'pptx',
      renderDerivative: {
        sha256: '6'.repeat(64),
        pageCount: 9,
        rendererName: 'test-renderer',
      },
      pages: [{ pageNumber: 1, width: 960, height: 540, rotationDegrees: 0 }],
      marksByPage: {},
    })).toThrow('PPTX 渲染页数必须与批阅页面数量一致。')
  })

  it('keeps a user-confirmed voice-to-mark binding explicit and exports no audio bytes', () => {
    const result = buildArtifactReviewPackage({
      sourceHash: 'b'.repeat(64),
      createdAt: new Date('2026-07-30T00:00:00.000Z'),
      pages: [{ pageNumber: 1, width: 595, height: 842, rotationDegrees: 0 }],
      marksByPage: {
        1: [{
          id: 'ann_mark_002', kind: 'circle', pageNumber: 1, createdAtMs: 2_000,
          points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }],
          voiceWindow: { startMs: 2_100, endMs: 3_000, transcriptSegmentIds: ['voice_001'] },
          bindingStatus: 'confirmed',
        }],
      },
      voiceSegments: [{ segmentId: 'voice_001', startMs: 2_100, endMs: 3_000, text: '这个地方要改', confidence: 0.9 }],
    })

    expect(result.review_state).toEqual({ interpretation_status: 'user_confirmed', execution_authorized: false })
    expect(result.annotations[0]).toEqual(expect.objectContaining({ binding_status: 'confirmed', evidence_ids: expect.arrayContaining(['ev_voice_001']) }))
    expect(result.voice_segments).toEqual([{ segment_id: 'voice_001', start_ms: 2_100, end_ms: 3_000, text: '这个地方要改', confidence: 0.9 }])
    expect(JSON.stringify(result)).not.toContain('audio/webm')

    const validate = new Ajv2020({ strict: false }).compile(artifactReviewSchema)
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true)
  })

  it('keeps the whole package in clarification when any other mark is unresolved', () => {
    const result = buildArtifactReviewPackage({
      sourceHash: 'c'.repeat(64),
      pages: [{ pageNumber: 1, width: 595, height: 842, rotationDegrees: 0 }],
      marksByPage: { 1: [
        { id: 'ann_confirmed', kind: 'circle', pageNumber: 1, createdAtMs: 1, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], bindingStatus: 'confirmed' },
        { id: 'ann_unresolved', kind: 'ink', pageNumber: 1, createdAtMs: 2, points: [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }] },
      ] },
    })

    expect(result.review_state).toEqual({ interpretation_status: 'clarification_required', execution_authorized: false })
  })

  it('exports page visits and a unique-evidence reference without treating it as confirmation', () => {
    const result = buildArtifactReviewPackage({
      sourceHash: 'd'.repeat(64),
      pages: [{ pageNumber: 1, width: 595, height: 842, rotationDegrees: 0 }],
      pageVisits: [{ pageNumber: 1, atMs: 0 }],
      marksByPage: { 1: [{ id: 'ann_target', kind: 'circle', pageNumber: 1, createdAtMs: 4_000, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }] },
      voiceSegments: [{ segmentId: 'voice_target', startMs: 4_500, endMs: 5_000, text: '这个地方需要调整' }],
    })

    expect(result.page_visits).toEqual([{ page_number: 1, at_ms: 0 }])
    expect(result.reference_resolutions).toEqual([expect.objectContaining({
      status: 'unique_evidence', annotation_id: 'ann_target', voice_segment_id: 'voice_target',
    })])
    expect(result.annotations[0]).toEqual(expect.objectContaining({ binding_status: 'candidate', voice_window: expect.any(Object) }))
    expect(result.review_state).toEqual({ interpretation_status: 'clarification_required', execution_authorized: false })

    const validate = new Ajv2020({ strict: false }).compile(artifactReviewSchema)
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true)
  })

  it('turns an ambiguous target into confirmation only after an explicit spatial response', () => {
    const result = buildArtifactReviewPackage({
      sourceHash: 'f'.repeat(64),
      pages: [{ pageNumber: 2, width: 595, height: 842, rotationDegrees: 0 }],
      pageVisits: [{ pageNumber: 2, atMs: 0 }],
      marksByPage: { 2: [
        { id: 'ann_chosen', kind: 'circle', pageNumber: 2, createdAtMs: 4_000, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], bindingStatus: 'confirmed', confirmedAtMs: 8_000, voiceWindow: { startMs: 4_500, endMs: 5_000, transcriptSegmentIds: ['voice_ambiguous'] } },
        { id: 'ann_other', kind: 'circle', pageNumber: 2, createdAtMs: 4_100, points: [{ x: 0.4, y: 0.4 }, { x: 0.5, y: 0.5 }] },
      ] },
      voiceSegments: [{ segmentId: 'voice_ambiguous', startMs: 4_500, endMs: 5_000, text: '这个地方需要调整' }],
    })

    expect(result.reference_resolutions).toEqual([expect.objectContaining({
      voice_segment_id: 'voice_ambiguous', status: 'unique_evidence', annotation_id: 'ann_chosen', evidence_ids: expect.arrayContaining(['ev_confirm_chosen']),
    })])
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({
      evidence_id: 'ev_confirm_chosen', kind: 'clarification_response', assertion_level: 'explicit_user_assertion', annotation_id: 'ann_chosen',
    })]))
    expect(result.review_state).toEqual({ interpretation_status: 'clarification_required', execution_authorized: false })
  })

  it('schema rejects a clarification record that smuggles in an annotation target', () => {
    const validate = new Ajv2020({ strict: false }).compile(artifactReviewSchema)
    expect(validate({
      schema_version: 'artifact-review/0.2-draft',
      package_id: 'arp_test',
      artifact: { artifact_id: 'art_test', artifact_kind: 'pdf', source_version_id: 'sha256:' + 'e'.repeat(64), source_sha256: 'e'.repeat(64), page_count: 1, read_only: true },
      pages: [{ page_id: 'page_test', page_number: 1, render_box: { width: 1, height: 1, unit: 'pdf_point' }, rotation_degrees: 0 }],
      annotations: [], evidence: [], privacy: { processing: 'local_only', source_bytes_in_export: false, retention: 'session_only' },
      review_state: { interpretation_status: 'clarification_required', execution_authorized: false },
      reference_resolutions: [{ resolution_id: 'ref_test', voice_segment_id: 'voice_test', page_number: 1, status: 'clarification_required', annotation_id: 'ann_should_not_exist', evidence_ids: ['ev_test'] }],
    })).toBe(false)
  })

  it('schema rejects a render derivative as the original or nested under a PDF', () => {
    const validate = new Ajv2020({ strict: false }).compile(artifactReviewSchema)
    const base = buildArtifactReviewPackage({
      sourceHash: '1'.repeat(64),
      pages: [{ pageNumber: 1, width: 595, height: 842, rotationDegrees: 0 }],
      marksByPage: {},
    })
    expect(validate({
      ...base,
      artifact: { ...base.artifact, artifact_kind: 'pdf_derivative' },
    })).toBe(false)
    expect(validate({
      ...base,
      artifact: {
        ...base.artifact,
        render_derivative: {
          artifact_kind: 'pdf_derivative',
          source_sha256: '2'.repeat(64),
          page_count: 1,
          renderer: { name: 'test' },
        },
      },
    })).toBe(false)
  })
})
