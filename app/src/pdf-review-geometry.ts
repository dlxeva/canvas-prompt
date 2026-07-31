import type { PagePoint } from './artifact-review-package'

type ClientPoint = { clientX: number; clientY: number }
type ClientRect = { left: number; top: number; width: number; height: number }

const clampRatio = (value: number) => Math.max(0, Math.min(1, value))

/** Converts CSS viewport input into page-relative coordinates for zoom-safe replay. */
export function clientPointToPagePoint(point: ClientPoint, bounds: ClientRect): PagePoint {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 }
  return {
    x: clampRatio((point.clientX - bounds.left) / bounds.width),
    y: clampRatio((point.clientY - bounds.top) / bounds.height),
  }
}
