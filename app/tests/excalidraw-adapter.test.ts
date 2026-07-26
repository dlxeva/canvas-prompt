import { describe, expect, it } from 'vitest'
import { countCanvasElements, diffScene } from '../src/excalidraw-adapter'

const line = (overrides: Partial<{ version: number; x: number; y: number; isDeleted: boolean }> = {}) => ({
  id: 'line_1', type: 'line', version: 1, updated: 1, isDeleted: false,
  x: 20, y: 30, width: 180, height: 0, points: [[0, 0], [180, 0]], ...overrides,
})

describe('Excalidraw adapter', () => {
  it('records a hand-drawn straight line as a geometric create event', () => {
    const result = diffScene(new Map(), [line()], 125)
    expect(result.events).toEqual([expect.objectContaining({
      at_ms: 125,
      kind: 'create',
      element: expect.objectContaining({ type: 'line', point_count: 2, width: 180, height: 0 }),
    })])
  })

  it('preserves deliberate color and thickness as direct style evidence', () => {
    const styled = { ...line(), strokeColor: '#2563eb', strokeWidth: 4 }
    const result = diffScene(new Map(), [styled], 240)
    expect(result.events[0]?.element).toMatchObject({
      type: 'line',
      stroke_color: '#2563eb',
      stroke_width: 4,
    })
  })

  it('records a move as update and a deletion exactly once', () => {
    const first = diffScene(new Map(), [line()], 0)
    const moved = diffScene(first.next, [line({ version: 2, x: 90, y: 54 })], 550)
    const deleted = diffScene(moved.next, [line({ version: 3, isDeleted: true })], 900)
    const stableDeleted = diffScene(deleted.next, [line({ version: 3, isDeleted: true })], 980)
    expect(moved.events).toEqual([expect.objectContaining({ kind: 'update', element: expect.objectContaining({ x: 90, y: 54 }) })])
    expect(deleted.events).toEqual([expect.objectContaining({ kind: 'delete', element: expect.objectContaining({ type: 'line' }) })])
    expect(stableDeleted.events).toEqual([])
  })

  it('preserves native Chinese and English text without OCR inference', () => {
    const result = diffScene(new Map(), [{
      ...line(), id: 'text_1', type: 'text', text: '中文 wrapped', originalText: '中文 English', points: undefined,
    }], 300)
    expect(result.events[0]?.element).toMatchObject({
      type: 'text',
      text: '中文 wrapped',
      original_text: '中文 English',
      semantic_content: '中文 English',
    })
  })

  it('counts hand-drawn, connecting, shape, and image inputs independently', () => {
    expect(countCanvasElements([
      line(),
      { ...line({ version: 1 }), id: 'draw_1', type: 'freedraw', points: [[0, 0], [2, 2], [4, 5]] },
      { ...line({ version: 1 }), id: 'arrow_1', type: 'arrow' },
      { ...line({ version: 1 }), id: 'circle_1', type: 'ellipse' },
      { ...line({ version: 1 }), id: 'image_1', type: 'image', fileId: 'file_1', points: undefined },
    ])).toEqual({ total: 5, freedraw: 1, lines: 1, arrows: 1, shapes: 1, images: 1 })
  })
})
