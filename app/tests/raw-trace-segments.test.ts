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
})
