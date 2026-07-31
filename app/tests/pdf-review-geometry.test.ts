import { describe, expect, it } from 'vitest'
import { clientPointToPagePoint } from '../src/pdf-review-geometry'

describe('PDF page-normalized geometry', () => {
  it('maps viewport input to page-relative ratios regardless of rendered size', () => {
    expect(clientPointToPagePoint({ clientX: 420, clientY: 530 }, { left: 120, top: 80, width: 600, height: 900 })).toEqual({ x: 0.5, y: 0.5 })
    expect(clientPointToPagePoint({ clientX: 210, clientY: 305 }, { left: 120, top: 80, width: 180, height: 450 })).toEqual({ x: 0.5, y: 0.5 })
  })

  it('clamps a pointer that lands outside the page edge', () => {
    expect(clientPointToPagePoint({ clientX: 0, clientY: 2_000 }, { left: 120, top: 80, width: 600, height: 900 })).toEqual({ x: 0, y: 1 })
  })
})
