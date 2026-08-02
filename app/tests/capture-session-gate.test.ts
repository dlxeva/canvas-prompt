import { describe, expect, it } from 'vitest'
import { captureSwitchBlockMessage } from '../src/capture-session-gate'

describe('capture session gate', () => {
  it('allows switching after the current workspace is fully idle', () => {
    expect(captureSwitchBlockMessage('canvas', false, 'zh')).toBeNull()
    expect(captureSwitchBlockMessage('artifact-review', false, 'en')).toBeNull()
  })

  it('explains why an active freeform round cannot switch workspaces', () => {
    expect(captureSwitchBlockMessage('canvas', true, 'zh')).toBe('当前自由推演仍在记录或整理，请先结束本轮，再进入交互审阅。')
  })

  it('explains why an active review cannot switch workspaces', () => {
    expect(captureSwitchBlockMessage('artifact-review', true, 'en')).toBe('Interactive Review is still recording or finalizing. Finish this round before returning to Freeform.')
  })
})
