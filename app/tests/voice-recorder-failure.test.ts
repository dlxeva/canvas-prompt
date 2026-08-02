import { describe, expect, it, vi } from 'vitest'
import { VoiceRecorder } from '../src/voice-recorder'

describe('VoiceRecorder failure cleanup', () => {
  it('removes its devicechange listener on dispose', () => {
    const mediaDevices = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('navigator', { mediaDevices })
    const recorder = new VoiceRecorder()
    recorder.dispose()
    expect(mediaDevices.addEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function))
    expect(mediaDevices.removeEventListener).toHaveBeenCalledWith('devicechange', mediaDevices.addEventListener.mock.calls[0][1])
    vi.unstubAllGlobals()
  })

  it('rejects a pending stop and returns to inactive after MediaRecorder failure', async () => {
    const tracks = [{ stop: vi.fn() }]
    const fakeRecorder = { mimeType: 'audio/webm', ondataavailable: null, onerror: null, onstop: null, stop: vi.fn() }
    class MockMediaRecorder {
      static isTypeSupported() { return true }
      constructor() { return fakeRecorder }
    }
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    const recorder = new VoiceRecorder()
    ;(recorder as any).stream = { getTracks: () => tracks }
    ;(recorder as any).state = 'recording'
    ;(recorder as any).startTime = Date.now() - 100
    ;(recorder as any).setupMediaRecorder()
    const stopping = recorder.stop()
    fakeRecorder.onerror?.({ message: 'device lost' } as ErrorEvent)
    await expect(stopping).rejects.toThrow('MediaRecorder error: device lost')
    expect(recorder.getState()).toBe('inactive')
    expect((recorder as any).mediaRecorder).toBeNull()
    expect(tracks[0].stop).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
