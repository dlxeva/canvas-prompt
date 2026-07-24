import { Excalidraw, convertToExcalidrawElements, exportToBlob } from '@excalidraw/excalidraw'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { countCanvasElements, diffScene, emptyElementCounts } from './excalidraw-adapter'
import type { CanvasElement, ElementCounts, TraceEvent } from './excalidraw-adapter'
import type { ExcalidrawImperativeAPI, NormalizedZoomValue } from '@excalidraw/excalidraw/types'
import { VoiceRecorder } from './voice-recorder'
import type { RecordingResult } from './voice-recorder'
import { VoiceTranscriber } from './voice-transcriber'
import type { TranscriptionResult } from './voice-transcriber'
import { asrClient } from './asr-client'
import { WindowedAsrSession } from './windowed-asr'
import type { AsrWindowProgress } from './windowed-asr'
import { compactTraceToCognitiveEvents, buildPointerTrack } from './excalidraw-cognitive-events'
import { compilePromptPackage, validatePromptPackage } from './prompt-package-compiler'
import type { CanvasObject, PromptPackage } from './prompt-package-compiler'

type CanvasTool = 'selection' | 'freedraw' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'eraser'
type HistoryAction = 'undo' | 'redo'

const tools: Array<{ id: CanvasTool; label: string; hint: string }> = [
  { id: 'selection', label: '选择', hint: '移动、缩放、框选' },
  { id: 'freedraw', label: '画笔', hint: '自由手绘' },
  { id: 'line', label: '直线', hint: '直线输入' },
  { id: 'arrow', label: '箭头', hint: '快速连接两个对象' },
  { id: 'rectangle', label: '矩形', hint: '矩形或方形' },
  { id: 'ellipse', label: '圆形', hint: '椭圆；按 Shift 画正圆' },
  { id: 'eraser', label: '擦除', hint: '删除笔迹或对象' },
]

const strokeColors = ['#1e1e1e', '#64748b', '#2563eb', '#7c3aed', '#dc2626', '#ea580c', '#16a34a', '#0f766e']
const strokeWidths = [1, 2, 4]

function ToolIcon({ tool }: { tool: CanvasTool }) {
  const shared = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const content = {
    selection: <><path {...shared} d="m4 3 7 15 2.1-6.1L19 10 4 3Z" /><path {...shared} d="m13 12 4 5" /></>,
    freedraw: <><path {...shared} d="m5 18 2.3-6.6L15.8 3a2.1 2.1 0 0 1 3 3l-8.4 8.5L5 18Z" /><path {...shared} d="m13.7 5.2 3 3" /></>,
    line: <path {...shared} d="m4 18 16-12" />,
    arrow: <><path {...shared} d="M4 18 18 5" /><path {...shared} d="M12 5h6v6" /></>,
    rectangle: <rect {...shared} x="4" y="5" width="16" height="14" rx="1.5" />,
    ellipse: <ellipse {...shared} cx="12" cy="12" rx="8" ry="6.5" />,
    eraser: <><path {...shared} d="m7 18-3-3 8-10 7 7-5 6H7Z" /><path {...shared} d="M14 18h6" /></>,
  }[tool]
  return <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true">{content}</svg>
}

type SessionStage = 'idle' | 'starting' | 'recording' | 'compiling' | 'ready' | 'error'
type ExportStatus = 'idle' | 'exporting' | 'saved' | 'error'
type StoredRound = {
  package_id: string
  exported_at: string
  duration_ms: number | null
  status: string
  has_snapshot: boolean
  has_audio: boolean
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const url = URL.createObjectURL(blob)
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取导出截图尺寸'))
    }
    image.src = url
  })
}

