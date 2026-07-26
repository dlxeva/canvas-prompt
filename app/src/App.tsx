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
import type { BaselineContext, CanvasObject, Keyframe, PromptPackage, ViewTransformation } from './prompt-package-compiler'
import { appendViewTransformation } from './view-transform'
import { countIncludedBaselineObjects, projectLiveRoundElementIds } from './baseline-projection'
import { deriveExportReceiptStatus, isReceiptComplete } from './receipt-state'
import type { ExportReceiptStatus, HandoffReceipt } from './receipt-state'
import { protectedLocalApiFetch } from './protected-local-api'
import { resolveInitialLocale, saveLocalePreference } from './locale'
import type { Locale } from './locale'

type CanvasTool = 'selection' | 'freedraw' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'eraser'
type HistoryAction = 'undo' | 'redo'
const tools: Array<{ id: CanvasTool; zh: string; en: string }> = [
  { id: 'selection', zh: '选择', en: 'Select' },
  { id: 'freedraw', zh: '画笔', en: 'Draw' },
  { id: 'line', zh: '直线', en: 'Line' },
  { id: 'arrow', zh: '箭头', en: 'Arrow' },
  { id: 'rectangle', zh: '矩形', en: 'Rectangle' },
  { id: 'ellipse', zh: '圆形', en: 'Ellipse' },
  { id: 'eraser', zh: '擦除', en: 'Erase' },
]

const ui = {
  zh: { importImage: '导入图片', importing: '正在导入…', more: '更多功能', archive: '本地档案', recording: '录音中', asrUnavailable: '语音仅保存', finish: '结束推演', processing: '处理中', export: '发送到当前对话', retryExport: '重新发送到当前对话', sending: '正在发送…', archived: '✓ 已保存到本地', accepted: '✓ 已送入主对话', deliveredReceipt: '✓ 主对话已完成处理', failedReceipt: '已保存 · 推送失败', next: '开始下一轮', start: '开始推演', preparing: '准备中…', canvasTools: '画布工具', expandTools: '展开画布工具', collapseTools: '收起画布工具', undo: '撤销（⌘Z）', redo: '重做（⇧⌘Z）', zoomOut: '缩小', zoomIn: '放大', color: '颜色', weight: '粗细', releaseToImport: '松开以导入图片', archiveDescription: '保存在本项目的', archiveDescriptionEnd: '。不自动上传云端；删除后无法恢复。', closeArchive: '关闭本地档案', loadingArchive: '正在读取本地档案…', noArchive: '还没有已归档的推演。', seconds: '秒', unknownDuration: '时长未知', snapshot: '画布快照', noSnapshot: '无快照', audio: '录音', noAudio: '无录音', delivered: '已送达', sent: '已接收', sendFailed: '发送失败', local: '仅本地', delete: '删除' },
  en: { importImage: 'Import image', importing: 'Importing…', more: 'More', archive: 'Local archive', recording: 'Recording', asrUnavailable: 'Audio saved only', finish: 'Finish session', processing: 'Processing', export: 'Send to Codex', retryExport: 'Retry sending', sending: 'Sending…', archived: '✓ Saved locally', accepted: '✓ Sent to main conversation', deliveredReceipt: '✓ Main conversation completed', failedReceipt: 'Saved · send failed', next: 'Start next round', start: 'Start session', preparing: 'Preparing…', canvasTools: 'Canvas tools', expandTools: 'Expand tools', collapseTools: 'Collapse tools', undo: 'Undo (⌘Z)', redo: 'Redo (⇧⌘Z)', zoomOut: 'Zoom out', zoomIn: 'Zoom in', color: 'Color', weight: 'Weight', releaseToImport: 'Release to import image', archiveDescription: 'Stored locally in', archiveDescriptionEnd: '. Nothing is uploaded automatically; deleted rounds cannot be recovered.', closeArchive: 'Close local archive', loadingArchive: 'Loading local archive…', noArchive: 'No saved rounds yet.', seconds: 'sec', unknownDuration: 'duration unknown', snapshot: 'canvas snapshot', noSnapshot: 'no snapshot', audio: 'audio', noAudio: 'no audio', delivered: 'delivered', sent: 'received', sendFailed: 'send failed', local: 'local only', delete: 'Delete' },
} as const

function visibleWorkflowMessage(message: string, locale: Locale) {
  if (locale === 'zh') return message
  const translated: Record<string, string> = {
    '画下来，圈出来，需要时说出来。': 'Draw it, circle it, and speak when useful.',
    '正在准备本次推演…': 'Preparing this session…',
    '推演中 · 画、圈、移动，也可以直接说。语音会在后台分段整理。': 'In session · Draw, circle, move, and speak. Audio is transcribed in the background.',
    '推演中 · 画、圈、移动。录音会保存在本地；当前没有可用语音转写。': 'In session · Draw, circle, and move. Audio will be saved locally; speech transcription is not available.',
    '推演中 · 画、圈、移动，也可以直接说。': 'In session · Draw, circle, move, and speak.',
    '推演中 · 麦克风不可用，但画布过程仍会被记录。': 'In session · Microphone unavailable; canvas activity is still recorded.',
    '正在结束录音…': 'Finishing the recording…',
    '正在完成最后的语音片段…': 'Finishing the last audio segment…',
    '少量语音片段需要回退补齐…': 'A few audio segments need recovery…',
    '正在整理画布和标记…': 'Compiling canvas marks…',
    '正在准备本轮上下文…': 'Preparing this round’s context…',
    '本轮内容已整理完成。导出后会作为主对话的上下文。': 'This round is ready. Export it as context for the main conversation.',
    '本轮内容已整理完成；当前没有可用的语音转写。': 'This round is ready; no usable voice transcript is available.',
    '正在归档并发送到当前对话…': 'Archiving and sending to the current conversation…',
  }
  return translated[message] ?? message
}

