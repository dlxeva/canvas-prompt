/**
 * Boundary primitives for local, page-level visual evidence.
 *
 * This module intentionally has no transport or filesystem API.  A later
 * local-only route may stage bytes and write the resulting manifest only after
 * it has loaded and validated the immutable Artifact Review package.  Keeping
 * that binding outside this pure module avoids a partially-bound upload route.
 */

const MAX_EDGE = 1600
const MAX_PAGE_BYTES = 4 * 1024 * 1024
const MAX_ROUND_BYTES = 32 * 1024 * 1024

export type ArtifactReviewVisualPage = { page_id: string }

export type VisualEvidenceManifestEntry = {
  page_id: string
  render_ref: string
  media_type: 'image/png'
  width: number
  height: number
  byte_length: number
  sha256: string
}

export type VisualEvidenceManifest = {
  schema_version: 'artifact-review-visual-evidence/0.1-draft'
  package_id: string
  total_byte_length: number
  pages: VisualEvidenceManifestEntry[]
}

export type VisualEvidenceCandidate = {
  page_id: string
  media_type: string
  bytes: Uint8Array
}

function fail(message: string): never {
  throw new Error(message)
}

function safePackageId(value: string) {
  return /^arp_[A-Za-z0-9_-]+$/.test(value)
}

function pngDimensions(bytes: Uint8Array) {
  // PNG signature + IHDR length/type + 32-bit width/height.
  if (bytes.byteLength < 24
    || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47
    || bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a
    || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13
    || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    fail('视觉证据必须是有效的 PNG。')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width < 1 || height < 1) fail('PNG 尺寸无效。')
  return { width, height }
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

async function sha256(bytes: Uint8Array) {
  if (!globalThis.crypto?.subtle) fail('当前运行环境无法计算视觉证据摘要。')
  // Copy into an ArrayBuffer-backed view: TypeScript permits Uint8Array views
  // over SharedArrayBuffer too, while WebCrypto deliberately does not.
  const digestInput = new Uint8Array(bytes)
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', digestInput)))
}

function opaqueRenderRef() {
  if (!globalThis.crypto?.getRandomValues) fail('当前运行环境无法生成视觉证据引用。')
  const entropy = new Uint8Array(18)
  globalThis.crypto.getRandomValues(entropy)
  return `vre_${hex(entropy)}`
}

/**
 * Validates bytes before any staging write and returns a manifest entry that
 * contains no caller filename, path, URL, or source bytes.
 */
export async function prepareVisualEvidenceManifest(input: {
  package_id: string
  pages: readonly ArtifactReviewVisualPage[]
  candidates: readonly VisualEvidenceCandidate[]
}): Promise<VisualEvidenceManifest> {
  if (!safePackageId(input.package_id)) fail('视觉证据需要合法的 package_id。')
  const validPageIds = new Set(input.pages.map((page) => page.page_id))
  if (validPageIds.size !== input.pages.length || [...validPageIds].some((pageId) => !/^page_[A-Za-z0-9_-]+$/.test(pageId))) {
    fail('视觉证据需要来自过程包的合法 page_id。')
  }
  const seen = new Set<string>()
  let total = 0
  const pages: VisualEvidenceManifestEntry[] = []
  for (const candidate of input.candidates) {
    if (!validPageIds.has(candidate.page_id) || seen.has(candidate.page_id)) fail('视觉证据 page_id 不在过程包中或重复。')
    if (candidate.media_type !== 'image/png') fail('视觉证据只接受 image/png。')
    if (candidate.bytes.byteLength === 0 || candidate.bytes.byteLength > MAX_PAGE_BYTES) fail('单页视觉证据必须大于 0 且不超过 4MiB。')
    const { width, height } = pngDimensions(candidate.bytes)
    if (Math.max(width, height) > MAX_EDGE) fail('视觉证据长边不得超过 1600 像素。')
    total += candidate.bytes.byteLength
    if (total > MAX_ROUND_BYTES) fail('整轮视觉证据不得超过 32MiB。')
    seen.add(candidate.page_id)
    pages.push({
      page_id: candidate.page_id,
      render_ref: opaqueRenderRef(),
      media_type: 'image/png',
      width,
      height,
      byte_length: candidate.bytes.byteLength,
      sha256: await sha256(candidate.bytes),
    })
  }
  return { schema_version: 'artifact-review-visual-evidence/0.1-draft', package_id: input.package_id, total_byte_length: total, pages }
}

export const visualEvidenceLimits = { max_edge: MAX_EDGE, max_page_bytes: MAX_PAGE_BYTES, max_round_bytes: MAX_ROUND_BYTES } as const
