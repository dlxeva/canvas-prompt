import { describe, expect, it, vi } from 'vitest'
import { VoiceRecorder } from '../src/voice-recorder'

describe('microphone permission boundary', () => {
  it('reports a denied microphone explicitly and leaves the recorder inactive', async () => {
    const onError = vi.fn()
    const getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error('denied by test'), { name: 'NotAllowedError' }))
    vi.stubGlobal('navigator', {
      mediaDevices: { addEventListener: vi.fn(), getUserMedia },
      permissions: { query: vi.fn() },
    })

    const recorder = new VoiceRecorder({}, { onError })
    await expect(recorder.start()).rejects.toThrow('Microphone permission denied')

    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(recorder.getState()).toBe('inactive')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Microphone permission denied. Please allow microphone access.' }))
    vi.unstubAllGlobals()
  })
})