const strokeColors = ['#1e1e1e', '#64748b', '#2563eb', '#7c3aed', '#dc2626', '#ea580c', '#16a34a', '#0f766e']
const strokeWidths = [1, 2, 4]
const STATE_FRAME_IDLE_MS = 8_000
const STATE_FRAME_MIN_GAP_MS = 10_000
const STATE_FRAME_MAX_ACTIVITY_MS = 45_000
const STATE_FRAME_LIMIT = 8

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

function HeaderIcon({ kind }: { kind: 'upload' | 'record' | 'stop' | 'send' | 'next' }) {
  const shared = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const content = {
    upload: <><path {...shared} d="M5 15.5v3h14v-3" /><path {...shared} d="m12 4 4 4" /><path {...shared} d="m12 4-4 4" /><path {...shared} d="M12 4v10" /></>,
    record: <circle cx="12" cy="12" r="4.3" fill="currentColor" />,
    stop: <rect x="7.2" y="7.2" width="9.6" height="9.6" rx="1.2" fill="currentColor" />,
    send: <><path {...shared} d="M4 12h14" /><path {...shared} d="m13 5 7 7-7 7" /></>,
    next: <path d="m8 5 10 7-10 7Z" fill="currentColor" />,
  }[kind]
  return <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">{content}</svg>
}

