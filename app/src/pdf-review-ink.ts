import { getStroke } from 'perfect-freehand'
import type { PagePoint } from './artifact-review-package'

type PointerSample = { clientX: number; clientY: number }

/**
 * Chromium may expose getCoalescedEvents() while returning an empty array for
 * pointerdown. Falling back to the original event preserves the stroke origin.
 */
export function pointerSamples<T extends PointerSample & { getCoalescedEvents?: () => T[] }>(event: T): T[] {
  if (typeof event.getCoalescedEvents === 'function') {
    const coalesced = event.getCoalescedEvents()
    if (coalesced.length > 0) return coalesced
  }
  return [event]
}

/** Converts normalized raw points into a valid closed SVG fill path. */
export function createInkSvgPath(points: PagePoint[], draft: boolean) {
  if (points.length < 2) return ''
  const outline = getStroke(points.map(({ x, y }) => [x * 1000, y * 1000]), {
    size: 2.4,
    thinning: 0,
    smoothing: 0.6,
    streamline: 0.35,
    simulatePressure: false,
    last: !draft,
  })
  if (outline.length === 0) return ''
  return `M ${outline.map(([x, y]) => `${x},${y}`).join(' L ')} Z`
}
