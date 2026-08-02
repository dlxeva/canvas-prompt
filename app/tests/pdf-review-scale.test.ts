import { describe, expect, it } from 'vitest'
import { reviewPageScale } from '../src/pdf-review-scale'

describe('responsive Artifact Review page scale', () => {
  it('fits a wide page into a narrow sidebar at the 100% baseline', () => {
    expect(reviewPageScale(1000, 420, 100)).toBeCloseTo(0.42)
  })

  it('does not enlarge a page merely because the browser is wide', () => {
    expect(reviewPageScale(1000, 1400, 100)).toBe(1)
  })

  it('applies explicit zoom relative to the fitted baseline', () => {
    expect(reviewPageScale(1000, 420, 120)).toBeCloseTo(0.504)
  })
})
