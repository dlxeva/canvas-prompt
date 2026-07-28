/**
 * prompt-package-compiler.ts
 * Prompt Package 编译器
 *
 * 将白板创作过程中的多维度信息（认知事件、语音转写、画布截图）
 * 编译为符合 prompt-package-spec v2.0 的结构化 Prompt Package。
 *
 * 输入：
 *   - CognitiveEvent[]  — 认知事件流（来自 cognitive-events.ts）
 *   - string            — 语音转写文本
 *   - string            — 最终画布截图（base64 data URI 或 URL）
 *
 * 输出：
 *   - PromptPackage     — 符合 spec v2.0 的完整 JSON 结构
 */

import type { CognitiveEvent, CognitiveEventType, SemanticType, PointerTrack, GestureEvent, PointerSample } from './excalidraw-cognitive-events'

// Excalidraw stores usable points directly. This compatibility helper keeps the
// former tldraw encoded-path branch harmless for old imported events.
const b64Vecs = { decodePoints: (_path: string): Array<{ x: number; y: number; z?: number }> => [] }

// ============================================================
// 1. Spec 类型定义（prompt-package-spec v2.0）
// ============================================================

// --- 通用基础类型 ---

export interface BoundingBox {
  x: number
  y: number
  width: number   // ≥ 0
  height: number  // ≥ 0
}

export interface CanvasSize {
  width: number   // ≥ 1
  height: number  // ≥ 1
  unit?: 'px' | 'mm' | 'inch' | 'scene'
}

/** Coordinates carried by objects and gestures, independent of viewport zoom/pan. */
export interface CoordinateSystem {
  space: 'excalidraw_scene'
  unit: 'scene'
  origin: { x: number; y: number }
  x_axis: 'right'
  y_axis: 'down'
}

// --- 图片引用 ---

export interface ImageReference {
  url: string            // URL 或 base64 data URI
  format: 'png' | 'jpg' | 'webp'
  width: number          // ≥ 1
  height: number         // ≥ 1
  hash?: string
}

export interface Keyframe {
  timestamp_ms: number   // ≥ 0
  image: ImageReference
  label?: string
}

// --- Meta ---

export interface MetaObject {
  package_id: string         // pp_{timestamp}_{random}
  version: string            // SemVer
  created_at: string         // ISO8601
  duration_ms: number        // ≥ 0
  user_id?: string
  canvas_size: CanvasSize
  coordinate_system: CoordinateSystem
  tags?: string[]
}

export interface BaselineContext {
  scene_sha256?: string
  object_count: number
  image_count: number
  included_object_count: number
  status: 'none' | 'fully_included' | 'partially_included' | 'omitted'
}

// --- Canvas Snapshot ---

export interface CanvasSnapshot {
  final: ImageReference
  /** Scene-space rectangle rendered into final. It prevents pixel/scene confusion. */
  scene_bounds: BoundingBox
  keyframes?: Keyframe[]
}

/**
 * A locally archived original image that can be used for image editing.
 * It is deliberately distinct from the rendered canvas snapshot: the latter
 * shows annotations, while this preserves the editable source material.
 */
export interface EditableSourceImage {
  artifact_object_id: string
  asset_id: string
  mime_type: string
  width: number
  height: number
  archive_relative_path: string
  availability: 'available'
}

// --- Stroke ---

export interface Point {
  x: number
  y: number
  pressure?: number      // 0–1
  timestamp_ms?: number  // ≥ 0
}

export interface StrokeStyle {
  color: string
  width: number          // ≥ 0
  opacity?: number       // 0–1
}

export interface Stroke {
  stroke_id: string
  timestamp_ms: number   // ≥ 0
  duration_ms: number    // ≥ 0
  points: Point[]
  style: StrokeStyle
  semantic_type?: 'text' | 'drawing' | 'underline' | 'circle' | 'highlight'
  recognized_text?: string
  bounding_box: BoundingBox
}

// --- Region ---

export interface Region {
  region_id: string
  timestamp_ms: number
  bounds: BoundingBox
  label?: string
  color?: string
  semantic_role?: 'group' | 'input' | 'output' | 'process' | 'decision' | 'note'
  contained_objects?: string[]
}

// --- Arrow ---

export type PointConnection = {
  type: 'point'
  ref: { x: number; y: number }
  anchor?: 'center' | 'top' | 'bottom' | 'left' | 'right'
}

export type ObjectConnection = {
  type: 'object' | 'region'
  ref: string
  anchor?: 'center' | 'top' | 'bottom' | 'left' | 'right'
}

export type ConnectionPoint = PointConnection | ObjectConnection

export interface ArrowStyle {
  color: string
  width: number
  line_style?: 'solid' | 'dashed' | 'dotted' | 'dash_dot'
  arrowhead: 'solid' | 'open' | 'diamond' | 'circle'
}

export interface Arrow {
  arrow_id: string
  timestamp_ms: number
  from: ConnectionPoint
  to: ConnectionPoint
  style: ArrowStyle
  label?: string
  semantic_type?: 'flow' | 'dependency' | 'association' | 'data' | 'control'
}

// --- Deletion ---

export interface Deletion {
  deletion_id: string
  timestamp_ms: number
  target_type: 'stroke' | 'region' | 'arrow' | 'object'
  target_id: string
  method: 'erase' | 'cross_out' | 'select_delete' | 'voice_cancel' | 'unknown'
  stroke_data?: Stroke
  reason?: string
}

// --- Transcript ---

export interface TranscriptSegment {
  segment_id: string
  start_ms: number       // ≥ 0
  end_ms: number         // ≥ start_ms
  text: string
  speaker?: string
  confidence?: number    // 0–1
  linked_strokes?: string[]
}

export interface Transcript {
  full_text: string
  segments: TranscriptSegment[]
  language: string
  /** Whether segment timestamps come from ASR rather than compiler interpolation. */
  alignment_status: 'timestamped' | 'unavailable'
}

// --- Timeline ---

export interface TimelineEvent {
  event_id: string
  timestamp_ms: number
  event_type:
    | 'stroke_start'
    | 'stroke_end'
    | 'region_create'
    | 'text_create'
    | 'unknown_element_observed'
    | 'arrow_draw'
    | 'delete'
    | 'voice_segment'
    | 'pause'
    | 'zoom'
    | 'pan'
    | 'undo'
    | 'redo'
    | 'transform'
  duration_ms?: number
  target_id?: string
  metadata?: Record<string, unknown>
  importance?: 'low' | 'medium' | 'high'
}

// --- Canvas Object ---

export interface ObjectRelationship {
  relation_type: 'contains' | 'connects_to' | 'depends_on' | 'references' | 'contradicts'
  target_object_id: string
  weight?: number // 0–1
}

export interface CanvasObject {
  object_id: string
  type:
    | 'text_block'
    | 'shape'
    | 'icon'
    | 'image'
    | 'diagram_element'
    | 'sticky_note'
    | 'checkbox'
    | 'pointer_anchor'    // 用户点击/指点的锚点（轻量手势，非语义对象）
    | 'unknown_element'   // Unsupported renderer element retained as observation only
  timestamp_ms: number
  bounds: BoundingBox
  properties: Record<string, unknown>
  source_strokes?: string[]
  semantic_content?: string
  relationships?: ObjectRelationship[]
}

