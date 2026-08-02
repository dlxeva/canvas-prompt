import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { handlePptxReviewRender } from '../pptx-review-endpoint'
import type { PptxReviewConversion } from '../pptx-review-converter'

const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

async function withEndpoint(
  options: Parameters<typeof handlePptxReviewRender>[2],
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer((req, res) => handlePptxReviewRender(req, res, options))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function successfulConversion(source: Uint8Array): PptxReviewConversion {
  const pdfBytes = Buffer.from(`%PDF-1.4\n${source.at(-1)}\n%%EOF\n`)
  return {
    pdfBytes,
    sourceSha256: sha256(source),
    renderSha256: sha256(pdfBytes),
    renderer: { name: 'LibreOffice', version: 'test-renderer' },
  }
}

describe('PPTX review HTTP endpoint', () => {
  it('rejects wrong methods, origins and media types with stable statuses', async () => {
    await withEndpoint({}, async (baseUrl) => {
      const method = await fetch(baseUrl)
      expect(method.status).toBe(405)
      expect(method.headers.get('allow')).toBe('POST')

      const origin = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': PPTX_MIME_TYPE, origin: 'https://outside.example' },
        body: 'PK',
      })
      expect(origin.status).toBe(403)

      const mediaType = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'PK',
      })
      expect(mediaType.status).toBe(415)
    })
  })

  it('returns 413 without invoking conversion or breaking the response', async () => {
    const convert = vi.fn(async (source: Uint8Array) => successfulConversion(source))
    await withEndpoint({ maxBytes: 4, convert }, async (baseUrl) => {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': PPTX_MIME_TYPE },
        body: '12345',
      })
      expect(response.status).toBe(413)
      await expect(response.text()).resolves.toContain('PPTX 文件超过')
      expect(convert).not.toHaveBeenCalled()
    })
  })

  it('maps renderer failures to a no-store 422 JSON response', async () => {
    const convert = vi.fn(async () => {
      throw new Error('PPTX 本地渲染器不可用。')
    })
    await withEndpoint({ convert }, async (baseUrl) => {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': PPTX_MIME_TYPE },
        body: 'PK\u0003\u0004',
      })
      expect(response.status).toBe(422)
      expect(response.headers.get('cache-control')).toBe('no-store')
      await expect(response.json()).resolves.toEqual({ ok: false, error: 'PPTX 本地渲染器不可用。' })
    })
  })

  it('returns verified identity headers and keeps concurrent requests isolated', async () => {
    const convert = vi.fn(async (source: Uint8Array) => {
      await new Promise((resolve) => setTimeout(resolve, source.at(-1) === 0x41 ? 15 : 1))
      return successfulConversion(source)
    })
    await withEndpoint({ convert }, async (baseUrl) => {
      const request = (suffix: number) => fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': PPTX_MIME_TYPE },
        body: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, suffix]),
      })
      const [responseA, responseB] = await Promise.all([request(0x41), request(0x42)])
      const [pdfA, pdfB] = await Promise.all([responseA.arrayBuffer(), responseB.arrayBuffer()])

      expect(responseA.status).toBe(200)
      expect(responseB.status).toBe(200)
      expect(responseA.headers.get('content-type')).toBe('application/pdf')
      expect(responseA.headers.get('x-canvas-prompt-source-sha256')).not.toBe(responseB.headers.get('x-canvas-prompt-source-sha256'))
      expect(responseA.headers.get('x-canvas-prompt-render-sha256')).toBe(sha256(new Uint8Array(pdfA)))
      expect(responseB.headers.get('x-canvas-prompt-render-sha256')).toBe(sha256(new Uint8Array(pdfB)))
      expect(new TextDecoder().decode(pdfA)).toContain('65')
      expect(new TextDecoder().decode(pdfB)).toContain('66')
    })
  })
})
