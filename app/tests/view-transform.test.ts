import { describe, expect, it } from 'vitest'
import { appendViewTransformation } from '../src/view-transform'

describe('viewport transform evidence', () => {
  it('coalesces a pan gesture without claiming attention', () => {
    const first = { timestamp_ms: 100, zoom: 1, scroll_x: 0, scroll_y: 0 }
    const second = { timestamp_ms: 180, zoom: 1, scroll_x: 24, scroll_y: 5 }
    const third = { timestamp_ms: 240, zoom: 1, scroll_x: 60, scroll_y: 9 }
    const one = appendViewTransformation([], first, second)
    const merged = appendViewTransformation(one, second, third)
    expect(merged).toEqual([expect.objectContaining({
      kind: 'pan', sample_count: 2, time_range_ms: [100, 240],
      coordinate_space: 'viewport_transform', assertion_level: 'observation',
      interpretation_constraint: 'does_not_establish_attention_or_priority',
    })])
  })

  it('keeps a separate zoom transform after a gesture gap', () => {
    const pan = appendViewTransformation([], { timestamp_ms: 0, zoom: 1, scroll_x: 0, scroll_y: 0 }, { timestamp_ms: 100, zoom: 1, scroll_x: 20, scroll_y: 0 })
    const result = appendViewTransformation(pan, { timestamp_ms: 2_000, zoom: 1, scroll_x: 20, scroll_y: 0 }, { timestamp_ms: 2_100, zoom: 1.25, scroll_x: 20, scroll_y: 0 })
    expect(result.map((item) => item.kind)).toEqual(['pan', 'zoom'])
  })

  it('drops a small pan excursion that returns near its starting point', () => {
    const first = { timestamp_ms: 7_010, zoom: 1, scroll_x: 0, scroll_y: 0 }
    const peak = { timestamp_ms: 8_098, zoom: 1, scroll_x: 0, scroll_y: 56.2 }
    const middle = { timestamp_ms: 9_168, zoom: 1, scroll_x: 0, scroll_y: 48.6 }
    const end = { timestamp_ms: 9_821, zoom: 1, scroll_x: 0, scroll_y: 14.3 }
    const one = appendViewTransformation([], first, peak)
    const two = appendViewTransformation(one, peak, middle)
    expect(appendViewTransformation(two, middle, end)).toEqual([])
  })
})