export interface ReviewItem {
  review_id: string
  artifact_object_id: string
  /** Always expressed against the imported source image, never canvas space. */
  coordinate_space: 'base_artifact'
  region: { x_ratio: number; y_ratio: number; width_ratio: number; height_ratio: number }
  instruction: string | null
  evidence_caption_ids: string[]
  speech_link_status: 'linked' | 'unavailable'
  assertion_level: 'observation'
  resolution_status: 'unresolved'
}

/** Viewport evidence is deliberately separate from scene-space object transforms. */
export interface ViewTransformation {
  observation_id: string
  type: 'view_transform'
  time_range_ms: [number, number]
  kind: 'zoom' | 'pan' | 'zoom_pan'
  before: { timestamp_ms: number; zoom: number; scroll_x: number; scroll_y: number }
  after: { timestamp_ms: number; zoom: number; scroll_x: number; scroll_y: number }
  sample_count: number
  coordinate_space: 'viewport_transform'
  assertion_level: 'observation'
  interpretation_constraint: 'does_not_establish_attention_or_priority'
}

/** Direct geometry evidence; it never claims why the user transformed an object. */
export interface Transformation {
  transformation_id: string
  timestamp_ms: number
  /** Inclusive object-level transform session, when source frames were coalesced. */
  time_range_ms?: [number, number]
  /** Number of raw scene updates represented by this single observation. */
  sample_count?: number
  /** Stable ID for one simultaneous multi-object transform gesture. */
  batch_id?: string
  /** Objects transformed within that same gesture; geometry only, never intent. */
  batch_object_ids?: string[]
  object_id: string
  object_type: string
  kind: 'move' | 'resize' | 'move_resize'
  before_bounds: BoundingBox
  after_bounds: BoundingBox
  delta: { x: number; y: number }
  scale?: { x: number; y: number }
  assertion_level: 'observation'
}

/**
 * Evidence-only join around a transform gesture. It states which exported
 * objects share source strokes with the gesture, plus nearby speech candidates.
 * It deliberately does not resolve pronouns or assign a semantic relation.
 */
export interface TransformBinding {
  binding_id: string
  batch_id: string
  transformation_ids: string[]
  object_links: Array<{ object_id: string; source_stroke_id: string }>
  speech_candidates: Array<{ segment_id: string; temporal_distance_ms: number; resolution_status: 'unresolved' }>
  assertion_level: 'observation'
}

// --- Intent Summary ---

export interface ActionItem {
  action_id: string
  description: string
  priority: 'low' | 'medium' | 'high'
  related_objects?: string[]
}

export interface IntentSummary {
  primary_intent: string
  sub_intents?: string[]
  key_concepts: string[]
  action_items?: ActionItem[]
  open_questions?: string[]
  confidence: number // 0–1
  analysis_notes?: string
}

export interface OcrObservation {
  observation_id: string
  text: string
  confidence: number
  polygon: Array<{ x: number; y: number }>
  bounding_box: BoundingBox
  source: 'paddleocr-js'
  model: 'PP-OCRv5'
  assertion_level: 'observation'
}

// --- Target Agent ---

export interface TargetAgent {
  agent_type:
    | 'code_generator'
    | 'design_system'
    | 'document_writer'
    | 'project_planner'
    | 'data_analyst'
    | 'custom'
  agent_id?: string
  capabilities?: string[]
  constraints?: string[]
  preferred_format?: string
}

// --- Output Schema ---

export interface OutputExample {
  title: string
  input_description: string
  output_sample: string
  notes?: string
}

export interface OutputSection {
  section_id: string
  title: string
  description: string
  required: boolean
  max_length?: number
}

export interface OutputSchema {
  format: 'json' | 'markdown' | 'code' | 'html' | 'yaml' | 'text'
  schema?: Record<string, unknown> // JSON Schema
  template?: string
  examples?: OutputExample[]
  validation_rules?: string[]
  max_length?: number
  sections?: OutputSection[]
}

// ============================================================
// 2. 顶层 PromptPackage 类型
// ============================================================

export interface PromptPackage {
  meta: MetaObject
  canvas_snapshot: CanvasSnapshot
  strokes: Stroke[]
  regions?: Region[]
  arrows?: Arrow[]
  deletions?: Deletion[]
  transcript?: Transcript | null
  timeline: TimelineEvent[]
  objects: CanvasObject[]
  /** Local OCR is an optional observation layer; speech remains authoritative. */
  ocr_observations?: OcrObservation[]
  /** Explicit boundary for objects that existed before this round began. */
  baseline_context?: BaselineContext
  base_artifacts?: CanvasObject[]
  /** Original image material retained for edit-capable review rounds. */
  source_images?: EditableSourceImage[]
  review_items?: ReviewItem[]
  /** Viewport changes are observation-only and never object coordinates. */
  view_transformations?: ViewTransformation[]
  transformations?: Transformation[]
  /** Traceable object/speech candidates around transform gestures; never semantic resolution. */
  transform_bindings?: TransformBinding[]
  pointer_track?: PointerTrackData   // 第七轨：隐式手势层
  intent_summary: IntentSummary
  target_agent?: TargetAgent
  output_schema?: OutputSchema
}

/**
 * Pointer Track 数据（进 Prompt Package 的部分）
 * 调试阶段暂时包含原始采样点，验证后移除
 */
export interface PointerTrackData {
  gestures: GestureEvent[]
  samples?: PointerSample[]   // 调试用，验证手势聚合后移除
  meta: {
    device: string
    sample_interval_ms: number
    total_samples: number
    total_gestures: number
  }
}

// ============================================================
// 3. 编译器选项
// ============================================================

export interface CompilerOptions {
  /** Logical extent of the exported Excalidraw scene. */
  canvasSize?: CanvasSize
  /** Pixel dimensions of the rendered screenshot; distinct from scene units. */
  snapshotSize?: { width: number; height: number }
  coordinateSystem?: CoordinateSystem
  /** 用户ID */
  userId?: string
  /** 标签 */
  tags?: string[]
  /** 语音语言，默认 "zh-CN" */
  language?: string
  /** 指定目标代理 */
  targetAgent?: TargetAgent
  /** 指定输出格式 */
  outputSchema?: OutputSchema
  /** 编译模式：'fast' 跳过耗时分析，'full' 执行完整编译 */
  mode?: 'fast' | 'full'
  /** Imported visual artifacts present in this round. They are evidence, not a mode switch. */
  baseArtifacts?: CanvasObject[]
  /** Locally archived originals corresponding to imported image artifacts. */
  sourceImages?: EditableSourceImage[]
  /** Live objects present when the round began. They are spatial anchors, not new actions. */
  baselineAnchors?: CanvasObject[]
  /** Coalesced viewport pan/zoom observations, distinct from scene transforms. */
  viewTransformations?: ViewTransformation[]
  /** What this round carries forward from the scene that existed at start. */
  baselineContext?: BaselineContext
  /** Sparse state frames captured after meaningful activity settles. */
  keyframes?: Keyframe[]
  /** Raw pointer samples are diagnostic-only and excluded from normal exports. */
  includeRawPointerSamples?: boolean
}

// ============================================================
// 4. 辅助工具
// ============================================================

/** 生成 pp_{timestamp}_{random} 格式的 package ID */
function generatePackageId(): string {
  const now = new Date()
  const ts = now
    .toISOString()
    .replace(/[-:T.Z]/g, '')
    .slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 8)
  return `pp_${ts}_${rand}`
}

/** 从 data URI 或 URL 中推断图片格式 */
function inferImageFormat(dataUri: string): 'png' | 'jpg' | 'webp' {
  if (dataUri.includes('image/webp')) return 'webp'
  if (dataUri.includes('image/jpeg') || dataUri.includes('image/jpg')) return 'jpg'
  return 'png'
}

