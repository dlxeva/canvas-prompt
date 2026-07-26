/**
 * Voice Recorder Module
 *
 * 语音采集模块 - 提供完整的录音功能
 * 功能：MediaRecorder初始化、权限管理、设备选择、录音导出、电平监控、暂停/继续
 */

// ============================================================
// Type Definitions
// ============================================================

/** 录音状态 */
export type RecordingState = 'inactive' | 'recording' | 'paused';

/** 录音格式 */
export type AudioFormat = 'webm' | 'mp3' | 'wav' | 'ogg';

/** 电平数据 */
export interface AudioLevel {
  /** 均方根电平 (0~1) */
  rms: number;
  /** 峰值电平 (0~1) */
  peak: number;
  /** 分贝值 (dB) */
  db: number;
}

/** 录音配置 */
export interface RecorderConfig {
  /** 音频格式 */
  format?: AudioFormat;
  /** 比特率 (bps) */
  bitrate?: number;
  /** 采样率 (Hz) */
  sampleRate?: number;
  /** 声道数 */
  channelCount?: number;
  /** 是否启用降噪 */
  noiseSuppression?: boolean;
  /** 是否启用回声消除 */
  echoCancellation?: boolean;
  /** 是否启用自动增益控制 */
  autoGainControl?: boolean;
  /** 电平监控回调间隔 (ms) */
  levelInterval?: number;
}

/** 录音结果 */
export interface RecordingResult {
  /** 音频 Blob */
  blob: Blob;
  /** 音频 URL */
  url: string;
  /** 时长 (ms) */
  duration: number;
  /** 格式 */
  format: AudioFormat;
  /** 大小 (bytes) */
  size: number;
  /** 起始时间戳 */
  startTime: number;
  /** 结束时间戳 */
  endTime: number;
  /** 暂停时间段 */
  pauseSegments: Array<{ start: number; end: number }>;
}

/** 设备信息 */
export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  groupId: string;
}

/** 事件回调映射 */
export interface RecorderEvents {
  onStateChange?: (state: RecordingState) => void;
  onLevelChange?: (level: AudioLevel) => void;
  onDataAvailable?: (data: Blob) => void;
  onError?: (error: Error) => void;
  onDeviceChange?: () => void;
  onStart?: () => void;
  onStop?: (result: RecordingResult) => void;
  onPause?: () => void;
  onResume?: () => void;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONFIG: Required<RecorderConfig> = {
  format: 'webm',
  bitrate: 128000,
  sampleRate: 44100,
  channelCount: 1,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  levelInterval: 50,
};

// MIME type mapping with fallbacks
const MIME_TYPES: Record<AudioFormat, string[]> = {
  webm: ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'],
  ogg: ['audio/ogg;codecs=opus', 'audio/ogg'],
  mp3: ['audio/mpeg', 'audio/mp3'],
  wav: ['audio/wav', 'audio/wave', 'audio/x-wav'],
};

// ============================================================
// Utility Functions
// ============================================================

/**
 * 检测浏览器支持的 MIME 类型
 */
function getSupportedMimeType(format: AudioFormat): string | null {
  const types = MIME_TYPES[format];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return null;
}

/**
 * 计算 RMS (Root Mean Square)
 */
function calculateRMS(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / data.length);
}

/**
 * 计算 Peak
 */
function calculatePeak(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > max) max = abs;
  }
  return max;
}

/**
 * 线性值转分贝
 */
function linearToDb(value: number): number {
  if (value === 0) return -Infinity;
  return 20 * Math.log10(value);
}

// ============================================================
// VoiceRecorder Class
// ============================================================

