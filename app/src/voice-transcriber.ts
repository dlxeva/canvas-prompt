/**
 * voice-transcriber.ts
 * 语音转写模块
 *
 * 提供三种转写策略：
 *   1. Web Speech API (浏览器原生，实时，免费，中文支持一般)
 *   2. Whisper API (OpenAI，高质量，需要API key)
 *   3. MiMo ASR (小米语音识别，中文优化，需要API key)
 *
 * 使用方式：
 *   const transcriber = new VoiceTranscriber({ strategy: 'mimo-asr' })
 *   transcriber.start()
 *   // ... 录音过程中 ...
 *   const result = await transcriber.stop()
 *   console.log(result.text) // 转写文本
 */

// ============================================================
// 类型定义
// ============================================================

export type TranscriptionStrategy = 'webspeech' | 'whisper-api' | 'local-whisper' | 'mimo-asr' | 'glm-asr' | 'doubao-asr'

export interface TranscriptSegment {
  text: string
  startMs: number
  endMs: number
  confidence: number
  isFinal: boolean
}

export interface TranscriptionResult {
  text: string
  segments: TranscriptSegment[]
  language: string
  strategy: TranscriptionStrategy
  durationMs: number
}

export interface TranscriberOptions {
  strategy?: TranscriptionStrategy
  language?: string
  continuous?: boolean
  interimResults?: boolean
  whisperApiUrl?: string
  whisperApiKey?: string
  mimoApiKey?: string
  mimoBaseUrl?: string
  glmApiKey?: string
  glmBaseUrl?: string
  asrServerUrl?: string
  doubaoApiKey?: string
  doubaoResourceId?: string
  onInterim?: (text: string) => void
  onSegment?: (segment: TranscriptSegment) => void
}

// ============================================================
// Web Speech API 实现
// ============================================================

class WebSpeechTranscriber {
  private recognition: any | null = null
  private segments: TranscriptSegment[] = []
  private startTime = 0
  private isRunning = false
  private options: TranscriberOptions

  constructor(options: TranscriberOptions) {
    this.options = options
  }

  get isSupported(): boolean {
    return typeof window !== 'undefined' &&
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isSupported) {
        reject(new Error('Web Speech API 不支持'))
        return
      }

      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      this.recognition = new SpeechRecognition()

      this.recognition.lang = this.options.language || 'zh-CN'
      this.recognition.continuous = this.options.continuous !== false
      this.recognition.interimResults = this.options.interimResults !== false
      this.recognition.maxAlternatives = 1

      this.startTime = Date.now()
      this.segments = []
      this.isRunning = true

      this.recognition.onresult = (event: any) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          const transcript = result[0].transcript
          const confidence = result[0].confidence

          if (result.isFinal) {
            const segment: TranscriptSegment = {
              text: transcript.trim(),
              startMs: Date.now() - this.startTime,
              endMs: Date.now() - this.startTime,
              confidence,
              isFinal: true,
            }
            this.segments.push(segment)
            this.options.onSegment?.(segment)
          } else {
            // 临时结果
            this.options.onInterim?.(transcript)
          }
        }
      }

      this.recognition.onerror = (event: any) => {
        console.error('[WebSpeechTranscriber] error:', event.error)
        if (event.error === 'not-allowed') {
          reject(new Error('麦克风权限被拒绝'))
        } else if (event.error === 'no-speech') {
          // 没有检测到语音，继续
        } else {
          reject(new Error(`语音识别错误: ${event.error}`))
        }
      }

      this.recognition.onend = () => {
        if (this.isRunning) {
          // 自动重启（continuous模式）
          try {
            this.recognition.start()
          } catch (e) {
            // 忽略重复启动错误
          }
        }
      }

      this.recognition.onstart = () => {
        resolve()
      }

      try {
        this.recognition.start()
      } catch (e) {
        reject(e)
      }
    })
  }

  stop(): TranscriptionResult {
    this.isRunning = false
    if (this.recognition) {
      try {
        this.recognition.stop()
      } catch (e) {
        // 忽略
      }
      this.recognition = null
    }

    const fullText = this.segments.map(s => s.text).join(' ')
    const durationMs = Date.now() - this.startTime

    return {
      text: fullText,
      segments: [...this.segments],
      language: this.options.language || 'zh-CN',
      strategy: 'webspeech',
      durationMs,
    }
  }

  abort(): void {
    this.isRunning = false
    if (this.recognition) {
      try {
        this.recognition.abort()
      } catch (e) {
        // 忽略
      }
      this.recognition = null
    }
  }
}