/** 简易 clamp 工具，确保值在 [min, max] 范围内 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** 将 CognitiveEvent 中的 semanticType 映射为 Stroke.semantic_type */
function mapSemanticType(
  semanticType?: SemanticType
): Stroke['semantic_type'] | undefined {
  const mapping: Partial<Record<SemanticType, Stroke['semantic_type']>> = {
    write: 'text',
    draw: 'drawing',
    circle: 'circle',
    highlight: 'highlight',
    cross_out: 'underline',
  }
  return semanticType ? mapping[semanticType] : undefined
}

// ============================================================
// 5. 从 CognitiveEvent 提取各子结构
// ============================================================

function numericData(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

type FinalShapeLifecycle = {
  alive: boolean
  latestLiveEvent?: CognitiveEvent
}

/** Reduce noisy history to the canvas elements that are alive at round end. */
function reduceFinalShapeLifecycle(events: CognitiveEvent[], initiallyAliveShapeIds: string[] = []): Map<string, FinalShapeLifecycle> {
  const lifecycle = new Map<string, FinalShapeLifecycle>(
    initiallyAliveShapeIds.map((shapeId) => [shapeId, { alive: true }]),
  )
  events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.timestamp - right.event.timestamp || left.index - right.index)
    .forEach(({ event }) => {
      if (!event.shapeId) return
      if (event.type === 'deletion') {
        lifecycle.set(event.shapeId, { ...lifecycle.get(event.shapeId), alive: false })
      } else if (event.type === 'stroke' || event.type === 'text' || event.type === 'region' || event.type === 'arrow' || event.type === 'unknown_element') {
        lifecycle.set(event.shapeId, { alive: true, latestLiveEvent: event })
      }
    })
  return lifecycle
}

function finalLiveProjectionEvents(lifecycle: Map<string, FinalShapeLifecycle>): CognitiveEvent[] {
  return [...lifecycle.values()]
    .filter((item): item is FinalShapeLifecycle & { latestLiveEvent: CognitiveEvent } => item.alive && item.latestLiveEvent !== undefined)
    .map((item) => item.latestLiveEvent)
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
}

/** 从事件流中提取 Stroke[] */
function extractStrokes(events: CognitiveEvent[]): Stroke[] {
  return events
    .filter((e) => e.type === 'stroke')
    .map((e) => {
      // tldraw draw shape 的 props 透传后，data 里有 segments（点坐标数组）。
      // 每个 segment: { type: 'free' | 'straight', points: [[x,y,pressure], ...] }
      // 旧格式兼容：data.points（直接数组）
      const points: Point[] = extractStrokePoints(e.data)

      // 颜色：tldraw draw 用 strokeColor，geo/text 用 color
      const color = (e.data.color as string)
        ?? (e.data.strokeColor as string)
        ?? '#000000'

      // 画笔粗细：tldraw 用 size（s/m/l/xl），不是 bbox 尺寸
      const lineWidth = resolveLineWidth(e.data.size)

      return {
        stroke_id: e.shapeId || e.id,
        timestamp_ms: Math.max(0, e.timestamp),
        // Recorder keeps only the final draw-segment update timestamp rather
        // than every pointer update, yielding duration without event noise.
        duration_ms: Math.max(0, numericData(e.data.stroke_duration_ms)),
        points,
        style: {
          color,
          width: lineWidth,
          opacity: 1.0,
        },
        semantic_type: mapSemanticType(e.semanticType),
        recognized_text: typeof e.data.text === 'string' ? e.data.text : undefined,
        bounding_box: {
          x: e.data.x ?? 0,
          y: e.data.y ?? 0,
          width: typeof e.data.bbox_width === 'number' ? e.data.bbox_width : 0,
          height: typeof e.data.bbox_height === 'number' ? e.data.bbox_height : 0,
        },
      } satisfies Stroke
    })
}

/**
 * 从 tldraw draw shape 的 segments 提取全局点坐标。
 *
 * tldraw 5 将真实笔迹放在 delta-encoded base64 `path` 中，而不是旧版的
 * `points` 数组。若只读取旧字段，手绘线条在导出中会退化成 shape 的单点
 * fallback，因而不能作为任何关系或方向推断的证据。
 */
export function extractStrokePoints(data: Record<string, unknown>): Point[] {
  const offsetX = numericData(data.x)
  const offsetY = numericData(data.y)
  const scaleX = typeof data.scaleX === 'number' ? data.scaleX : 1
  const scaleY = typeof data.scaleY === 'number' ? data.scaleY : 1

  // 当前格式：tldraw draw 的 segments 数组，点被编码在 `path`。
  if (Array.isArray(data.segments)) {
    const allPoints: Point[] = []
    for (const seg of data.segments as Array<{ path?: unknown, points?: unknown }>) {
      if (typeof seg.path === 'string' && seg.path.length > 0) {
        try {
          const decoded = b64Vecs.decodePoints(seg.path)
          for (const point of decoded) {
            allPoints.push({
              x: offsetX + point.x * scaleX,
              y: offsetY + point.y * scaleY,
              ...(point.z !== undefined ? { pressure: clamp(point.z, 0, 1) } : {}),
            })
          }
          continue
        } catch {
          // 保留对旧/损坏格式的兼容分支；不会以伪造点替代真实轨迹。
        }
      }
      // 旧格式：segments 内直接保存 number[][]。
      if (Array.isArray(seg.points)) {
        for (const p of seg.points as number[][]) {
          allPoints.push({
            x: offsetX + (p[0] ?? 0) * scaleX,
            y: offsetY + (p[1] ?? 0) * scaleY,
            ...(p[2] !== undefined ? { pressure: clamp(p[2], 0, 1) } : {}),
          })
        }
      }
    }
    if (allPoints.length > 0) return allPoints
  }
  // 旧格式：直接 points 数组
  if (Array.isArray(data.points)) {
    return (data.points as number[][]).map((p) => ({
      x: offsetX + (p[0] ?? 0) * scaleX,
      y: offsetY + (p[1] ?? 0) * scaleY,
      ...(p[2] !== undefined ? { pressure: clamp(p[2], 0, 1) } : {}),
    }))
  }
  // fallback：用 shape 位置当单点
  return [{ x: numericData(data.x), y: numericData(data.y) }]
}

/** tldraw size（s/m/l/xl）映射为画笔像素粗细 */
function resolveLineWidth(size: unknown): number {
  const map: Record<string, number> = { s: 2, m: 3.5, l: 5, xl: 8 }
  if (typeof size === 'string' && map[size]) return map[size]
  if (typeof size === 'number' && size > 0 && size < 50) return size // 防御：已是像素值
  return 3.5 // 默认 medium
}

/** 从事件流中提取 Region[] */
function extractRegions(events: CognitiveEvent[]): Region[] {
  return events
    .filter((e) => e.type === 'region')
    .map((e) => ({
      region_id: e.shapeId || e.id,
      timestamp_ms: Math.max(0, e.timestamp),
      bounds: {
        x: e.data.x ?? 0,
        y: e.data.y ?? 0,
        width: numericData(e.data.bbox_width),
        height: numericData(e.data.bbox_height),
      },
      label: typeof e.data.text === 'string' ? e.data.text : undefined,
      color: typeof e.data.color === 'string' ? e.data.color : undefined,
    }) satisfies Region)
}

