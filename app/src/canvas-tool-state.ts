export type CanvasTool = 'selection' | 'freedraw' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'eraser'

const continuousDrawingTools = new Set<CanvasTool>(['line', 'arrow', 'rectangle', 'ellipse'])

export function canvasToolActivation(tool: CanvasTool): { type: CanvasTool; locked?: boolean } {
  return continuousDrawingTools.has(tool) ? { type: tool, locked: true } : { type: tool }
}