function sceneBounds(elements: readonly CanvasElement[]) {
  const visible = elements.filter((element) => !element.isDeleted)
  if (visible.length === 0) return { x: 0, y: 0, width: 1, height: 1 }
  const left = Math.min(...visible.map((element) => element.x))
  const top = Math.min(...visible.map((element) => element.y))
  const right = Math.max(...visible.map((element) => element.x + element.width))
  const bottom = Math.max(...visible.map((element) => element.y + element.height))
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

export default function App() {
  const [recording, setRecording] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [events, setEvents] = useState<TraceEvent[]>([])
  const [nowMs, setNowMs] = useState(Date.now())
  const [elementCounts, setElementCounts] = useState<ElementCounts>(emptyElementCounts)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [activeTool, setActiveTool] = useState<CanvasTool>('freedraw')
  const [toolsCollapsed, setToolsCollapsed] = useState(false)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [strokeColor, setStrokeColor] = useState(strokeColors[0])
  const [strokeWidth, setStrokeWidth] = useState(1)
  const [sessionStage, setSessionStage] = useState<SessionStage>('idle')
  const [workflowMessage, setWorkflowMessage] = useState('画下来，圈出来，需要时说出来。')
  const [asrProgress, setAsrProgress] = useState<AsrWindowProgress>({ completed: 0, pending: 0, failed: 0, active: 0 })
  const [compiledPackage, setCompiledPackage] = useState<PromptPackage | null>(null)
  const [lastRecording, setLastRecording] = useState<RecordingResult | null>(null)
  const [transcription, setTranscription] = useState<TranscriptionResult | null>(null)
  const [exportStatus, setExportStatus] = useState<ExportStatus>('idle')
  const [storedRounds, setStoredRounds] = useState<StoredRound[]>([])
  const [storageOpen, setStorageOpen] = useState(false)
  const [storageLoading, setStorageLoading] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [imageImporting, setImageImporting] = useState(false)
  const [imageNotice, setImageNotice] = useState<string | null>(null)
  const [imageDropActive, setImageDropActive] = useState(false)
  const versions = useRef(new Map<string, {
    version: number
    isDeleted: boolean
    bounds: { x: number; y: number; width: number; height: number }
  }>())
  const trace = useRef<TraceEvent[]>([])
  const latestCounts = useRef(elementCounts)
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const transcriberRef = useRef<VoiceTranscriber | null>(null)
  const windowedAsrRef = useRef<WindowedAsrSession | null>(null)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const audioRunning = useRef(false)
  const pointerSamples = useRef<Array<{ t: number; x: number; y: number; speed?: number; pressure?: number }>>([])
  const lastPointer = useRef<{ t: number; x: number; y: number } | null>(null)
  const lastPointerSampleAt = useRef(0)
  const baselineImageIds = useRef(new Set<string>())

  const bindCanvasApi = useCallback((canvasApi: ExcalidrawImperativeAPI) => {
    apiRef.current = canvasApi
    setApi(canvasApi)
  }, [])

  if (recorderRef.current === null) {
    recorderRef.current = new VoiceRecorder(
      { format: 'webm', levelInterval: 50 },
      { onDataAvailable: (chunk) => transcriberRef.current?.addAudioChunk(chunk) },
    )
  }

  const elapsed = useMemo(() => {
    if (!startedAt) return '00:00'
    const seconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000))
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }, [startedAt, nowMs])

  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [recording])

  const beginTrace = async () => {
    if (recording || sessionStage === 'compiling') return
    setSessionStage('starting')
    setWorkflowMessage('正在准备本次推演…')
    setAsrProgress({ completed: 0, pending: 0, failed: 0, active: 0 })
    const baseline = (apiRef.current ?? api)?.getSceneElementsIncludingDeleted() ?? []
    versions.current = new Map(baseline.map((element) => [element.id, {
      version: element.version,
      isDeleted: element.isDeleted,
      bounds: { x: element.x, y: element.y, width: element.width, height: element.height },
    }]))
    // A review round may start after the user has placed a source image on the
    // board.  Keep that substrate, but do not leak unrelated old whiteboard
    // content into the current round screenshot/context.
    baselineImageIds.current = new Set(baseline.filter((element) => element.type === 'image' && !element.isDeleted).map((element) => element.id))
    trace.current = []
    setEvents([])
    pointerSamples.current = []
    lastPointer.current = null
    lastPointerSampleAt.current = 0
    setCompiledPackage(null)
    setLastRecording(null)
    setTranscription(null)
    setExportStatus('idle')
    setImageNotice(null)
    const start = Date.now()
    setStartedAt(start)
    setNowMs(start)
    setRecording(true)
    audioRunning.current = false
    try {
      await recorderRef.current?.start()
      audioRunning.current = true
      const stream = recorderRef.current?.createInputStreamClone()
      if (stream && typeof MediaRecorder !== 'undefined') {
        windowedAsrRef.current = new WindowedAsrSession({
          stream,
          language: 'zh-CN',
          windowMs: 25_000,
          overlapMs: 3_000,
          onProgress: setAsrProgress,
        })
        windowedAsrRef.current.start()
        transcriberRef.current = null
        setWorkflowMessage('推演中 · 画、圈、移动，也可以直接说。语音会在后台分段整理。')
      } else {
        // Fallback for browsers without a second MediaRecorder stream.
        transcriberRef.current = new VoiceTranscriber({ strategy: 'doubao-asr', language: 'zh', asrServerUrl: 'http://localhost:8080' })
        await transcriberRef.current.start()
        setWorkflowMessage('推演中 · 画、圈、移动，也可以直接说。')
      }
    } catch {
      setWorkflowMessage('推演中 · 麦克风不可用，但画布过程仍会被记录。')
    }
    setSessionStage('recording')
  }

  const finishTrace = async () => {
    if (!recording || !startedAt) return
    setRecording(false)
    setEvents([...trace.current])
    setSessionStage('compiling')
    setWorkflowMessage('正在结束录音…')
    try {
      let audio: RecordingResult | null = null
      const backgroundSession = windowedAsrRef.current
      const backgroundTranscript = backgroundSession?.stop() ?? null
      if (audioRunning.current) {
        try {
          audio = await recorderRef.current?.stop() ?? null
          setLastRecording(audio)
        } catch {
          audio = null
        }
      }
      setWorkflowMessage('正在完成最后的语音片段…')
      let transcript: TranscriptionResult | null = null
      if (backgroundTranscript) {
        try {
          transcript = await backgroundTranscript
        } catch {
          transcript = null
        }
      } else if (transcriberRef.current) {
        try {
          transcript = await transcriberRef.current.stop()
        } catch {
          transcript = null
        }
      }
      // Do not export a partial timeline just because some windows succeeded.
      // The raw archival recording is the authoritative recovery source.
      if ((!transcript?.text || backgroundSession?.hasFailures()) && audio?.blob) {
        if (backgroundSession?.hasFailures()) setWorkflowMessage('少量语音片段需要回退补齐…')
        try {
          const result = await asrClient.transcribe(audio.blob, 'zh')
          transcript = {
            text: result.text,
            segments: result.segments.map((segment) => ({ text: segment.text, startMs: segment.start * 1000, endMs: segment.end * 1000, confidence: segment.confidence, isFinal: true })),
            language: result.language,
            strategy: 'doubao-asr',
            durationMs: result.duration * 1000,
          }
        } catch {
          // Audio is kept with the export even when a local ASR service is absent.
        }
      }
      setTranscription(transcript)
      setWorkflowMessage('正在整理画布和标记…')
      const elements = api?.getSceneElements() ?? []
      const baseArtifacts: CanvasObject[] = elements
        .filter((element) => baselineImageIds.current.has(element.id) && element.type === 'image' && !element.isDeleted)
        .map((element) => ({
          object_id: `obj_${element.id}`,
          type: 'image',
          timestamp_ms: 0,
          bounds: { x: element.x, y: element.y, width: element.width, height: element.height },
          properties: { base_artifact: true, asset_id: 'fileId' in element ? element.fileId ?? null : null },
        }))
      const currentRoundIds = new Set(trace.current
        .filter((event) => event.kind !== 'delete')
        .map((event) => event.element.id))
      baselineImageIds.current.forEach((id) => currentRoundIds.add(id))
      const roundElements = elements.filter((element) => currentRoundIds.has(element.id))
      const screenshotBlob = await exportToBlob({ elements: roundElements, appState: api?.getAppState(), files: api?.getFiles() ?? null, mimeType: 'image/png', exportPadding: 24 })
      const [screenshot, snapshotSize] = await Promise.all([blobToDataUrl(screenshotBlob), imageDimensions(screenshotBlob)])
      const exportedSceneBounds = sceneBounds(roundElements)
      setWorkflowMessage('正在准备本轮上下文…')
      const cognitiveEvents = compactTraceToCognitiveEvents(trace.current)
      const pointerTrack = buildPointerTrack(pointerSamples.current)
      const segments = transcript?.segments
        .filter((segment) => segment.isFinal && segment.text.trim())
        .map((segment, index) => ({ segment_id: `seg_${String(index + 1).padStart(3, '0')}`, start_ms: segment.startMs, end_ms: segment.endMs, text: segment.text.trim(), confidence: segment.confidence }))
      const pkg = compilePromptPackage(cognitiveEvents, transcript?.text ?? '', screenshot, {
        canvasSize: { width: exportedSceneBounds.width, height: exportedSceneBounds.height, unit: 'scene' },
        snapshotSize,
        coordinateSystem: {
          space: 'excalidraw_scene',
          unit: 'scene',
          origin: { x: exportedSceneBounds.x, y: exportedSceneBounds.y },
          x_axis: 'right',
          y_axis: 'down',
        },
        language: transcript?.language || 'zh-CN',
        tags: ['canvas-prompt', 'excalidraw', ...(baseArtifacts.length > 0 ? ['image-review'] : [])],
        baseArtifacts,
      }, segments && segments.length > 0 ? segments : undefined, pointerTrack)
      // MediaRecorder may flush its final chunk after the click that ends a
      // round. The package duration must still cover timestamped evidence.
      const evidenceEndMs = Math.max(
        audio?.duration ?? 0,
        ...cognitiveEvents.map((event) => event.timestamp),
        ...(segments ?? []).map((segment) => segment.end_ms),
      )
      pkg.meta.duration_ms = Math.max(pkg.meta.duration_ms, evidenceEndMs)
      const validation = validatePromptPackage(pkg)
      if (!validation.valid) throw new Error(validation.errors.join('；'))
      setCompiledPackage(pkg)
      setWorkflowMessage(transcript?.text
        ? '本轮内容已整理完成。导出后会作为主对话的上下文。'
        : '本轮内容已整理完成；当前没有可用的语音转写。')
      setSessionStage('ready')
    } catch (error) {
      setWorkflowMessage(`整理失败：${error instanceof Error ? error.message : '请重试'}`)
      setSessionStage('error')
    } finally {
      audioRunning.current = false
      transcriberRef.current = null
      windowedAsrRef.current = null
    }
  }

  const exportPromptPackage = async () => {
    if (!compiledPackage) return
    setExportStatus('exporting')
    setWorkflowMessage('正在保存这轮推演…')
    const payload = {
      ...compiledPackage,
      source: { canvas: 'excalidraw', trace: trace.current, audio: lastRecording ? { mime_type: lastRecording.blob.type, duration_ms: lastRecording.duration } : null },
    }

    try {
      if (lastRecording) {
        const audioResponse = await fetch(`/api/round-audio/${compiledPackage.meta.package_id}`, {
          method: 'POST',
          headers: { 'content-type': lastRecording.blob.type || 'audio/webm' },
          body: lastRecording.blob,
        })
        if (!audioResponse.ok) throw new Error('本轮录音未能保存到本地档案')
      }
      const response = await fetch('/api/prompt-package', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(compiledPackage),
      })
      const result = await response.json().catch(() => null) as { ok?: boolean; error?: string; engine?: { error?: string } } | null
      if (!response.ok || !result?.ok) throw new Error(result?.error || result?.engine?.error || `本轮上下文未能归档（${response.status}）`)
      setExportStatus('saved')
      setWorkflowMessage('本轮已保存到本地档案。现在可让 Codex 读取最新的 Canvas Prompt Package。')
      if (storageOpen) void loadStoredRounds()
      window.dispatchEvent(new Event('canvas-prompt-exported'))
    } catch (error) {
      setExportStatus('error')
      setWorkflowMessage(`本轮未能保存：${error instanceof Error ? error.message : '请重试'}`)
    }
  }

  const loadStoredRounds = async () => {
    setStorageLoading(true)
    try {
      const response = await fetch('/api/rounds')
      if (!response.ok) throw new Error('无法读取本地档案')
      const result = await response.json() as { rounds?: StoredRound[] }
      setStoredRounds(result.rounds ?? [])
    } catch {
      setWorkflowMessage('无法读取本地档案；请稍后重试。')
    } finally {
      setStorageLoading(false)
    }
  }

  const openStorage = async () => {
    setMoreOpen(false)
    setStorageOpen(true)
    await loadStoredRounds()
  }

  const deleteStoredRound = async (round: StoredRound) => {
    if (!window.confirm(`删除这轮本地档案？\n\n${round.package_id}\n这会删除画布快照、录音、过程包和编译产物，无法恢复。`)) return
    try {
      const response = await fetch(`/api/rounds/${round.package_id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('删除失败')
      setStoredRounds((rounds) => rounds.filter((item) => item.package_id !== round.package_id))
    } catch {
      setWorkflowMessage('删除本地档案失败；原始文件没有被确认删除。')
    }
  }

  const activateTool = (tool: CanvasTool) => {
    const canvasApi = apiRef.current ?? api
    setActiveTool(tool)
    if (!canvasApi) {
      setImageNotice('画布正在准备工具，请稍后再试。')
      return
    }
    canvasApi.setActiveTool({ type: tool })
    canvasApi.updateScene({ appState: { currentItemStrokeColor: strokeColor, currentItemStrokeWidth: strokeWidth } })
  }

  const importImageFile = async (file: File | undefined) => {
    const canvasApi = apiRef.current ?? api
    if (!file) return
    if (!canvasApi) {
      setImageNotice('画布尚未准备好，请等一秒后重试。')
      return
    }

    const supportedTypes = new Set([
      'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
      'image/bmp', 'image/x-icon', 'image/avif', 'image/jfif',
    ])
    const inferredImageType = file.type || (file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : file.name.toLowerCase().endsWith('.png') ? 'image/png' : '')
    if (!supportedTypes.has(inferredImageType)) {
      setImageNotice('只支持 PNG、JPG、WebP、GIF、SVG、BMP、ICO 或 AVIF 图片。')
      return
    }
    if (file.size > 25 * 1024 * 1024) {
      setImageNotice('图片超过 25MB；请压缩后再导入，避免画布失去响应。')
      return
    }

    setImageImporting(true)
    setImageNotice(`正在导入「${file.name}」…`)
    try {
      const [dataURL, dimensions] = await Promise.all([
        blobToDataUrl(file),
        new Promise<{ width: number; height: number }>((resolve, reject) => {
          const source = new Image()
          const url = URL.createObjectURL(file)
          source.onload = () => {
            URL.revokeObjectURL(url)
            resolve({ width: source.naturalWidth, height: source.naturalHeight })
          }
          source.onerror = () => {
            URL.revokeObjectURL(url)
            reject(new Error('浏览器无法读取这张图片'))
          }
          source.src = url
        }),
      ])
      if (!dimensions.width || !dimensions.height) throw new Error('图片尺寸无效')

      const fileId = `canvas-image-${crypto.randomUUID()}`
      const maxSide = 720
      const scale = Math.min(1, maxSide / Math.max(dimensions.width, dimensions.height))
      const width = Math.max(1, Math.round(dimensions.width * scale))
      const height = Math.max(1, Math.round(dimensions.height * scale))
      const state = canvasApi.getAppState()
      const x = -state.scrollX + (state.width / state.zoom.value - width) / 2
      const y = -state.scrollY + (state.height / state.zoom.value - height) / 2

      canvasApi.addFiles([{
        id: fileId as never,
        dataURL: dataURL as never,
        mimeType: inferredImageType as never,
        created: Date.now(),
      }])
      const imageElement = convertToExcalidrawElements([{
        type: 'image', fileId: fileId as never, x, y, width, height,
      }])
      canvasApi.updateScene({ elements: [...canvasApi.getSceneElementsIncludingDeleted(), ...imageElement] })
      canvasApi.setActiveTool({ type: 'selection' })
      setActiveTool('selection')
      // A newly imported review substrate must not inherit the previous
      // round's ready-to-send state.
      if (!recording) {
        setCompiledPackage(null)
        setExportStatus('idle')
        setSessionStage('idle')
      }
      setImageNotice(`已导入「${file.name}」，现在可以圈画和说明。`)
    } catch (error) {
      setImageNotice(`图片未导入：${error instanceof Error ? error.message : '请换一张图片重试'}`)
    } finally {
      setImageImporting(false)
    }
  }

  const importImage = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Reset immediately so choosing the same file after a failed attempt still
    // triggers onChange.
    event.target.value = ''
    void importImageFile(file)
  }

  const handleExternalDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setImageDropActive(true)
  }

  const handleExternalDrop = (event: React.DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    setImageDropActive(false)
    void importImageFile(event.dataTransfer.files[0])
  }

  const changeZoom = (factor: number) => {
    const canvasApi = apiRef.current ?? api
    if (!canvasApi) return
    const current = canvasApi.getAppState().zoom.value
    const next = Math.max(0.5, Math.min(2, current * factor))
    canvasApi.updateScene({ appState: { zoom: { value: next as NormalizedZoomValue } } })
    setZoomPercent(Math.round(next * 100))
  }

  const changeStrokeColor = (color: string) => {
    const canvasApi = apiRef.current ?? api
    if (!canvasApi) return
    canvasApi.updateScene({ appState: { currentItemStrokeColor: color } })
    setStrokeColor(color)
  }

  const changeStrokeWidth = (width: number) => {
    const canvasApi = apiRef.current ?? api
    if (!canvasApi) return
    canvasApi.updateScene({ appState: { currentItemStrokeWidth: width } })
    setStrokeWidth(width)
  }

  const triggerHistoryAction = (action: HistoryAction) => {
    // The native buttons own Excalidraw's history state. Keep them in the DOM
    // but hidden, and use their real click handlers from our compact toolbar.
    const label = action === 'undo' ? 'Undo' : 'Redo'
    const nativeButton = document.querySelector<HTMLButtonElement>(`.spike-canvas [aria-label="${label}"]`)
    if (nativeButton && !nativeButton.disabled) nativeButton.click()
  }

  const handleChange = useCallback((elements: readonly CanvasElement[], appState?: { zoom: { value: number }; currentItemStrokeColor?: string; currentItemStrokeWidth?: number }) => {
    const nextCounts = countCanvasElements(elements)
    if (
      nextCounts.total !== latestCounts.current.total ||
      nextCounts.freedraw !== latestCounts.current.freedraw ||
      nextCounts.lines !== latestCounts.current.lines ||
      nextCounts.arrows !== latestCounts.current.arrows ||
      nextCounts.shapes !== latestCounts.current.shapes ||
      nextCounts.images !== latestCounts.current.images
    ) {
      latestCounts.current = nextCounts
      setElementCounts(nextCounts)
    }
    if (appState) {
      setZoomPercent(Math.round(appState.zoom.value * 100))
      if (appState.currentItemStrokeColor) setStrokeColor(appState.currentItemStrokeColor)
      if (appState.currentItemStrokeWidth) setStrokeWidth(appState.currentItemStrokeWidth)
    }
    if (!recording || !startedAt) return

    const result = diffScene(versions.current, elements, Date.now() - startedAt)
    versions.current = result.next
    if (result.events.length > 0) {
      trace.current.push(...result.events)
      setEvents([...trace.current])
    }
  }, [recording, startedAt])

  const latestEvent = events.at(-1)

  const capturePointer = (event: React.PointerEvent<HTMLElement>) => {
    if (!recording || !startedAt || !api) return
    const now = Date.now()
    if (now - lastPointerSampleAt.current < 100) return
    lastPointerSampleAt.current = now
    const state = api.getAppState()
    const x = (event.clientX - state.offsetLeft) / state.zoom.value - state.scrollX
    const y = (event.clientY - state.offsetTop) / state.zoom.value - state.scrollY
    const t = now - startedAt
    const previous = lastPointer.current
    const speed = previous ? Math.hypot(x - previous.x, y - previous.y) / Math.max(1, t - previous.t) : 0
    pointerSamples.current.push({ t, x, y, speed, pressure: event.pressure || undefined })
    lastPointer.current = { t, x, y }
  }

  return (
    <main className="spike-shell">
      <input
        id="canvas-image-import"
        ref={imageInputRef}
        className="image-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/bmp,image/x-icon,image/avif,image/jfif"
        onChange={importImage}
      />
      <header className="spike-header">
        <div className="brand-lockup">
          <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
          <p className="eyebrow">canvas_prompt<span>_</span></p>
        </div>
        <div className="header-actions">
          <button className="button image-import" type="button" disabled={imageImporting} onClick={() => imageInputRef.current?.click()}>
            {imageImporting ? '正在导入…' : '导入图片'}
          </button>
          <div className="more-menu">
            <button className="button more-button" type="button" onClick={() => setMoreOpen((open) => !open)} aria-expanded={moreOpen} aria-label="更多功能">•••</button>
            {moreOpen && <div className="more-popover"><button type="button" onClick={() => void openStorage()}>本地档案</button></div>}
          </div>
          {recording ? <span className="recording-state" aria-live="polite"><i />录音中 {elapsed}</span> : null}
          {recording ? (
            <button className="button stop" onClick={() => void finishTrace()}>结束推演</button>
          ) : sessionStage === 'compiling' ? (
            <div className="compile-progress" role="status" aria-live="polite" aria-label={workflowMessage}>
              <div className="compile-progress-copy"><span>{workflowMessage}</span><strong>{asrProgress.completed > 0 ? `已整理 ${asrProgress.completed} 段` : '处理中'}</strong></div>
              <small>{asrProgress.pending > 0 ? `${asrProgress.pending} 段正在处理` : asrProgress.failed > 0 ? `${asrProgress.failed} 段待回退处理` : '不会重跑已完成的语音片段'}</small>
            </div>
          ) : sessionStage === 'ready' && exportStatus !== 'saved' ? (
            <button className="button primary" onClick={() => void exportPromptPackage()} disabled={exportStatus === 'exporting'}>{exportStatus === 'exporting' ? '正在导出…' : exportStatus === 'error' ? '重新导出本轮' : '导出本轮'}</button>
          ) : sessionStage === 'ready' && exportStatus === 'saved' ? (
            <><span className="receipt-status" role="status">✓ 本轮已保存</span><button className="button primary" onClick={() => void beginTrace()}>开始下一轮</button></>
          ) : (
            <button className="button primary" onClick={() => void beginTrace()} disabled={sessionStage === 'starting'}>{sessionStage === 'starting' ? '准备中…' : '开始推演'}</button>
          )}
        </div>
      </header>

      <div className="status-stack">
        {imageNotice && <div className="image-notice" role="status">{imageNotice}</div>}

        <section className={recording || sessionStage === 'compiling' || sessionStage === 'error' || exportStatus === 'error' ? 'guide' : 'guide guide-empty'} aria-label="当前推演状态">
          {(recording || sessionStage === 'compiling' || sessionStage === 'error' || exportStatus === 'error') && <>
            <span>{workflowMessage}</span>
            <strong>{sessionStage === 'compiling' ? (asrProgress.completed > 0 ? `后台已完成 ${asrProgress.completed} 段语音整理；结束时只收尾未完成片段。` : '正在完成第一段语音整理。') : sessionStage === 'error' ? '本轮尚未发送；可重新开始。' : exportStatus === 'error' ? '原始录音已保留在本地档案；修复后可直接重新发送。' : asrProgress.completed > 0 ? `后台已整理 ${asrProgress.completed} 段语音，不会打断当前推演。` : '画、圈、移动与语音会记录在这一轮。'}</strong>
          </>}
        </section>
      </div>

      <section
        className={imageDropActive ? 'canvas-wrap spike-canvas drop-active' : 'canvas-wrap spike-canvas'}
        onPointerMove={capturePointer}
        onDragOver={handleExternalDragOver}
        onDragLeave={() => setImageDropActive(false)}
        onDrop={handleExternalDrop}
      >
        <nav
          className={toolsCollapsed ? 'canvas-tools collapsed' : 'canvas-tools'}
          aria-label="画布工具"
        >
          {toolsCollapsed ? (
            <button
              type="button"
              className="menu-toggle"
              onClick={() => setToolsCollapsed(false)}
              aria-label="展开画布工具"
              title="展开工具"
            >
              <span aria-hidden="true">☰</span>
            </button>
          ) : <>
            <div className="tool-row">
              <button type="button" className="canvas-tool history-tool" onClick={() => triggerHistoryAction('undo')} title="撤销（⌘Z）" aria-label="撤销">↶</button>
              <button type="button" className="canvas-tool history-tool" onClick={() => triggerHistoryAction('redo')} title="重做（⇧⌘Z）" aria-label="重做">↷</button>
              <span className="tool-divider" />
              {tools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={activeTool === tool.id ? 'canvas-tool active' : 'canvas-tool'}
                onClick={() => activateTool(tool.id)}
                title={tool.hint}
                aria-label={tool.label}
                aria-pressed={activeTool === tool.id}
              >
                <ToolIcon tool={tool.id} />
              </button>
            ))}
              <button type="button" className="zoom-button" onClick={() => changeZoom(0.8)} aria-label="缩小">−</button>
              <span className="zoom-label">{zoomPercent}%</span>
              <button type="button" className="zoom-button" onClick={() => changeZoom(1.25)} aria-label="放大">＋</button>
              <button
                type="button"
                className="menu-toggle"
                onClick={() => setToolsCollapsed(true)}
                aria-label="收起画布工具"
                title="收起工具"
              >
                <span aria-hidden="true">‹</span>
              </button>
            </div>
            <div className="style-row" aria-label="画笔样式">
              <span className="style-label">颜色</span>
              {strokeColors.map((color) => (
              <button
                key={color}
                type="button"
                className={strokeColor === color ? 'color-swatch active' : 'color-swatch'}
                style={{ '--swatch': color } as React.CSSProperties}
                onClick={() => changeStrokeColor(color)}
                aria-label={`颜色 ${color}`}
                aria-pressed={strokeColor === color}
              />
            ))}
              <span className="style-label width-label">粗细</span>
              {strokeWidths.map((width) => (
              <button
                key={width}
                type="button"
                className={strokeWidth === width ? 'width-swatch active' : 'width-swatch'}
                onClick={() => changeStrokeWidth(width)}
                aria-label={`${width} 号线宽`}
                aria-pressed={strokeWidth === width}
              >
                <i style={{ height: width + 1 }} />
              </button>
              ))}
            </div>
          </>}
        </nav>
        <Excalidraw
          excalidrawAPI={bindCanvasApi}
          onChange={handleChange}
          initialData={{ appState: { currentItemStrokeColor: strokeColors[0], currentItemStrokeWidth: 1 } }}
          UIOptions={{
            tools: { image: false },
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              loadScene: false,
              saveToActiveFile: false,
              saveAsImage: false,
              toggleTheme: false,
              export: { saveFileToDisk: false },
            },
          }}
        />
        {imageDropActive && <div className="drop-image-hint" aria-hidden="true">松开以导入图片</div>}
      </section>

      {storageOpen && <div className="storage-backdrop" role="presentation" onClick={() => setStorageOpen(false)}>
        <section className="storage-dialog" role="dialog" aria-modal="true" aria-label="本地档案" onClick={(event) => event.stopPropagation()}>
          <div className="storage-dialog-head">
            <div><h2>本地档案</h2><p>保存在本项目的 <code>.canvas-prompt/rounds</code>。不自动上传云端；删除后无法恢复。</p></div>
            <button className="dialog-close" type="button" onClick={() => setStorageOpen(false)} aria-label="关闭本地档案">×</button>
          </div>
          <div className="storage-list">
            {storageLoading ? <p>正在读取本地档案…</p> : storedRounds.length === 0 ? <p>还没有已归档的推演。</p> : storedRounds.map((round) => (
              <article className="storage-item" key={round.package_id}>
                <div><strong>{new Date(round.exported_at).toLocaleString('zh-CN')}</strong><span>{round.duration_ms ? `${Math.round(round.duration_ms / 1000)} 秒` : '时长未知'} · {round.has_snapshot ? '画布快照' : '无快照'} · {round.has_audio ? '录音' : '无录音'}</span></div>
                <div className="storage-item-actions"><span className="round-local">本地已保存</span><button type="button" onClick={() => void deleteStoredRound(round)}>删除</button></div>
              </article>
            ))}
          </div>
        </section>
      </div>}
    </main>
  )
}
