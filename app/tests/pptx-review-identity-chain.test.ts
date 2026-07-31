import { createHash } from 'node:crypto'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { buildArtifactReviewPackage } from '../src/artifact-review-package'
import type { ArtifactReviewPage } from '../src/artifact-review-package'
import { prepareArtifactReviewSource } from '../src/artifact-review-source'

function sha256(bytes: ArrayBuffer | Uint8Array) {
  return createHash('sha256').update(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).digest('hex')
}

function syntheticPdf(pageCount: number) {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(' ')}] >>`,
  ]
  for (let index = 0; index < pageCount; index += 1) {
    const pageObjectNumber = 3 + index * 2
    const contentObjectNumber = pageObjectNumber + 1
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${612 + index} ${792 + index}] /Contents ${contentObjectNumber} 0 R >>`)
    objects.push('<< /Length 0 >>\nstream\n\nendstream')
  }

  let serialized = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(serialized, 'ascii'))
    serialized += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(serialized, 'ascii')
  serialized += `xref\n0 ${objects.length + 1}\n`
  serialized += '0000000000 65535 f \n'
  serialized += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  serialized += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Uint8Array.from(Buffer.from(serialized, 'ascii')).buffer
}

describe('PPTX review identity chain', () => {
  it('keeps original PPTX identity through conversion, PDF.js pages and package export', async () => {
    const privateSourceMarker = 'PRIVATE_PPTX_BYTES_/Users/example/private-deck.pptx'
    const sourceBytes = Uint8Array.from(Buffer.from(`PK\u0003\u0004${privateSourceMarker}`)).buffer
    const renderedPdf = syntheticPdf(2)
    const sourceHash = sha256(sourceBytes)
    const renderHash = sha256(renderedPdf)
    const request = async () => new Response(renderedPdf, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'x-canvas-prompt-source-sha256': sourceHash,
        'x-canvas-prompt-render-sha256': renderHash,
        'x-canvas-prompt-renderer-name': 'SyntheticRenderer',
        'x-canvas-prompt-renderer-version': 'fixture-1',
      },
    })

    const prepared = await prepareArtifactReviewSource({
      name: 'private-deck.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: sourceBytes,
    }, request)
    const loadingTask = getDocument({
      data: new Uint8Array(prepared.pdfBytes),
      disableAutoFetch: true,
      disableStream: true,
    })
    const pdf = await loadingTask.promise
    const pages = await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
      const page = await pdf.getPage(index + 1)
      const viewport = page.getViewport({ scale: 1 })
      return {
        pageNumber: index + 1,
        width: viewport.width,
        height: viewport.height,
        rotationDegrees: (viewport.rotation % 360) as ArtifactReviewPage['rotationDegrees'],
      }
    }))
    const packageData = buildArtifactReviewPackage({
      sourceHash: prepared.sourceHash,
      artifactKind: prepared.artifactKind,
      renderDerivative: prepared.renderDerivative && {
        ...prepared.renderDerivative,
        pageCount: pdf.numPages,
      },
      pages,
      marksByPage: {},
      createdAt: new Date('2026-07-31T07:18:44.000Z'),
    })
    await loadingTask.destroy()

    expect(pdf.numPages).toBe(2)
    expect(pages.map((page) => [page.width, page.height])).toEqual([[612, 792], [613, 793]])
    expect(packageData.artifact).toMatchObject({
      artifact_kind: 'pptx',
      source_sha256: sourceHash,
      source_version_id: `sha256:${sourceHash}`,
      page_count: 2,
      render_derivative: {
        artifact_kind: 'pdf_derivative',
        source_sha256: renderHash,
        page_count: 2,
        renderer: { name: 'SyntheticRenderer', version: 'fixture-1' },
      },
    })
    expect(packageData.pages.map((page) => page.page_id)).toEqual([
      `page_${sourceHash.slice(0, 16)}_1`,
      `page_${sourceHash.slice(0, 16)}_2`,
    ])

    const exported = JSON.stringify(packageData)
    expect(exported).not.toContain(privateSourceMarker)
    expect(exported).not.toContain('/Users/example')
    expect(exported).not.toContain('%PDF-1.4')
    expect(packageData.privacy).toMatchObject({
      processing: 'local_only',
      source_bytes_in_export: false,
    })
  })
})