/** 从事件流中提取 Arrow[] */
function extractArrows(events: CognitiveEvent[]): Arrow[] {
  return events
    .filter((e) => e.type === 'arrow')
    .map((e) => {
      const fromX = e.data.x ?? 0
      const fromY = e.data.y ?? 0
      const toX = typeof e.data.toX === 'number' ? e.data.toX : fromX + (typeof e.data.bbox_width === 'number' ? e.data.bbox_width : 100)
      const toY = typeof e.data.toY === 'number' ? e.data.toY : fromY

      const color = (e.data.color as string) ?? (e.data.strokeColor as string) ?? '#2196F3'
      const lineWidth = resolveLineWidth(e.data.size)

      return {
        arrow_id: e.shapeId || e.id,
        timestamp_ms: Math.max(0, e.timestamp),
        from: {
          type: 'point' as const,
          ref: { x: fromX, y: fromY },
        },
        to: {
          type: 'point' as const,
          ref: { x: toX, y: toY },
        },
        style: {
          color,
          width: lineWidth,
          line_style: 'solid' as const,
          arrowhead: 'solid' as const,
        },
        label: typeof e.data.text === 'string' ? e.data.text : undefined,
      } satisfies Arrow
    })
}

/** 从事件流中提取 Deletion[] */
function extractDeletions(events: CognitiveEvent[]): Deletion[] {
  return events
    .filter((e) => e.type === 'deletion')
    .map((e) => {
      const targetType: Deletion['target_type'] = e.shapeType === 'arrow'
        ? 'arrow'
        : ['freedraw', 'line'].includes(e.shapeType)
          ? 'stroke'
          : ['rectangle', 'ellipse', 'diamond', 'image'].includes(e.shapeType)
            ? 'region'
            : 'object'
      return {
        deletion_id: e.id,
        timestamp_ms: Math.max(0, e.timestamp),
        target_type: targetType,
        target_id: e.shapeId,
        method: e.semanticType === 'cross_out' ? 'cross_out' as const : 'unknown' as const,
        reason: typeof e.data.text === 'string' ? e.data.text : undefined,
      } satisfies Deletion
    })
}

// ============================================================
// 6. Timeline 生成
// ============================================================

/** 从事件流推断开始与结束时间 */
function inferDuration(events: CognitiveEvent[]): {
  startTime: number
  endTime: number
  durationMs: number
} {
  if (events.length === 0) {
    return { startTime: 0, endTime: 0, durationMs: 0 }
  }
  const timestamps = events.map((e) => e.timestamp)
  const startTime = Math.min(...timestamps)
  const endTime = Math.max(...timestamps)
  return { startTime, endTime, durationMs: Math.max(0, endTime - startTime) }
}

/** 事件类型映射到 TimelineEvent.event_type */
function mapTimelineEventType(
  eventType: CognitiveEventType,
  _semanticType?: SemanticType
): TimelineEvent['event_type'] {
  switch (eventType) {
    case 'stroke':
      return 'stroke_start'
    case 'region':
      return 'region_create'
    case 'text':
      return 'text_create'
    case 'unknown_element':
      return 'unknown_element_observed'
    case 'arrow':
      return 'arrow_draw'
    case 'deletion':
      return 'delete'
    case 'pause':
      return 'pause'
    case 'move':
      return 'transform'
    default:
      return 'stroke_start'
  }
}

/** 从事件流构建 TimelineEvent[] */
function buildTimeline(events: CognitiveEvent[]): TimelineEvent[] {
  return events.map((e) => ({
    event_id: `evt_${e.id}`,
    timestamp_ms: Math.max(0, e.timestamp),
    event_type: mapTimelineEventType(e.type, e.semanticType),
    target_id: e.shapeId || undefined,
    metadata: {
      shapeType: e.shapeType,
      ...(e.semanticType ? { semanticType: e.semanticType } : {}),
    },
  }) satisfies TimelineEvent)
}

function boundsFromUnknown(value: unknown): BoundingBox | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const x = numericData(candidate.x, Number.NaN)
  const y = numericData(candidate.y, Number.NaN)
  const width = numericData(candidate.width, Number.NaN)
  const height = numericData(candidate.height, Number.NaN)
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null
}

function extractTransformations(events: CognitiveEvent[]): Transformation[] {
  return events.flatMap((event) => {
    if (event.type !== 'move') return []
    const before = boundsFromUnknown(event.data.previous_bounds)
    if (!before) return []
    const after = {
      x: numericData(event.data.x),
      y: numericData(event.data.y),
      width: numericData(event.data.bbox_width),
      height: numericData(event.data.bbox_height),
    }
    const kind = event.data.transform_kind
    if (kind !== 'move' && kind !== 'resize' && kind !== 'move_resize') return []
    const scaleX = typeof event.data.scale_x === 'number' ? event.data.scale_x : undefined
    const scaleY = typeof event.data.scale_y === 'number' ? event.data.scale_y : undefined
    return [{
      transformation_id: `transform_${event.shapeId}_${event.timestamp}`,
      timestamp_ms: Math.max(0, event.timestamp),
      ...(typeof event.data.session_start_ms === 'number' && typeof event.data.session_end_ms === 'number'
        ? { time_range_ms: [Math.max(0, event.data.session_start_ms), Math.max(0, event.data.session_end_ms)] as [number, number] }
        : {}),
      ...(typeof event.data.transform_sample_count === 'number'
        ? { sample_count: event.data.transform_sample_count }
        : {}),
      ...(typeof event.data.transform_batch_id === 'string'
        ? { batch_id: event.data.transform_batch_id }
        : {}),
      ...(Array.isArray(event.data.transform_batch_object_ids)
        ? { batch_object_ids: event.data.transform_batch_object_ids.filter((id): id is string => typeof id === 'string') }
        : {}),
      object_id: event.shapeId,
      object_type: event.shapeType,
      kind,
      before_bounds: before,
      after_bounds: after,
      delta: { x: numericData(event.data.delta_x), y: numericData(event.data.delta_y) },
      ...(scaleX !== undefined && scaleY !== undefined ? { scale: { x: scaleX, y: scaleY } } : {}),
      assertion_level: 'observation',
    }]
  })
}

function distanceToInterval(timestamp: number, start: number, end: number): number {
  if (timestamp < start) return start - timestamp
  if (timestamp > end) return timestamp - end
  return 0
}

function buildTransformBindings(
  transformations: Transformation[],
  objects: CanvasObject[],
  transcript: Transcript | null,
): TransformBinding[] {
  if (transformations.length === 0) return []
  const objectByStroke = new Map<string, CanvasObject>()
  for (const object of objects) {
    for (const strokeId of object.source_strokes ?? []) objectByStroke.set(strokeId, object)
  }
  const groups = new Map<string, Transformation[]>()
  for (const transformation of transformations) {
    const batchId = transformation.batch_id ?? transformation.transformation_id
    const group = groups.get(batchId) ?? []
    group.push(transformation)
    groups.set(batchId, group)
  }
  return [...groups.entries()].map(([batchId, group]) => {
    const sourceIds = new Set(group.flatMap((item) => item.batch_object_ids ?? [item.object_id]))
    const objectLinks = [...sourceIds]
      .map((sourceStrokeId) => ({ source_stroke_id: sourceStrokeId, object_id: objectByStroke.get(sourceStrokeId)?.object_id }))
      .filter((link): link is { source_stroke_id: string; object_id: string } => typeof link.object_id === 'string')
    const start = Math.min(...group.map((item) => item.time_range_ms?.[0] ?? item.timestamp_ms))
    const end = Math.max(...group.map((item) => item.time_range_ms?.[1] ?? item.timestamp_ms))
    const speechCandidates = (transcript?.segments ?? [])
      .map((segment) => ({ segment, distance: distanceToInterval((segment.start_ms + segment.end_ms) / 2, start, end) }))
      .filter(({ distance }) => distance <= 6_000)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 2)
      .map(({ segment, distance }) => ({ segment_id: segment.segment_id, temporal_distance_ms: Math.round(distance), resolution_status: 'unresolved' as const }))
    return {
      binding_id: `binding_${batchId}`,
      batch_id: batchId,
      transformation_ids: group.map((item) => item.transformation_id),
      object_links: objectLinks,
      speech_candidates: speechCandidates,
      assertion_level: 'observation',
    }
  })
}

