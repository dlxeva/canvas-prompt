import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { ReviewMark } from './artifact-review-package'
import { protectedLocalApiFetch } from './protected-local-api'

const MAX_RENDER_EDGE = 1600

type PackagePage = { page_id: string; page_number: number }

export function visualEvidencePageNumbers(marksByPage: Record<number, ReviewMark[]>) {
  return Object.entries(marksByPage)
    .filter(([, marks]) => marks.length > 0)
    .map(([pageNumber]) => Number(pageNumber))
    .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0)
    .sort((left, right) => left - right)
}

function drawMark(context: CanvasRenderingContext2D, mark: ReviewMark, width: number, height: number) {
  if (mark.points.length === 0) return
  context.strokeStyle = '#dc2626'
  context.fillStyle = '#dc2626'
  context.lineWidth = Math.max(2, Math.min(width, height) / 350)
  context.lineCap = 'round'
  context.lineJoin = 'round'
  const point = (index: number) => ({ x: mark.points[index].x * width, y: mark.points[index].y * height })
  const start = point(0)
  if (mark.kind === 'ink') {
    context.beginPath()
    context.moveTo(start.x, start.y)
    for (let index = 1; index < mark.points.length; index += 1) {
      const next = point(index)
      context.lineTo(next.x, next.y)
    }
    context.stroke()
    return
  }
  if (mark.points.length < 2) return
  const end = point(1)
  if (mark.kind === 'circle') {
    context.beginPath()
    context.ellipse((start.x + end.x) / 2, (start.y + end.y) / 2, Math.abs(end.x - start.x) / 2, Math.abs(end.y - start.y) / 2, 0, 0, Math.PI * 2)
    context.stroke()
    return
  }
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const head = Math.max(10, Math.min(width, height) / 35)
  context.beginPath()
  context.moveTo(start.x, start.y)
  context.lineTo(end.x, end.y)
  context.stroke()
  context.beginPath()
  context.moveTo(end.x, end.y)
  context.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6))
  context.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6))
  context.closePath()
  context.fill()
}

async function renderAnnotatedPage(documentHandle: PDFDocumentProxy, pageNumber: number, marks: ReviewMark[]) {
  const page = await documentHandle.getPage(pageNumber)
  const natural = page.getViewport({ scale: 1 })
  const scale = Math.min(2, MAX_RENDER_EDGE / Math.max(natural.width, natural.height))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('当前浏览器无法生成页面视觉证据。')
  await page.render({ canvas, canvasContext: context, viewport, background: 'rgb(255, 255, 255)' }).promise
  for (const mark of marks) drawMark(context, mark, canvas.width, canvas.height)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('页面视觉证据编码失败。')), 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export async function archiveArtifactReviewVisualEvidence(input: {
  documentHandle: PDFDocumentProxy
  packageData: { package_id: string; pages: PackagePage[] }
  marksByPage: Record<number, ReviewMark[]>
}) {
  const pageIdByNumber = new Map(input.packageData.pages.map((page) => [page.page_number, page.page_id]))
  const pages = []
  for (const pageNumber of visualEvidencePageNumbers(input.marksByPage)) {
    const pageId = pageIdByNumber.get(pageNumber)
    if (!pageId) throw new Error(`过程包缺少第 ${pageNumber} 页身份。`)
    const bytes = await renderAnnotatedPage(input.documentHandle, pageNumber, input.marksByPage[pageNumber])
    pages.push({ page_id: pageId, media_type: 'image/png', data_base64: bytesToBase64(bytes) })
  }
  if (pages.length === 0) return { archivedPageCount: 0 }
  const response = await protectedLocalApiFetch('/api/artifact-review-visual-evidence', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ package_id: input.packageData.package_id, pages }),
  })
  const result = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null
  if (!response.ok || !result?.ok) throw new Error(result?.error || `页面视觉证据未能归档（${response.status}）`)
  return { archivedPageCount: pages.length }
}
