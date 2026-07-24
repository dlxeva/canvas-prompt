import { describe, expect, it } from 'vitest'
import { compactTraceToCognitiveEvents, buildPointerTrack } from '../src/excalidraw-cognitive-events'
import { compilePromptPackage, validatePromptPackage } from '../src/prompt-package-compiler'
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
  it('compacts a drawn arrow into the established cognitive event contract', () => {
    expect(compactTraceToCognitiveEvents([arrow])).toEqual([expect.objectContaining({
      type: 'arrow', semanticType: 'connect', shapeType: 'arrow',
      data: expect.objectContaining({ toX: 200, toY: 90, strokeWidth: 4 }),
    })])
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

  it('compiles Excalidraw process data into a valid Prompt Package', () => {
    const events = compactTraceToCognitiveEvents([arrow])
    const pkg = compilePromptPackage(events, '这里是一条关系箭头', 'data:image/png;base64,AA==', {
      canvasSize: { width: 1920, height: 1080 }, language: 'zh-CN', tags: ['excalidraw'],
    }, undefined, buildPointerTrack([]))
    expect(validatePromptPackage(pkg).valid).toBe(true)
    expect(pkg.arrows).toHaveLength(1)
    expect(pkg.transcript?.full_text).toBe('这里是一条关系箭头')
  })

  it('compiles a time-adjacent mark on an imported image into a review item', () => {
    const image: CanvasObject = {
      object_id: 'obj_source_image', type: 'image', timestamp_ms: 0,
      bounds: { x: 100, y: 100, width: 800, height: 600 },
      properties: { base_artifact: true, asset_id: 'source_file' },
    }
    const circle = {
      id: 'evt_circle', timestamp: 2_100, type: 'region' as const, semanticType: 'group' as const,
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