// ============================================================
// 7. Transcript 构建
// ============================================================

/**
 * 将语音转写文本编译为 Transcript 结构。
 *
 * 优先使用 STT 服务返回的 segments（带真实句级时间戳）。
 * 没有 segments 时 fallback 为整段文本单 segment。
 */
function buildTranscript(
  transcriptionText: string,
  events: CognitiveEvent[],
  language: string,
  sttSegments?: TranscriptSegment[]
): Transcript | null {
  const trimmed = transcriptionText.trim()
  if (!trimmed) return null

  // 优先用 STT 返回的真实时间戳 segments
  if (sttSegments && sttSegments.length > 0) {
    return {
      full_text: trimmed,
      segments: sttSegments,
      language,
      alignment_status: 'timestamped',
    }
  }

  // Full text remains useful context, but the compiler must not stretch it
  // across the canvas session and pretend that sentence-level timestamps exist.
  return {
    full_text: trimmed,
    segments: [],
    language,
    alignment_status: 'unavailable',
  }
}

// ============================================================
// 8. Intent Summary 提取
// ============================================================

/**
 * 从事件流和语音转写中提取意图摘要。
 *
 * 当前实现使用启发式规则提取关键信息。
 * 生产环境中可对接 LLM 做更深层的意图分析。
 */
function extractIntentSummary(
  _events: CognitiveEvent[],
  _transcriptionText: string,
): IntentSummary {
  // Intent belongs to a later, evidence-citing interpretation step. Canvas
  // geometry, interaction patterns, and raw transcript text are not a
  // compiler verdict about the user's purpose.
  return {
    primary_intent: 'unknown',
    key_concepts: [],
    confidence: 0,
    analysis_notes: 'Intent was not inferred from canvas geometry or interaction patterns.',
  }
}

// ============================================================
// 9. Canvas Object 提取
// ============================================================

/**
 * 从事件流中识别结构化的 CanvasObject。
 *
 * 当前实现将具有 recognized_text 的 stroke 提升为 text_block，
 * 将 geo 形状提升为 shape。生产环境中可对接更复杂的视觉识别。
 */
function extractObjects(events: CognitiveEvent[]): CanvasObject[] {
  const objects: CanvasObject[] = []

  for (const e of events) {
    // A pasted/imported image is a stable review substrate, not a hand-drawn
    // diagram element. Keep its geometry for later annotation anchoring.
    if (e.shapeType === 'image') {
      objects.push({
        object_id: `obj_${e.shapeId || e.id}`,
        type: 'image',
        timestamp_ms: Math.max(0, e.timestamp),
        bounds: { x: e.data.x ?? 0, y: e.data.y ?? 0, width: numericData(e.data.bbox_width), height: numericData(e.data.bbox_height) },
        properties: { base_artifact: true, asset_id: e.data.assetId ?? e.data.asset_id ?? null },
      })
      continue
    }
    // Native Excalidraw text is direct renderer evidence. Preserve it as a
    // text object even when empty, but only non-empty content can name it.
    if (e.type === 'text') {
      const semanticContent = typeof e.data.semantic_content === 'string'
        ? e.data.semantic_content.trim()
        : typeof e.data.text === 'string'
          ? e.data.text.trim()
          : ''
      objects.push({
        object_id: `obj_${e.shapeId || e.id}`,
        type: 'text_block',
        timestamp_ms: Math.max(0, e.timestamp),
        bounds: {
          x: e.data.x ?? 0,
          y: e.data.y ?? 0,
          width: numericData(e.data.bbox_width),
          height: numericData(e.data.bbox_height),
        },
        properties: { shapeType: e.shapeType, evidence_source: 'excalidraw_native_text' },
        source_strokes: [e.shapeId || e.id],
        ...(semanticContent ? { semantic_content: semanticContent } : {}),
      })
      continue
    }
    // Unsupported renderer elements remain inspectable observations. They are
    // never converted into hand-drawn strokes or diagram semantics.
    if (e.type === 'unknown_element') {
      objects.push({
        object_id: `obj_${e.shapeId || e.id}`,
        type: 'unknown_element',
        timestamp_ms: Math.max(0, e.timestamp),
        bounds: {
          x: e.data.x ?? 0,
          y: e.data.y ?? 0,
          width: numericData(e.data.bbox_width),
          height: numericData(e.data.bbox_height),
        },
        properties: { shapeType: e.shapeType, assertion_level: 'observation' },
      })
      continue
    }
    // Legacy text-bearing stroke → text_block (backward compatibility only).
    if (e.type === 'stroke' && typeof e.data.text === 'string' && e.data.text.trim()) {
      objects.push({
        object_id: `obj_${e.shapeId || e.id}`,
        type: 'text_block',
        timestamp_ms: Math.max(0, e.timestamp),
        bounds: {
          x: e.data.x ?? 0,
          y: e.data.y ?? 0,
          width: numericData(e.data.bbox_width),
          height: numericData(e.data.bbox_height),
        },
        properties: {
          semanticType: e.semanticType,
        },
        source_strokes: [e.shapeId || e.id],
        semantic_content: e.data.text.trim(),
      })
    }

    // 绘制笔画（有实际几何尺寸）→ diagram_element
    // 让 draw stroke 成为可被 pointer gesture 命中的对象
    // 语义内容（"这是金字塔"）留给下游 AI 判断，这里只保证几何存在
    if (e.type === 'stroke' && e.semanticType === 'draw') {
      const w = typeof e.data.bbox_width === 'number' ? e.data.bbox_width : 0
      const h = typeof e.data.bbox_height === 'number' ? e.data.bbox_height : 0
      // 跳过过小的（可能是误触）
      if (w >= 15 && h >= 15) {
        objects.push({
          object_id: `obj_${e.shapeId || e.id}`,
          type: 'diagram_element',
          timestamp_ms: Math.max(0, e.timestamp),
          bounds: {
            x: e.data.x ?? 0,
            y: e.data.y ?? 0,
            width: w,
            height: h,
          },
          properties: {
            semanticType: e.semanticType,
            ...(e.data.color ? { color: e.data.color } : {}),
          },
          source_strokes: [e.shapeId || e.id],
        })
      }
    }

    // 区域事件 → 区分 pointer_anchor（点击锚点）和 shape（语义区域）
    // 判断依据：尺寸过小（<15px）的是用户点击产生的锚点，不是真正的语义对象
    if (e.type === 'region') {
      const w = typeof e.data.bbox_width === 'number' ? e.data.bbox_width : 0
      const h = typeof e.data.bbox_height === 'number' ? e.data.bbox_height : 0
      const isPointerAnchor = w < 15 && h < 15

      objects.push({
        object_id: `obj_${e.shapeId || e.id}`,
        type: isPointerAnchor ? 'pointer_anchor' : 'shape',
        timestamp_ms: Math.max(0, e.timestamp),
        bounds: {
          x: e.data.x ?? 0,
          y: e.data.y ?? 0,
          width: w,
          height: h,
        },
        properties: {
          shapeType: e.shapeType,
          ...(e.data.color ? { color: e.data.color } : {}),
        },
        source_strokes: [e.shapeId || e.id],
        semantic_content: typeof e.data.text === 'string' ? e.data.text : undefined,
      })
    }
  }

  // 空间命中：对每个 pointer_anchor，找包含它坐标的最大非锚点对象
  // 纯几何计算（点是否落在 bbox 内），无语义判断
  resolvePointerAnchors(objects)

  return objects
}

