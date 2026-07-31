import { describe, expect, it } from 'vitest'
import { createInkSvgPath, pointerSamples } from '../src/pdf-review-ink'

describe('PDF review ink rendering', () => {
  it('creates a valid SVG path that begins with an explicit move command', () => {
    const path = createInkSvgPath([{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }], false)
    expect(path).toMatch(/^M /)
    expect(path).toMatch(/ Z$/)
  })

  it('keeps the original pointer event when coalesced events are empty', () => {
    const pointer = { clientX: 120, clientY: 240, getCoalescedEvents: () => [] }
    expect(pointerSamples(pointer)).toEqual([pointer])
  })

  it('uses coalesced pointer samples when the browser provides them', () => {
    const samples = [{ clientX: 121, clientY: 241 }, { clientX: 122, clientY: 242 }]
    const pointer = { clientX: 120, clientY: 240, getCoalescedEvents: () => samples }
    expect(pointerSamples(pointer)).toEqual(samples)
  })
})
