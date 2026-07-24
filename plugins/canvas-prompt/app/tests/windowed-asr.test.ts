import { describe, expect, it } from 'vitest'
import { absoluteSegments, mergeWindowSegments } from '../src/windowed-asr'

describe('windowed ASR timeline', () => {
  it('moves window-relative ASR timestamps onto the recording timeline', () => {
    expect(absoluteSegments(22_000, [{ start: 1.25, end: 3.4, text: '继续推演', confidence: 0.91 }])).toEqual([
      { startMs: 23_250, endMs: 25_400, text: '继续推演', confidence: 0.91, isFinal: true },
    ])
  })

  it('only removes exact duplicates inside an overlap window', () => {
    const merged = mergeWindowSegments([
      { startMs: 20_000, endMs: 24_000, text: '这里先保留', confidence: 0.8, isFinal: true },
      { startMs: 22_000, endMs: 24_100, text: '这里先保留', confidence: 0.9, isFinal: true },
      { startMs: 23_000, endMs: 27_000, text: '然后画一个箭头', confidence: 0.9, isFinal: true },
    ])
    expect(merged).toHaveLength(2)
    expect(merged.map((segment) => segment.text)).toEqual(['这里先保留', '然后画一个箭头'])
  })

  it('does not silently erase a different overlapping utterance', () => {
    const merged = mergeWindowSegments([
      { startMs: 20_000, endMs: 24_000, text: '这里先保留', confidence: 0.8, isFinal: true },
      { startMs: 22_000, endMs: 24_100, text: '这里先改掉', confidence: 0.9, isFinal: true },
    ])
    expect(merged).toHaveLength(2)
  })
})

