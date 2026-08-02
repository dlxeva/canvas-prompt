import Ajv2020 from 'ajv/dist/2020.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildArtifactReviewPackage } from '../src/artifact-review-package'
import { fixedArtifactReviewInput } from './fixtures/artifact-review-multipage-fixed-input'

const artifactReviewSchema = JSON.parse(readFileSync(new URL('../../spec/artifact-review-package-v0.2.schema.json', import.meta.url), 'utf8'))

describe('Artifact Review fixed multi-page trace', () => {
  it('exports page/region anchors and evidence without source PDF bytes', () => {
    const result = buildArtifactReviewPackage(fixedArtifactReviewInput)

    expect(result.pages.map((page) => page.page_number)).toEqual([1, 2])
    expect(result.page_visits).toEqual([
      { page_number: 1, at_ms: 0 },
      { page_number: 2, at_ms: 4_000 },
    ])
    expect(result.annotations[0]).toEqual(expect.objectContaining({
      annotation_id: 'ann_page_one', page_id: 'page_1111111111111111_1',
      region: { coordinate_space: 'page_normalized_v1', x_ratio: 0.12, y_ratio: 0.18, width_ratio: 0.2, height_ratio: 0.2 },
      binding_status: 'clarification_required',
    }))
    expect(result.annotations[1]).toEqual(expect.objectContaining({
      annotation_id: 'ann_page_two', page_id: 'page_1111111111111111_2',
      binding_status: 'candidate', evidence_ids: ['ev_page_two', 'ev_voice_page_two'],
    }))
    expect(result.annotations[1].region).toEqual(expect.objectContaining({
      coordinate_space: 'page_normalized_v1', x_ratio: 0.6, y_ratio: 0.25, height_ratio: 0.2,
    }))
    expect(result.annotations[1].region.width_ratio).toBeCloseTo(0.22)
    expect(result.reference_resolutions).toEqual([expect.objectContaining({
      voice_segment_id: 'voice_page_two', page_number: 2, status: 'unique_evidence', annotation_id: 'ann_page_two',
    })])
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence_id: 'ev_page_one', page_id: 'page_1111111111111111_1', annotation_id: 'ann_page_one' }),
      expect.objectContaining({ evidence_id: 'ev_page_two', page_id: 'page_1111111111111111_2', annotation_id: 'ann_page_two' }),
      expect.objectContaining({ evidence_id: 'ev_voice_page_two', kind: 'voice_segment', assertion_level: 'raw' }),
    ]))
    expect(JSON.stringify(result)).not.toContain('"source_bytes":')
    expect(result).toEqual(expect.objectContaining({
      privacy: expect.objectContaining({ source_bytes_in_export: false }),
      review_state: { interpretation_status: 'clarification_required', execution_authorized: false },
    }))

    const validate = new Ajv2020({ strict: false }).compile(artifactReviewSchema)
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true)
  })
})
