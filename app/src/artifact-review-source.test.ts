import { describe, expect, it, vi } from 'vitest'
import { detectArtifactReviewKind, prepareArtifactReviewSource } from './artifact-review-source'

function bytes(value: string) {
  return new TextEncoder().encode(value).buffer
}

async function hash(value: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('artifact review source preparation', () => {
  it('opens PDF bytes directly without calling the PPTX renderer', async () => {
    const source = bytes('%PDF-1.4\n%%EOF\n')
    const request = vi.fn()

    const prepared = await prepareArtifactReviewSource(
      { name: 'review.pdf', mimeType: 'application/pdf', bytes: source },
      request,
    )

    expect(prepared).toEqual({
      artifactKind: 'pdf',
      sourceHash: await hash(source),
      pdfBytes: source,
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('converts PPTX and preserves the original and derivative identities separately', async () => {
    const source = bytes('PK\u0003\u0004pptx')
    const rendered = bytes('%PDF-1.4\nconverted\n%%EOF\n')
    const sourceHash = await hash(source)
    const renderHash = await hash(rendered)
    const request = vi.fn(async () => new Response(rendered, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'x-canvas-prompt-source-sha256': sourceHash,
        'x-canvas-prompt-render-sha256': renderHash,
        'x-canvas-prompt-renderer-name': 'LibreOffice',
        'x-canvas-prompt-renderer-version': 'test-version',
      },
    }))

    const prepared = await prepareArtifactReviewSource(
      { name: 'review.pptx', mimeType: '', bytes: source },
      request,
    )

    expect(prepared).toEqual({
      artifactKind: 'pptx',
      sourceHash,
      pdfBytes: rendered,
      renderDerivative: {
        sha256: renderHash,
        rendererName: 'LibreOffice',
        rendererVersion: 'test-version',
      },
    })
    expect(request).toHaveBeenCalledWith('/api/artifact-review-pptx-render', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      body: source,
    }))
  })

  it('rejects unsupported files and any endpoint hash mismatch', async () => {
    expect(() => detectArtifactReviewKind('notes.txt', 'text/plain')).toThrow('请选择 PDF 或 PPTX 文件')

    const source = bytes('PK\u0003\u0004pptx')
    const rendered = bytes('%PDF-rendered')
    const sourceHash = await hash(source)
    const renderHash = await hash(rendered)
    const wrongHash = '0'.repeat(64)
    const sourceMismatch = async () => new Response(rendered, {
      headers: {
        'x-canvas-prompt-source-sha256': wrongHash,
        'x-canvas-prompt-render-sha256': renderHash,
        'x-canvas-prompt-renderer-name': 'LibreOffice',
      },
    })
    await expect(prepareArtifactReviewSource(
      { name: 'review.pptx', mimeType: '', bytes: source },
      sourceMismatch,
    )).rejects.toThrow('原文件哈希校验失败')

    const renderMismatch = async () => new Response(rendered, {
      headers: {
        'x-canvas-prompt-source-sha256': sourceHash,
        'x-canvas-prompt-render-sha256': wrongHash,
        'x-canvas-prompt-renderer-name': 'LibreOffice',
      },
    })
    await expect(prepareArtifactReviewSource(
      { name: 'review.pptx', mimeType: '', bytes: source },
      renderMismatch,
    )).rejects.toThrow('渲染结果哈希校验失败')
  })

  it('surfaces a structured conversion failure without treating it as a PDF', async () => {
    const source = bytes('PK\u0003\u0004broken')
    const request = async () => new Response(JSON.stringify({ ok: false, error: 'PPTX 损坏。' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    })

    await expect(prepareArtifactReviewSource(
      { name: 'broken.pptx', mimeType: '', bytes: source },
      request,
    )).rejects.toThrow('PPTX 损坏')
  })
})