// ============================================================
// Whisper API 实现（占位，需要后端代理）
// ============================================================

class WhisperApiTranscriber {
  private audioChunks: Blob[] = []
  private startTime = 0
  private options: TranscriberOptions

  constructor(options: TranscriberOptions) {
    this.options = options
  }

  get isSupported(): boolean {
    return !!this.options.whisperApiUrl
  }

  async start(): Promise<void> {
    this.audioChunks = []
    this.startTime = Date.now()
  }

  addAudioChunk(chunk: Blob): void {
    this.audioChunks.push(chunk)
  }

  async stop(): Promise<TranscriptionResult> {
    if (this.audioChunks.length === 0) {
      return {
        text: '',
        segments: [],
        language: this.options.language || 'zh-CN',
        strategy: 'whisper-api',
        durationMs: Date.now() - this.startTime,
      }
    }

    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' })

    // 调用Whisper API
    const formData = new FormData()
    formData.append('file', audioBlob, 'audio.webm')
    formData.append('model', 'whisper-1')
    formData.append('language', this.options.language || 'zh')
    formData.append('response_format', 'verbose_json')

    try {
      const response = await fetch(this.options.whisperApiUrl!, {
        method: 'POST',
        headers: this.options.whisperApiKey
          ? { 'Authorization': `Bearer ${this.options.whisperApiKey}` }
          : {},
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`Whisper API error: ${response.status}`)
      }

      const data = await response.json() as {
        text: string
        segments?: Array<{ start: number; end: number; text: string }>
        language?: string
      }

      const segments: TranscriptSegment[] = (data.segments || []).map(seg => ({
        text: seg.text.trim(),
        startMs: Math.round(seg.start * 1000),
        endMs: Math.round(seg.end * 1000),
        confidence: 0.9,
        isFinal: true,
      }))

      return {
        text: data.text.trim(),
        segments,
        language: data.language || this.options.language || 'zh-CN',
        strategy: 'whisper-api',
        durationMs: Date.now() - this.startTime,
      }
    } catch (err) {
      console.error('[WhisperApiTranscriber] error:', err)
      throw err
    }
  }

  abort(): void {
    this.audioChunks = []
  }
}

// ============================================================
// MiMo ASR 实现（小米语音识别）
// ============================================================

class MiMoAsrTranscriber {
  private audioChunks: Blob[] = []
  private startTime = 0
  private options: TranscriberOptions

  constructor(options: TranscriberOptions) {
    this.options = options
  }

  get isSupported(): boolean {
    return !!this.options.mimoApiKey
  }

  async start(): Promise<void> {
    this.audioChunks = []
    this.startTime = Date.now()
  }

  addAudioChunk(chunk: Blob): void {
    this.audioChunks.push(chunk)
  }