// ============================================================
// 9b. 图片批阅项编译
// ============================================================

type ReviewBounds = { x: number; y: number; width: number; height: number }

function intersection(a: ReviewBounds, b: ReviewBounds): ReviewBounds | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

type ReviewUtterance = {
  utterance_id: string
  start_ms: number
  end_ms: number
  text: string
  caption_ids: string[]
}

type ReviewMarkDraft = { timestamp_ms: number; item: ReviewItem }

const REVIEW_UTTERANCE_GAP_MS = 1_200
const REVIEW_MARK_BEFORE_SPEECH_MS = 4_000
const REVIEW_MARK_AFTER_SPEECH_MS = 6_000
const REVIEW_AFTER_SPEECH_PENALTY_MS = 1_000
const REVIEW_AMBIGUITY_MARGIN_MS = 500

function reviewUtterances(transcript: Transcript | null): ReviewUtterance[] {
  const segments = [...(transcript?.segments ?? [])]
    .filter((segment) => segment.text.trim())
    .sort((left, right) => left.start_ms - right.start_ms)
  const utterances: ReviewUtterance[] = []
  for (const segment of segments) {
    const last = utterances.at(-1)
    if (last && segment.start_ms - last.end_ms <= REVIEW_UTTERANCE_GAP_MS) {
      last.end_ms = Math.max(last.end_ms, segment.end_ms)
      last.text = `${last.text} ${segment.text.trim()}`.trim()
      last.caption_ids.push(segment.segment_id)
      continue
    }
    utterances.push({
      utterance_id: `utterance_${String(utterances.length + 1).padStart(3, '0')}`,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      text: segment.text.trim(),
      caption_ids: [segment.segment_id],
    })
  }
  return utterances
}

function reviewSpeechScore(timestamp: number, utterance: ReviewUtterance): number | null {
  if (utterance.end_ms < timestamp - REVIEW_MARK_AFTER_SPEECH_MS) return null
  if (utterance.start_ms > timestamp + REVIEW_MARK_BEFORE_SPEECH_MS) return null
  if (timestamp < utterance.start_ms) return utterance.start_ms - timestamp
  if (timestamp > utterance.end_ms) return timestamp - utterance.end_ms + REVIEW_AFTER_SPEECH_PENALTY_MS
  return 0
}

/** Assign each continuous utterance to at most one mark, preserving ambiguity. */
function attachReviewSpeech(drafts: ReviewMarkDraft[], transcript: Transcript | null): ReviewItem[] {
  const utterances = reviewUtterances(transcript)
  const ambiguousUtterances = new Set<string>()
  const pairs: Array<{ markIndex: number; utterance: ReviewUtterance; score: number }> = []

  for (const utterance of utterances) {
    const candidates = drafts.flatMap((draft, markIndex) => {
      const score = reviewSpeechScore(draft.timestamp_ms, utterance)
      return score === null ? [] : [{ markIndex, utterance, score }]
    }).sort((left, right) => left.score - right.score)
    if (candidates.length > 1 && candidates[1].score - candidates[0].score < REVIEW_AMBIGUITY_MARGIN_MS) {
      ambiguousUtterances.add(utterance.utterance_id)
      continue
    }
    pairs.push(...candidates)
  }

  pairs.sort((left, right) => left.score - right.score)
  const usedMarks = new Set<number>()
  const usedUtterances = new Set<string>()
  const assignments = new Map<number, ReviewUtterance>()
  for (const pair of pairs) {
    if (ambiguousUtterances.has(pair.utterance.utterance_id)) continue
    if (usedMarks.has(pair.markIndex) || usedUtterances.has(pair.utterance.utterance_id)) continue
    usedMarks.add(pair.markIndex)
    usedUtterances.add(pair.utterance.utterance_id)
    assignments.set(pair.markIndex, pair.utterance)
  }

  return drafts.map((draft, markIndex) => {
    const speech = assignments.get(markIndex)
    if (!speech) return draft.item
    return {
      ...draft.item,
      instruction: `你当时说：“${speech.text}”`,
      evidence_caption_ids: speech.caption_ids,
      speech_link_status: 'linked' as const,
    }
  })
}

/**
 * Compiles an imported image plus subsequent user marks into review
 * candidates. It reports image-relative regions and one-to-one speech
 * candidates; it never guesses an edit operation or claims intent as fact.
 */
function buildReviewItems(events: CognitiveEvent[], baseArtifacts: CanvasObject[], transcript: Transcript | null): ReviewItem[] {
  const images = baseArtifacts.filter((object) => object.type === 'image' && object.bounds.width > 0 && object.bounds.height > 0)
  if (images.length === 0) return []

  const candidates = events.filter((event) =>
    event.type !== 'deletion' && event.shapeType !== 'image' && ['stroke', 'region', 'arrow'].includes(event.type),
  )
  const drafts: ReviewMarkDraft[] = []
  for (const event of candidates) {
    const markBounds: ReviewBounds = {
      x: numericData(event.data.x),
      y: numericData(event.data.y),
      width: numericData(event.data.bbox_width),
      height: numericData(event.data.bbox_height),
    }
    if (markBounds.width < 8 || markBounds.height < 8) continue
    for (const image of images) {
      const overlap = intersection(markBounds, image.bounds)
      if (!overlap) continue
      drafts.push({
        timestamp_ms: event.timestamp,
        item: {
          review_id: `review_${String(drafts.length + 1).padStart(3, '0')}`,
          artifact_object_id: image.object_id,
          coordinate_space: 'base_artifact',
          region: {
            x_ratio: Number(((overlap.x - image.bounds.x) / image.bounds.width).toFixed(4)),
            y_ratio: Number(((overlap.y - image.bounds.y) / image.bounds.height).toFixed(4)),
            width_ratio: Number((overlap.width / image.bounds.width).toFixed(4)),
            height_ratio: Number((overlap.height / image.bounds.height).toFixed(4)),
          },
          instruction: null,
          evidence_caption_ids: [],
          speech_link_status: 'unavailable',
          assertion_level: 'observation',
          resolution_status: 'unresolved',
        },
      })
      // Do not duplicate one mark across multiple overlapping source images.
      break
    }
  }
  return attachReviewSpeech(drafts, transcript)
}

/** 点是否落在 bbox 内 */
function pointInBounds(px: number, py: number, bounds: BoundingBox): boolean {
  return px >= bounds.x && px <= bounds.x + bounds.width
    && py >= bounds.y && py <= bounds.y + bounds.height
}

/** 碰撞检测：一个点落在哪个对象内，返回面积最小（最精确）的命中对象 */
function hitTestObjects(
  px: number,
  py: number,
  targets: CanvasObject[]
): CanvasObject | null {
  let bestHit: CanvasObject | null = null
  let bestArea = Infinity
  for (const t of targets) {
    if (pointInBounds(px, py, t.bounds)) {
      const area = t.bounds.width * t.bounds.height
      if (area < bestArea) {
        bestArea = area
        bestHit = t
      }
    }
  }
  return bestHit
}

