import { describe, expect, it } from 'vitest'
import { splitRawTraceSegments } from '../src/raw-trace-segments'

describe('raw trace checkpoint segments', () => {
  it('keeps events whole while bounding normal segments', () => {
    const events = Array.from({ length: 12 }, (_, index) => ({ index, payload: 'x'.repeat(90) }))
    const segments = splitRawTraceSegments(events, 300)
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.flat().map((event) => event.index)).toEqual(events.map((event) => event.index))
    for (const segment of segments) expect(new TextEncoder().encode(JSON.stringify(segment)).byteLength).toBeLessThanOrEqual(300)
  })

  it('keeps a dense ten-minute trace ordered and recoverable across local checkpoints', () => {
    const events = Array.from({ length: 6_000 }, (_, index) => ({
      at_ms: index * 100,
      kind: index % 10 === 0 ? 'stroke_start' : 'pointer_move',
      payload: 'x'.repeat(2_048),
    }))
    const segments = splitRawTraceSegments(events)

    expect(segments.length).toBeGreaterThan(1)
    expect(segments.flat()).toEqual(events)
    expect(segments.flat().at(-1)?.at_ms).toBe(599_900)
    for (const segment of segments) {
      expect(new TextEncoder().encode(JSON.stringify(segment)).byteLength).toBeLessThanOrEqual(4 * 1024 * 1024)
    }
  })
})