  async stop(): Promise<TranscriptionResult> {
    if (this.audioChunks.length === 0) {
      return {
        text: '',
        segments: [],
        language: this.options.language || 'zh-CN',
        strategy: 'mimo-asr',
        durationMs: Date.now() - this.startTime,
      }
    }

    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' })

    // 转换为 WAV 格式（MiMo ASR 只支持 wav/mp3）
    const wavBlob = await this.convertToWav(audioBlob)

    // 转换为 Base64
    const base64Audio = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const dataUrl = reader.result as string
        // 提取 base64 部分（去掉 data:audio/wav;base64, 前缀）
        const base64 = dataUrl.split(',')[1]
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(wavBlob)
    })

    // 调用 MiMo ASR API
    const baseUrl = this.options.mimoBaseUrl || 'https://api.xiaomimimo.com/v1'
    const language = this.options.language === 'en' ? 'en' : 'zh'

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.options.mimoApiKey!,
        },
        body: JSON.stringify({
          model: 'mimo-v2.5-asr',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_audio',
                  input_audio: {
                    data: `data:audio/wav;base64,${base64Audio}`,
                  },
                },
              ],
            },
          ],
          asr_options: {
            language: language,
          },
        }),
      })

      if (!response.ok) {
        const errorData = await response.text()
        throw new Error(`MiMo ASR error: ${response.status} - ${errorData}`)
      }

      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content: string
          }
        }>
      }

      const text = data.choices?.[0]?.message?.content?.trim() || ''

      return {
        text,
        segments: [
          {
            text,
            startMs: 0,
            endMs: Date.now() - this.startTime,
            confidence: 0.9,
            isFinal: true,
          },
        ],
        language: this.options.language || 'zh-CN',
        strategy: 'mimo-asr',
        durationMs: Date.now() - this.startTime,
      }
    } catch (err) {
      console.error('[MiMoAsrTranscriber] error:', err)
      throw err
    }
  }

  /**
   * 将 webm 转换为 wav 格式
   */
  private async convertToWav(webmBlob: Blob): Promise<Blob> {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    const arrayBuffer = await webmBlob.arrayBuffer()
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)

    // 创建 WAV 文件
    const numChannels = audioBuffer.numberOfChannels
    const sampleRate = audioBuffer.sampleRate
    const format = 1 // PCM
    const bitDepth = 16

    const bytesPerSample = bitDepth / 8
    const blockAlign = numChannels * bytesPerSample
    const dataSize = audioBuffer.length * blockAlign
    const bufferSize = 44 + dataSize

    const buffer = new ArrayBuffer(bufferSize)
    const view = new DataView(buffer)

    // WAV header
    this.writeString(view, 0, 'RIFF')
    view.setUint32(4, bufferSize - 8, true)
    this.writeString(view, 8, 'WAVE')
    this.writeString(view, 12, 'fmt ')
    view.setUint32(16, 16, true) // fmt chunk size
    view.setUint16(20, format, true)
    view.setUint16(22, numChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * blockAlign, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, bitDepth, true)
    this.writeString(view, 36, 'data')
    view.setUint32(40, dataSize, true)

    // 写入音频数据
    let offset = 44
    for (let i = 0; i < audioBuffer.length; i++) {
      for (let channel = 0; channel < numChannels; channel++) {
        const sample = audioBuffer.getChannelData(channel)[i]
        // 转换为 16-bit PCM
        const clampedSample = Math.max(-1, Math.min(1, sample))
        const intSample = clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7FFF
        view.setInt16(offset, intSample, true)
        offset += 2
      }
    }

    return new Blob([buffer], { type: 'audio/wav' })
  }

  private writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  abort(): void {
    this.audioChunks = []
  }
}

// ============================================================
// GLM ASR 实现（智谱 GLM-ASR-2512 + 服务端VAD分段）
// ============================================================

class GlmAsrTranscriber {
  private audioChunks: Blob[] = []
  private startTime = 0
  private options: TranscriberOptions

  constructor(options: TranscriberOptions) {
    this.options = options
  }

  get isSupported(): boolean {
    // 优先用本地 ASR Server（有VAD分段），否则直调GLM API（无分段）
    return !!this.options.asrServerUrl || !!this.options.glmApiKey
  }

  async start(): Promise<void> {
    this.audioChunks = []
    this.startTime = Date.now()
  }

  addAudioChunk(chunk: Blob): void {
    this.audioChunks.push(chunk)
  }

  async stop(): Promise<TranscriptionResult> {
    if (this.audioChunks.length === 0) {
      return {
        text: '',
        segments: [],
        language: this.options.language || 'zh-CN',
        strategy: 'glm-asr',
        durationMs: Date.now() - this.startTime,
      }
    }

    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' })

    // 优先走本地 ASR Server（有VAD分段+时间戳）
    if (this.options.asrServerUrl) {
      try {
        return await this.transcribeViaServer(audioBlob)
      } catch (err) {
        console.error('[GlmAsrTranscriber] ASR Server 调用失败，尝试直调GLM API:', err)
        // 降级到直调GLM API
      }
    }

    // 降级：直调GLM API（无VAD分段，无时间戳）
    if (this.options.glmApiKey) {
      return await this.transcribeDirect(audioBlob)
    }

    throw new Error('GLM ASR 不可用：需要 asrServerUrl 或 glmApiKey')
  }