/** 碰撞检测：pointer_anchor 的中心点落在哪个对象 bbox 内，记到 hit_object_id */
function resolvePointerAnchors(objects: CanvasObject[]): void {
  const anchors = objects.filter((o) => o.type === 'pointer_anchor')
  const targets = objects.filter((o) => o.type !== 'pointer_anchor')

  for (const anchor of anchors) {
    const cx = anchor.bounds.x + anchor.bounds.width / 2
    const cy = anchor.bounds.y + anchor.bounds.height / 2
    const hit = hitTestObjects(cx, cy, targets)
    if (hit) {
      anchor.properties.hit_object_id = hit.object_id
      anchor.properties.hit_object_type = hit.type
      anchor.properties.hit_object_content = hit.semantic_content
    }
  }
}

/** 给 Pointer Track 的 gestures 做空间命中（复用 hitTestObjects） */
function resolveGestureHits(gestures: GestureEvent[], objects: CanvasObject[]): void {
  const targets = objects.filter((o) => o.type !== 'pointer_anchor')
  for (const g of gestures) {
    const hit = hitTestObjects(g.position.x, g.position.y, targets)
    if (hit) {
      g.hit_object_id = hit.object_id
    }
  }
}

// ============================================================
// 10. 截图处理
// ============================================================

/** 推断截图尺寸（从 base64 header 或使用默认画布尺寸） */
function inferImageSize(
  dataUri: string,
  canvasSize: { width: number; height: number }
): { width: number; height: number } {
  // 如果是 base64 data URI，尝试从 canvasSize 推断
  if (dataUri.startsWith('data:image/')) {
    return { width: canvasSize.width, height: canvasSize.height }
  }
  // URL 引用，使用画布尺寸
  return { width: canvasSize.width, height: canvasSize.height }
}

/** 构建 ImageReference */
function buildImageReference(
  screenshot: string,
  snapshotSize: { width: number; height: number }
): ImageReference {
  const { width, height } = inferImageSize(screenshot, snapshotSize)
  return {
    url: screenshot,
    format: inferImageFormat(screenshot),
    width: Math.max(1, width),
    height: Math.max(1, height),
  }
}

// ============================================================
// 11. 主编译函数
// ============================================================

/**
 * compilePromptPackage
 *
 * 将认知事件流、语音转写、画布截图编译为 Prompt Package。
 *
 * @param events          - 认知事件数组
 * @param transcription   - 语音转写文本（可为空字符串）
 * @param screenshot      - 最终画布截图（base64 data URI 或 URL）
 * @param options         - 编译选项
 * @param transcriptionSegments - STT 返回的句级时间戳 segments（可选，有则优先使用）
 * @param pointerTrack    - Pointer Track 数据（第七轨，可选）
 * @returns               - 符合 prompt-package-spec v2.0 的 PromptPackage
 */
export function compilePromptPackage(
  events: CognitiveEvent[],
  transcription: string,
  screenshot: string,
  options: CompilerOptions = {},
  transcriptionSegments?: TranscriptSegment[],
  pointerTrack?: PointerTrack | null
): PromptPackage {
  const canvasSize = options.canvasSize ?? { width: 1, height: 1, unit: 'scene' }
  const coordinateSystem = options.coordinateSystem ?? {
    space: 'excalidraw_scene' as const,
    unit: 'scene' as const,
    origin: { x: 0, y: 0 },
    x_axis: 'right' as const,
    y_axis: 'down' as const,
  }
  const snapshotSize = options.snapshotSize ?? { width: canvasSize.width, height: canvasSize.height }
  const language = options.language ?? 'zh-CN'

  // --- 1. 提取各子结构 ---
  // Final scene geometry and historical evidence serve different jobs. Deleted
  // elements remain in timeline/deletions, but cannot participate in the final
  // object graph, review binding, or spatial reasoning.
  const initialBaseArtifactIds = [
    ...(options.baseArtifacts ?? []),
    ...(options.baselineAnchors ?? []),
  ].map((item) => item.object_id.replace(/^obj_/, ''))
  const lifecycle = reduceFinalShapeLifecycle(events, initialBaseArtifactIds)
  const liveEvents = finalLiveProjectionEvents(lifecycle)
  const activeBaseArtifacts = (options.baseArtifacts ?? []).filter((item) => lifecycle.get(item.object_id.replace(/^obj_/, ''))?.alive !== false)
  const activeBaselineAnchors = (options.baselineAnchors ?? []).filter((item) => lifecycle.get(item.object_id.replace(/^obj_/, ''))?.alive !== false)
  const activeSourceImages = (options.sourceImages ?? []).filter((item) =>
    [...activeBaseArtifacts, ...activeBaselineAnchors].some((artifact) => artifact.object_id === item.artifact_object_id),
  )
  const strokes = extractStrokes(liveEvents)
  const regions = extractRegions(liveEvents)
  const arrows = extractArrows(liveEvents)
  const deletions = extractDeletions(events)
  const timeline = buildTimeline(events)
  // A material imported during a round is represented both by its lifecycle
  // event and its artifact record. Keep one canonical object, preferring the
  // artifact record because it carries its stable asset identity.
  const objects = [...new Map([
    // These existed before the round. Keep them as geometry-only targets so
    // new ink and spatial deixis can refer to them without rewriting history.
    ...activeBaselineAnchors.map((item) => [item.object_id, item] as const),
    ...extractObjects(liveEvents).map((item) => [item.object_id, item] as const),
    ...activeBaseArtifacts.map((item) => [item.object_id, item] as const),
  ]).values()]
  const transcript = buildTranscript(transcription, events, language, transcriptionSegments)
  // Image-relative marks are evidence available in every round.  The canvas
  // must not decide whether a person's mixed work is “reasoning” or “review”.
  const reviewItems = buildReviewItems(liveEvents, activeBaseArtifacts, transcript)
  const transformations = extractTransformations(events)
  const transformBindings = buildTransformBindings(transformations, objects, transcript)
  const intentSummary = extractIntentSummary(events, transcription)
  const canvasSnapshot: CanvasSnapshot = {
    final: buildImageReference(screenshot, snapshotSize),
    scene_bounds: { x: coordinateSystem.origin.x, y: coordinateSystem.origin.y, width: canvasSize.width, height: canvasSize.height },
    ...(options.keyframes && options.keyframes.length > 0 ? { keyframes: options.keyframes.slice(0, 8) } : {}),
  }

  // --- 1b. Pointer Track：对 gestures 做空间命中（复用 objects 的碰撞检测）---
  let pointerTrackData: PointerTrackData | undefined
  if (pointerTrack && pointerTrack.gestures.length > 0) {
    resolveGestureHits(pointerTrack.gestures, objects)
    pointerTrackData = {
      gestures: pointerTrack.gestures,
      // Individual cursor samples are low-value render telemetry. Gesture
      // summaries remain; raw samples can be explicitly requested for a
      // local diagnostic export.
      ...(options.includeRawPointerSamples ? { samples: pointerTrack.samples } : {}),
      meta: pointerTrack.meta,
    }
  }

  // --- 2. 推断时间范围 ---
  const { durationMs } = inferDuration(events)

  // --- 3. 构建 meta ---
  const meta: MetaObject = {
    package_id: generatePackageId(),
    version: '2.1',
    created_at: new Date().toISOString(),
    duration_ms: Math.max(0, durationMs),
    canvas_size: canvasSize,
    coordinate_system: coordinateSystem,
    ...(options.userId ? { user_id: options.userId } : {}),
    ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
  }

  // --- 4. 组装 Prompt Package ---
  const pkg: PromptPackage = {
    meta,
    canvas_snapshot: canvasSnapshot,
    strokes,
    // 仅在有内容时包含可选数组
    ...(regions.length > 0 ? { regions } : {}),
    ...(arrows.length > 0 ? { arrows } : {}),
    ...(deletions.length > 0 ? { deletions } : {}),
    ...(transcript ? { transcript } : { transcript: null }),
    timeline,
    objects,
    ...(activeBaseArtifacts.length ? { base_artifacts: activeBaseArtifacts } : {}),
    ...(activeSourceImages.length ? { source_images: activeSourceImages } : {}),
    ...(options.baselineContext ? { baseline_context: options.baselineContext } : {}),
    ...(reviewItems.length > 0 ? { review_items: reviewItems } : {}),
    ...(options.viewTransformations?.length ? { view_transformations: options.viewTransformations } : {}),
    ...(transformations.length > 0 ? { transformations } : {}),
    ...(transformBindings.length > 0 ? { transform_bindings: transformBindings } : {}),
    ...(pointerTrackData ? { pointer_track: pointerTrackData } : {}),
    intent_summary: intentSummary,
    ...(options.targetAgent ? { target_agent: options.targetAgent } : {}),
    ...(options.outputSchema ? { output_schema: options.outputSchema } : {}),
  }

  return pkg
}

