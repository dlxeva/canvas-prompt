import { describe, expect, it } from 'vitest'
import { compactTraceToCognitiveEvents, buildPointerTrack } from '../src/excalidraw-cognitive-events'
import { compilePromptPackage, validatePromptPackage } from '../src/prompt-package-compiler'
import { diffScene } from '../src/excalidraw-adapter'
import type { TraceEvent } from '../src/excalidraw-adapter'
import { OCR_MODEL_CONTEXT_POLICY, observationsFromOcrItems } from '../src/local-ocr'
import type { CanvasObject } from '../src/prompt-package-compiler'

const arrow: TraceEvent = {
  at_ms: 320,
  kind: 'create',
  element: {
    id: 'arrow_1', type: 'arrow', version: 1, x: 20, y: 30, width: 180, height: 60,
    fileId: null, point_count: 2, points: [[0, 0], [180, 60]], stroke_color: '#2563eb', stroke_width: 4,
  },
}

describe('Excalidraw process bridge', () => {
  it('records a drawn arrow as geometry without inferring its meaning', () => {
    expect(compactTraceToCognitiveEvents([arrow])).toEqual([expect.objectContaining({
      type: 'arrow', semanticType: undefined, shapeType: 'arrow',
      data: expect.objectContaining({ toX: 200, toY: 90, strokeWidth: 4 }),
    })])
  })

  it('keeps deletion target geometry while leaving an unknown delete method unknown', () => {
    const deletedArrow: TraceEvent = {
      at_ms: 900,
      kind: 'delete',
      element: { ...arrow.element, isDeleted: true },
    }
    const events = compactTraceToCognitiveEvents([arrow, deletedArrow])
    const pkg = compilePromptPackage(events, '', 'data:image/png;base64,AA==')
    expect(pkg.deletions).toEqual([expect.objectContaining({
      target_id: 'arrow_1', target_type: 'arrow', method: 'unknown',
    })])
    expect(pkg.arrows).toBeUndefined()
    expect(pkg.objects.some((item) => item.object_id === 'obj_arrow_1')).toBe(false)
    expect(pkg.timeline.map((item) => item.event_type)).toEqual(['arrow_draw', 'delete'])
  })

  it('restores an element only when a later live event follows deletion', () => {
    const deletedArrow: TraceEvent = {
      at_ms: 900,
      kind: 'delete',
      element: { ...arrow.element, version: 2, isDeleted: true },
    }
    const restoredArrow: TraceEvent = {
      at_ms: 1_200,
      kind: 'create',
      element: { ...arrow.element, version: 3, isDeleted: false, x: 40 },
    }
    const pkg = compilePromptPackage(compactTraceToCognitiveEvents([arrow, deletedArrow, restoredArrow]), '', 'data:image/png;base64,AA==')
    expect(pkg.arrows).toHaveLength(1)
    expect(pkg.arrows?.[0]).toMatchObject({ arrow_id: 'arrow_1', timestamp_ms: 1_200 })
    expect(pkg.deletions).toHaveLength(1)
  })

  it('uses the restore generation timestamp after a later update and keeps all deletion history', () => {
    const deletedArrow: TraceEvent = {
      at_ms: 900, kind: 'delete', element: { ...arrow.element, version: 2, isDeleted: true },
    }
    const restoredArrow: TraceEvent = {
      at_ms: 1_200, kind: 'create', element: { ...arrow.element, version: 3, isDeleted: false, x: 40 },
    }
    const updatedArrow: TraceEvent = {
      at_ms: 1_500, kind: 'update', previous_bounds: { x: 40, y: 30, width: 180, height: 60 },
      element: { ...arrow.element, version: 4, isDeleted: false, x: 90 },
    }
    const pkg = compilePromptPackage(compactTraceToCognitiveEvents([arrow, deletedArrow, restoredArrow, updatedArrow]), '', 'data:image/png;base64,AA==')
    expect(pkg.arrows?.[0]).toMatchObject({ arrow_id: 'arrow_1', timestamp_ms: 1_200, from: { ref: { x: 90, y: 30 } } })
    expect(pkg.deletions).toHaveLength(1)
  })

  it('retains two delete/restore cycles and excludes an element after the final delete', () => {
    const lifecycle: TraceEvent[] = [
      arrow,
      { at_ms: 500, kind: 'delete', element: { ...arrow.element, version: 2 } },
      { at_ms: 700, kind: 'create', element: { ...arrow.element, version: 3, x: 30 } },
      { at_ms: 900, kind: 'delete', element: { ...arrow.element, version: 4, x: 30 } },
      { at_ms: 1_100, kind: 'create', element: { ...arrow.element, version: 5, x: 50 } },
      { at_ms: 1_300, kind: 'delete', element: { ...arrow.element, version: 6, x: 50 } },
    ]
    const pkg = compilePromptPackage(compactTraceToCognitiveEvents(lifecycle), '', 'data:image/png;base64,AA==')
    expect(pkg.deletions?.map((item) => item.timestamp_ms)).toEqual([500, 900, 1_300])
    expect(pkg.arrows).toBeUndefined()
    expect(pkg.objects.some((item) => item.object_id === 'obj_arrow_1')).toBe(false)
  })

  it('filters renderer growth against the restored freehand generation, not first-ever creation', () => {
    const stroke: TraceEvent = {
      at_ms: 100, kind: 'create',
      element: { id: 'stroke_restore', type: 'freedraw', version: 1, x: 0, y: 0, width: 4, height: 2, points: [[0, 0], [4, 2]], point_count: 2, sampled_point_count: 2, fileId: null, text: null, original_text: null, semantic_content: null, stroke_color: '#111', stroke_width: 1 },
    }
    const trace: TraceEvent[] = [
      stroke,
      { at_ms: 2_000, kind: 'delete', element: { ...stroke.element, version: 2 } },
      { at_ms: 10_000, kind: 'create', element: { ...stroke.element, version: 3 } },
      { at_ms: 10_100, kind: 'update', previous_bounds: { x: 0, y: 0, width: 4, height: 2 }, element: { ...stroke.element, version: 4, width: 40, height: 20 } },
      { at_ms: 12_000, kind: 'update', previous_bounds: { x: 0, y: 0, width: 40, height: 20 }, element: { ...stroke.element, version: 5, x: 80, width: 40, height: 20 } },
    ]
    const transforms = compactTraceToCognitiveEvents(trace).filter((event) => event.type === 'move')
    expect(transforms).toHaveLength(1)
    expect(transforms[0]).toMatchObject({ timestamp: 12_000, data: { transform_kind: 'move' } })
  })

  it('removes a deleted imported image from the active review substrate', () => {
    const image: CanvasObject = {
      object_id: 'obj_image_1', type: 'image', timestamp_ms: 0,
      bounds: { x: 0, y: 0, width: 400, height: 300 }, properties: { base_artifact: true },
    }
    const deletedImage: TraceEvent = {
      at_ms: 800,
      kind: 'delete',
      element: { id: 'image_1', type: 'image', version: 2, x: 0, y: 0, width: 400, height: 300, isDeleted: true },
    }
    const pkg = compilePromptPackage(compactTraceToCognitiveEvents([deletedImage]), '', 'data:image/png;base64,AA==', {
      baseArtifacts: [image],
    })
    expect(pkg.base_artifacts).toBeUndefined()
    expect(pkg.objects.some((item) => item.object_id === 'obj_image_1')).toBe(false)
    expect(pkg.review_items).toBeUndefined()
    expect(pkg.deletions).toHaveLength(1)
  })

  it('keeps pen turns while dropping predictable renderer samples', () => {
    const result = diffScene(new Map(), [{
      id: 'seven', type: 'freedraw', version: 1, updated: 0, isDeleted: false,
      x: 0, y: 0, width: 20, height: 10,
      points: [[0, 0], [10, 0], [20, 0], [20, 10]],
    }], 100)
    expect(result.events[0].element).toMatchObject({
      point_count: 4,
      sampled_point_count: 3,
      points: [[0, 0], [20, 0], [20, 10]],
    })
  })

  it('keeps a move and resize as direct transform evidence', () => {
    const transformed: TraceEvent = {
      at_ms: 880,
      kind: 'update',
      previous_bounds: { x: 20, y: 30, width: 180, height: 60 },
      element: { ...arrow.element, version: 2, x: 80, y: 54, width: 270, height: 90 },
    }
    const events = compactTraceToCognitiveEvents([arrow, transformed])
    expect(events).toContainEqual(expect.objectContaining({
      type: 'move', shapeId: 'arrow_1',
      data: expect.objectContaining({
        transform_kind: 'move_resize', delta_x: 60, delta_y: 24, scale_x: 1.5, scale_y: 1.5,
        previous_bounds: { x: 20, y: 30, width: 180, height: 60 },
      }),
    }))
    const pkg = compilePromptPackage(events, '', 'data:image/png;base64,AA==', {
      canvasSize: { width: 300, height: 200, unit: 'scene' },
      snapshotSize: { width: 348, height: 248 },
      coordinateSystem: { space: 'excalidraw_scene', unit: 'scene', origin: { x: 20, y: 30 }, x_axis: 'right', y_axis: 'down' },
    })
    expect(pkg.transformations).toEqual([expect.objectContaining({
      kind: 'move_resize', delta: { x: 60, y: 24 }, scale: { x: 1.5, y: 1.5 }, assertion_level: 'observation',
    })])
    expect(pkg.canvas_snapshot).toMatchObject({ final: { width: 348, height: 248 }, scene_bounds: { x: 20, y: 30, width: 300, height: 200 } })
  })

  it('coalesces render-frame updates into one object-level transform session', () => {
    const first = {
      at_ms: 1_000,
      kind: 'update' as const,
      previous_bounds: { x: 20, y: 30, width: 180, height: 60 },
      element: { ...arrow.element, version: 2, x: 40, y: 30 },
    }
    const middle = {
      at_ms: 1_080,
      kind: 'update' as const,
      previous_bounds: { x: 40, y: 30, width: 180, height: 60 },
      element: { ...arrow.element, version: 3, x: 80, y: 30 },
    }
    const last = {
      at_ms: 1_160,
      kind: 'update' as const,
      previous_bounds: { x: 80, y: 30, width: 180, height: 60 },
      element: { ...arrow.element, version: 4, x: 120, y: 54 },
    }
    const events = compactTraceToCognitiveEvents([arrow, first, middle, last])
    const transforms = events.filter((event) => event.type === 'move')
    expect(transforms).toHaveLength(1)
    expect(transforms[0]).toMatchObject({
      timestamp: 1_160,
      data: {
        previous_bounds: { x: 20, y: 30, width: 180, height: 60 },
        delta_x: 100,
        delta_y: 24,
        session_start_ms: 1_000,
        session_end_ms: 1_160,
        transform_sample_count: 3,
      },
    })
    const pkg = compilePromptPackage(events, '', 'data:image/png;base64,AA==')
    expect(pkg.transformations).toEqual([expect.objectContaining({
      time_range_ms: [1_000, 1_160], sample_count: 3,
      batch_id: 'transform_batch_1000_1160', batch_object_ids: ['arrow_1'],
    })])
  })

  it('does not mistake a newly drawn freehand stroke growing under the pen for a resize', () => {
    const stroke: TraceEvent = {
      at_ms: 2_000,
      kind: 'create',
      element: {
        id: 'stroke_1', type: 'freedraw', version: 1, x: 20, y: 30, width: 4, height: 2,
        point_count: 2, points: [[0, 0], [4, 2]], stroke_color: '#111', stroke_width: 1,
      },
    }
    const growing = {
      at_ms: 2_120,
      kind: 'update' as const,
      previous_bounds: { x: 20, y: 30, width: 4, height: 2 },
      element: { ...stroke.element, version: 2, width: 42, height: 18, points: [[0, 0], [42, 18]] },
    }
    const events = compactTraceToCognitiveEvents([stroke, growing])
    expect(events.some((event) => event.type === 'move')).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: 'stroke', shapeId: 'stroke_1' }))
  })

  it('marks simultaneous transforms as one multi-object gesture without inferring intent', () => {
    const second = { ...arrow, element: { ...arrow.element, id: 'arrow_2', x: 260 } }
    const firstUpdate = { at_ms: 2_000, kind: 'update' as const, previous_bounds: { x: 20, y: 30, width: 180, height: 60 }, element: { ...arrow.element, version: 2, x: 50 } }
    const secondUpdate = { at_ms: 2_000, kind: 'update' as const, previous_bounds: { x: 260, y: 30, width: 180, height: 60 }, element: { ...second.element, version: 2, x: 290 } }
    const events = compactTraceToCognitiveEvents([arrow, second, firstUpdate, secondUpdate])
    const transforms = events.filter((event) => event.type === 'move')
    expect(transforms).toHaveLength(2)
    expect(transforms.map((event) => event.data.transform_batch_id)).toEqual(['transform_batch_2000_2000', 'transform_batch_2000_2000'])
    expect(transforms[0].data.transform_batch_object_ids).toEqual(['arrow_1', 'arrow_2'])
    const pkg = compilePromptPackage(events, '', 'data:image/png;base64,AA==')
    expect(pkg.transformations).toEqual(expect.arrayContaining([
      expect.objectContaining({ batch_id: 'transform_batch_2000_2000', batch_object_ids: ['arrow_1', 'arrow_2'], assertion_level: 'observation' }),
    ]))
    expect(pkg.transform_bindings).toEqual([expect.objectContaining({
      batch_id: 'transform_batch_2000_2000',
      transformation_ids: ['transform_arrow_1_2000', 'transform_arrow_2_2000'],
      object_links: [],
      speech_candidates: [],
      assertion_level: 'observation',
    })])
  })

  it('compiles Excalidraw process data into a valid Prompt Package', () => {
    const events = compactTraceToCognitiveEvents([arrow])
    const pkg = compilePromptPackage(events, '这里是一条关系箭头', 'data:image/png;base64,AA==', {
      canvasSize: { width: 1920, height: 1080 }, language: 'zh-CN', tags: ['excalidraw'],
    }, undefined, buildPointerTrack([]))
    expect(validatePromptPackage(pkg).valid).toBe(true)
    expect(pkg.arrows).toHaveLength(1)
    expect(pkg.transcript?.full_text).toBe('这里是一条关系箭头')
    expect(pkg.transcript?.alignment_status).toBe('unavailable')
    expect(pkg.transcript?.segments).toEqual([])
  })

  it('keeps visual events as observations rather than compiler-level conclusions', () => {
    const rectangle: TraceEvent = {
      at_ms: 1_000,
      kind: 'create',
      element: { id: 'rect_1', type: 'rectangle', version: 1, x: 10, y: 20, width: 120, height: 80 },
    }
    const pkg = compilePromptPackage(
      compactTraceToCognitiveEvents([arrow, rectangle]),
      '把这个连到那里',
      'data:image/png;base64,AA==',
    )
    expect(pkg.arrows?.[0]?.semantic_type).toBeUndefined()
    expect(pkg.regions?.[0]?.semantic_role).toBeUndefined()
    expect(pkg.timeline.every((event) => event.importance === undefined)).toBe(true)
    expect(pkg.intent_summary).toEqual({
      primary_intent: 'unknown',
      key_concepts: [],
      confidence: 0,
      analysis_notes: 'Intent was not inferred from canvas geometry or interaction patterns.',
    })
  })

  it('compiles native Chinese and English text as text evidence across move, delete, restore, and update', () => {
    const textElement = {
      id: 'text_1', type: 'text', version: 1, x: 10, y: 20, width: 160, height: 30,
      fileId: null, point_count: null, sampled_point_count: null, points: null,
      text: '旧文本', original_text: '旧文本', semantic_content: '旧文本', stroke_color: '#111', stroke_width: 1,
    }
    const trace: TraceEvent[] = [
      { at_ms: 100, kind: 'create', element: textElement },
      { at_ms: 300, kind: 'update', previous_bounds: { x: 10, y: 20, width: 160, height: 30 }, element: { ...textElement, version: 2, x: 60 } },
      { at_ms: 500, kind: 'delete', element: { ...textElement, version: 3, x: 60 } },
      { at_ms: 800, kind: 'create', element: { ...textElement, version: 4, x: 80, text: '中文 English', original_text: '中文 English', semantic_content: '中文 English' } },
      { at_ms: 1_000, kind: 'update', previous_bounds: { x: 80, y: 20, width: 160, height: 30 }, element: { ...textElement, version: 5, x: 100, text: '中文 English', original_text: '中文 English', semantic_content: '中文 English' } },
    ]
    const pkg = compilePromptPackage(compactTraceToCognitiveEvents(trace), '', 'data:image/png;base64,AA==')
    expect(pkg.strokes).toEqual([])
    expect(pkg.objects).toContainEqual(expect.objectContaining({
      object_id: 'obj_text_1', type: 'text_block', timestamp_ms: 800, semantic_content: '中文 English',
      bounds: { x: 100, y: 20, width: 160, height: 30 },
    }))
    expect(pkg.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: 'text_create', target_id: 'text_1' }),
      expect.objectContaining({ event_type: 'delete', target_id: 'text_1' }),
    ]))
    expect(pkg.deletions).toHaveLength(1)
  })

  it('keeps empty native text unnamed and unsupported elements out of hand-drawn evidence', () => {
    const traces: TraceEvent[] = [
      {
        at_ms: 100, kind: 'create', element: {
          id: 'empty_text', type: 'text', version: 1, x: 0, y: 0, width: 20, height: 20,
          fileId: null, point_count: null, sampled_point_count: null, points: null,
          text: '', original_text: '', semantic_content: null, stroke_color: '#111', stroke_width: 1,
        },
      },
      ...['frame', 'embeddable'].map((type, index): TraceEvent => ({
        at_ms: 200 + index * 100, kind: 'create', element: {
          id: type, type, version: 1, x: 40 + index * 30, y: 0, width: 20, height: 20,
          fileId: null, point_count: null, sampled_point_count: null, points: null,
          text: null, original_text: null, semantic_content: null, stroke_color: '#111', stroke_width: 1,
        },
      })),
    ]
    const cognitive = compactTraceToCognitiveEvents(traces)
    expect(cognitive.filter((item) => item.type === 'stroke')).toEqual([])
    expect(cognitive.filter((item) => item.type === 'unknown_element').map((item) => item.shapeType)).toEqual(['frame', 'embeddable'])
    const pkg = compilePromptPackage(cognitive, '', 'data:image/png;base64,AA==')
    expect(pkg.strokes).toEqual([])
    expect(pkg.objects.find((item) => item.object_id === 'obj_empty_text')).not.toHaveProperty('semantic_content')
    expect(pkg.objects.filter((item) => item.type === 'unknown_element')).toHaveLength(2)
    expect(pkg.timeline.filter((item) => item.event_type === 'unknown_element_observed')).toHaveLength(2)
  })

  it('preserves restored image geometry without classifying it as ink', () => {
    const base = {
      id: 'image_restore', type: 'image', version: 1, x: 0, y: 0, width: 400, height: 300,
      fileId: 'file_1', point_count: null, sampled_point_count: null, points: null,
      text: null, original_text: null, semantic_content: null, stroke_color: null, stroke_width: null,
    }
    const trace: TraceEvent[] = [
      { at_ms: 100, kind: 'create', element: base },
      { at_ms: 500, kind: 'delete', element: { ...base, version: 2 } },
      { at_ms: 900, kind: 'create', element: { ...base, version: 3, x: 40 } },
      { at_ms: 1_100, kind: 'update', previous_bounds: { x: 40, y: 0, width: 400, height: 300 }, element: { ...base, version: 4, x: 80 } },
    ]
    const pkg = compilePromptPackage(compactTraceToCognitiveEvents(trace), '', 'data:image/png;base64,AA==')
    expect(pkg.strokes).toEqual([])
    expect(pkg.objects).toContainEqual(expect.objectContaining({ object_id: 'obj_image_restore', type: 'image', timestamp_ms: 900, bounds: { x: 80, y: 0, width: 400, height: 300 } }))
    expect(pkg.deletions).toHaveLength(1)
  })

  it('states when an earlier canvas is only partially included in this round', () => {
    const pkg = compilePromptPackage([], '', 'data:image/png;base64,AA==', {
      baselineContext: {
        scene_sha256: 'abc123', object_count: 5, image_count: 1,
        included_object_count: 1, status: 'partially_included',
      },
    })
    expect(pkg.baseline_context).toEqual({
      scene_sha256: 'abc123', object_count: 5, image_count: 1,
      included_object_count: 1, status: 'partially_included',
    })
  })

  it('keeps prior live objects as spatial anchors without turning them into new actions', () => {
    const priorText: CanvasObject = {
      object_id: 'obj_prior_text', type: 'text_block', timestamp_ms: 0,
      bounds: { x: 20, y: 30, width: 240, height: 48 },
      properties: { baseline_anchor: true, evidence_source: 'round_start_scene' },
      source_strokes: ['prior_text'], semantic_content: '简介',
    }

    const pkg = compilePromptPackage([], '', 'data:image/png;base64,AA==', {
      baselineAnchors: [priorText],
    })

    expect(pkg.objects).toContainEqual(priorText)
    expect(pkg.timeline).toEqual([])
  })

  it('keeps pointer gestures but excludes raw cursor samples from normal exports', () => {
    const events = compactTraceToCognitiveEvents([arrow])
    const pointer = buildPointerTrack([
      { t: 0, x: 10, y: 10, speed: 0 },
      { t: 800, x: 10, y: 10, speed: 0 },
    ])
    const pkg = compilePromptPackage(events, '', 'data:image/png;base64,AA==', {}, undefined, pointer)
    expect(pkg.pointer_track?.gestures).toHaveLength(1)
    expect(pkg.pointer_track?.samples).toBeUndefined()
  })

  it('keeps sparse state frames while capping them for a normal package', () => {
    const events = compactTraceToCognitiveEvents([arrow])
    const keyframes = Array.from({ length: 10 }, (_, index) => ({
      timestamp_ms: index * 10_000,
      image: { url: 'data:image/png;base64,AA==', format: 'png' as const, width: 640, height: 480 },
    }))
    const pkg = compilePromptPackage(events, '', 'data:image/png;base64,AA==', { keyframes })
    expect(pkg.canvas_snapshot.keyframes).toHaveLength(8)
    expect(pkg.canvas_snapshot.keyframes?.[0].timestamp_ms).toBe(0)
    expect(pkg.canvas_snapshot.keyframes?.at(-1)?.timestamp_ms).toBe(70_000)
  })

  it('compiles a time-adjacent mark on an imported image into a review item', () => {
    const image: CanvasObject = {
      object_id: 'obj_source_image', type: 'image', timestamp_ms: 0,
      bounds: { x: 100, y: 100, width: 800, height: 600 },
      properties: { base_artifact: true, asset_id: 'source_file' },
    }
    const circle = {
      id: 'evt_circle', timestamp: 2_100, type: 'region' as const,
      shapeId: 'circle_1', shapeType: 'ellipse',
      data: { x: 200, y: 250, bbox_width: 160, bbox_height: 120 },
    }
    const pkg = compilePromptPackage([circle], '把这里的标题改短一点', 'data:image/png;base64,AA==', {
      canvasSize: { width: 1920, height: 1080 }, language: 'zh-CN', baseArtifacts: [image],
    }, [{ segment_id: 'seg_001', start_ms: 1_500, end_ms: 3_000, text: '把这里的标题改短一点', confidence: 0.9 }])

    expect(pkg.base_artifacts).toEqual([image])
    expect(pkg.review_items).toEqual([expect.objectContaining({
      artifact_object_id: 'obj_source_image',
      coordinate_space: 'base_artifact',
      region: { x_ratio: 0.125, y_ratio: 0.25, width_ratio: 0.2, height_ratio: 0.2 },
      instruction: '你当时说：“把这里的标题改短一点”',
      evidence_caption_ids: ['seg_001'],
      speech_link_status: 'linked',
      assertion_level: 'observation',
      resolution_status: 'unresolved',
    })])
  })

  it('does not attach distant transcript text to an image mark', () => {
    const image: CanvasObject = {
      object_id: 'obj_source_image', type: 'image', timestamp_ms: 0,
      bounds: { x: 100, y: 100, width: 800, height: 600 }, properties: { base_artifact: true },
    }
    const circle = {
      id: 'evt_circle', timestamp: 50_000, type: 'region' as const,
      shapeId: 'circle_1', shapeType: 'ellipse',
      data: { x: 200, y: 250, bbox_width: 160, bbox_height: 120 },
    }
    const pkg = compilePromptPackage([circle], '最开始说的话', 'data:image/png;base64,AA==', {
      baseArtifacts: [image],
    }, [{ segment_id: 'seg_001', start_ms: 0, end_ms: 1_000, text: '最开始说的话', confidence: 0.9 }])
    expect(pkg.review_items?.[0]).toMatchObject({
      evidence_caption_ids: [],
      instruction: null,
      speech_link_status: 'unavailable',
    })
  })

  it('does not attach one long speech segment to multiple image marks', () => {
    const image: CanvasObject = {
      object_id: 'obj_source_image', type: 'image', timestamp_ms: 0,
      bounds: { x: 100, y: 100, width: 800, height: 600 }, properties: { base_artifact: true },
    }
    const marks = [
      { id: 'mark_a', timestamp: 2_000, type: 'region' as const, shapeId: 'circle_a', shapeType: 'ellipse', data: { x: 200, y: 250, bbox_width: 160, bbox_height: 120 } },
      { id: 'mark_b', timestamp: 4_000, type: 'region' as const, shapeId: 'circle_b', shapeType: 'ellipse', data: { x: 500, y: 350, bbox_width: 160, bbox_height: 120 } },
    ]
    const pkg = compilePromptPackage(marks, '改这里，但那里不需要改', 'data:image/png;base64,AA==', {
      baseArtifacts: [image],
    }, [{ segment_id: 'seg_001', start_ms: 1_000, end_ms: 5_000, text: '改这里，但那里不需要改', confidence: 0.9 }])
    expect(pkg.review_items).toEqual([
      expect.objectContaining({ instruction: null, evidence_caption_ids: [], speech_link_status: 'unavailable' }),
      expect.objectContaining({ instruction: null, evidence_caption_ids: [], speech_link_status: 'unavailable' }),
    ])
  })

  it('assigns a multi-segment instruction to the preceding mark, not a later silent mark', () => {
    const image: CanvasObject = {
      object_id: 'obj_source_image', type: 'image', timestamp_ms: 0,
      bounds: { x: 0, y: 0, width: 1_000, height: 1_000 }, properties: { base_artifact: true },
    }
    const marks = [
      { id: 'mark_spoken', timestamp: 13_774, type: 'region' as const, shapeId: 'circle_spoken', shapeType: 'freedraw', data: { x: 670, y: 67, bbox_width: 330, bbox_height: 338 } },
      { id: 'mark_silent', timestamp: 23_030, type: 'region' as const, shapeId: 'circle_silent', shapeType: 'freedraw', data: { x: 256, y: 736, bbox_width: 272, bbox_height: 156 } },
    ]
    const segments = [
      { segment_id: 'seg_001', start_ms: 4_880, end_ms: 11_950, text: '我们来调整一下这个图片', confidence: 0.9 },
      { segment_id: 'seg_002', start_ms: 15_140, end_ms: 16_540, text: '这个地方的话', confidence: 0.9 },
      { segment_id: 'seg_003', start_ms: 16_540, end_ms: 18_540, text: '我觉得整体主要是把这个', confidence: 0.9 },
      { segment_id: 'seg_004', start_ms: 18_940, end_ms: 20_140, text: '这儿的颜色改一下', confidence: 0.9 },
      { segment_id: 'seg_005', start_ms: 20_140, end_ms: 21_340, text: '全部改成绿色', confidence: 0.9 },
    ]
    const pkg = compilePromptPackage(marks, segments.map((segment) => segment.text).join(' '), 'data:image/png;base64,AA==', {
      baseArtifacts: [image],
    }, segments)
    expect(pkg.review_items?.[0]).toMatchObject({
      instruction: '你当时说：“这个地方的话 我觉得整体主要是把这个 这儿的颜色改一下 全部改成绿色”',
      evidence_caption_ids: ['seg_002', 'seg_003', 'seg_004', 'seg_005'],
      speech_link_status: 'linked',
    })
    expect(pkg.review_items?.[1]).toMatchObject({
      instruction: null,
      evidence_caption_ids: [],
      speech_link_status: 'unavailable',
    })
  })

  it('keeps an image-relative mark as an unresolved candidate without a round mode', () => {
    const image: CanvasObject = { object_id: 'obj_image', type: 'image', timestamp_ms: 0, bounds: { x: 0, y: 0, width: 100, height: 100 }, properties: {} }
    const mark = { id: 'mark', timestamp: 1_000, type: 'region' as const, shapeId: 'mark', shapeType: 'ellipse', data: { x: 10, y: 10, bbox_width: 40, bbox_height: 40 } }
    const pkg = compilePromptPackage([mark], '', 'data:image/png;base64,AA==', { baseArtifacts: [image] })
    expect('round_kind' in pkg.meta).toBe(false)
    expect(pkg.review_items).toEqual([expect.objectContaining({
      artifact_object_id: 'obj_image',
      assertion_level: 'observation',
      resolution_status: 'unresolved',
    })])
  })

  it('keeps a material imported mid-round with its timestamp and an unresolved mark candidate', () => {
    const importedImage: TraceEvent = {
      at_ms: 400, kind: 'create',
      element: { id: 'mid_round_image', type: 'image', version: 1, x: 100, y: 100, width: 400, height: 300, fileId: 'asset_mid', point_count: null, sampled_point_count: null, points: null, text: null, original_text: null, semantic_content: null, stroke_color: null, stroke_width: null },
    }
    const circle: TraceEvent = {
      at_ms: 900, kind: 'create',
      element: { id: 'mark_after_import', type: 'freedraw', version: 1, x: 180, y: 180, width: 90, height: 80, fileId: null, point_count: 4, sampled_point_count: 4, points: [[0, 0], [90, 0], [90, 80], [0, 80]], text: null, original_text: null, semantic_content: null, stroke_color: '#ef4444', stroke_width: 3 },
    }
    const image: CanvasObject = {
      object_id: 'obj_mid_round_image', type: 'image', timestamp_ms: 400,
      bounds: { x: 100, y: 100, width: 400, height: 300 }, properties: { base_artifact: true, asset_id: 'asset_mid' },
    }

    const pkg = compilePromptPackage(compactTraceToCognitiveEvents([importedImage, circle]), '', 'data:image/png;base64,AA==', { baseArtifacts: [image] })
    expect(pkg.base_artifacts).toEqual([image])
    expect(pkg.objects.filter((item) => item.object_id === 'obj_mid_round_image')).toEqual([image])
    expect(pkg.review_items).toEqual([expect.objectContaining({
      artifact_object_id: 'obj_mid_round_image',
      assertion_level: 'observation',
      resolution_status: 'unresolved',
    })])
  })

  it('keeps OCR text as positioned, non-semantic observations', () => {
    expect(observationsFromOcrItems([{ text: '底层', score: 0.82, poly: [{ x: 20, y: 30 }, { x: 90, y: 30 }, { x: 90, y: 55 }, { x: 20, y: 55 }] }])).toEqual([
      expect.objectContaining({ text: '底层', confidence: 0.82, assertion_level: 'observation', bounding_box: { x: 20, y: 30, width: 70, height: 25 } }),
    ])
  })

  it('keeps raw OCR candidates review-only until cross-modal validation exists', () => {
    const observations = observationsFromOcrItems([
      { text: '修改', score: 0.842, poly: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      { text: '术', score: 0.517, poly: [[20, 0], [30, 0], [30, 10], [20, 10]] },
    ])
    expect(observations).toHaveLength(2)
    expect(OCR_MODEL_CONTEXT_POLICY).toBe('review_only')
  })
})
