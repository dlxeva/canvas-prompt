import { describe, expect, it } from 'vitest'
import { canvasToolActivation } from '../src/canvas-tool-state'

describe('canvas tool activation', () => {
  it.each(['line', 'arrow', 'rectangle', 'ellipse'] as const)('keeps %s active for repeated drawing', (tool) => {
    expect(canvasToolActivation(tool)).toEqual({ type: tool, locked: true })
  })

  it.each(['selection', 'freedraw', 'eraser'] as const)('does not lock %s', (tool) => {
    expect(canvasToolActivation(tool)).toEqual({ type: tool })
  })
})
