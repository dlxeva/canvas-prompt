export type CanvasElement = {
  id: string
  type: string
  version: number
  updated: number
  isDeleted: boolean
  x: number
  y: number
  width: number
  height: number
  points?: readonly unknown[]
  fileId?: string | null
  /** Native Excalidraw text after layout/wrapping. */
  text?: string
  /** Native user-entered text before renderer layout. */
  originalText?: string
  strokeColor?: string
  strokeWidth?: number
}

export type TraceEvent = {
  at_ms: number
  kind: 'create' | 'update' | 'delete'
  element: {
    id: string
    type: string
    version: number
    x: number
    y: number
    width: number
    height: number
    fileId: string | null
    /** Original renderer samples; retained as a diagnostic count only. */
    point_count: number | null
    /** Geometry samples retained after corner-preserving simplification. */
    sampled_point_count: number | null
    points: number[][] | null
    /** Native text fields are direct trace evidence, not OCR or inference. */
    text: string | null
    original_text: string | null
    semantic_content: string | null
    stroke_color: string | null
    stroke_width: number | null
  }
  /** Geometry immediately before a user-visible transform. */
  previous_bounds?: { x: number; y: number; width: number; height: number }
}

export type ElementCounts = {
  total: number
  freedraw: number
  lines: number
  arrows: number
  shapes: number
  images: number
}

type KnownElement = {
  version: number
  isDeleted: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

function boundsOf(element: CanvasElement) {
  return { x: element.x, y: element.y, width: element.width, height: element.height }
}

function hasGeometryChanged(before: KnownElement, element: CanvasElement) {
  const after = boundsOf(element)
  return before.bounds.x !== after.x || before.bounds.y !== after.y ||
    before.bounds.width !== after.width || before.bounds.height !== after.height
}

function squaredDistanceToSegment(point: number[], start: number[], end: number[]) {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  if (dx === 0 && dy === 0) return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)))
  const x = start[0] + t * dx
  const y = start[1] + t * dy
  return (point[0] - x) ** 2 + (point[1] - y) ** 2
}

/**
 * Retain the start, end, and visual turns of a pen path, not every renderer
 * sample. This is Ramer-Douglas-Peucker with a small scene-space tolerance:
 * a handwritten "7" keeps its horizontal-to-descending corner while a smooth
 * straight segment collapses to its endpoints.
 */
function simplifyPath(points: number[][], tolerance = 1.5): number[][] {
  if (points.length <= 2) return points
  const keep = new Set<number>([0, points.length - 1])
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  const threshold = tolerance * tolerance
  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop()!
    let furthestIndex = -1
    let furthestDistance = 0
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = squaredDistanceToSegment(points[index], points[startIndex], points[endIndex])
      if (distance > furthestDistance) {
        furthestDistance = distance
        furthestIndex = index
      }
    }
    if (furthestIndex >= 0 && furthestDistance > threshold) {
      keep.add(furthestIndex)
      stack.push([startIndex, furthestIndex], [furthestIndex, endIndex])
    }
  }
  return [...keep].sort((left, right) => left - right).map((index) => points[index])
}

export const emptyElementCounts: ElementCounts = { total: 0, freedraw: 0, lines: 0, arrows: 0, shapes: 0, images: 0 }

export function countCanvasElements(elements: readonly CanvasElement[]): ElementCounts {
  return elements.reduce<ElementCounts>((counts, element) => {
    if (element.isDeleted) return counts
    counts.total += 1
    if (element.type === 'freedraw') counts.freedraw += 1
    if (element.type === 'line') counts.lines += 1
    if (element.type === 'arrow') counts.arrows += 1
    if (['rectangle', 'ellipse', 'diamond'].includes(element.type)) counts.shapes += 1
    if (element.type === 'image') counts.images += 1
    return counts
  }, { ...emptyElementCounts })
}

function traceElement(element: CanvasElement): TraceEvent['element'] {
  const nativeText = typeof element.text === 'string' ? element.text : null
  const originalText = typeof element.originalText === 'string' ? element.originalText : null
  const semanticContent = (originalText?.trim() ? originalText : nativeText?.trim() ? nativeText : null)
  const rawPoints = Array.isArray(element.points)
    ? element.points.flatMap((point) => Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number'
      ? [[point[0], point[1]]]
      : [])
    : null
  const points = rawPoints ? simplifyPath(rawPoints) : null
  return {
    id: element.id,
    type: element.type,
    version: element.version,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    fileId: element.fileId ?? null,
    point_count: Array.isArray(element.points) ? element.points.length : null,
    sampled_point_count: points?.length ?? null,
    points,
    text: nativeText,
    original_text: originalText,
    semantic_content: semanticContent,
    stroke_color: element.strokeColor ?? null,
    stroke_width: element.strokeWidth ?? null,
  }
}

/**
 * Converts Excalidraw scene snapshots into lifecycle evidence only. It records
 * geometry and point count, never infers user intent. Element type is preserved
 * as direct canvas evidence (for example line, arrow, rectangle, or freedraw).
 */
export function diffScene(
  previous: ReadonlyMap<string, KnownElement>,
  elements: readonly CanvasElement[],
  atMs: number,
): { events: TraceEvent[]; next: Map<string, KnownElement> } {
  const next = new Map<string, KnownElement>()
  const seen = new Set<string>()
  const events: TraceEvent[] = []

  for (const element of elements) {
    seen.add(element.id)
    const before = previous.get(element.id)
    const changed = before === undefined || before.version !== element.version || before.isDeleted !== element.isDeleted
    if (changed) {
      events.push({
        at_ms: Math.max(0, atMs),
        kind: element.isDeleted ? 'delete' : before === undefined || before.isDeleted ? 'create' : 'update',
        element: traceElement(element),
        ...(before && !before.isDeleted && !element.isDeleted && hasGeometryChanged(before, element)
          ? { previous_bounds: before.bounds }
          : {}),
      })
    }
    next.set(element.id, { version: element.version, isDeleted: element.isDeleted, bounds: boundsOf(element) })
  }

  for (const [id, before] of previous) {
    if (!seen.has(id) && !before.isDeleted) {
      events.push({
        at_ms: Math.max(0, atMs),
        kind: 'delete',
      element: { id, type: 'unknown', version: before.version, x: 0, y: 0, width: 0, height: 0, fileId: null, point_count: null, sampled_point_count: null, points: null, text: null, original_text: null, semantic_content: null, stroke_color: null, stroke_width: null },
      })
    }
  }

  return { events, next }
}