  /**
   * 通过本地 ASR Server 转写（有VAD分段+时间戳）
   */
  private async transcribeViaServer(audioBlob: Blob): Promise<TranscriptionResult> {
    const serverUrl = this.options.asrServerUrl!

    // webm → wav
    const wavBlob = await this.convertToWav(audioBlob)

    const formData = new FormData()
    formData.append('audio', wavBlob, 'audio.wav')
    formData.append('language', this.options.language === 'en' ? 'en' : 'zh')

    const response = await fetch(`${serverUrl}/transcribe`, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }))
      throw new Error(`ASR Server error: ${error.detail || response.status}`)
    }

    const data = await response.json() as {
      text: string
      segments: Array<{ start: number; end: number; text: string; confidence: number }>
      language: string
      duration: number
    }

    const segments: TranscriptSegment[] = data.segments.map(seg => ({
      text: seg.text,
      startMs: Math.round(seg.start * 1000),
      endMs: Math.round(seg.end * 1000),
      confidence: seg.confidence,
      isFinal: true,
    }))

    return {
      text: data.text,
      segments,
      language: data.language,
      strategy: 'glm-asr',
      durationMs: Math.round(data.duration * 1000),
    }
  }

  /**
   * 直调 GLM ASR API（降级模式：无VAD分段，无时间戳）
   * GLM ASR 单次限制 ≤30秒，如果音频超长会截断
   */
  private async transcribeDirect(audioBlob: Blob): Promise<TranscriptionResult> {
    const wavBlob = await this.convertToWav(audioBlob)

    const baseUrl = this.options.glmBaseUrl || 'https://open.bigmodel.cn/api/paas/v4'

    const formData = new FormData()
    formData.append('model', 'glm-asr-2512')
    formData.append('stream', 'false')
    formData.append('file', wavBlob, 'audio.wav')

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.options.glmApiKey}`,
      },
      body: formData,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`GLM ASR error: ${response.status} - ${errorText}`)
    }

    const data = await response.json() as { text: string }
    const text = data.text?.trim() || ''
    const durationMs = Date.now() - this.startTime

    return {
      text,
      segments: [{
        text,
        startMs: 0,
        endMs: durationMs,
        confidence: 0.9,
        isFinal: true,
      }],
      language: this.options.language || 'zh-CN',
      strategy: 'glm-asr',
      durationMs,
    }
  }

  /**
   * 将 webm 转换为 wav 格式
   */
  private async convertToWav(webmBlob: Blob): Promise<Blob> {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    const arrayBuffer = await webmBlob.arrayBuffer()
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)

    const numChannels = audioBuffer.numberOfChannels
    const sampleRate = 16000 // GLM ASR 推荐 16kHz
    const format = 1
    const bitDepth = 16

    const bytesPerSample = bitDepth / 8
    const blockAlign = numChannels * bytesPerSample
    const dataSize = audioBuffer.length * blockAlign
    const bufferSize = 44 + dataSize

    const buffer = new ArrayBuffer(bufferSize)
    const view = new DataView(buffer)

    this.writeString(view, 0, 'RIFF')
    view.setUint32(4, bufferSize - 8, true)
    this.writeString(view, 8, 'WAVE')
    this.writeString(view, 12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, format, true)
    view.setUint16(22, numChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * blockAlign, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, bitDepth, true)
    this.writeString(view, 36, 'data')
    view.setUint32(40, dataSize, true)

    let offset = 44
    for (let i = 0; i < audioBuffer.length; i++) {
      for (let channel = 0; channel < numChannels; channel++) {
        const sample = audioBuffer.getChannelData(channel)[i]
        const clampedSample = Math.max(-1, Math.min(1, sample))
        const intSample = clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7FFF
        view.setInt16(offset, intSample, true)
        offset += 2
      }
    }

    return new Blob([buffer], { type: 'audio/wav' })
  }

  private writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  abort(): void {
    this.audioChunks = []
  }
}

// ============================================================
// 本地 Whisper ASR 实现（通过本地 ASR Server，原生时间戳）
// ============================================================

class DoubaoAsrTranscriber {
  private audioChunks: Blob[] = []
  private startTime = 0
  private options: TranscriberOptions

  constructor(options: TranscriberOptions) {
    this.options = options
  }

  get isSupported(): boolean {
    return !!this.options.asrServerUrl
  }

  async start(): Promise<void> {
    this.audioChunks = []
    this.startTime = Date.now()
  }

  addAudioChunk(chunk: Blob): void {
    this.audioChunks.push(chunk)
  }

  async stop(): Promise<TranscriptionResult> {
    if (this.audioChunks.length === 0) {
      return {
        text: '',
        segments: [],
        language: this.options.language || 'zh-CN',
        strategy: 'local-whisper',
        durationMs: Date.now() - this.startTime,
      }
    }

    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' })

    const serverUrl = this.options.asrServerUrl!
    const formData = new FormData()
    // 直接发 webm，后端 webm_to_wav_pcm 会转 wav；省掉前端 convertToWav
    formData.append('audio', audioBlob, 'audio.webm')
    formData.append('language', 'zh-CN')

    // backend=whisper：本地 faster-whisper，零外部依赖，自带句级时间戳
    const response = await fetch(`${serverUrl}/transcribe?backend=whisper`, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }))
      throw new Error(`ASR Server error: ${error.detail || response.status}`)
    }

    const data = await response.json() as {
      text: string
      segments: Array<{ start: number; end: number; text: string; confidence: number }>
      language: string
      duration: number
    }

    const segments: TranscriptSegment[] = data.segments.map(seg => ({
      text: seg.text,
      startMs: Math.round(seg.start * 1000),
      endMs: Math.round(seg.end * 1000),
      confidence: seg.confidence,
      isFinal: true,
    }))

    return {
      text: data.text,
      segments,
      language: data.language,
      strategy: 'local-whisper',
      durationMs: Math.round(data.duration * 1000),
    }
  }

  abort(): void {
    this.audioChunks = []
  }
}

// ============================================================
// 主转写器类
// ============================================================

export class VoiceTranscriber {
  private strategy: TranscriptionStrategy
  private webSpeech: WebSpeechTranscriber | null = null
  private whisperApi: WhisperApiTranscriber | null = null
  private mimoAsr: MiMoAsrTranscriber | null = null
  private glmAsr: GlmAsrTranscriber | null = null
  private doubaoAsr: DoubaoAsrTranscriber | null = null
  private options: TranscriberOptions

  constructor(options: TranscriberOptions = {}) {
    this.options = options
    this.strategy = options.strategy || 'webspeech'
  }

  get isSupported(): boolean {
    switch (this.strategy) {
      case 'webspeech':
        return typeof window !== 'undefined' &&
          ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
      case 'whisper-api':
        return !!this.options.whisperApiUrl
      case 'mimo-asr':
        return !!this.options.mimoApiKey
      case 'glm-asr':
        return !!this.options.asrServerUrl || !!this.options.glmApiKey
      case 'doubao-asr':
      case 'local-whisper':
        return !!this.options.asrServerUrl
      default:
        return false
    }
  }

  async start(): Promise<void> {
    switch (this.strategy) {
      case 'webspeech':
        this.webSpeech = new WebSpeechTranscriber(this.options)
        await this.webSpeech.start()
        break
      case 'whisper-api':
        this.whisperApi = new WhisperApiTranscriber(this.options)
        await this.whisperApi.start()
        break
      case 'mimo-asr':
        this.mimoAsr = new MiMoAsrTranscriber(this.options)
        await this.mimoAsr.start()
        break
      case 'glm-asr':
        this.glmAsr = new GlmAsrTranscriber(this.options)
        await this.glmAsr.start()
        break
      case 'doubao-asr':
      case 'local-whisper':
        this.doubaoAsr = new DoubaoAsrTranscriber(this.options)
        await this.doubaoAsr.start()
        break
      default:
        throw new Error(`不支持的转写策略: ${this.strategy}`)
    }
  }

  addAudioChunk(chunk: Blob): void {
    if (this.strategy === 'whisper-api' && this.whisperApi) {
      this.whisperApi.addAudioChunk(chunk)
    } else if (this.strategy === 'mimo-asr' && this.mimoAsr) {
      this.mimoAsr.addAudioChunk(chunk)
    } else if (this.strategy === 'glm-asr' && this.glmAsr) {
      this.glmAsr.addAudioChunk(chunk)
    } else if ((this.strategy === 'doubao-asr' || this.strategy === 'local-whisper') && this.doubaoAsr) {
      this.doubaoAsr.addAudioChunk(chunk)
    }
  }

  async stop(): Promise<TranscriptionResult> {
    switch (this.strategy) {
      case 'webspeech':
        if (!this.webSpeech) throw new Error('WebSpeech未启动')
        return this.webSpeech.stop()
      case 'whisper-api':
        if (!this.whisperApi) throw new Error('WhisperApi未启动')
        return this.whisperApi.stop()
      case 'mimo-asr':
        if (!this.mimoAsr) throw new Error('MiMoAsr未启动')
        return this.mimoAsr.stop()
      case 'glm-asr':
        if (!this.glmAsr) throw new Error('GlmAsr未启动')
        return this.glmAsr.stop()
      case 'doubao-asr':
      case 'local-whisper':
        if (!this.doubaoAsr) throw new Error('DoubaoAsr未启动')
        return this.doubaoAsr.stop()
      default:
        throw new Error(`不支持的转写策略: ${this.strategy}`)
    }
  }

  abort(): void {
    this.webSpeech?.abort()
    this.whisperApi?.abort()
    this.mimoAsr?.abort()
    this.glmAsr?.abort()
    this.doubaoAsr?.abort()
  }

  /**
   * 自动选择最佳策略
   */
  static autoDetect(): TranscriptionStrategy {
    if (typeof window !== 'undefined') {
      if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
        return 'webspeech'
      }
    }
    return 'whisper-api'
  }
}

export default VoiceTranscriber
