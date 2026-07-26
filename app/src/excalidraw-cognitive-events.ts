import type { TraceEvent } from './excalidraw-adapter'

export type CognitiveEventType = 'stroke' | 'text' | 'region' | 'arrow' | 'unknown_element' | 'deletion' | 'move' | 'select' | 'pause'
export type SemanticType = 'draw' | 'write' | 'circle' | 'cross_out' | 'connect' | 'group' | 'highlight'

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

type TraceGeneration = { created: TraceEvent; latest: TraceEvent }
type TraceEnvelope = { generations: TraceGeneration[]; current?: TraceGeneration; deletions: TraceEvent[]; alive: boolean }
type TransformEnvelope = { first: TraceEvent; latest: TraceEvent; sampleCount: number; generationStartedAt?: number }

/**
 * Excalidraw emits a scene update for many animation frames during one drag or
 * resize. The frames are useful for rendering, but they are not independent
 * cognitive evidence. Collapse a continuous run for the same element into one
 * object-level transform session before it can reach the prompt package.
 */
const TRANSFORM_SESSION_GAP_MS = 250
const DRAW_CONSTRUCTION_WINDOW_MS = 1_500

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
      ...(typeof event.element.semantic_content === 'string' ? { text: event.element.semantic_content, semantic_content: event.element.semantic_content } : {}),
      ...(typeof event.element.text === 'string' ? { native_text: event.element.text } : {}),
      ...(typeof event.element.original_text === 'string' ? { original_text: event.element.original_text } : {}),
      raw_point_count: event.element.point_count ?? undefined,
      sampled_point_count: event.element.sampled_point_count ?? undefined,
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

function toTransformSessionEvent(session: TransformEnvelope): CognitiveEvent | null {
  const event = toTransformEvent({
    ...session.latest,
    previous_bounds: session.first.previous_bounds,
  })
  if (!event) return null
  return {
    ...event,
    data: {
      ...event.data,
      session_start_ms: session.first.at_ms,
      session_end_ms: session.latest.at_ms,
      transform_sample_count: session.sampleCount,
    },
  }
}

function coalesceTransformSessions(trace: readonly TraceEvent[]): CognitiveEvent[] {
  const generationStartedAt = new Map<string, number>()
  const open = new Map<string, TransformEnvelope>()
  const completed: TransformEnvelope[] = []

  const closeSession = (elementId: string) => {
    const existing = open.get(elementId)
    if (existing) completed.push(existing)
    open.delete(elementId)
  }

  for (const event of trace) {
    const elementId = event.element.id
    if (event.kind === 'create') {
      // Restore begins a fresh lifecycle generation. Renderer growth immediately
      // after restore must be judged against this timestamp, not the first-ever
      // creation of the same Excalidraw ID.
      closeSession(elementId)
      generationStartedAt.set(elementId, event.at_ms)
      continue
    }
    if (event.kind === 'delete') {
      closeSession(elementId)
      generationStartedAt.delete(elementId)
      continue
    }
    if (!toTransformEvent(event)) continue
    const existing = open.get(elementId)
    if (existing && event.at_ms - existing.latest.at_ms <= TRANSFORM_SESSION_GAP_MS) {
      existing.latest = event
      existing.sampleCount += 1
      continue
    }
    if (existing) completed.push(existing)
    open.set(elementId, {
      first: event,
      latest: event,
      sampleCount: 1,
      generationStartedAt: generationStartedAt.get(elementId),
    })
  }

  completed.push(...open.values())
  const events = completed
    // A freehand element grows as the pen moves. Those updates are renderer
    // geometry, not an intentional resize. Later selection-based transforms
    // remain because they occur outside the current lifecycle generation's
    // construction window.
    .filter((session) => !(
      session.first.element.type === 'freedraw'
      && typeof session.generationStartedAt === 'number'
      && session.first.at_ms - session.generationStartedAt <= DRAW_CONSTRUCTION_WINDOW_MS
    ))
    .map(toTransformSessionEvent)
    .filter((event): event is CognitiveEvent => event !== null)
  const batchMembers = new Map<string, string[]>()
  for (const event of events) {
    const start = event.data.session_start_ms
    const end = event.data.session_end_ms
    if (typeof start !== 'number' || typeof end !== 'number') continue
    const key = `${start}_${end}`
    const members = batchMembers.get(key) ?? []
    members.push(event.shapeId)
    batchMembers.set(key, members)
  }
  return events.map((event) => {
    const start = event.data.session_start_ms
    const end = event.data.session_end_ms
    if (typeof start !== 'number' || typeof end !== 'number') return event
    const key = `${start}_${end}`
    const members = batchMembers.get(key) ?? [event.shapeId]
    return {
      ...event,
      data: {
        ...event.data,
        transform_batch_id: `transform_batch_${key}`,
        transform_batch_object_ids: members,
      },
    }
  })
}

function observationKind(elementType: string): { type: CognitiveEventType; semanticType?: SemanticType } {
  if (elementType === 'text') return { type: 'text', semanticType: 'write' }
  if (elementType === 'freedraw' || elementType === 'line') return { type: 'stroke', semanticType: 'draw' }
  if (elementType === 'arrow') return { type: 'arrow' }
  if (['geo', 'rectangle', 'ellipse', 'diamond', 'image'].includes(elementType)) return { type: 'region' }
  return { type: 'unknown_element' }
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
    const elementId = event.element.id
    const entry = objects.get(elementId) ?? { generations: [], deletions: [], alive: false }
    if (event.kind === 'delete') {
      entry.deletions.push(event)
      entry.alive = false
      objects.set(elementId, entry)
      continue
    }
    if (event.kind === 'create' || !entry.current || !entry.alive) {
      const generation = { created: event, latest: event }
      entry.generations.push(generation)
      entry.current = generation
    } else {
      entry.current.latest = event
    }
    entry.alive = true
    objects.set(elementId, entry)
  }

  // Keep one direct observation per drag/resize session, never one per render
  // frame. This protects both archive size and downstream attention.
  const result: CognitiveEvent[] = coalesceTransformSessions(trace)
  for (const entry of objects.values()) {
    for (const generation of entry.generations) {
      const { type, semanticType } = observationKind(generation.latest.element.type)
      // Geometry comes from the latest update in this lifecycle generation,
      // while timestamp identity belongs to its create/restore event. Keeping
      // closed generations preserves the observable history; the Prompt Package
      // lifecycle reducer decides which generation remains live at round end.
      result.push(toCognitiveEvent(generation.latest, generation.created.at_ms, type, semanticType))
    }
    // Preserve every delete/restore cycle. Excalidraw lifecycle updates do not
    // reveal whether the user used Delete, an eraser, or undo, so method remains
    // unknown downstream.
    for (const deletion of entry.deletions) {
      result.push(toCognitiveEvent(deletion, deletion.at_ms, 'deletion'))
    }
  }
  return result.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
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
