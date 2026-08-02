import { MoreHorizontal, Undo2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { ASRClient } from './asr-client'
import type { Locale } from './locale'
import { createInkSvgPath, pointerSamples } from './pdf-review-ink'
import { VoiceRecorder } from './voice-recorder'
import type { InteractionReviewPackage } from './interaction-review-contract'
import { handoffInteractionReviewPackage } from './interaction-review-handoff'
import { prepareWebPrototypeSource, releaseWebPrototypeSource } from './web-prototype-source'
import type { WebPrototypeSource } from './web-prototype-source'

type ReviewTool = 'interact' | 'ink' | 'circle' | 'arrow'
type Point = { x: number; y: number }
type WebMark = { id: string; kind: Exclude<ReviewTool, 'interact'>; points: Point[]; created_at_ms: number }
type CapturedEvent = {
  id: string
  kind: string
  at_ms: number
  route: string
  viewport: { width: number; height: number; scroll_x: number; scroll_y: number }
  target: null | { element_id: string | null; tag: string; role: string | null; label: string; rect: { x: number; y: number; width: number; height: number } }
  state: { route: string; title: string; scroll_x: number; scroll_y: number }
  detail: Record<string, unknown>
}
type VoiceSegment = { segment_id: string; start_ms: number; end_ms: number; text: string; confidence: number }

const CHANNEL = 'canvas-prompt-interaction-review-v1'
const DEFAULT_LOCAL_ASR_BASE_URL = 'http://127.0.0.1:18080'

export default function WebPrototypeReview({ locale, onClose, onCaptureStateChange }: { locale: Locale; onClose: () => void; onCaptureStateChange?: (busy: boolean) => void }) {
  const htmlInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const sourceRef = useRef<WebPrototypeSource | null>(null)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const sessionStartedRef = useRef(0)
  const sessionEndedMsRef = useRef<number | null>(null)
  const recordingRef = useRef(false)
  const voiceStartMsRef = useRef(0)
  const drawingRef = useRef<WebMark | null>(null)
  const [source, setSource] = useState<WebPrototypeSource | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tool, setTool] = useState<ReviewTool>('interact')
  const [marks, setMarks] = useState<WebMark[]>([])
  const [draftMark, setDraftMark] = useState<WebMark | null>(null)
  const [events, setEvents] = useState<CapturedEvent[]>([])
  const [voiceSegments, setVoiceSegments] = useState<VoiceSegment[]>([])
  const [recording, setRecording] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [asrBaseUrl, setAsrBaseUrl] = useState(DEFAULT_LOCAL_ASR_BASE_URL)
  const [viewport, setViewport] = useState<'desktop' | 'phone'>('desktop')

  const ui = locale === 'zh' ? {
    title: '网页原型审阅', intro: '上传你做好的 HTML 网页或静态网页文件夹，在画布中真实操作、口述并圈画反馈。',
    chooseHtml: '选择 HTML', chooseFolder: '选择网页文件夹', example: '查看自动演示', loading: '正在准备网页…',
    interact: '操作原型', ink: '手写', circle: '圈选', arrow: '箭头', undo: '撤销最近一笔', more: '更多操作', clear: '清除全部标注', replace: '更换网页', close: '关闭网页',
    desktop: '网页视图', phone: '手机视图', start: '开始审阅', finish: '结束审阅', export: '导出本轮记录',
  } : {
    title: 'Web prototype review', intro: 'Upload a standalone HTML file or static web folder, then use, speak, and mark feedback directly on the canvas.',
    chooseHtml: 'Choose HTML', chooseFolder: 'Choose web folder', example: 'Open automated demo', loading: 'Preparing web prototype…',
    interact: 'Use prototype', ink: 'Draw', circle: 'Circle', arrow: 'Arrow', undo: 'Undo last mark', more: 'More actions', clear: 'Clear annotations', replace: 'Replace prototype', close: 'Close prototype',
    desktop: 'Web view', phone: 'Phone view', start: 'Start review', finish: 'Finish review', export: 'Export review record',
  }

  const elapsed = () => sessionStartedRef.current
    ? (sessionEndedMsRef.current ?? Date.now()) - sessionStartedRef.current
    : 0

  useEffect(() => {
    sourceRef.current = source
    return () => releaseWebPrototypeSource(sourceRef.current)
  }, [source])

  useEffect(() => {
    onCaptureStateChange?.(recording || processing)
  }, [onCaptureStateChange, processing, recording])

  useEffect(() => {
    void fetch('/api/runtime-identity', { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() as Promise<{ asr_url?: unknown }> : null)
      .then((identity) => { if (identity && typeof identity.asr_url === 'string' && identity.asr_url) setAsrBaseUrl(identity.asr_url) })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const receive = (message: MessageEvent) => {
      if (!source || message.source !== iframeRef.current?.contentWindow || message.data?.channel !== CHANNEL) return
      if (message.data.kind === 'runtime_ready') {
        setStatus(locale === 'zh' ? '网页已就绪，点击“开始审阅”后会记录本轮操作。' : 'Prototype ready. Start the review to record this session.')
        return
      }
      if (!recordingRef.current) return
      const { kind, at_ms, route, viewport: eventViewport, target, state, detail } = message.data
      if (typeof kind !== 'string' || typeof at_ms !== 'number' || typeof route !== 'string' || !eventViewport || !state) return
      setEvents((current) => [...current, { id: `evt_${crypto.randomUUID()}`, kind, at_ms, route, viewport: eventViewport, target: target ?? null, state, detail: detail ?? {} }])
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [locale, source])

  const chooseFiles = async (files: FileList | null) => {
    if (!files?.length || recording || processing) return
    setLoading(true)
    setError(null)
    try {
      const next = await prepareWebPrototypeSource(files)
      releaseWebPrototypeSource(sourceRef.current)
      setSource(next)
      setEvents([])
      setMarks([])
      setVoiceSegments([])
      setStatus(null)
      sessionStartedRef.current = 0
      sessionEndedMsRef.current = null
      recordingRef.current = false
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
      if (htmlInputRef.current) htmlInputRef.current.value = ''
      if (folderInputRef.current) folderInputRef.current.value = ''
    }
  }

  const startReview = async () => {
    if (!source || recording || processing) return
    const recorder = new VoiceRecorder()
    recorderRef.current = recorder
    setProcessing(true)
    setError(null)
    try {
      await recorder.start()
      sessionStartedRef.current = Date.now()
      sessionEndedMsRef.current = null
      recordingRef.current = true
      voiceStartMsRef.current = 0
      setEvents([])
      setMarks([])
      setVoiceSegments([])
      setRecording(true)
      setStatus(locale === 'zh' ? '审阅中：正常操作网页，也可以切换工具圈画。' : 'Reviewing: use the prototype normally or switch tools to annotate.')
      iframeRef.current?.contentWindow?.postMessage({ channel: CHANNEL, command: 'start', elapsed_ms: 0 }, '*')
    } catch (cause) {
      recorderRef.current = null
      recordingRef.current = false
      setError(`${locale === 'zh' ? '无法开始录音' : 'Could not start audio'}：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setProcessing(false)
    }
  }

  const packageData = (segments = voiceSegments): InteractionReviewPackage => ({
    schema_version: 'interaction-review/0.1-draft',
    package_id: `irp_${source?.sourceHash.slice(0, 16)}_${Math.max(0, sessionStartedRef.current)}`,
    source: { kind: 'local-static-html', name: source!.name, entry_path: source!.entryPath, sha256: source!.sourceHash, source_bytes_in_export: false },
    session: { started_at: new Date(sessionStartedRef.current).toISOString(), duration_ms: elapsed(), capture_scope: 'explicit-session-only' },
    events,
    annotations: marks,
    transcript: segments,
    privacy: { processing: 'local_only', sensitive_input_values: 'excluded', external_network: 'blocked-by-frame-policy', full_screen_video: false },
    execution_authorized: false,
  })

  const downloadPackage = (segments = voiceSegments) => {
    if (!source || (events.length === 0 && marks.length === 0 && segments.length === 0)) {
      setStatus(locale === 'zh' ? '本轮还没有操作、标注或语音。' : 'This review has no interaction, annotation, or speech yet.')
      return
    }
    const blob = new Blob([`${JSON.stringify(packageData(segments), null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `interaction-review-${source.sourceHash.slice(0, 16)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const finishReview = async () => {
    const recorder = recorderRef.current
    if (!recorder || processing) return
    sessionEndedMsRef.current = Date.now()
    recordingRef.current = false
    setRecording(false)
    setProcessing(true)
    setStatus(locale === 'zh' ? '正在整理本轮操作、语音和标注…' : 'Preparing interaction, speech, and annotations…')
    let recordingUrl: string | null = null
    try {
      const recordingResult = await recorder.stop()
      recordingUrl = recordingResult.url
      const transcription = await new ASRClient({ baseUrl: asrBaseUrl }).transcribe(recordingResult.blob, locale === 'zh' ? 'zh' : 'en')
      const raw = transcription.segments.length ? transcription.segments : [{ start: 0, end: recordingResult.duration / 1000, text: transcription.text, confidence: 0 }]
      const segments = raw.filter((segment) => segment.text.trim()).map((segment) => ({
        segment_id: `voice_${crypto.randomUUID()}`,
        start_ms: voiceStartMsRef.current + Math.round(segment.start * 1000),
        end_ms: voiceStartMsRef.current + Math.round(segment.end * 1000),
        text: segment.text.trim(), confidence: segment.confidence,
      }))
      setVoiceSegments(segments)
      await handoffInteractionReviewPackage(packageData(segments))
      setStatus(locale === 'zh' ? `本轮已保存到本地档案：记录 ${events.length} 个操作、${marks.length} 个标注和 ${segments.length} 段语音。回到对话后，AI 会先复述理解。` : `Saved locally: ${events.length} interactions, ${marks.length} annotations, ${segments.length} speech segments. AI will restate its understanding in the conversation.`)
    } catch (cause) {
      try {
        await handoffInteractionReviewPackage(packageData())
        setStatus(`${locale === 'zh' ? '本轮操作与标注已保存，语音或整理步骤未完成' : 'Interactions and annotations were saved; speech or processing did not finish'}：${cause instanceof Error ? cause.message : String(cause)}`)
      } catch (handoffCause) {
        setStatus(`${locale === 'zh' ? '本轮未能保存' : 'Review could not be saved'}：${handoffCause instanceof Error ? handoffCause.message : String(handoffCause)}`)
      }
    } finally {
      if (recordingUrl) URL.revokeObjectURL(recordingUrl)
      recorderRef.current = null
      setProcessing(false)
    }
  }

  const pointFromEvent = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return pointerSamples(event.nativeEvent).map((sample) => ({ x: Math.max(0, Math.min(1, (sample.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (sample.clientY - bounds.top) / bounds.height)) }))
  }
  const startMark = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (tool === 'interact') return
    const [point] = pointFromEvent(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const mark: WebMark = { id: `ann_${crypto.randomUUID()}`, kind: tool, points: [point], created_at_ms: elapsed() }
    drawingRef.current = mark
    setDraftMark(mark)
  }
  const moveMark = (event: ReactPointerEvent<SVGSVGElement>) => {
    const current = drawingRef.current
    if (!current) return
    const samples = pointFromEvent(event)
    const last = samples.at(-1)
    if (!last) return
    const next = { ...current, points: current.kind === 'ink' ? [...current.points, ...samples] : [current.points[0], last] }
    drawingRef.current = next
    setDraftMark(next)
  }
  const finishMark = (event: ReactPointerEvent<SVGSVGElement>) => {
    const current = drawingRef.current
    if (!current) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (current.kind === 'ink' ? current.points.length > 1 : current.points.length === 2) setMarks((items) => [...items, current])
    drawingRef.current = null
    setDraftMark(null)
  }
  const renderMark = (mark: WebMark, draft = false) => {
    const color = draft ? '#f97316' : '#dc2626'
    if (mark.kind === 'ink') {
      const path = createInkSvgPath(mark.points, draft)
      return path ? <path key={mark.id} d={path} fill={color} opacity={draft ? 0.72 : 1} /> : null
    }
    const [start, end] = mark.points
    if (!end) return null
    if (mark.kind === 'circle') return <ellipse key={mark.id} cx={(start.x + end.x) * 500} cy={(start.y + end.y) * 500} rx={Math.abs(start.x - end.x) * 500} ry={Math.abs(start.y - end.y) * 500} fill="none" stroke={color} strokeWidth="2.5" />
    return <line key={mark.id} x1={start.x * 1000} y1={start.y * 1000} x2={end.x * 1000} y2={end.y * 1000} stroke={color} strokeWidth="2.5" markerEnd="url(#prototype-arrow-head)" />
  }

  if (!source) return <div className="web-prototype-entry">
    <input ref={htmlInputRef} type="file" accept="text/html,.html,.htm" hidden onChange={(event) => void chooseFiles(event.target.files)} />
    <input ref={folderInputRef} type="file" hidden multiple {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(event) => void chooseFiles(event.target.files)} />
    <div className="web-prototype-entry-copy"><p className="artifact-review-kicker">WEB PROTOTYPE REVIEW</p><h2>{ui.title}</h2><p>{ui.intro}</p></div>
    <div className="web-prototype-entry-actions">
      <button className="artifact-review-primary" type="button" disabled={loading} onClick={() => htmlInputRef.current?.click()}><Upload aria-hidden="true" />{loading ? ui.loading : ui.chooseHtml}</button>
      <button type="button" disabled={loading} onClick={() => folderInputRef.current?.click()}>{ui.chooseFolder}</button>
      <a href="/interaction-review-i0/index.html">{ui.example}</a>
    </div>
    <p className="web-prototype-boundary">{locale === 'zh' ? '首版支持单 HTML 或已经构建好的静态网页文件夹；外部网络和敏感输入值默认不采集。' : 'This first slice accepts a standalone HTML file or built static folder. External network and sensitive input values are excluded.'}</p>
    {error && <p role="alert" className="web-prototype-error">{error}</p>}
  </div>

  return <div className="web-prototype-workspace">
    <input ref={htmlInputRef} type="file" accept="text/html,.html,.htm" hidden onChange={(event) => void chooseFiles(event.target.files)} />
    <div className="artifact-review-toolbar web-prototype-toolbar">
      <div className="artifact-review-tools" role="toolbar" aria-label={ui.title}>
        {([['interact', ui.interact], ['ink', ui.ink], ['circle', ui.circle], ['arrow', ui.arrow]] as Array<[ReviewTool, string]>).map(([value, label]) => <button key={value} type="button" className={tool === value ? 'active' : ''} aria-pressed={tool === value} onClick={() => setTool(value)} title={label}>{label}</button>)}
        <button type="button" className="artifact-review-icon-button" disabled={!marks.length} onClick={() => setMarks((items) => items.slice(0, -1))} aria-label={ui.undo} title={ui.undo}><Undo2 aria-hidden="true" /></button>
        <details className="artifact-review-more"><summary title={ui.more}><MoreHorizontal aria-hidden="true" /></summary><div className="artifact-review-more-menu">
          <button type="button" disabled={!marks.length} onClick={() => setMarks([])}>{ui.clear}</button>
          <button type="button" disabled={recording || processing} onClick={() => htmlInputRef.current?.click()}>{ui.replace}</button>
          <button type="button" disabled={recording || processing} onClick={onClose}>{ui.close}</button>
          <a href="/interaction-review-i0/index.html">{ui.example}</a>
        </div></details>
      </div>
      <div className="artifact-review-toolbar-actions">
        <div className="web-prototype-view-toggle"><button type="button" className={viewport === 'desktop' ? 'active' : ''} onClick={() => setViewport('desktop')}>{ui.desktop}</button><button type="button" className={viewport === 'phone' ? 'active' : ''} onClick={() => setViewport('phone')}>{ui.phone}</button></div>
        {!recording && sessionStartedRef.current > 0 && <button type="button" onClick={() => downloadPackage()} disabled={processing}>{ui.export}</button>}
        <button type="button" className={`artifact-review-session-button${recording ? ' recording' : ''}`} disabled={processing} onClick={() => void (recording ? finishReview() : startReview())}>{recording ? ui.finish : ui.start}</button>
      </div>
    </div>
    {status && <div className="web-prototype-status" role="status">{status}</div>}
    {error && <p role="alert" className="web-prototype-error">{error}</p>}
    <div className={`web-prototype-stage ${viewport}`}>
      <div className="web-prototype-frame">
        <iframe ref={iframeRef} title={source.name} srcDoc={source.srcDoc} sandbox="allow-scripts allow-forms allow-modals" />
        <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className={`web-prototype-annotation-layer${tool === 'interact' ? ' passthrough' : ''}`} onPointerDown={startMark} onPointerMove={moveMark} onPointerUp={finishMark} onPointerCancel={finishMark}>
          <defs><marker id="prototype-arrow-head" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto"><path d="M 0 0 L 12 6 L 0 12 z" fill="#dc2626" /></marker></defs>
          {marks.map((mark) => renderMark(mark))}{draftMark && renderMark(draftMark, true)}
        </svg>
      </div>
    </div>
  </div>
}
