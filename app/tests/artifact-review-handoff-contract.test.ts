import { describe, expect, it } from 'vitest'
import { isArtifactReviewHandoffPayload } from '../src/artifact-review-handoff-contract'

const sourceHash = 'a'.repeat(64)
const cleanPayload = {
  schema_version: 'artifact-review/0.2-draft', package_id: 'arp_clean_001', annotations: [],
  artifact: { artifact_kind: 'pdf', read_only: true, source_sha256: sourceHash, source_version_id: `sha256:${sourceHash}` },
  privacy: { processing: 'local_only', source_bytes_in_export: false },
}

describe('Artifact Review handoff boundary', () => {
  it('accepts a source-byte-free local PDF process package', () => {
    expect(isArtifactReviewHandoffPayload(cleanPayload)).toBe(true)
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
})
