import type { IncomingMessage, ServerResponse } from 'node:http'
import { convertPptxForReview, DEFAULT_MAX_PPTX_BYTES } from './pptx-review-converter'
import type { PptxReviewConversion } from './pptx-review-converter'

const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

type ConvertPptx = (sourceBytes: Uint8Array) => Promise<PptxReviewConversion>

type EndpointOptions = {
  maxBytes?: number
  convert?: ConvertPptx
}

function isLocalArtifactReviewRequest(req: IncomingMessage) {
  const host = String(req.headers.host ?? '').split(':')[0]
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '')
  if (fetchSite && fetchSite !== 'same-origin') return false
  const origin = String(req.headers.origin ?? '')
  if (!origin) return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost'
  } catch {
    return false
  }
}

function endText(res: ServerResponse, statusCode: number, message: string) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(message)
}

function endJsonError(res: ServerResponse, statusCode: number, error: string) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({ ok: false, error }))
}

/**
 * Local-only PPTX rendering boundary. It deliberately owns request limits and
 * response metadata so Vite wiring and HTTP contract tests use the same code.
 */
export function handlePptxReviewRender(
  req: IncomingMessage,
  res: ServerResponse,
  {
    maxBytes = DEFAULT_MAX_PPTX_BYTES,
    convert = convertPptxForReview,
  }: EndpointOptions = {},
) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    endText(res, 405, 'Method Not Allowed')
    return
  }
  if (!isLocalArtifactReviewRequest(req)) {
    endText(res, 403, 'Local same-origin request required')
    return
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== PPTX_MIME_TYPE) {
    endText(res, 415, 'PPTX content type required')
    return
  }

  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    endText(res, 413, `PPTX 文件超过 ${Math.round(maxBytes / 1024 / 1024) || 1}MB 限制。`)
    req.resume()
    return
  }

  const chunks: Buffer[] = []
  let total = 0
  let exceeded = false
  req.on('data', (chunk: Buffer) => {
    if (exceeded) return
    total += chunk.length
    if (total > maxBytes) {
      exceeded = true
      endText(res, 413, `PPTX 文件超过 ${Math.round(maxBytes / 1024 / 1024) || 1}MB 限制。`)
      return
    }
    chunks.push(chunk)
  })
  req.on('error', () => {
    if (!res.writableEnded) endText(res, exceeded ? 413 : 400, exceeded ? 'PPTX 文件超过限制。' : 'PPTX 上传中断。')
  })
  req.on('end', async () => {
    if (exceeded || res.writableEnded) return
    try {
      const converted = await convert(Buffer.concat(chunks))
      res.statusCode = 200
      res.setHeader('content-type', 'application/pdf')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-canvas-prompt-source-sha256', converted.sourceSha256)
      res.setHeader('x-canvas-prompt-render-sha256', converted.renderSha256)
      res.setHeader('x-canvas-prompt-renderer-name', converted.renderer.name)
      if (converted.renderer.version) res.setHeader('x-canvas-prompt-renderer-version', converted.renderer.version)
      res.end(converted.pdfBytes)
    } catch (error) {
      endJsonError(res, 422, error instanceof Error ? error.message : String(error))
    }
  })
}