type SessionStage = 'idle' | 'starting' | 'recording' | 'compiling' | 'ready' | 'error'
type ExportStatus = ExportReceiptStatus | 'error'
type DeliveryMode = 'codex' | 'local'
type StoredRound = {
  package_id: string
  exported_at: string
  duration_ms: number | null
  status: string
  has_snapshot: boolean
  has_audio: boolean
  handoff?: HandoffReceipt
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
  const [locale, setLocale] = useState<Locale>(() => resolveInitialLocale(window.localStorage, window.navigator.languages, window.navigator.language))
  const text = ui[locale]
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
  const displayWorkflow = visibleWorkflowMessage(workflowMessage, locale)
  const [asrProgress, setAsrProgress] = useState<AsrWindowProgress>({ completed: 0, pending: 0, failed: 0, active: 0 })
  const [asrAvailable, setAsrAvailable] = useState(false)
  const [asrEndpoint, setAsrEndpoint] = useState('http://127.0.0.1:8080')
  const [compiledPackage, setCompiledPackage] = useState<PromptPackage | null>(null)
  const [lastRecording, setLastRecording] = useState<RecordingResult | null>(null)
  const [transcription, setTranscription] = useState<TranscriptionResult | null>(null)
  const [exportStatus, setExportStatus] = useState<ExportStatus>('idle')
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('local')
  const [handoffReceipt, setHandoffReceipt] = useState<HandoffReceipt | null>(null)
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
  const asrAvailableRef = useRef(false)
  const pointerSamples = useRef<Array<{ t: number; x: number; y: number; speed?: number; pressure?: number }>>([])
  const lastPointer = useRef<{ t: number; x: number; y: number } | null>(null)
  const lastPointerSampleAt = useRef(0)
  // A round can freely acquire several visual materials.  This is an evidence
  // set, not a review-mode switch: each image remains an independently
  // addressable artifact for later spatial candidates.
  const artifactImageIds = useRef(new Set<string>())
  const baselineObjectIds = useRef(new Set<string>())
  const baselineContext = useRef<BaselineContext | null>(null)
  const stateFrames = useRef<Keyframe[]>([])
  const viewTransformations = useRef<ViewTransformation[]>([])
  const lastViewState = useRef<{ timestamp_ms: number; zoom: number; scroll_x: number; scroll_y: number } | null>(null)
  const stateFrameTimer = useRef<number | null>(null)
  const stateFrameMaxTimer = useRef<number | null>(null)
  const activeSessionId = useRef(0)
  const activeHandoffPackageId = useRef<string | null>(null)
  const sessionLocale = useRef<Locale>(locale)

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }, [locale])

  useEffect(() => {
    void fetch('/api/runtime-identity', { cache: 'no-store' })
      .then(async (response) => response.ok ? await response.json() as { delivery_mode?: DeliveryMode; asr_url?: string | null } : null)
      .then((identity) => {
        if (identity?.delivery_mode === 'codex' || identity?.delivery_mode === 'local') setDeliveryMode(identity.delivery_mode)
        if (typeof identity?.asr_url === 'string') setAsrEndpoint(identity.asr_url)
      })
      .catch(() => undefined)
  }, [])

  const refreshAsrAvailability = useCallback(async () => {
    try {
      asrClient.setBaseUrl(asrEndpoint)
      const health = await asrClient.health()
      // Reuse a pre-existing local Whisper service only when its health shape
      // proves it is one of the endpoints Canvas Prompt already supports.
      const available = health.status === 'ok'
        && health.whisper_loaded !== false
        && (health.canvas_prompt_asr === true || health.backend === 'whisper' || health.backend === 'faster-whisper')
      asrAvailableRef.current = available
      setAsrAvailable(available)
      return available
    } catch {
      asrAvailableRef.current = false
      setAsrAvailable(false)
      return false
    }
  }, [asrEndpoint])

  useEffect(() => {
    void refreshAsrAvailability()
    const timer = window.setInterval(() => { void refreshAsrAvailability() }, 5_000)
    return () => window.clearInterval(timer)
  }, [refreshAsrAvailability])

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
    const startElements = (apiRef.current ?? api)?.getSceneElementsIncludingDeleted() ?? []
    setSessionStage('starting')
    setWorkflowMessage('正在准备本次推演…')
    setAsrProgress({ completed: 0, pending: 0, failed: 0, active: 0 })
    const baseline = startElements
    const liveBaseline = baseline.filter((element) => !element.isDeleted)
    baselineObjectIds.current = new Set(liveBaseline.map((element) => element.id))
    versions.current = new Map(baseline.map((element) => [element.id, {
      version: element.version,
      isDeleted: element.isDeleted,
      bounds: { x: element.x, y: element.y, width: element.width, height: element.height },
    }]))
    artifactImageIds.current = new Set(liveBaseline.filter((element) => element.type === 'image').map((element) => element.id))
    const sceneSummary = liveBaseline
      .map((element) => ({ id: element.id, type: element.type, version: element.version, x: element.x, y: element.y, width: element.width, height: element.height }))
      .sort((left, right) => left.id.localeCompare(right.id))
    const digestSource = new TextEncoder().encode(JSON.stringify(sceneSummary))
    const digest = await crypto.subtle.digest('SHA-256', digestSource)
    const sceneSha256 = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
    baselineContext.current = {
      scene_sha256: sceneSha256,
      object_count: liveBaseline.length,
      image_count: artifactImageIds.current.size,
      included_object_count: 0,
      status: liveBaseline.length === 0 ? 'none' : 'omitted',
    }
    trace.current = []
    activeSessionId.current += 1
    if (stateFrameTimer.current !== null) window.clearTimeout(stateFrameTimer.current)
    if (stateFrameMaxTimer.current !== null) window.clearTimeout(stateFrameMaxTimer.current)
    stateFrameTimer.current = null
    stateFrameMaxTimer.current = null
    stateFrames.current = []
    viewTransformations.current = []
    const initialView = (apiRef.current ?? api)?.getAppState()
    lastViewState.current = initialView ? {
      timestamp_ms: 0,
      zoom: initialView.zoom.value,
      scroll_x: initialView.scrollX,
      scroll_y: initialView.scrollY,
    } : null
    setEvents([])
    pointerSamples.current = []
    lastPointer.current = null
    lastPointerSampleAt.current = 0
    setCompiledPackage(null)
    setLastRecording(null)
    setTranscription(null)
    activeHandoffPackageId.current = null
    setExportStatus('idle')
    setImageNotice(null)
    const start = Date.now()
    const recordingLocale = locale
    sessionLocale.current = recordingLocale
    setStartedAt(start)
    setNowMs(start)
    setRecording(true)
    audioRunning.current = false
    const canTranscribe = await refreshAsrAvailability()
    try {
      await recorderRef.current?.start()
      audioRunning.current = true
      const stream = recorderRef.current?.createInputStreamClone()
      if (canTranscribe && stream && typeof MediaRecorder !== 'undefined') {
        windowedAsrRef.current = new WindowedAsrSession({
          stream,
          language: recordingLocale === 'zh' ? 'zh-CN' : 'en',
          endpoint: `${asrEndpoint}/transcribe?backend=whisper`,
          windowMs: 25_000,
          overlapMs: 3_000,
          onProgress: setAsrProgress,
        })
        windowedAsrRef.current.start()
        transcriberRef.current = null
        setWorkflowMessage('推演中 · 画、圈、移动，也可以直接说。语音会在后台分段整理。')
      } else if (canTranscribe) {
        // Fallback for browsers without a second MediaRecorder stream.
        transcriberRef.current = new VoiceTranscriber({ strategy: 'local-whisper', language: recordingLocale, asrServerUrl: asrEndpoint })
        await transcriberRef.current.start()
        setWorkflowMessage('推演中 · 画、圈、移动，也可以直接说。')
      } else {
        transcriberRef.current = null
        windowedAsrRef.current = null
        setWorkflowMessage('推演中 · 画、圈、移动。录音会保存在本地；当前没有可用语音转写。')
      }
    } catch {
      setWorkflowMessage('推演中 · 麦克风不可用，但画布过程仍会被记录。')
    }
    setSessionStage('recording')
  }

  const finishTrace = async () => {
    if (!recording || !startedAt) return
    // A state frame represents a settled in-session state; do not let a queued
    // idle timer race the final snapshot after the user ends the round.
    activeSessionId.current += 1
    if (stateFrameTimer.current !== null) window.clearTimeout(stateFrameTimer.current)
    if (stateFrameMaxTimer.current !== null) window.clearTimeout(stateFrameMaxTimer.current)
    stateFrameTimer.current = null
    stateFrameMaxTimer.current = null
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
      if (asrAvailableRef.current && (!transcript?.text || backgroundSession?.hasFailures()) && audio?.blob) {
        if (backgroundSession?.hasFailures()) setWorkflowMessage('少量语音片段需要回退补齐…')
        try {
          const result = await asrClient.transcribe(audio.blob, sessionLocale.current)
          transcript = {
            text: result.text,
            segments: result.segments.map((segment) => ({ text: segment.text, startMs: segment.start * 1000, endMs: segment.end * 1000, confidence: segment.confidence, isFinal: true })),
            language: result.language,
            strategy: 'local-whisper',
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
        .filter((element) => artifactImageIds.current.has(element.id) && element.type === 'image' && !element.isDeleted)
        .map((element) => ({
          object_id: `obj_${element.id}`,
          type: 'image',
          // A material may arrive after recording starts. Its create event is
          // the evidence timestamp; start-of-round materials intentionally
          // remain at 0 because their creation predates this round.
          timestamp_ms: trace.current.find((event) => event.kind === 'create' && event.element.id === element.id)?.at_ms ?? 0,
          bounds: { x: element.x, y: element.y, width: element.width, height: element.height },
          properties: { base_artifact: true, asset_id: 'fileId' in element ? element.fileId ?? null : null },
        }))
      const currentRoundIds = projectLiveRoundElementIds(elements, trace.current, artifactImageIds.current)
      const baselineObjectCount = baselineContext.current?.object_count ?? 0
      const includedBaselineCount = countIncludedBaselineObjects(baselineObjectIds.current, currentRoundIds)
      const roundBaselineContext: BaselineContext | undefined = baselineContext.current
        ? {
            ...baselineContext.current,
            included_object_count: includedBaselineCount,
            status: baselineObjectCount === 0
              ? 'none'
              : includedBaselineCount === 0
                ? 'omitted'
                : includedBaselineCount === baselineObjectCount
                  ? 'fully_included'
                  : 'partially_included',
          }
        : undefined
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
        language: transcript?.language || (sessionLocale.current === 'zh' ? 'zh-CN' : 'en'),
        tags: ['canvas-prompt', 'excalidraw'],
        baseArtifacts,
        viewTransformations: viewTransformations.current,
        baselineContext: roundBaselineContext,
        keyframes: stateFrames.current,
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

  const pollHandoffReceipt = async (packageId: string) => {
    activeHandoffPackageId.current = packageId
    const deadline = Date.now() + 80_000
    while (Date.now() < deadline && activeHandoffPackageId.current === packageId) {
      await new Promise((resolvePoll) => window.setTimeout(resolvePoll, 1_000))
      try {
        const response = await fetch('/api/rounds', { cache: 'no-store' })
        if (!response.ok) continue
        const result = await response.json() as { rounds?: StoredRound[] }
        const round = result.rounds?.find((item) => item.package_id === packageId)
        const receipt = round?.handoff ?? null
        const status = deriveExportReceiptStatus(receipt)
        if (receipt) setHandoffReceipt(receipt)
        if (status === 'delivered') {
          setExportStatus('delivered')
          setWorkflowMessage('本轮已送达当前 Codex 对话。')
          return
        }
        if (status === 'failed') {
          setExportStatus('failed')
          setWorkflowMessage('本轮已保存在本地，但主对话未能完成处理。')
          return
        }
      } catch {
        // The durable handoff receipt remains the source of truth. A transient
        // polling failure must not downgrade an already accepted round.
      }
    }
  }

  const exportPromptPackage = async ({ retryHandoff = false } = {}) => {
    if (!compiledPackage) return
    setExportStatus('exporting')
    setHandoffReceipt(null)
    setWorkflowMessage(deliveryMode === 'codex' ? '正在归档并发送到当前对话…' : '正在归档本轮上下文…')
    const payload = {
      ...compiledPackage,
      source: { canvas: 'excalidraw', trace: trace.current, audio: lastRecording ? { mime_type: lastRecording.blob.type, duration_ms: lastRecording.duration } : null },
    }

    try {
      if (lastRecording) {
        const audioResponse = await protectedLocalApiFetch(`/api/round-audio/${compiledPackage.meta.package_id}`, {
          method: 'POST',
          headers: { 'content-type': lastRecording.blob.type || 'audio/webm' },
          body: lastRecording.blob,
        })
        if (!audioResponse.ok) throw new Error('本轮录音未能保存到本地档案')
      }
      const response = await protectedLocalApiFetch('/api/prompt-package', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(retryHandoff ? { 'x-canvas-prompt-retry-handoff': '1' } : {}) },
        // Raw scene lifecycle is archived separately by the local service.
        // It is intentionally not retained inside the model-facing package.
        body: JSON.stringify(payload),
      })
      const result = await response.json().catch(() => null) as { ok?: boolean; error?: string; engine?: { error?: string }; handoff?: HandoffReceipt } | null
      if (!response.ok || !result?.ok) throw new Error(result?.error || result?.engine?.error || `本轮上下文未能归档（${response.status}）`)
      const receiptStatus = deriveExportReceiptStatus(result.handoff)
      setHandoffReceipt(result.handoff ?? null)
      setExportStatus(receiptStatus)
      setWorkflowMessage(deliveryMode === 'local'
        ? '本轮已保存在本地。请在你的 AI 终端中读取 Canvas Prompt 上下文。'
        : receiptStatus === 'delivered'
        ? '本轮已送达当前 Codex 对话。'
          : receiptStatus === 'accepted'
            ? '本轮已送入主对话，请在主对话继续。'
          : receiptStatus === 'failed'
            ? `本轮已保存在本地，但主对话没有确认接收：${result.handoff?.reason || '可重新发送'}`
            : '本轮已保存在本地，并已完成核心编译。')
      if (storageOpen) void loadStoredRounds()
      window.dispatchEvent(new Event('canvas-prompt-exported'))
    } catch (error) {
      setExportStatus('error')
      setWorkflowMessage(`本轮未送达：${error instanceof Error ? error.message : '请重试'}`)
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
      const response = await protectedLocalApiFetch(`/api/rounds/${round.package_id}`, { method: 'DELETE' })
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
      if (recording) {
        for (const element of imageElement) artifactImageIds.current.add(element.id)
      }
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

  const importDroppedImageSource = async (source: string) => {
    try {
      if (!/^data:image\//i.test(source) && !/^(https?:|blob:|app:|attachment:)/i.test(source)) {
        throw new Error('拖拽内容不是可读取的图片')
      }
      const response = await fetch(source)
      if (!response.ok) throw new Error('无法读取聊天中的图片数据')
      const blob = await response.blob()
      const mimeType = blob.type || (/^data:image\/([^;,]+)/i.exec(source)?.[1] ? `image/${/^data:image\/([^;,]+)/i.exec(source)?.[1]}` : '')
      if (!mimeType.startsWith('image/')) throw new Error('拖拽内容不是图片')
      const extension = mimeType.split('/')[1]?.replace('svg+xml', 'svg') || 'png'
      await importImageFile(new File([blob], `聊天图片.${extension}`, { type: mimeType }))
    } catch (error) {
      setImageNotice(`无法直接读取聊天图片：${error instanceof Error ? error.message : '请使用“导入图片”'}`)
    }
  }

  const importNativeMacImage = async (board: 'general' | 'drag') => {
    try {
      const response = await protectedLocalApiFetch(`/api/native-pasteboard-image?board=${board}`, { method: 'POST', cache: 'no-store' })
      if (!response.ok) return false
      const blob = await response.blob()
      if (!blob.type.startsWith('image/')) return false
      await importImageFile(new File([blob], 'Codex 图片.png', { type: blob.type }))
      return true
    } catch {
      return false
    }
  }

  const droppedImageSource = (transfer: DataTransfer) => {
    const uri = transfer.getData('text/uri-list').split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#'))
    if (uri) return uri
    const downloadUrl = transfer.getData('DownloadURL')
    const downloadedImage = /^image\/[^:]+:[^:]*:(.+)$/i.exec(downloadUrl)?.[1]
    if (downloadedImage) return downloadedImage
    const mozUrl = transfer.getData('text/x-moz-url').split('\n')[0]?.trim()
    if (mozUrl) return mozUrl
    const html = transfer.getData('text/html')
    const imageSource = /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1]
    if (imageSource) return imageSource
    const plain = transfer.getData('text/plain').trim()
    if (/^(data:image\/|https?:|blob:|app:|attachment:)/i.test(plain)) return plain
    for (const type of Array.from(transfer.types)) {
      const value = transfer.getData(type).trim()
      if (/^(data:image\/|https?:|blob:|app:|attachment:)/i.test(value)) return value
    }
    return null
  }

  const handleExternalDragOver = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setImageDropActive(true)
  }

  const handleExternalDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault()
    setImageDropActive(false)
    const file = event.dataTransfer.files[0]
    const source = file ? null : droppedImageSource(event.dataTransfer)
    if (file) {
      void importImageFile(file)
    } else if (source) {
      void importDroppedImageSource(source)
    } else {
      const types = Array.from(event.dataTransfer.types).join('、') || '无可读拖拽类型'
      setImageNotice('正在读取 Codex 的原生拖拽图片…')
      void importNativeMacImage('drag').then((imported) => {
        if (!imported) setImageNotice(`未能读取 Codex 的原生拖拽图片（${types}）。`)
      })
    }
  }

  const handleExternalPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    // Window capture owns paste so Excalidraw cannot consume a context-menu
    // paste before our importer sees it.
    if (event.defaultPrevented) return
    // Do not let Excalidraw run its own paste after our importer has claimed
    // the clipboard; otherwise one Cmd+V produces two independent images.
    event.preventDefault()
    event.stopPropagation()
    const file = Array.from(event.clipboardData.files).find((candidate) => candidate.type.startsWith('image/'))
    const source = file ? null : droppedImageSource(event.clipboardData)
    if (file) {
      void importImageFile(file)
    } else if (source) {
      void importDroppedImageSource(source)
    } else {
      setImageNotice('正在读取 Codex 的原生剪贴板图片…')
      void importNativeMacImage('general').then((imported) => {
        if (!imported) setImageNotice('剪贴板中没有可导入的原生图片。')
      })
    }
  }

  const handleCanvasContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    // The stock Excalidraw menu creates a second, unreliable image-import path
    // in the Codex host. Keep one explicit contract: copy in Codex, then ⌘V.
    event.preventDefault()
    event.stopPropagation()
    setImageNotice(locale === 'zh' ? '请使用 ⌘V 粘贴图片。' : 'Use ⌘V to paste an image.')
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
    // Labels are localized (and our own buttons also have labels), so use the
    // stable native test id instead of an English aria-label.
    const testId = action === 'undo' ? 'button-undo' : 'button-redo'
    const nativeButton = document.querySelector<HTMLButtonElement>(`.spike-canvas [data-testid="${testId}"]`)
    if (nativeButton && !nativeButton.disabled) nativeButton.click()
  }

  const captureStateFrame = useCallback(async (sessionId: number) => {
    if (stateFrameTimer.current !== null) window.clearTimeout(stateFrameTimer.current)
    if (stateFrameMaxTimer.current !== null) window.clearTimeout(stateFrameMaxTimer.current)
    stateFrameTimer.current = null
    stateFrameMaxTimer.current = null
    if (activeSessionId.current !== sessionId || stateFrames.current.length >= STATE_FRAME_LIMIT) return
    const canvasApi = apiRef.current ?? api
    if (!canvasApi || !startedAt) return
    const timestampMs = Math.max(0, Date.now() - startedAt)
    const previous = stateFrames.current.at(-1)
    if (previous && timestampMs - previous.timestamp_ms < STATE_FRAME_MIN_GAP_MS) return
    const elements = canvasApi.getSceneElements()
    const roundIds = projectLiveRoundElementIds(elements, trace.current, artifactImageIds.current)
    const roundElements = elements.filter((element) => roundIds.has(element.id))
    if (roundElements.length === 0) return
    try {
      const blob = await exportToBlob({ elements: roundElements, appState: canvasApi.getAppState(), files: canvasApi.getFiles() ?? null, mimeType: 'image/png', exportPadding: 24 })
      const [url, size] = await Promise.all([blobToDataUrl(blob), imageDimensions(blob)])
      if (activeSessionId.current !== sessionId || stateFrames.current.length >= STATE_FRAME_LIMIT) return
      stateFrames.current.push({ timestamp_ms: timestampMs, image: { url, format: 'png', width: size.width, height: size.height } })
    } catch {
      // State frames are optional evidence. A failed frame must not block the round export.
    }
  }, [api, startedAt])

  const scheduleStateFrame = useCallback((sessionId: number) => {
    if (stateFrameTimer.current !== null) window.clearTimeout(stateFrameTimer.current)
    stateFrameTimer.current = window.setTimeout(() => void captureStateFrame(sessionId), STATE_FRAME_IDLE_MS)
    if (stateFrameMaxTimer.current === null) {
      stateFrameMaxTimer.current = window.setTimeout(() => void captureStateFrame(sessionId), STATE_FRAME_MAX_ACTIVITY_MS)
    }
  }, [captureStateFrame])

  const handleChange = useCallback((elements: readonly CanvasElement[], appState?: { zoom: { value: number }; scrollX: number; scrollY: number; currentItemStrokeColor?: string; currentItemStrokeWidth?: number }) => {
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

    if (appState) {
      const nextView = {
        timestamp_ms: Math.max(0, Date.now() - startedAt),
        zoom: appState.zoom.value,
        scroll_x: appState.scrollX,
        scroll_y: appState.scrollY,
      }
      if (lastViewState.current) {
        viewTransformations.current = appendViewTransformation(viewTransformations.current, lastViewState.current, nextView)
      }
      lastViewState.current = nextView
    }

    const result = diffScene(versions.current, elements, Date.now() - startedAt)
    versions.current = result.next
    if (result.events.length > 0) {
      trace.current.push(...result.events)
      setEvents([...trace.current])
      scheduleStateFrame(activeSessionId.current)
    }
  }, [recording, scheduleStateFrame, startedAt])

  const latestEvent = events.at(-1)
  const hasReceipt = exportStatus !== 'error' && isReceiptComplete(exportStatus)
  const canRetryHandoff = deliveryMode === 'codex' && exportStatus === 'failed' && handoffReceipt?.accepted !== true
  const exportLabel = deliveryMode === 'codex' ? text.export : locale === 'zh' ? '保存上下文' : 'Save context'
  const retryExportLabel = deliveryMode === 'codex' ? text.retryExport : locale === 'zh' ? '重新保存上下文' : 'Save context again'
  const receiptText = exportStatus === 'delivered'
    ? text.deliveredReceipt
    : exportStatus === 'accepted'
    ? text.accepted
      : exportStatus === 'failed'
        ? text.failedReceipt
        : text.archived

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
          {recording ? <span className="recording-state" aria-live="polite"><i />{text.recording} {elapsed}</span> : null}
          {!recording && !asrAvailable ? <span className="quiet-state" title={locale === 'zh' ? '当前本机没有可用语音转写；录音仍会保存到本地。' : 'No local speech transcription is available; audio will still be saved locally.'}>{text.asrUnavailable}</span> : null}
          {recording ? (
            <button className="button icon-button stop" onClick={() => void finishTrace()} aria-label={text.finish} title={text.finish}><HeaderIcon kind="stop" /></button>
          ) : sessionStage === 'compiling' ? (
            <div className="compile-progress" role="status" aria-live="polite" aria-label={displayWorkflow}>
              <div className="compile-progress-copy"><span>{displayWorkflow}</span><strong>{asrProgress.completed > 0 ? `${asrProgress.completed} ${locale === 'zh' ? '段已整理' : 'segments ready'}` : text.processing}</strong></div>
              <small>{asrProgress.pending > 0 ? `${asrProgress.pending} 段正在处理` : asrProgress.failed > 0 ? `${asrProgress.failed} 段待回退处理` : '不会重跑已完成的语音片段'}</small>
            </div>
          ) : sessionStage === 'ready' && !hasReceipt ? (
            <button className="button primary session-action" onClick={() => void exportPromptPackage()} disabled={exportStatus === 'exporting'}>
              <HeaderIcon kind="send" /><span>{exportStatus === 'exporting' ? text.sending : exportStatus === 'error' ? retryExportLabel : exportLabel}</span>
            </button>
          ) : sessionStage === 'ready' && hasReceipt ? (
            <>
              <span className={`receipt-status receipt-${exportStatus}`} role="status">{receiptText}</span>
              {canRetryHandoff ? <button className="button icon-button" onClick={() => void exportPromptPackage({ retryHandoff: true })} aria-label={retryExportLabel} title={retryExportLabel}><HeaderIcon kind="send" /></button> : null}
              <button className="button primary session-action" onClick={() => void beginTrace()}><HeaderIcon kind="next" /><span>{text.next}</span></button>
            </>
          ) : (
            <button className="button primary session-action" onClick={() => void beginTrace()} disabled={sessionStage === 'starting'}><HeaderIcon kind="record" /><span>{sessionStage === 'starting' ? text.preparing : text.start}</span></button>
          )}
          <button className="button icon-button image-import" type="button" disabled={imageImporting} onClick={() => imageInputRef.current?.click()} aria-label={imageImporting ? text.importing : text.importImage} title={imageImporting ? text.importing : text.importImage}>
            <HeaderIcon kind="upload" />
          </button>
          <div className="more-menu">
            <button className="button icon-button more-button" type="button" onClick={() => setMoreOpen((open) => !open)} aria-expanded={moreOpen} aria-label={text.more} title={text.more}>•••</button>
            {moreOpen && <div className="more-popover"><button type="button" onClick={() => void openStorage()}>{text.archive}</button></div>}
          </div>
          <button className="language-toggle" type="button" onClick={() => setLocale((current) => {
            const next = current === 'zh' ? 'en' : 'zh'
            saveLocalePreference(window.localStorage, next)
            return next
          })} aria-label={locale === 'zh' ? 'Switch to English' : '切换至中文'}>
            <span className={locale === 'zh' ? 'active' : ''}>中</span><span className={locale === 'en' ? 'active' : ''}>EN</span>
          </button>
        </div>
      </header>

      <div className="status-stack">
        {imageNotice && <div className="image-notice" role="status">{imageNotice}</div>}

        <section className={recording || sessionStage === 'compiling' || sessionStage === 'error' || exportStatus === 'error' ? 'guide' : 'guide guide-empty'} aria-label="当前推演状态">
          {(recording || sessionStage === 'compiling' || sessionStage === 'error' || exportStatus === 'error') && <>
            <span>{displayWorkflow}</span>
            <strong>{sessionStage === 'compiling' ? (asrProgress.completed > 0 ? `后台已完成 ${asrProgress.completed} 段语音整理；结束时只收尾未完成片段。` : '正在完成第一段语音整理。') : sessionStage === 'error' ? '本轮尚未发送；可重新开始。' : exportStatus === 'error' ? '原始录音已保留在本地档案；修复后可直接重新发送。' : asrProgress.completed > 0 ? `后台已整理 ${asrProgress.completed} 段语音，不会打断当前推演。` : '画、圈、移动与语音会记录在这一轮。'}</strong>
          </>}
        </section>
      </div>

      <section
        className={imageDropActive ? 'canvas-wrap spike-canvas drop-active' : 'canvas-wrap spike-canvas'}
        onPointerMove={capturePointer}
        onDragOverCapture={handleExternalDragOver}
        onDragLeave={() => setImageDropActive(false)}
        onDropCapture={handleExternalDrop}
        onPasteCapture={handleExternalPaste}
        onContextMenuCapture={handleCanvasContextMenu}
      >
        <nav
          className={toolsCollapsed ? 'canvas-tools collapsed' : 'canvas-tools'}
          aria-label={text.canvasTools}
        >
          {toolsCollapsed ? (
            <button
              type="button"
              className="menu-toggle"
              onClick={() => setToolsCollapsed(false)}
              aria-label={text.expandTools}
              title={text.expandTools}
            >
              <span aria-hidden="true">☰</span>
            </button>
          ) : <>
            <div className="tool-row">
              <button type="button" className="canvas-tool history-tool" onClick={() => triggerHistoryAction('undo')} title={text.undo} aria-label={text.undo}>↶</button>
              <button type="button" className="canvas-tool history-tool" onClick={() => triggerHistoryAction('redo')} title={text.redo} aria-label={text.redo}>↷</button>
              <span className="tool-divider" />
              {tools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={activeTool === tool.id ? 'canvas-tool active' : 'canvas-tool'}
                onClick={() => activateTool(tool.id)}
                title={tool[locale]}
                aria-label={tool[locale]}
                aria-pressed={activeTool === tool.id}
              >
                <ToolIcon tool={tool.id} />
              </button>
            ))}
              <button type="button" className="zoom-button" onClick={() => changeZoom(0.8)} aria-label={text.zoomOut}>−</button>
              <span className="zoom-label">{zoomPercent}%</span>
              <button type="button" className="zoom-button" onClick={() => changeZoom(1.25)} aria-label={text.zoomIn}>＋</button>
              <button
                type="button"
                className="menu-toggle"
                onClick={() => setToolsCollapsed(true)}
                aria-label={text.collapseTools}
                title={text.collapseTools}
              >
                <span aria-hidden="true">‹</span>
              </button>
            </div>
            <div className="style-row" aria-label={text.canvasTools}>
              <span className="style-label">{text.color}</span>
              {strokeColors.map((color) => (
              <button
                key={color}
                type="button"
                className={strokeColor === color ? 'color-swatch active' : 'color-swatch'}
                style={{ '--swatch': color } as React.CSSProperties}
                onClick={() => changeStrokeColor(color)}
                aria-label={`${text.color} ${color}`}
                aria-pressed={strokeColor === color}
              />
            ))}
              <span className="style-label width-label">{text.weight}</span>
              {strokeWidths.map((width) => (
              <button
                key={width}
                type="button"
                className={strokeWidth === width ? 'width-swatch active' : 'width-swatch'}
                onClick={() => changeStrokeWidth(width)}
                aria-label={`${text.weight} ${width}`}
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
          langCode={locale === 'zh' ? 'zh-CN' : 'en'}
          onChange={handleChange}
          initialData={{ appState: { currentItemStrokeColor: strokeColors[0], currentItemStrokeWidth: 1 } }}
          UIOptions={{
            // The native Excalidraw image tool remains visually hidden by our
            // custom shell, but must stay enabled: its capability gate also
            // protects programmatic image elements created by paste/drop/import.
            tools: { image: true },
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
        {imageDropActive && <div className="drop-image-hint" aria-hidden="true">{text.releaseToImport}</div>}
      </section>

      {storageOpen && <div className="storage-backdrop" role="presentation" onClick={() => setStorageOpen(false)}>
        <section className="storage-dialog" role="dialog" aria-modal="true" aria-label={text.archive} onClick={(event) => event.stopPropagation()}>
          <div className="storage-dialog-head">
            <div><h2>{text.archive}</h2><p>{text.archiveDescription} <code>.canvas-prompt/rounds</code>{text.archiveDescriptionEnd}</p></div>
            <button className="dialog-close" type="button" onClick={() => setStorageOpen(false)} aria-label={text.closeArchive}>×</button>
          </div>
          <div className="storage-list">
            {storageLoading ? <p>{text.loadingArchive}</p> : storedRounds.length === 0 ? <p>{text.noArchive}</p> : storedRounds.map((round) => (
              <article className="storage-item" key={round.package_id}>
                <div><strong>{new Date(round.exported_at).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</strong><span>{round.duration_ms ? `${Math.round(round.duration_ms / 1000)} ${text.seconds}` : text.unknownDuration} · {round.has_snapshot ? text.snapshot : text.noSnapshot} · {round.has_audio ? text.audio : text.noAudio}</span></div>
                <div className="storage-item-actions"><span className={round.handoff?.delivered ? 'round-delivered' : deriveExportReceiptStatus(round.handoff) === 'failed' ? 'round-failed' : round.handoff?.accepted ? 'round-accepted' : 'round-local'}>{round.handoff?.delivered ? text.delivered : deriveExportReceiptStatus(round.handoff) === 'failed' ? text.sendFailed : round.handoff?.accepted ? text.sent : text.local}</span><button type="button" onClick={() => void deleteStoredRound(round)}>{text.delete}</button></div>
              </article>
            ))}
          </div>
        </section>
      </div>}
    </main>
  )
}
