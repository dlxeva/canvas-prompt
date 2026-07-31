import type { ArtifactReviewKind } from './artifact-review-package'
import { protectedLocalApiFetch } from './protected-local-api'

const PDF_MIME_TYPE = 'application/pdf'
const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export type ArtifactReviewRenderDerivative = {
  sha256: string
  pageCount: number
  rendererName: string
  rendererVersion?: string
}

export type PreparedArtifactReviewSource = {
  artifactKind: ArtifactReviewKind
  sourceHash: string
  pdfBytes: ArrayBuffer
  renderDerivative?: Omit<ArtifactReviewRenderDerivative, 'pageCount'>
}

type PrepareSourceInput = {
  name: string
  mimeType: string
  bytes: ArrayBuffer
}

type RequestPptxRender = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function detectArtifactReviewKind(name: string, mimeType: string): ArtifactReviewKind {
  const normalizedName = name.toLowerCase()
  const normalizedMimeType = mimeType.toLowerCase()
  if (normalizedMimeType === PDF_MIME_TYPE || normalizedName.endsWith('.pdf')) return 'pdf'
  if (normalizedMimeType === PPTX_MIME_TYPE || normalizedName.endsWith('.pptx')) return 'pptx'
  throw new Error('请选择 PDF 或 PPTX 文件。')
}

async function sha256(bytes: ArrayBuffer) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function responseError(response: Response) {
  const fallback = `PPTX 本地转换失败（HTTP ${response.status}）。`
  const body = await response.text()
  if (!body) return fallback
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') return parsed.error
  } catch {
    // Plain-text endpoint errors are safe to surface.
  }
  return body
}

function requiredHeader(response: Response, name: string) {
  const value = response.headers.get(name)?.trim()
  if (!value) throw new Error(`PPTX 转换响应缺少 ${name}。`)
  return value
}

/**
 * Keeps the original artifact identity separate from the temporary PDF used
 * by PDF.js. Both endpoint-provided hashes are independently verified here.
 */
export async function prepareArtifactReviewSource(
  { name, mimeType, bytes }: PrepareSourceInput,
  requestPptxRender: RequestPptxRender = protectedLocalApiFetch,
): Promise<PreparedArtifactReviewSource> {
  const artifactKind = detectArtifactReviewKind(name, mimeType)
  const sourceHash = await sha256(bytes)
  if (artifactKind === 'pdf') return { artifactKind, sourceHash, pdfBytes: bytes }

  const response = await requestPptxRender('/api/artifact-review-pptx-render', {
    method: 'POST',
    headers: { 'content-type': PPTX_MIME_TYPE },
    body: bytes,
  })
  if (!response.ok) throw new Error(await responseError(response))

  const endpointSourceHash = requiredHeader(response, 'x-canvas-prompt-source-sha256')
  const endpointRenderHash = requiredHeader(response, 'x-canvas-prompt-render-sha256')
  const rendererName = requiredHeader(response, 'x-canvas-prompt-renderer-name')
  if (!SHA256_PATTERN.test(endpointSourceHash) || endpointSourceHash !== sourceHash) {
    throw new Error('PPTX 原文件哈希校验失败，已停止打开。')
  }

  const pdfBytes = await response.arrayBuffer()
  const renderHash = await sha256(pdfBytes)
  if (!SHA256_PATTERN.test(endpointRenderHash) || endpointRenderHash !== renderHash) {
    throw new Error('PPTX 渲染结果哈希校验失败，已停止打开。')
  }

  return {
    artifactKind,
    sourceHash,
    pdfBytes,
    renderDerivative: {
      sha256: renderHash,
      rendererName,
      ...(response.headers.get('x-canvas-prompt-renderer-version')?.trim()
        ? { rendererVersion: response.headers.get('x-canvas-prompt-renderer-version')!.trim() }
        : {}),
    },
  }
}
