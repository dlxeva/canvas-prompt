import type { TraceEvent } from './excalidraw-adapter'

export type CognitiveEventType = 'stroke' | 'region' | 'arrow' | 'deletion' | 'move' | 'select' | 'pause'
export type SemanticType = 'draw' | 'write' | 'circle' | 'cross_out' | 'connect' | 'group' | 'highlight' | 'erase'

export interface CognitiveEvent {
  id: string
  timestamp: number
  type: CognitiveEventType
  semanticType?: SemanticType
  shapeId: string
  shapeType: string
  data: {
    x?: number
    y?: number
    width?: number
    height?: number
    bbox_width?: number
    bbox_height?: number
    toX?: number
    toY?: number
    text?: string
    points?: number[][]
    color?: string
    strokeColor?: string
    strokeWidth?: number
    size?: number | string
    asset_id?: string
    [key: string]: unknown
  }
}

export interface PointerSample {
  t: number
  x: number
  y: number
  speed?: number
  pressure?: number
}

export type GestureType = 'pointing' | 'dwell' | 'trace' | 'comparison' | 'return'

export interface GestureEvent {
  gesture_id: string
  start_ms: number
  end_ms: number
  gesture_type: GestureType
  position: { x: number; y: number }
  dwell_ms: number
  hit_object_id?: string
  sample_count: number
}

export interface PointerTrack {
  samples: PointerSample[]
  gestures: GestureEvent[]
  meta: {
    device: string
    sample_interval_ms: number
    total_samples: number
    total_gestures: number
  }
}

type TraceEnvelope = { first: TraceEvent; latest: TraceEvent; deletion?: TraceEvent }

function pointPairs(value: unknown): number[][] {
  if (!Array.isArray(value)) return []
  return value.flatMap((point) => Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number'
    ? [[point[0], point[1]]]
    : [])
}

function toCognitiveEvent(event: TraceEvent, timestamp: number, type: CognitiveEventType, semanticType?: SemanticType): CognitiveEvent {
  const points = pointPairs(event.element.points)
  const last = points.at(-1)
  return {
    id: `evt_${event.element.id}_${type}_${timestamp}`,
    timestamp,
    type,
    semanticType,
    shapeId: event.element.id,
    shapeType: event.element.type,
    data: {
      x: event.element.x,
      y: event.element.y,
      bbox_width: event.element.width,
      bbox_height: event.element.height,
      points,
      color: event.element.stroke_color ?? undefined,
      strokeColor: event.element.stroke_color ?? undefined,
      size: event.element.stroke_width ?? undefined,
      strokeWidth: event.element.stroke_width ?? undefined,
      ...(last ? { toX: event.element.x + last[0], toY: event.element.y + last[1] } : {}),
      ...(event.element.fileId ? { asset_id: event.element.fileId } : {}),
    },
  }
}

function toTransformEvent(event: TraceEvent): CognitiveEvent | null {
  const before = event.previous_bounds
  if (!before) return null
  const after = event.element
  const deltaX = after.x - before.x
  const deltaY = after.y - before.y
  const scaleX = before.width > 0 ? after.width / before.width : null
  const scaleY = before.height > 0 ? after.height / before.height : null
  const moved = deltaX !== 0 || deltaY !== 0
  const resized = scaleX !== null && scaleY !== null && (scaleX !== 1 || scaleY !== 1)
  if (!moved && !resized) return null
  return {
    id: `evt_${event.element.id}_transform_${event.at_ms}`,
    timestamp: event.at_ms,
    type: 'move',
    shapeId: event.element.id,
    shapeType: event.element.type,
    data: {
      x: after.x,
      y: after.y,
      bbox_width: after.width,
      bbox_height: after.height,
      previous_bounds: before,
      delta_x: deltaX,
      delta_y: deltaY,
      ...(scaleX !== null ? { scale_x: Number(scaleX.toFixed(4)) } : {}),
      ...(scaleY !== null ? { scale_y: Number(scaleY.toFixed(4)) } : {}),
      transform_kind: moved && resized ? 'move_resize' : moved ? 'move' : 'resize',
      assertion_level: 'observation',
    },
  }
}

/**
 * Converts noisy scene lifecycle updates into the compact cognitive-event
 * contract consumed by the existing Prompt Package compiler.  A gesture that
 * creates an element contributes its first timestamp and its final geometry,
 * rather than every intermediate pointer update.
 */
export function compactTraceToCognitiveEvents(trace: readonly TraceEvent[]): CognitiveEvent[] {
  const objects = new Map<string, TraceEnvelope>()
  for (const event of trace) {
    const existing = objects.get(event.element.id)
    if (event.kind === 'delete') {
      if (existing) existing.deletion = event
      else objects.set(event.element.id, { first: event, latest: event, deletion: event })
      continue
    }
    if (existing) existing.latest = event
    else objects.set(event.element.id, { first: event, latest: event })
  }

  const result: CognitiveEvent[] = []
  for (const event of trace) {
    if (event.kind === 'update') {
      const transform = toTransformEvent(event)
      if (transform) result.push(transform)
    }
  }
  for (const entry of objects.values()) {
    const final = entry.latest
    if (final.kind !== 'delete') {
      const elementType = final.element.type
      if (elementType === 'arrow') result.push(toCognitiveEvent(final, entry.first.at_ms, 'arrow', 'connect'))
      else if (['rectangle', 'ellipse', 'diamond', 'image'].includes(elementType)) result.push(toCognitiveEvent(final, entry.first.at_ms, 'region', 'group'))
      else result.push(toCognitiveEvent(final, entry.first.at_ms, 'stroke', 'draw'))
    }
    if (entry.deletion) result.push(toCognitiveEvent(entry.deletion, entry.deletion.at_ms, 'deletion', 'erase'))
  }
  return result.sort((a, b) => a.timestamp - b.timestamp)
}

export function buildPointerTrack(samples: PointerSample[], device = 'mouse'): PointerTrack {
  const gestures: GestureEvent[] = []
  let start = -1
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]
    const still = (sample.speed ?? 0) < 0.1
    if (still && start < 0) start = index
    if ((!still || index === samples.length - 1) && start >= 0) {
      const end = still && index === samples.length - 1 ? index : index - 1
      const first = samples[start]
      const last = samples[end]
      if (last.t - first.t >= 600) {
        gestures.push({
          gesture_id: `gesture_${String(gestures.length + 1).padStart(3, '0')}`,
          start_ms: first.t,
          end_ms: last.t,
          gesture_type: 'dwell',
          position: { x: Math.round((first.x + last.x) / 2), y: Math.round((first.y + last.y) / 2) },
          dwell_ms: last.t - first.t,
          sample_count: end - start + 1,
        })
      }
      start = -1
    }
  }
  return {
    samples,
    gestures,
    meta: { device, sample_interval_ms: 100, total_samples: samples.length, total_gestures: gestures.length },
  }
}