export class VoiceRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private state: RecordingState = 'inactive';
  private config: Required<RecorderConfig>;
  private events: RecorderEvents;
  private levelTimer: number | null = null;
  private startTime: number = 0;
  private pauseSegments: Array<{ start: number; end: number }> = [];
  private currentPauseStart: number = 0;
  private selectedDeviceId: string | undefined;
  private levelDataArray: Float32Array<ArrayBuffer> | null = null;

  constructor(config: RecorderConfig = {}, events: RecorderEvents = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events;

    // 监听设备变化
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        this.events.onDeviceChange?.();
      });
    }
  }

  // ----------------------------------------------------------
  // Public API - Device Management
  // ----------------------------------------------------------

  /**
   * 获取可用的音频输入设备列表
   */
  async getAvailableDevices(): Promise<AudioDeviceInfo[]> {
    try {
      // 先请求临时权限以获取设备标签
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === 'audioinput')
        .map(d => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          groupId: d.groupId,
        }));
    } catch (err) {
      this.handleError(new Error(`Failed to enumerate devices: ${(err as Error).message}`));
      return [];
    }
  }

  /**
   * 选择输入设备
   */
  setDevice(deviceId: string): void {
    this.selectedDeviceId = deviceId;
  }

  /**
   * 获取当前选中的设备 ID
   */
  getSelectedDeviceId(): string | undefined {
    return this.selectedDeviceId;
  }

  // ----------------------------------------------------------
  // Public API - Recording Control
  // ----------------------------------------------------------

  /**
   * 初始化并开始录音
   */
  async start(): Promise<void> {
    if (this.state === 'recording' || this.state === 'paused') {
      throw new Error('Recording already in progress. Stop current recording first.');
    }

    try {
      // 1. 请求麦克风权限
      await this.acquireStream();

      // 2. 创建 AudioContext 和分析节点（用于电平监控）
      this.setupAudioContext();

      // 3. 创建 MediaRecorder
      this.setupMediaRecorder();

      // 4. 开始录音
      this.chunks = [];
      this.pauseSegments = [];
      this.startTime = Date.now();
      this.mediaRecorder!.start(100); // 每 100ms 触发一次 dataavailable
      this.setState('recording');

      // 5. 启动电平监控
      this.startLevelMonitoring();

      this.events.onStart?.();
    } catch (err) {
      this.cleanup();
      this.handleError(err as Error);
      throw err;
    }
  }

  /**
   * 暂停录音
   */
  pause(): void {
    if (this.state !== 'recording' || !this.mediaRecorder) {
      throw new Error('Not recording. Cannot pause.');
    }

    this.mediaRecorder.pause();
    this.currentPauseStart = Date.now();
    this.setState('paused');
    this.events.onPause?.();
  }

  /**
   * 继续录音
   */
  resume(): void {
    if (this.state !== 'paused' || !this.mediaRecorder) {
      throw new Error('Not paused. Cannot resume.');
    }

    this.mediaRecorder.resume();
    this.pauseSegments.push({
      start: this.currentPauseStart,
      end: Date.now(),
    });
    this.setState('recording');
    this.events.onResume?.();
  }

  /**
   * 停止录音并返回结果
   */
  async stop(): Promise<RecordingResult> {
    if (this.state === 'inactive' || !this.mediaRecorder) {
      throw new Error('Not recording. Nothing to stop.');
    }

    // 如果正在暂停，先记录暂停段
    if (this.state === 'paused') {
      this.pauseSegments.push({
        start: this.currentPauseStart,
        end: Date.now(),
      });
    }

    return new Promise<RecordingResult>((resolve, _reject) => {
      const endTime = Date.now();

      this.mediaRecorder!.onstop = () => {
        const mimeType = this.mediaRecorder!.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        const url = URL.createObjectURL(blob);

        const result: RecordingResult = {
          blob,
          url,
          duration: endTime - this.startTime - this.calculateTotalPauseDuration(),
          format: this.config.format,
          size: blob.size,
          startTime: this.startTime,
          endTime,
          pauseSegments: [...this.pauseSegments],
        };

        this.stopLevelMonitoring();
        this.cleanup();
        this.setState('inactive');

        this.events.onStop?.(result);
        resolve(result);
      };

      this.mediaRecorder!.stop();
    });
  }

  /** Lets background ASR create independently decodable audio windows. */
  createInputStreamClone(): MediaStream | null {
    return this.stream?.clone() ?? null
  }

  /**
   * 获取当前状态
   */
  getState(): RecordingState {
    return this.state;
  }

  /**
   * 获取当前电平（同步快照）
   */
  getCurrentLevel(): AudioLevel {
    if (!this.analyserNode || !this.levelDataArray) {
      return { rms: 0, peak: 0, db: -Infinity };
    }

    this.analyserNode.getFloatTimeDomainData(this.levelDataArray!);
    const rms = calculateRMS(this.levelDataArray!);
    const peak = calculatePeak(this.levelDataArray!);

    return {
      rms: Math.min(1, rms),
      peak: Math.min(1, peak),
      db: linearToDb(rms),
    };
  }

  /**
   * 更新配置（下次录音生效）
   */
  updateConfig(config: Partial<RecorderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 更新事件回调
   */
  updateEvents(events: Partial<RecorderEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 检查浏览器是否支持录音
   */
  static isSupported(): boolean {
    return !!(
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof window.MediaRecorder !== 'undefined'
    );
  }

  /**
   * 检查权限状态（不触发权限弹窗）
   */
  async checkPermission(): Promise<PermissionState> {
    try {
      const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      return result.state;
    } catch {
      return 'prompt'; // 不支持 permissions API 时返回 prompt
    }
  }

  /**
   * 释放所有资源
   */
  dispose(): void {
    this.stopLevelMonitoring();
    this.cleanup();
  }

  // ----------------------------------------------------------
  // Public API - Export Utilities
  // ----------------------------------------------------------

  /**
   * 将录音结果下载为文件
   */
  static downloadRecording(result: RecordingResult, filename?: string): void {
    const ext = result.format;
    const name = filename || `recording-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${ext}`;
    const a = document.createElement('a');
    a.href = result.url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /**
   * 将 Blob 转为 ArrayBuffer
   */
  static async blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    return blob.arrayBuffer();
  }

  /**
   * 将 Blob 转为 Base64
   */
  static async blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, _reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve(base64);
      };
      reader.onerror = _reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * 获取录音的实际有效时长（排除暂停时间）
   */
  static getEffectiveDuration(result: RecordingResult): number {
    return result.duration;
  }

  // ----------------------------------------------------------
  // Private Methods - Stream & Audio Context
  // ----------------------------------------------------------

  private async acquireStream(): Promise<void> {
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: this.selectedDeviceId ? { exact: this.selectedDeviceId } : undefined,
        sampleRate: this.config.sampleRate,
        channelCount: this.config.channelCount,
        noiseSuppression: this.config.noiseSuppression,
        echoCancellation: this.config.echoCancellation,
        autoGainControl: this.config.autoGainControl,
      } as MediaTrackConstraints,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const error = err as DOMException;
      if (error.name === 'NotAllowedError') {
        throw new Error('Microphone permission denied. Please allow microphone access.');
      } else if (error.name === 'NotFoundError') {
        throw new Error('No microphone found. Please connect an audio input device.');
      } else if (error.name === 'NotReadableError') {
        throw new Error('Microphone is in use by another application.');
      }
      throw new Error(`Failed to access microphone: ${error.message}`);
    }
  }

  private setupAudioContext(): void {
    if (!this.stream) return;

    this.audioContext = new AudioContext({ sampleRate: this.config.sampleRate });
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.8;
    this.sourceNode.connect(this.analyserNode);

    this.levelDataArray = new Float32Array(this.analyserNode.fftSize);
  }

  // ----------------------------------------------------------
  // Private Methods - MediaRecorder Setup
  // ----------------------------------------------------------

  private setupMediaRecorder(): void {
    if (!this.stream) throw new Error('No audio stream available.');

    // 查找支持的 MIME 类型
    let mimeType = getSupportedMimeType(this.config.format);

    // 如果目标格式不支持，尝试降级
    if (!mimeType) {
      const fallbackOrder: AudioFormat[] = ['webm', 'ogg', 'wav'];
      for (const fmt of fallbackOrder) {
        mimeType = getSupportedMimeType(fmt);
        if (mimeType) {
          console.warn(`Format '${this.config.format}' not supported, falling back to '${fmt}'.`);
          this.config.format = fmt;
          break;
        }
      }
    }

    if (!mimeType) {
      throw new Error('No supported audio MIME type found in this browser.');
    }

    const options: MediaRecorderOptions = {
      mimeType,
      audioBitsPerSecond: this.config.bitrate,
    };

    this.mediaRecorder = new MediaRecorder(this.stream, options);

    // 事件绑定
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.chunks.push(e.data);
        this.events.onDataAvailable?.(e.data);
      }
    };

    this.mediaRecorder.onerror = (e) => {
      this.handleError(new Error(`MediaRecorder error: ${(e as ErrorEvent).message || 'Unknown error'}`));
    };
  }

  // ----------------------------------------------------------
  // Private Methods - Level Monitoring
  // ----------------------------------------------------------

  private startLevelMonitoring(): void {
    if (this.levelTimer) return;

    const poll = () => {
      if (this.state === 'inactive') return;

      const level = this.getCurrentLevel();
      this.events.onLevelChange?.(level);

      this.levelTimer = window.setTimeout(poll, this.config.levelInterval);
    };

    poll();
  }

  private stopLevelMonitoring(): void {
    if (this.levelTimer) {
      clearTimeout(this.levelTimer);
      this.levelTimer = null;
    }
  }

  // ----------------------------------------------------------
  // Private Methods - Cleanup & Helpers
  // ----------------------------------------------------------

  private cleanup(): void {
    // 停止所有轨道
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }

    // 断开音频节点
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    // 关闭 AudioContext
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.analyserNode = null;
    this.levelDataArray = null;
    this.mediaRecorder = null;
  }

  private setState(newState: RecordingState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.events.onStateChange?.(newState);
    }
  }

  private handleError(error: Error): void {
    console.error('[VoiceRecorder]', error.message);
    this.events.onError?.(error);
  }

  private calculateTotalPauseDuration(): number {
    return this.pauseSegments.reduce((total, seg) => total + (seg.end - seg.start), 0);
  }
}

// ============================================================
// Convenience Factory
// ============================================================

/**
 * 快速创建录音器并开始录音
 */
export async function quickRecord(
  events?: RecorderEvents,
  config?: RecorderConfig,
): Promise<VoiceRecorder> {
  const recorder = new VoiceRecorder(config, events);
  await recorder.start();
  return recorder;
}

/**
 * 检测浏览器支持的录音格式
 */
export function getSupportedFormats(): AudioFormat[] {
  const formats: AudioFormat[] = ['webm', 'ogg', 'mp3', 'wav'];
  return formats.filter(f => getSupportedMimeType(f) !== null);
}
