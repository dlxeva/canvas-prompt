import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { ChevronLeft, ChevronRight, Minus, MoreHorizontal, Plus, Undo2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { isEditableReviewShortcutTarget, restoredReviewPage, reviewPageNavigationState, reviewPageShortcutDelta } from './pdf-review-navigation'
import { reviewPageScale } from './pdf-review-scale'
import { VoiceRecorder } from './voice-recorder'
import { archiveArtifactReviewVisualEvidence } from './artifact-review-visual-handoff'
import type { Locale } from './locale'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const MAX_RENDER_SCALE = 2
const DEFAULT_LOCAL_ASR_BASE_URL = 'http://127.0.0.1:18080'

/**
 * The page-aware review surface can still be opened through the development
 * query flag, and the main Canvas Prompt file picker routes PDF/PPTX here.
 */
export default function PdfReviewSpike({ active = true, locale, onLocaleChange, initialFile, onReturnToCanvas, onCaptureStateChange }: { active?: boolean, locale: Locale, onLocaleChange: (next: Locale) => void, initialFile?: File, onReturnToCanvas?: (captureBusy?: boolean) => void, onCaptureStateChange?: (busy: boolean) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageScrollRef = useRef<HTMLDivElement | null>(null)
  const documentRef = useRef<PDFDocumentProxy | null>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const sessionStartedAtRef = useRef(Date.now())
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const voiceStartMsRef = useRef(0)
  const [documentHandle, setDocumentHandle] = useState<PDFDocumentProxy | null>(null)
  const [sourceHash, setSourceHash] = useState('')
  const [artifactKind, setArtifactKind] = useState<ArtifactReviewKind>('pdf')
  const [renderDerivative, setRenderDerivative] = useState<ArtifactReviewRenderDerivative | undefined>()
  const [pageCount, setPageCount] = useState(0)
  const [pages, setPages] = useState<ArtifactReviewPage[]>([])
  const [pageNumber, setPageNumber] = useState(1)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [stageContentSize, setStageContentSize] = useState({ width: 0, height: 0 })
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
  const [voiceProcessing, setVoiceProcessing] = useState(false)
  const captureBusy = voiceRecording || voiceProcessing
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null)
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null)
  const [asrBaseUrl, setAsrBaseUrl] = useState(DEFAULT_LOCAL_ASR_BASE_URL)
  const [draftMark, setDraftMark] = useState<ReviewMark | null>(null)
  const draggingMarkRef = useRef<ReviewMark | null>(null)
  const initialFileHandledRef = useRef<File | null>(null)
  const ui = locale === 'zh' ? {
    canvas: '自由推演', review: '交互审阅', workspace: '工作入口', switched: '已切换到交互审阅',
    intro: '像在白板上一样审阅：边看、边说、边标记，AI 会结合页码和批注理解你的反馈；标记始终与原 PDF 或 PPTX 分离。',
    entry: '选择一份本地 PDF 或 PPTX，进入逐页标记与语音审阅。原文件不会被修改。', choose: '选择本地 PDF / PPTX', reading: '正在读取…',
    tools: '批注工具', ink: '手写', circle: '圈选', arrow: '箭头', undo: '撤销最近一笔', more: '更多审阅操作', clear: '清除本页笔迹', export: '导出审阅记录', replace: '更换文件', close: '关闭当前文件',
    start: '开始审阅', finish: '结束审阅', pageJump: '快速跳转页面', page: (current: number, total: number) => `第 ${current} / ${total} 页`, zoom: '页面缩放', zoomOut: '缩小', zoomIn: '放大',
  } : {
    canvas: 'Freeform', review: 'Interactive review', workspace: 'Workspace', switched: 'Switched to Interactive Review',
    intro: 'Review as you would on a canvas: look, speak, and mark while AI keeps feedback anchored to pages and annotations. Your source file is never modified.',
    entry: 'Choose a local PDF or PPTX for page-by-page voice and visual review. The original file remains unchanged.', choose: 'Choose PDF / PPTX', reading: 'Opening…',
    tools: 'Annotation tools', ink: 'Draw', circle: 'Circle', arrow: 'Arrow', undo: 'Undo last mark', more: 'More review actions', clear: 'Clear marks on this page', export: 'Export review record', replace: 'Replace file', close: 'Close current file',
    start: 'Start review', finish: 'Finish review', pageJump: 'Jump to page', page: (current: number, total: number) => `Page ${current} of ${total}`, zoom: 'Page zoom', zoomOut: 'Zoom out', zoomIn: 'Zoom in',
  }

  useEffect(() => {
    if (!active) return
    const previousTitle = document.title
    document.title = `${ui.review} | Canvas Prompt`
    return () => { document.title = previousTitle }
  }, [active, ui.review])

  useEffect(() => {
    onCaptureStateChange?.(captureBusy)
  }, [captureBusy, onCaptureStateChange])

  useLayoutEffect(() => {
    const stage = stageScrollRef.current
    if (!documentHandle || !stage) return
    const updateSize = () => {
      const styles = window.getComputedStyle(stage)
      const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight)
      const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
      const nextSize = {
        width: Math.max(1, stage.clientWidth - horizontalPadding),
        height: Math.max(1, stage.clientHeight - verticalPadding),
      }
      setStageContentSize((current) => Math.abs(current.width - nextSize.width) < 1 && Math.abs(current.height - nextSize.height) < 1 ? current : nextSize)
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [documentHandle])

  useEffect(() => {
    if (!initialFile || initialFileHandledRef.current === initialFile) return
    initialFileHandledRef.current = initialFile
    void chooseFile(initialFile)
  }, [initialFile])

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
    if (!documentHandle || !canvasRef.current || stageContentSize.width <= 0 || stageContentSize.height <= 0) return

    let cancelled = false
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null
    const canvas = canvasRef.current

    const renderPage = async () => {
      setRendering(true)
      setError(null)
      try {
        const page = await documentHandle.getPage(pageNumber)
        if (cancelled) return
        const baseViewport = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: reviewPageScale(baseViewport.width, baseViewport.height, stageContentSize.width, stageContentSize.height, zoomPercent) })
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
  }, [documentHandle, pageNumber, stageContentSize, zoomPercent])

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
      setSourceHash(prepared.sourceHash)
      setArtifactKind(prepared.artifactKind)
      setRenderDerivative(prepared.renderDerivative ? {
        ...prepared.renderDerivative,
        pageCount: pdf.numPages,
      } : undefined)
      setPageCount(pdf.numPages)
      setPages(pageMetadata)
      setPageNumber(restoredReviewPage(restoredDraft.pageVisits, pdf.numPages))
      setMarksByPage(restoredDraft.marksByPage)
      setVoiceSegments(restoredDraft.voiceSegments)
      setPageVisits(restoredDraft.pageVisits.length > 0 ? restoredDraft.pageVisits : [{ pageNumber: 1, atMs: 0 }])
      setVoiceStatus(null)
      setHandoffStatus(null)
      setDocumentHandle(pdf)
      if (Object.values(restoredDraft.marksByPage).flat().length > 0) setRecoveryNotice('已恢复上次审阅进度。')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(`无法打开此文件：${message}`)
    } finally {
      setLoading(false)
    }
  }

  const zoomBy = (delta: number) => setZoomPercent((value) => Math.max(60, Math.min(200, value + delta)))
  const pageMarks = marksByPage[pageNumber] ?? []
  const pageNavigation = reviewPageNavigationState(pageNumber, pageCount, rendering)

  const navigateToPage = (nextPage: number) => {
    if (nextPage === pageNumber) return
    setPageNumber(nextPage)
    setPageVisits((current) => [...current, { pageNumber: nextPage, atMs: Date.now() - sessionStartedAtRef.current }])
  }

  useEffect(() => {
    if (!documentHandle || pageCount < 1) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || rendering || draggingMarkRef.current || isEditableReviewShortcutTarget(event.target)) return
      const delta = reviewPageShortcutDelta(event)
      if (delta === 0) return
      const nextPage = Math.max(1, Math.min(pageCount, pageNumber + delta))
      if (nextPage === pageNumber) return
      event.preventDefault()
      navigateToPage(nextPage)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [documentHandle, pageCount, pageNumber, rendering])

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

  const closeCurrentFile = async () => {
    if (voiceRecording || voiceProcessing || loading) return
    await loadingTaskRef.current?.destroy().catch(() => undefined)
    await documentRef.current?.cleanup().catch(() => undefined)
    loadingTaskRef.current = null
    documentRef.current = null
    setDocumentHandle(null)
    setSourceHash('')
    setRenderDerivative(undefined)
    setPageCount(0)
    setPages([])
    setPageNumber(1)
    setZoomPercent(100)
    setPageViewport(null)
    setMarksByPage({})
    setVoiceSegments([])
    setPageVisits([])
    setVoiceStatus(null)
    setHandoffStatus(null)
    setRecoveryNotice(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const exportProcessPackage = () => {
    if (!sourceHash || pages.length === 0) return
    if (Object.values(marksByPage).flat().length === 0 && voiceSegments.length === 0) {
      setHandoffStatus('还没有记录批注或语音，请先完成审阅再导出。')
      return
    }
    const packageData = buildArtifactReviewPackage({ sourceHash, artifactKind, renderDerivative, pages, marksByPage, voiceSegments, pageVisits })
    const blob = new Blob([`${JSON.stringify(packageData, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `artifact-review-${sourceHash.slice(0, 16)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const handoffProcessPackage = async (completedVoiceSegments = voiceSegments) => {
    if (!sourceHash || pages.length === 0) return
    if (Object.values(marksByPage).flat().length === 0 && completedVoiceSegments.length === 0) {
      setHandoffStatus('还没有记录批注或语音，请先完成审阅。')
      return
    }
    setHandoffStatus('正在完成本轮交互审阅…')
    try {
      const packageData = buildArtifactReviewPackage({ sourceHash, artifactKind, renderDerivative, pages, marksByPage, voiceSegments: completedVoiceSegments, pageVisits })
      await handoffArtifactReviewPackage(packageData)
      if (documentHandle && Object.values(marksByPage).some((marks) => marks.length > 0)) {
        try {
          const visual = await archiveArtifactReviewVisualEvidence({ documentHandle, packageData, marksByPage })
          setHandoffStatus(`本轮交互审阅已完成，已归档 ${visual.archivedPageCount} 页视觉证据。回到对话后，AI 会先复述理解；你确认修改方案后才会执行。`)
        } catch (visualCause) {
          const visualMessage = visualCause instanceof Error ? visualCause.message : String(visualCause)
          setHandoffStatus(`本轮交互审阅已保存，但页面视觉证据未能归档：${visualMessage}。AI 仍可读取结构化批注和语音，并会在执行前请你确认修改方案。`)
        }
      } else {
        setHandoffStatus('本轮交互审阅已完成。回到对话后，AI 会先复述理解；你确认修改方案后才会执行。')
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setHandoffStatus(`本轮交互审阅未能完成：${message}`)
    }
  }

  const startVoiceReview = async () => {
    if (voiceRecording || voiceProcessing) return
    const recorder = new VoiceRecorder()
    recorderRef.current = recorder
    setVoiceProcessing(true)
    setVoiceStatus('正在开始审阅…')
    try {
      await recorder.start()
      voiceStartMsRef.current = Date.now() - sessionStartedAtRef.current
      setVoiceRecording(true)
      setVoiceStatus('审阅中')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      recorderRef.current = null
      setVoiceStatus(`麦克风不可用：${message}`)
    } finally {
      setVoiceProcessing(false)
    }
  }

  const finishVoiceReview = async () => {
    const recorder = recorderRef.current
    if (!recorder || voiceProcessing) return
    setVoiceProcessing(true)
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
      const completedVoiceSegments = [...voiceSegments, ...newSegments]
      setVoiceSegments(completedVoiceSegments)
      setVoiceStatus(`已收录 ${newSegments.length} 段语音，正在完成交互审阅…`)
      await handoffProcessPackage(completedVoiceSegments)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setVoiceStatus(`本轮完成 · 语音未收录：${message}`)
      await handoffProcessPackage()
    } finally {
      if (recordingUrl) URL.revokeObjectURL(recordingUrl)
      recorderRef.current = null
      setVoiceProcessing(false)
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
    <main className="artifact-review-shell">
      <header className="spike-header artifact-review-header">
        <div className="brand-lockup">
          <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
          <p className="eyebrow">canvas_prompt<span>_</span></p>
        </div>
        <nav className="workspace-switch" aria-label={ui.workspace}>
          {onReturnToCanvas
            ? <button type="button" onClick={() => onReturnToCanvas(captureBusy)} title={ui.canvas}>{ui.canvas}</button>
            : <a href="/" title={ui.canvas}>{ui.canvas}</a>}
          <button type="button" className="active" aria-current="page" title={ui.review}>{ui.review}</button>
        </nav>
        <div className="header-actions">
          <button className="language-toggle" type="button" onClick={() => onLocaleChange(locale === 'zh' ? 'en' : 'zh')} aria-label={locale === 'zh' ? 'Switch to English' : '切换至中文'} title={locale === 'zh' ? 'Switch to English' : '切换至中文'}>
            <span className={locale === 'zh' ? 'active' : ''}>中</span><span className={locale === 'en' ? 'active' : ''}>EN</span>
          </button>
        </div>
      </header>

      <section className="artifact-review-content">
        <div className={`artifact-review-intro${documentHandle ? ' artifact-review-intro-compact' : ''}`}>
          <div><p className="artifact-review-kicker">INTERACTIVE REVIEW</p><h1>{ui.review}</h1></div>
          {!documentHandle && <p>{ui.intro}</p>}
        </div>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx" hidden onChange={(event) => void chooseFile(event.target.files?.[0])} />
        {!documentHandle && <div className="artifact-review-entry-card">
          <div className="artifact-review-mode-notice" role="status"><i />{ui.switched}</div>
          <p>{ui.entry}</p>
          <button className="artifact-review-primary" type="button" onClick={() => inputRef.current?.click()} disabled={loading} title={loading ? ui.reading : ui.choose}>
            {loading ? ui.reading : ui.choose}
          </button>
        </div>}

        {error && <p role="alert" style={{ padding: 12, borderRadius: 8, background: '#fff1f1', color: '#a61b1b' }}>{error}</p>}
        {recoveryNotice && <p className="artifact-review-recovery" role="status">{recoveryNotice}</p>}

        {documentHandle && <>
          <div className="artifact-review-toolbar">
            <div className="artifact-review-tools" role="toolbar" aria-label={ui.tools}>
              {([['ink', ui.ink], ['circle', ui.circle], ['arrow', ui.arrow]] as Array<[ReviewTool, string]>).map(([tool, label]) => <button key={tool} type="button" onClick={() => setReviewTool(tool)} aria-pressed={reviewTool === tool} className={reviewTool === tool ? 'active' : ''} title={label}>{label}</button>)}
              <button type="button" className="artifact-review-icon-button" onClick={undoPageMark} disabled={pageMarks.length === 0} aria-label={ui.undo} title={ui.undo}><Undo2 aria-hidden="true" /></button>
              <details className="artifact-review-more">
                <summary aria-label={ui.more} title={ui.more}><MoreHorizontal aria-hidden="true" /></summary>
                <div className="artifact-review-more-menu">
                  <button type="button" onClick={clearPageMarks} disabled={pageMarks.length === 0} title={ui.clear}>{ui.clear}</button>
                  <button type="button" onClick={exportProcessPackage} disabled={Object.values(marksByPage).flat().length === 0 && voiceSegments.length === 0} title={ui.export}>{ui.export}</button>
                  <button type="button" onClick={() => inputRef.current?.click()} disabled={loading || voiceRecording || voiceProcessing} title={ui.replace}>{ui.replace}</button>
                  <button type="button" onClick={() => void closeCurrentFile()} disabled={loading || voiceRecording || voiceProcessing} title={ui.close}>{ui.close}</button>
                </div>
              </details>
            </div>
            <div className="artifact-review-toolbar-actions">
              <label className="artifact-review-page-indicator">
                <span className="sr-only">{ui.pageJump}</span>
                <select aria-label={ui.pageJump} title={ui.pageJump} value={pageNumber} onChange={(event) => navigateToPage(Number(event.target.value))} disabled={rendering}>
                  {pages.map((page) => <option key={page.pageNumber} value={page.pageNumber}>{ui.page(page.pageNumber, pageCount)}</option>)}
                </select>
              </label>
              <div className="artifact-review-zoom" aria-label={ui.zoom}>
                <button type="button" onClick={() => zoomBy(-20)} disabled={zoomPercent <= 60 || rendering} aria-label={ui.zoomOut} title={ui.zoomOut}><Minus aria-hidden="true" /></button>
                <span>{zoomPercent}%</span>
                <button type="button" onClick={() => zoomBy(20)} disabled={zoomPercent >= 200 || rendering} aria-label={ui.zoomIn} title={ui.zoomIn}><Plus aria-hidden="true" /></button>
              </div>
              <button type="button" className={`artifact-review-session-button${voiceRecording ? ' recording' : ''}`} onClick={() => void (voiceRecording ? finishVoiceReview() : startVoiceReview())} disabled={!sourceHash || voiceProcessing} aria-pressed={voiceRecording} title={voiceRecording ? ui.finish : ui.start}>
                {voiceRecording ? ui.finish : ui.start}
              </button>
            </div>
          </div>
          {voiceStatus && <div role="status" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '0 0 12px', padding: 10, borderRadius: 6, background: '#f9e5df', color: '#6b3427', fontSize: 14 }}>
            <span>{voiceStatus}</span>
          </div>}
          {handoffStatus && <div role="status" style={{ margin: '0 0 12px', padding: 10, borderRadius: 8, background: handoffStatus.includes('未能') ? '#fff1f1' : '#edf8f1', color: handoffStatus.includes('未能') ? '#a61b1b' : '#17643a', fontSize: 14 }}>
            {handoffStatus}
          </div>}
          <div className="artifact-review-stage-shell">
            <button
              type="button"
              className="artifact-review-page-edge artifact-review-page-edge-previous"
              aria-label="页面左侧：上一页"
              title={locale === 'zh' ? '上一页（← / PageUp）' : 'Previous page (← / PageUp)'}
              onClick={() => navigateToPage(pageNumber - 1)}
              disabled={pageNavigation.previousDisabled}
            >
              <ChevronLeft aria-hidden="true" strokeWidth={2.4} />
            </button>
            <div ref={stageScrollRef} className="artifact-review-stage-scroll">
              <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
                <canvas ref={canvasRef} aria-label={`${artifactKind.toUpperCase()} 第 ${pageNumber} 页`} style={{ display: 'block', maxWidth: 'none', boxShadow: '0 8px 28px rgba(23, 21, 18, .16)' }} />
                {pageViewport && <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" width={pageViewport.width} height={pageViewport.height} onPointerDown={startMark} onPointerMove={moveMark} onPointerUp={finishMark} onPointerCancel={finishMark} style={{ position: 'absolute', inset: 0, touchAction: 'none', cursor: 'crosshair' }} aria-label={`${artifactKind.toUpperCase()} 第 ${pageNumber} 页批注层`}>
                  <defs><marker id="review-arrow-head" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto"><path d="M 0 0 L 12 6 L 0 12 z" fill="#dc2626" /></marker></defs>
                  {pageMarks.map((mark) => renderMark(mark))}
                  {draftMark?.pageNumber === pageNumber && renderMark(draftMark, true)}
                </svg>}
              </div>
            </div>
            <button
              type="button"
              className="artifact-review-page-edge artifact-review-page-edge-next"
              aria-label="页面右侧：下一页"
              title={locale === 'zh' ? '下一页（→ / PageDown）' : 'Next page (→ / PageDown)'}
              onClick={() => navigateToPage(pageNumber + 1)}
              disabled={pageNavigation.nextDisabled}
            >
              <ChevronRight aria-hidden="true" strokeWidth={2.4} />
            </button>
          </div>
        </>}
      </section>
    </main>
  )
}
