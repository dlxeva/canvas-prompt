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
    point_count: number | null
    points: number[][] | null
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
  const points = Array.isArray(element.points)
    ? element.points.flatMap((point) => Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number'
      ? [[point[0], point[1]]]
      : [])
    : null
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
    points,
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
      element: { id, type: 'unknown', version: before.version, x: 0, y: 0, width: 0, height: 0, fileId: null, point_count: null, points: null, stroke_color: null, stroke_width: null },
      })
    }
  }

  return { events, next }
}

