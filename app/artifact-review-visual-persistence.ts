import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { prepareVisualEvidenceManifest, visualEvidenceLimits, type VisualEvidenceManifest } from './src/artifact-review-visual-evidence'

type UnknownRecord = Record<string, unknown>

const maxRequestBytes = Math.ceil(visualEvidenceLimits.max_round_bytes * 4 / 3) + 1024 * 1024

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safePackageId(value: unknown): value is string {
  return typeof value === 'string' && /^arp_[A-Za-z0-9_-]+$/.test(value)
}

function decodeBase64(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('视觉证据需要规范的 base64 数据。')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('视觉证据需要规范的 base64 数据。')
  return new Uint8Array(bytes)
}

function sameManifest(left: VisualEvidenceManifest, right: VisualEvidenceManifest) {
  if (left.package_id !== right.package_id || left.total_byte_length !== right.total_byte_length || left.pages.length !== right.pages.length) return false
  return left.pages.every((page, index) => {
    const other = right.pages[index]
    return other !== undefined
      && page.page_id === other.page_id
      && page.media_type === other.media_type
      && page.width === other.width
      && page.height === other.height
      && page.byte_length === other.byte_length
      && page.sha256 === other.sha256
  })
}

async function persistVisualEvidence(storageDir: string, value: unknown) {
  if (!isRecord(value) || !safePackageId(value.package_id) || !Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error('视觉证据请求缺少合法的 package_id 或页面。')
  }
  const packageId = value.package_id
  const roundPath = resolve(storageDir, 'artifact-review-rounds', packageId)
  const packagePath = resolve(roundPath, 'artifact-review-package.json')
  const packageValue: unknown = JSON.parse(await readFile(packagePath, 'utf8'))
  if (!isRecord(packageValue) || packageValue.package_id !== packageId || !Array.isArray(packageValue.pages)) {
    throw new Error('视觉证据无法绑定到对应的不可变过程包。')
  }
  const packagePages = packageValue.pages.flatMap((page) => (
    isRecord(page) && typeof page.page_id === 'string' ? [{ page_id: page.page_id }] : []
  ))
  if (packagePages.length !== packageValue.pages.length) throw new Error('不可变过程包的页面身份无效。')

  const candidates = value.pages.map((page) => {
    if (!isRecord(page) || typeof page.page_id !== 'string' || page.media_type !== 'image/png') {
      throw new Error('视觉证据页面格式无效。')
    }
    return { page_id: page.page_id, media_type: page.media_type, bytes: decodeBase64(page.data_base64) }
  })
  const manifest = await prepareVisualEvidenceManifest({ package_id: packageId, pages: packagePages, candidates })
  const destination = resolve(roundPath, 'visual-evidence')
  const existingManifestPath = resolve(destination, 'manifest.json')
  try {
    const existing = JSON.parse(await readFile(existingManifestPath, 'utf8')) as VisualEvidenceManifest
    if (sameManifest(existing, manifest)) return { manifest: existing, visualEvidencePath: destination, reused: true }
    throw new Error('该轮已存在不同的视觉证据，不能覆盖。')
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
    if (!missing) throw error
  }

  const staging = resolve(roundPath, `.visual-evidence.${randomUUID()}.tmp`)
  try {
    await mkdir(staging)
    for (let index = 0; index < manifest.pages.length; index += 1) {
      const entry = manifest.pages[index]
      await writeFile(resolve(staging, `${entry.render_ref}.png`), candidates[index].bytes)
    }
    await writeFile(resolve(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rename(staging, destination)
    return { manifest, visualEvidencePath: destination, reused: false }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export function handleArtifactReviewVisualEvidence(req: IncomingMessage, res: ServerResponse, storageDir: string) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return }
  let body = ''
  let tooLarge = false
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    if (tooLarge) return
    body += chunk
    if (Buffer.byteLength(body, 'utf8') > maxRequestBytes) {
      tooLarge = true
      body = ''
      res.statusCode = 413
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: '视觉证据请求超过本地 32MiB 轮次限制。' }))
    }
  })
  req.on('end', async () => {
    if (tooLarge) return
    try {
      const result = await persistVisualEvidence(storageDir, JSON.parse(body))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (error) {
      const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      res.statusCode = missing ? 404 : 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: missing ? '找不到对应的不可变交互审阅过程包。' : (error instanceof Error ? error.message : String(error)) }))
    }
  })
}

