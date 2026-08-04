import { describe, expect, it } from 'vitest'
import { reviewPageScale } from '../src/pdf-review-scale'

describe('responsive Artifact Review page scale', () => {
  it('fits a wide page into a narrow sidebar at the 100% baseline', () => {
    expect(reviewPageScale(1000, 562.5, 420, 900, 100)).toBeCloseTo(0.42)
  })

  it('uses the available width when the browser is wider than the native page', () => {
    expect(reviewPageScale(1000, 562.5, 1400, 900, 100)).toBeCloseTo(1.4)
  })

  it('uses the available height when it is the constraining dimension', () => {
    expect(reviewPageScale(1000, 562.5, 1400, 600, 100)).toBeCloseTo(600 / 562.5)
  })

  it('uses the extra viewport width and height for a wide review stage', () => {
    expect(reviewPageScale(1000, 562.5, 1500, 843.75, 100)).toBeCloseTo(1.5)
  })

  it('applies explicit zoom relative to the fitted baseline', () => {
    expect(reviewPageScale(1000, 562.5, 420, 900, 120)).toBeCloseTo(0.504)
  })

  it('keeps the explicit zoom multiplier when the viewport is resized', () => {
    expect(reviewPageScale(1000, 562.5, 1500, 843.75, 120)).toBeCloseTo(1.8)
  })
})
