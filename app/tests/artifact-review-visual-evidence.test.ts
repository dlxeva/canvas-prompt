import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prepareVisualEvidenceManifest, visualEvidenceLimits } from '../src/artifact-review-visual-evidence'

function png(width: number, height: number, padding = 0) {
  const bytes = new Uint8Array(24 + padding)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

const input = { package_id: 'arp_visual_001', pages: [{ page_id: 'page_one' }, { page_id: 'page_two' }] }

describe('artifact review visual evidence manifest', () => {
  it('creates opaque, page-bound manifests without exposing input bytes', async () => {
    const bytes = png(1200, 800)
    const manifest = await prepareVisualEvidenceManifest({ ...input, candidates: [{ page_id: 'page_one', media_type: 'image/png', bytes }] })
    expect(manifest).toMatchObject({ package_id: input.package_id, total_byte_length: bytes.byteLength, pages: [{ page_id: 'page_one', media_type: 'image/png', width: 1200, height: 800, byte_length: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }] })
    expect(manifest.pages[0].render_ref).toMatch(/^vre_[a-f0-9]{36}$/)
    expect(JSON.stringify(manifest)).not.toContain('iVBOR')
    expect(JSON.stringify(manifest)).not.toContain('bytes')
  })

  it.each([
    ['unknown page', { ...input, candidates: [{ page_id: 'page_missing', media_type: 'image/png', bytes: png(1, 1) }] }],
    ['wrong media type', { ...input, candidates: [{ page_id: 'page_one', media_type: 'image/jpeg', bytes: png(1, 1) }] }],
    ['long edge', { ...input, candidates: [{ page_id: 'page_one', media_type: 'image/png', bytes: png(visualEvidenceLimits.max_edge + 1, 1) }] }],
    ['invalid png', { ...input, candidates: [{ page_id: 'page_one', media_type: 'image/png', bytes: new Uint8Array([1, 2, 3]) }] }],
  ])('rejects %s before staging', async (_label, candidate) => {
    await expect(prepareVisualEvidenceManifest(candidate)).rejects.toThrow()
  })

  it('rejects oversized pages and cumulative rounds', async () => {
    await expect(prepareVisualEvidenceManifest({ ...input, candidates: [{ page_id: 'page_one', media_type: 'image/png', bytes: png(1, 1, visualEvidenceLimits.max_page_bytes) }] })).rejects.toThrow('4MiB')
    const oversizedRound = Array.from({ length: 9 }, (_, index) => ({ page_id: `page_${index}`, media_type: 'image/png', bytes: png(1, 1, 4 * 1024 * 1024 - 24) }))
    await expect(prepareVisualEvidenceManifest({ package_id: 'arp_visual_002', pages: oversizedRound.map(({ page_id }) => ({ page_id })), candidates: oversizedRound })).rejects.toThrow('32MiB')
  })
})
