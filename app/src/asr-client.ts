/**
 * asr-client.ts
 * ASR 客户端 - 调用 ASR 服务进行语音转写
 */

export interface TranscriptionResult {
  text: string
  segments: TranscriptionSegment[]
  language: string
  duration: number
}

export interface TranscriptionSegment {
  start: number
  end: number
  text: string
  confidence: number
}

export interface CaptionTrackResult {
  caption_track: CaptionTrackItem[]
  language: string
  duration_ms: number
}

export interface CaptionTrackItem {
  caption_id: string
  start_ms: number
  end_ms: number
  text: string
  speaker: string
  confidence: number
}

export interface ASRClientOptions {
  baseUrl?: string
  timeout?: number
}

export class ASRClient {
  private baseUrl: string
  private timeout: number

  constructor(options: ASRClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'http://localhost:8080'
    this.timeout = options.timeout || 120000
  }

  /**
   * 健康检查
   */
  async health(): Promise<{ status: string; backend: string; whisper_loaded: boolean }> {
    const response = await fetch(`${this.baseUrl}/health`)
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`)
    }
    return response.json()
  }

  /**
   * 转写音频
   */
  async transcribe(audio: Blob | File, language: string = 'zh'): Promise<TranscriptionResult> {
    const formData = new FormData()
    formData.append('audio', audio)
    formData.append('language', language)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.baseUrl}/transcribe?backend=whisper`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || `Transcription failed: ${response.status}`)
      }

      return response.json()
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 实时转写（返回 caption_track 格式）
   */
  async transcribeRealtime(audio: Blob | File, language: string = 'zh'): Promise<CaptionTrackResult> {
    const formData = new FormData()
    formData.append('audio', audio)
    formData.append('language', language)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.baseUrl}/transcribe_realtime`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || `Transcription failed: ${response.status}`)
      }

      return response.json()
    } finally {
      clearTimeout(timeoutId)
    }
  }
}

// 默认客户端实例
export const asrClient = new ASRClient()