// ============================================================
// 12. 验证工具（基础约束检查）
// ============================================================

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * validatePromptPackage
 *
 * 对编译产出的 Prompt Package 做基础约束校验。
 * 完整 JSON Schema 验证待 spec 附录 A 实现后补充。
 */
export function validatePromptPackage(pkg: PromptPackage): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // --- meta 必填 ---
  if (!pkg.meta) {
    errors.push('meta 字段缺失')
  } else {
    if (!pkg.meta.package_id) errors.push('meta.package_id 缺失')
    if (!pkg.meta.version) errors.push('meta.version 缺失')
    if (!pkg.meta.created_at) errors.push('meta.created_at 缺失')
    if (pkg.meta.duration_ms < 0) errors.push('meta.duration_ms 不能为负')
    if (!pkg.meta.canvas_size) {
      errors.push('meta.canvas_size 缺失')
    } else {
      if (pkg.meta.canvas_size.width < 1) errors.push('meta.canvas_size.width 必须 ≥ 1')
      if (pkg.meta.canvas_size.height < 1) errors.push('meta.canvas_size.height 必须 ≥ 1')
    }
  }

  // --- canvas_snapshot 必填 ---
  if (!pkg.canvas_snapshot) {
    errors.push('canvas_snapshot 字段缺失')
  } else if (!pkg.canvas_snapshot.final) {
    errors.push('canvas_snapshot.final 缺失')
  } else {
    if (!pkg.canvas_snapshot.final.url) errors.push('canvas_snapshot.final.url 缺失')
    if (pkg.canvas_snapshot.final.width < 1) errors.push('canvas_snapshot.final.width 必须 ≥ 1')
    if (pkg.canvas_snapshot.final.height < 1) errors.push('canvas_snapshot.final.height 必须 ≥ 1')
  }

  // --- strokes 必须存在（可为空数组）---
  if (!Array.isArray(pkg.strokes)) {
    errors.push('strokes 字段必须是数组')
  }

  // --- timeline 必须存在（可为空数组）---
  if (!Array.isArray(pkg.timeline)) {
    errors.push('timeline 字段必须是数组')
  }

  // --- objects 必须存在（可为空数组）---
  if (!Array.isArray(pkg.objects)) {
    errors.push('objects 字段必须是数组')
  }

  // --- transcript evidence contract ---
  if (pkg.transcript) {
    const segmentIds = pkg.transcript.segments.map((segment) => segment.segment_id)
    if (new Set(segmentIds).size !== segmentIds.length) errors.push('transcript.segment_id 必须唯一')
    if (pkg.transcript.alignment_status === 'unavailable' && pkg.transcript.segments.length > 0) {
      errors.push('transcript 无时间对齐时 segments 必须为空')
    }
    if (pkg.transcript.alignment_status === 'timestamped' && pkg.transcript.segments.length === 0) {
      errors.push('transcript 标记 timestamped 时必须包含 segments')
    }
    for (const segment of pkg.transcript.segments) {
      if (!segment.segment_id) errors.push('transcript.segment_id 缺失')
      if (segment.start_ms < 0 || segment.end_ms < segment.start_ms) {
        errors.push(`transcript ${segment.segment_id}: 时间范围无效`)
      }
    }
  }

  // --- intent_summary 必填 ---
  if (!pkg.intent_summary) {
    errors.push('intent_summary 字段缺失')
  } else {
    if (!pkg.intent_summary.primary_intent) errors.push('intent_summary.primary_intent 缺失')
    if (!Array.isArray(pkg.intent_summary.key_concepts)) errors.push('intent_summary.key_concepts 缺失')
    if (
      typeof pkg.intent_summary.confidence !== 'number' ||
      pkg.intent_summary.confidence < 0 ||
      pkg.intent_summary.confidence > 1
    ) {
      errors.push('intent_summary.confidence 必须在 0–1 范围内')
    }
  }

  // --- 时间戳约束 ---
  if (pkg.strokes) {
    for (const s of pkg.strokes) {
      if (s.timestamp_ms < 0) errors.push(`stroke ${s.stroke_id}: timestamp_ms 不能为负`)
      if (s.duration_ms < 0) errors.push(`stroke ${s.stroke_id}: duration_ms 不能为负`)
      if (s.style.width < 0) errors.push(`stroke ${s.stroke_id}: style.width 不能为负`)
    }
  }

  if (pkg.timeline) {
    for (const evt of pkg.timeline) {
      if (evt.timestamp_ms < 0) errors.push(`timeline ${evt.event_id}: timestamp_ms 不能为负`)
    }
  }

  // --- keyframe 数量建议 ---
  if (pkg.canvas_snapshot?.keyframes && pkg.canvas_snapshot.keyframes.length > 10) {
    warnings.push(`keyframe 数量 ${pkg.canvas_snapshot.keyframes.length} 超过建议上限 10`)
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

// ============================================================
// 13. 便捷导出工具
// ============================================================

/**
 * 编译并序列化为 JSON 字符串。
 */
export function compileAndSerialize(
  events: CognitiveEvent[],
  transcription: string,
  screenshot: string,
  options?: CompilerOptions
): string {
  const pkg = compilePromptPackage(events, transcription, screenshot, options)
  return JSON.stringify(pkg, null, 2)
}

/**
 * 编译、验证并序列化。验证失败时抛出错误。
 */
export function compileValidateAndSerialize(
  events: CognitiveEvent[],
  transcription: string,
  screenshot: string,
  options?: CompilerOptions
): string {
  const pkg = compilePromptPackage(events, transcription, screenshot, options)
  const result = validatePromptPackage(pkg)

  if (!result.valid) {
    throw new Error(
      `Prompt Package 验证失败:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`
    )
  }

  if (result.warnings.length > 0) {
    console.warn(
      `[PromptPackageCompiler] 警告:\n${result.warnings.map((w) => `  - ${w}`).join('\n')}`
    )
  }

  return JSON.stringify(pkg, null, 2)
}
