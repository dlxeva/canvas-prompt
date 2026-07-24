import type { TranscriptSegment, TranscriptionResult } from './voice-transcriber'

export type AsrWindowProgress = {
  completed: number
  pending: number
  failed: number
  active: number
}

type AsrResponse = {
  text: string
  segments: Array<{ start: number; end: number; text: string; confidence?: number }>
  language?: string
}

export type WindowedAsrOptions = {
  stream: MediaStream
  language?: string
  endpoint?: string
  windowMs?: number
  overlapMs?: number
  onProgress?: (progress: AsrWindowProgress) => void
}

type ActiveWindow = {
  id: number
  startMs: number
  recorder: MediaRecorder
  chunks: Blob[]
  timer: number
  stopped: boolean
  done: Promise<void>
  resolveDone: () => void
}

const normalise = (text: string) => text.replace(/\s+/g, '').replace(/[，。！？、,.!?]/g, '')

/** Convert window-relative ASR timings into the recording's absolute timeline. */
export function absoluteSegments(
  windowStartMs: number,
  segments: Array<{ start: number; end: number; text: string; confidence?: number }>,
): TranscriptSegment[] {
  return segments
    .filter((segment) => segment.text.trim())
    .map((segment) => ({
      text: segment.text.trim(),
      startMs: Math.max(0, Math.round(windowStartMs + segment.start * 1000)),
      endMs: Math.max(0, Math.round(windowStartMs + segment.end * 1000)),
      confidence: segment.confidence ?? 0.8,
      isFinal: true,
    }))
}

/** Only remove exact, time-overlapping duplicates from window overlap. */
export function mergeWindowSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const result: TranscriptSegment[] = []
  for (const segment of ordered) {
    const duplicate = result.some((existing) =>
      normalise(existing.text) === normalise(segment.text)
      && existing.startMs <= segment.endMs
      && segment.startMs <= existing.endMs,
    )
    if (!duplicate) result.push(segment)
  }
  return result
}

/**
 * Local ASR preprocessor. It never interprets partial speech; completed audio
 * windows are simply transcribed before the person ends their reasoning.
 */
export class WindowedAsrSession {
  private readonly stream: MediaStream
  private readonly language: string
  private readonly endpoint: string
  private readonly windowMs: number
  private readonly overlapMs: number
  private readonly onProgress?: (progress: AsrWindowProgress) => void
  private readonly active = new Map<number, ActiveWindow>()
  private readonly allSegments: TranscriptSegment[] = []
  private startedAt = 0
  private nextWindowId = 1
  private nextWindowTimer: number | null = null
  private queue = Promise.resolve()
  private stopped = false
  private completed = 0
  private pending = 0
  private failed = 0
  private languageResult = 'zh-CN'

  constructor(options: WindowedAsrOptions) {
    this.stream = options.stream
    this.language = options.language || 'zh-CN'
    this.endpoint = options.endpoint || 'http://localhost:8080/transcribe?backend=whisper'
    this.windowMs = options.windowMs || 25_000
    this.overlapMs = options.overlapMs || 3_000
    this.onProgress = options.onProgress
  }

  start(): void {
    this.startedAt = Date.now()
    this.startWindow()
    this.scheduleNextWindow()
    this.emitProgress()
  }

  /** Stops capture immediately, then waits only for queued background ASR. */
  async stop(): Promise<TranscriptionResult> {
    this.stopped = true
    if (this.nextWindowTimer !== null) window.clearTimeout(this.nextWindowTimer)
    this.nextWindowTimer = null
    const active = [...this.active.values()]
    active.forEach((item) => this.stopWindow(item))
    await Promise.all(active.map((item) => item.done))
    // This is a clone of the primary recorder's stream. Stop only the clone;
    // the archival recorder owns and closes its original stream separately.
    this.stream.getTracks().forEach((track) => track.stop())
    await this.queue
    const segments = mergeWindowSegments(this.allSegments)
    return {
      text: segments.map((segment) => segment.text).join(' '),
      segments,
      language: this.languageResult,
      strategy: 'local-whisper',
      durationMs: Date.now() - this.startedAt,
    }
  }

  /** A failed window means the caller should recover coverage from the archival audio. */
  hasFailures(): boolean {
    return this.failed > 0
  }

  private scheduleNextWindow() {
    const stride = Math.max(1_000, this.windowMs - this.overlapMs)
    this.nextWindowTimer = window.setTimeout(() => {
      if (this.stopped) return
      this.startWindow()
      this.scheduleNextWindow()
    }, stride)
  }

  private startWindow() {
    if (this.stopped) return
    const id = this.nextWindowId++
    const chunks: Blob[] = []
    const recorder = new MediaRecorder(this.stream)
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const item: ActiveWindow = { id, startMs: Date.now() - this.startedAt, recorder, chunks, timer: 0, stopped: false, done, resolveDone }
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
    recorder.onstop = () => {
      window.clearTimeout(item.timer)
      this.active.delete(item.id)
      item.resolveDone()
      if (chunks.length > 0) this.enqueue(item.startMs, new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
      this.emitProgress()
    }
    recorder.start()
    item.timer = window.setTimeout(() => this.stopWindow(item), this.windowMs)
    this.active.set(id, item)
    this.emitProgress()
  }

  private stopWindow(item: ActiveWindow) {
    if (item.stopped) return
    item.stopped = true
    window.clearTimeout(item.timer)
    if (item.recorder.state !== 'inactive') item.recorder.stop()
  }

  private enqueue(windowStartMs: number, audio: Blob) {
    this.pending += 1
    this.emitProgress()
    this.queue = this.queue
      .then(async () => {
        // A transient local-service failure should not silently drop part of a
        // reasoning turn. Retry once here; the caller falls back to archival
        // audio if a window still cannot be transcribed.
        let body: AsrResponse | null = null
        let lastError: unknown = null
        for (let attempt = 0; attempt < 2 && !body; attempt += 1) {
          try {
            const form = new FormData()
            form.append('audio', audio, 'window.webm')
            form.append('language', this.language)
            const response = await fetch(this.endpoint, { method: 'POST', body: form })
            const candidate = await response.json().catch(() => null) as AsrResponse | { detail?: string } | null
            if (!response.ok || !candidate || !('segments' in candidate)) {
              throw new Error(candidate && 'detail' in candidate ? candidate.detail || 'ASR failed' : 'ASR failed')
            }
            body = candidate
          } catch (error) {
            lastError = error
            if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 400))
          }
        }
        if (!body) throw lastError instanceof Error ? lastError : new Error('ASR failed')
        this.languageResult = body.language || this.languageResult
        this.allSegments.push(...absoluteSegments(windowStartMs, body.segments))
        this.completed += 1
      })
      .catch(() => { this.failed += 1 })
      .finally(() => {
        this.pending -= 1
        this.emitProgress()
      })
  }

  private emitProgress() {
    this.onProgress?.({ completed: this.completed, pending: this.pending, failed: this.failed, active: this.active.size })
  }
}

