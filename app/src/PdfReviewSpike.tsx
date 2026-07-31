import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { buildArtifactReviewPackage } from './artifact-review-package'
import type { ArtifactReviewKind, ArtifactReviewPage, ArtifactReviewPageVisit, ArtifactReviewVoiceSegment, PagePoint, ReviewMark, ReviewTool } from './artifact-review-package'
import { handoffArtifactReviewPackage } from './artifact-review-handoff'
import { prepareArtifactReviewSource } from './artifact-review-source'
import type { ArtifactReviewRenderDerivative } from './artifact-review-source'
import { ASRClient } from './asr-client'
import { latestDraftTimestamp, restoreReviewDraftFromExport } from './pdf-review-draft'
import { clientPointToPagePoint } from './pdf-review-geometry'
import { createInkSvgPath, pointerSamples } from './pdf-review-ink'
import { VoiceRecorder } from './voice-recorder'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const MAX_RENDER_SCALE = 2
const DEFAULT_LOCAL_ASR_BASE_URL = 'http://127.0.0.1:18080'

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Isolated AR-02 renderer. It is opt-in through `?artifact-review-spike=1`
 * so the v0.1 canvas and handoff workflow remain unchanged.
 */
export default function PdfReviewSpike() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const documentRef = useRef<PDFDocumentProxy | null>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const sessionStartedAtRef = useRef(Date.now())
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const voiceStartMsRef = useRef(0)
  const [documentHandle, setDocumentHandle] = useState<PDFDocumentProxy | null>(null)
  const [fileName, setFileName] = useState('')
  const [fileSize, setFileSize] = useState(0)
  const [sourceHash, setSourceHash] = useState('')
  const [artifactKind, setArtifactKind] = useState<ArtifactReviewKind>('pdf')
  const [renderDerivative, setRenderDerivative] = useState<ArtifactReviewRenderDerivative | undefined>()
  const [pageCount, setPageCount] = useState(0)
  const [pages, setPages] = useState<ArtifactReviewPage[]>([])
  const [pageNumber, setPageNumber] = useState(1)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [loading, setLoading] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null)
  const [pageViewport, setPageViewport] = useState<{ width: number; height: number } | null>(null)
  const [reviewTool, setReviewTool] = useState<ReviewTool>('ink')
  const [marksByPage, setMarksByPage] = useState<Record<number, ReviewMark[]>>({})
  const [voiceSegments, setVoiceSegments] = useState<ArtifactReviewVoiceSegment[]>([])
  const [pageVisits, setPageVisits] = useState<ArtifactReviewPageVisit[]>([])
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null)
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null)
  const [asrBaseUrl, setAsrBaseUrl] = useState(DEFAULT_LOCAL_ASR_BASE_URL)
  const [draftMark, setDraftMark] = useState<ReviewMark | null>(null)
  const draggingMarkRef = useRef<ReviewMark | null>(null)

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'PDF/PPTX 手动批阅 | Artifact Review'
    return () => { document.title = previousTitle }
  }, [])

  useEffect(() => {
    void fetch('/api/runtime-identity', { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() as Promise<{ asr_url?: unknown }> : null)
      .then((identity) => {
        if (identity && typeof identity.asr_url === 'string' && identity.asr_url.length > 0) setAsrBaseUrl(identity.asr_url)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => () => {
    void loadingTaskRef.current?.destroy()
    void documentRef.current?.cleanup()
    loadingTaskRef.current = null
    documentRef.current = null
  }, [])

  useEffect(() => {
    if (!sourceHash || pages.length === 0) return
    try {
      const packageData = buildArtifactReviewPackage({ sourceHash, artifactKind, renderDerivative, pages, marksByPage, voiceSegments, pageVisits })
      window.sessionStorage.setItem(`artifact-review-draft:${sourceHash}`, JSON.stringify(packageData))
    } catch {
      // Storage may be unavailable in a restrictive browser profile. Export remains available.
    }
  }, [artifactKind, marksByPage, pages, pageVisits, renderDerivative, sourceHash, voiceSegments])

  useEffect(() => {
    if (!documentHandle || !canvasRef.current) return

    let cancelled = false
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null
    const canvas = canvasRef.current

    const renderPage = async () => {
      setRendering(true)
      setError(null)
      try {
        const page = await documentHandle.getPage(pageNumber)
        if (cancelled) return
        const viewport = page.getViewport({ scale: zoomPercent / 100 })
        const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_RENDER_SCALE)
        if (!canvas.getContext('2d', { alpha: false })) throw new Error('当前浏览器无法建立 PDF 渲染画布。')
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio))
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio))
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        setPageViewport({ width: Math.floor(viewport.width), height: Math.floor(viewport.height) })
        renderTask = page.render({
          canvas,
          viewport,
          transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
          background: 'rgb(255, 255, 255)',
        })
        await renderTask.promise
      } catch (cause) {
        if (!cancelled) {
          const message = cause instanceof Error ? cause.message : String(cause)
          if (!message.includes('Rendering cancelled')) setError(`无法渲染第 ${pageNumber} 页：${message}`)
        }
      } finally {
        if (!cancelled) setRendering(false)
      }
    }

    void renderPage()
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [documentHandle, pageNumber, zoomPercent])

  const chooseFile = async (file: File | undefined) => {
    if (!file) return

    setLoading(true)
    setError(null)
    setDocumentHandle(null)
    setPageCount(0)
    setPages([])
    setPageNumber(1)
    setPageViewport(null)
    setSourceHash('')
    setArtifactKind('pdf')
    setRenderDerivative(undefined)
    setDraftMark(null)
    setRecoveryNotice(null)
    try {
      await loadingTaskRef.current?.destroy()
      await documentRef.current?.cleanup()
      loadingTaskRef.current = null
      documentRef.current = null
      const sourceBytes = await file.arrayBuffer()
      const prepared = await prepareArtifactReviewSource({
        name: file.name,
        mimeType: file.type,
        bytes: sourceBytes,
      })
      const loadingTask = getDocument({
        data: new Uint8Array(prepared.pdfBytes),
        disableAutoFetch: true,
        disableStream: true,
        enableXfa: false,
      })
      loadingTaskRef.current = loadingTask
      const pdf = await loadingTask.promise
      const pageMetadata = await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
        const page = await pdf.getPage(index + 1)
        const viewport = page.getViewport({ scale: 1 })
        return {
          pageNumber: index + 1,
          width: viewport.width,
          height: viewport.height,
          rotationDegrees: (viewport.rotation % 360) as ArtifactReviewPage['rotationDegrees'],
        }
      }))
      let restoredDraft = { marksByPage: {} as Record<number, ReviewMark[]>, voiceSegments: [] as ArtifactReviewVoiceSegment[], pageVisits: [] as ArtifactReviewPageVisit[] }
      try {
        const storedPackage = window.sessionStorage.getItem(`artifact-review-draft:${prepared.sourceHash}`)
        if (storedPackage) restoredDraft = restoreReviewDraftFromExport(prepared.sourceHash, JSON.parse(storedPackage))
      } catch {
        // A malformed old draft must never block opening the source PDF.
      }
      documentRef.current = pdf
      sessionStartedAtRef.current = Date.now() - latestDraftTimestamp(restoredDraft)
      setFileName(file.name)
      setFileSize(file.size)
      setSourceHash(prepared.sourceHash)
      setArtifactKind(prepared.artifactKind)
      setRenderDerivative(prepared.renderDerivative ? {
        ...prepared.renderDerivative,
        pageCount: pdf.numPages,
      } : undefined)
      setPageCount(pdf.numPages)
      setPages(pageMetadata)
      setMarksByPage(restoredDraft.marksByPage)
      setVoiceSegments(restoredDraft.voiceSegments)
      setPageVisits(restoredDraft.pageVisits.length > 0 ? restoredDraft.pageVisits : [{ pageNumber: 1, atMs: 0 }])
      setVoiceStatus(null)
      setHandoffStatus(null)
      setDocumentHandle(pdf)
      if (Object.values(restoredDraft.marksByPage).flat().length > 0) setRecoveryNotice('已恢复此浏览器会话中的本地批阅过程。')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(`无法打开此文件：${message}`)
    } finally {
      setLoading(false)
    }
  }

  const zoomBy = (delta: number) => setZoomPercent((value) => Math.max(60, Math.min(200, value + delta)))
  const pageMarks = marksByPage[pageNumber] ?? []

  const navigateToPage = (nextPage: number) => {
    if (nextPage === pageNumber) return
    setPageNumber(nextPage)
    setPageVisits((current) => [...current, { pageNumber: nextPage, atMs: Date.now() - sessionStartedAtRef.current }])
  }

  const pagePoints = (event: ReactPointerEvent<SVGSVGElement>): PagePoint[] => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return pointerSamples(event.nativeEvent).map((pointerEvent) => clientPointToPagePoint(pointerEvent, bounds))
  }

  const commitMark = (mark: ReviewMark) => {
    setMarksByPage((current) => ({ ...current, [mark.pageNumber]: [...(current[mark.pageNumber] ?? []), mark] }))
  }

  const startMark = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (rendering || !pageViewport) return
    const [point] = pagePoints(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const mark = {
      id: `ann_${crypto.randomUUID()}`,
      kind: reviewTool,
      pageNumber,
      points: [point],
      createdAtMs: Date.now() - sessionStartedAtRef.current,
    } satisfies ReviewMark
    draggingMarkRef.current = mark
    setDraftMark(mark)
  }

  const moveMark = (event: ReactPointerEvent<SVGSVGElement>) => {
    const active = draggingMarkRef.current
    if (!active) return
    const nextPoints = pagePoints(event)
    const point = nextPoints.at(-1)
    if (!point) return
    const points = active.kind === 'ink' ? [...active.points, ...nextPoints] : [active.points[0], point]
    const next = { ...active, points }
    draggingMarkRef.current = next
    setDraftMark(next)
  }

  const finishMark = (event: ReactPointerEvent<SVGSVGElement>) => {
    const active = draggingMarkRef.current
    if (!active) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (active.kind === 'ink' ? active.points.length > 1 : active.points.length === 2) commitMark(active)
    draggingMarkRef.current = null
    setDraftMark(null)
  }

  const clearPageMarks = () => {
    setMarksByPage((current) => {
      const next = { ...current }
      delete next[pageNumber]
      return next
    })
  }

  const undoPageMark = () => {
    setMarksByPage((current) => {
      const pageMarks = current[pageNumber] ?? []
      if (pageMarks.length === 0) return current
      const next = { ...current }
      const remaining = pageMarks.slice(0, -1)
      if (remaining.length === 0) delete next[pageNumber]
      else next[pageNumber] = remaining
      return next
    })
  }

  const exportProcessPackage = () => {
    if (!sourceHash || pages.length === 0) return
    const packageData = buildArtifactReviewPackage({ sourceHash, artifactKind, renderDerivative, pages, marksByPage, voiceSegments, pageVisits })
    const blob = new Blob([`${JSON.stringify(packageData, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `artifact-review-${sourceHash.slice(0, 16)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const handoffProcessPackage = async () => {
    if (!sourceHash || pages.length === 0) return
    setHandoffStatus('正在保存本轮批阅…')
    try {
      const packageData = buildArtifactReviewPackage({ sourceHash, artifactKind, renderDerivative, pages, marksByPage, voiceSegments, pageVisits })
      await handoffArtifactReviewPackage(packageData)
      setHandoffStatus('本轮已保存到本地档案。现在可让 Codex 读取本轮工件批阅。')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setHandoffStatus(`本轮未能保存：${message}`)
    }
  }

  const startVoiceReview = async () => {
    if (voiceRecording) return
    const recorder = new VoiceRecorder()
    recorderRef.current = recorder
    setVoiceStatus('正在开始本轮…')
    try {
      await recorder.start()
      voiceStartMsRef.current = Date.now() - sessionStartedAtRef.current
      setVoiceRecording(true)
      setVoiceStatus('批阅中')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      recorderRef.current = null
      setVoiceStatus(`麦克风不可用：${message}`)
    }
  }

  const finishVoiceReview = async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    setVoiceRecording(false)
    setVoiceStatus('正在整理本轮…')
    const startMs = voiceStartMsRef.current
    const endMs = Date.now() - sessionStartedAtRef.current
    let recordingUrl: string | null = null
    try {
      const recording = await recorder.stop()
      recordingUrl = recording.url
      const transcription = await new ASRClient({ baseUrl: asrBaseUrl }).transcribe(recording.blob, 'zh')
      const rawSegments = transcription.segments.length > 0
        ? transcription.segments
        : [{ start: 0, end: recording.duration / 1000, text: transcription.text, confidence: 0 }]
      const newSegments = rawSegments
        .filter((segment) => segment.text.trim().length > 0)
        .map((segment) => ({
          segmentId: `voice_${crypto.randomUUID()}`,
          startMs: Math.max(startMs, startMs + Math.round(segment.start * 1000)),
          endMs: Math.min(endMs, Math.max(startMs, startMs + Math.round(segment.end * 1000))),
          text: segment.text.trim(),
          confidence: segment.confidence,
        }))
      setVoiceSegments((current) => [...current, ...newSegments])

      setVoiceStatus(`本轮完成 · 已收录 ${newSegments.length} 段语音`)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setVoiceStatus(`本轮完成 · 语音未收录：${message}`)
    } finally {
      if (recordingUrl) URL.revokeObjectURL(recordingUrl)
      recorderRef.current = null
    }
  }

  const renderMark = (mark: ReviewMark, draft = false) => {
    const color = draft ? '#f97316' : '#dc2626'
    if (mark.kind === 'ink') {
      const path = createInkSvgPath(mark.points, draft)
      const rawPoints = mark.points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(' ')
      return <g key={mark.id}>
        {path && <path d={path} fill={color} opacity={draft ? 0.72 : 1} />}
        <polyline points={rawPoints} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" opacity={path ? 0.3 : 1} />
      </g>
    }
    if (mark.kind === 'circle') {
      const [start, end] = mark.points
      if (!end) return null
      return <ellipse key={mark.id} cx={(start.x + end.x) * 500} cy={(start.y + end.y) * 500} rx={Math.abs(start.x - end.x) * 500} ry={Math.abs(start.y - end.y) * 500} fill="none" stroke={color} strokeWidth="2.5" opacity={draft ? 0.72 : 1} />
    }
    if (mark.kind === 'arrow') {
      const [start, end] = mark.points
      if (!end) return null
      return <line key={mark.id} x1={start.x * 1000} y1={start.y * 1000} x2={end.x * 1000} y2={end.y * 1000} stroke={color} strokeWidth="2.5" strokeLinecap="round" markerEnd="url(#review-arrow-head)" opacity={draft ? 0.72 : 1} />
    }
    return null
  }

  return (
    <main style={{ minHeight: '100vh', background: '#f4f7fb', color: '#10233d', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '18px 24px', background: '#08213b', color: '#fff' }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: '0.08em', opacity: 0.72 }}>ARTIFACT REVIEW · AR-02 SPIKE</div>
          <h1 style={{ margin: '4px 0 0', fontSize: 20 }}>PDF / PPTX 手动批阅</h1>
        </div>
        <a href="/" style={{ color: '#c9dcff', fontSize: 14 }}>返回 v0.1 画布</a>
      </header>

      <section style={{ maxWidth: 1240, margin: '0 auto', padding: 24 }}>
        <p style={{ marginTop: 0, color: '#52657b' }}>像在白板上一样批阅：开始本轮后，直接画、圈、翻页、说；标记始终与原 PDF 或 PPTX 分离。</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: 14, background: '#fff', border: '1px solid #d9e2ef', borderRadius: 10 }}>
          <button type="button" onClick={() => inputRef.current?.click()} disabled={loading} style={{ border: 0, borderRadius: 7, padding: '9px 13px', background: '#165dff', color: '#fff', cursor: 'pointer' }}>
            {loading ? '正在读取…' : '选择本地 PDF / PPTX'}
          </button>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx" hidden onChange={(event) => void chooseFile(event.target.files?.[0])} />
          {fileName && <span style={{ fontSize: 14 }}>{artifactKind.toUpperCase()} · {fileName} · {formatBytes(fileSize)} · {pageCount} 页</span>}
          {sourceHash && <code style={{ color: '#52657b', fontSize: 11, overflowWrap: 'anywhere' }}>SHA-256 {sourceHash}</code>}
        </div>

        {error && <p role="alert" style={{ padding: 12, borderRadius: 8, background: '#fff1f1', color: '#a61b1b' }}>{error}</p>}
        {recoveryNotice && <p role="status" style={{ padding: 12, borderRadius: 8, background: '#edf8f1', color: '#17643a' }}>{recoveryNotice}</p>}

        {documentHandle && <>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, margin: '18px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" onClick={() => navigateToPage(Math.max(1, pageNumber - 1))} disabled={pageNumber === 1 || rendering}>上一页</button>
              <strong>第 {pageNumber} / {pageCount} 页</strong>
              <button type="button" onClick={() => navigateToPage(Math.min(pageCount, pageNumber + 1))} disabled={pageNumber === pageCount || rendering}>下一页</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" onClick={() => zoomBy(-20)} disabled={zoomPercent <= 60 || rendering}>−</button>
              <span>{zoomPercent}% {rendering ? '· 正在渲染' : ''}</span>
              <button type="button" onClick={() => zoomBy(20)} disabled={zoomPercent >= 200 || rendering}>＋</button>
            </div>
          </div>
          <nav aria-label="工件页面" style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 0 12px' }}>
            {pages.map((page) => <button key={page.pageNumber} type="button" onClick={() => navigateToPage(page.pageNumber)} aria-current={page.pageNumber === pageNumber ? 'page' : undefined} disabled={rendering || page.pageNumber === pageNumber} style={{ flex: '0 0 auto', minWidth: 36, border: `1px solid ${page.pageNumber === pageNumber ? '#165dff' : '#b9c6d6'}`, borderRadius: 7, padding: '7px 9px', background: page.pageNumber === pageNumber ? '#e8f0ff' : '#fff', color: '#10233d' }}>
              {page.pageNumber}
            </button>)}
          </nav>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
            <span style={{ fontSize: 13, color: '#52657b' }}>手动批阅：</span>
            {([['ink', '手写'], ['circle', '圈选'], ['arrow', '箭头']] as Array<[ReviewTool, string]>).map(([tool, label]) => <button key={tool} type="button" onClick={() => setReviewTool(tool)} aria-pressed={reviewTool === tool} style={{ border: `1px solid ${reviewTool === tool ? '#165dff' : '#b9c6d6'}`, borderRadius: 7, padding: '7px 10px', background: reviewTool === tool ? '#e8f0ff' : '#fff', color: '#10233d' }}>{label}</button>)}
            <button type="button" onClick={undoPageMark} disabled={pageMarks.length === 0} style={{ border: '1px solid #b9c6d6', borderRadius: 7, padding: '7px 10px', background: '#fff', color: '#10233d' }}>撤销最近一笔</button>
            <button type="button" onClick={clearPageMarks} disabled={pageMarks.length === 0} style={{ border: 0, padding: '7px 10px', color: '#9f1239', background: 'transparent' }}>清除本页笔迹</button>
            <button type="button" onClick={() => void (voiceRecording ? finishVoiceReview() : startVoiceReview())} disabled={!sourceHash} aria-pressed={voiceRecording} style={{ border: `1px solid ${voiceRecording ? '#b91c1c' : '#165dff'}`, borderRadius: 7, padding: '7px 10px', background: voiceRecording ? '#fff1f2' : '#e8f0ff', color: voiceRecording ? '#b91c1c' : '#10233d' }}>
              {voiceRecording ? '结束本轮批阅' : '开始本轮批阅'}
            </button>
            <button type="button" onClick={() => void handoffProcessPackage()} disabled={Object.values(marksByPage).flat().length === 0}>交给 AI</button>
            <button type="button" onClick={exportProcessPackage} disabled={Object.values(marksByPage).flat().length === 0}>导出副本</button>
          </div>
          {voiceStatus && <div role="status" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '0 0 12px', padding: 10, borderRadius: 8, background: '#edf5ff', color: '#174a7a', fontSize: 14 }}>
            <span>{voiceStatus}</span>
          </div>}
          {handoffStatus && <div role="status" style={{ margin: '0 0 12px', padding: 10, borderRadius: 8, background: handoffStatus.startsWith('本轮未能') ? '#fff1f1' : '#edf8f1', color: handoffStatus.startsWith('本轮未能') ? '#a61b1b' : '#17643a', fontSize: 14 }}>
            {handoffStatus}
          </div>}
          <div style={{ minHeight: 420, overflow: 'auto', padding: 24, border: '1px solid #d9e2ef', borderRadius: 10, background: '#dfe7f1', textAlign: 'center' }}>
            <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
              <canvas ref={canvasRef} aria-label={`${artifactKind.toUpperCase()} 第 ${pageNumber} 页`} style={{ display: 'block', maxWidth: 'none', boxShadow: '0 8px 28px rgba(22, 45, 77, .18)' }} />
              {pageViewport && <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" width={pageViewport.width} height={pageViewport.height} onPointerDown={startMark} onPointerMove={moveMark} onPointerUp={finishMark} onPointerCancel={finishMark} style={{ position: 'absolute', inset: 0, touchAction: 'none', cursor: 'crosshair' }} aria-label={`${artifactKind.toUpperCase()} 第 ${pageNumber} 页批注层`}>
                <defs><marker id="review-arrow-head" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto"><path d="M 0 0 L 12 6 L 0 12 z" fill="#dc2626" /></marker></defs>
                {pageMarks.map((mark) => renderMark(mark))}
                {draftMark?.pageNumber === pageNumber && renderMark(draftMark, true)}
              </svg>}
            </div>
          </div>
        </>}
      </section>
    </main>
  )
}
