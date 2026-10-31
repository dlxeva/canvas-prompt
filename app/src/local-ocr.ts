/**
 * Local browser OCR observation contract.
 *
 * OCR output is deliberately emitted as observations: it is never allowed to
 * replace the spoken transcript or to assert the meaning of a drawing.
 */
export interface LocalOcrObservation {
  observation_id: string
  text: string
  confidence: number
  polygon: Array<{ x: number; y: number }>
  bounding_box: { x: number; y: number; width: number; height: number }
  source: 'paddleocr-js'
  model: 'PP-OCRv5'
  assertion_level: 'observation'
}

/**
 * OCR candidates remain in the raw export for human inspection. The current
 * freehand evaluation found confident-looking false positives, so no OCR
 * candidate is automatically sent to model context until cross-modal
 * validation has been earned.
 */
export const OCR_MODEL_CONTEXT_POLICY = 'review_only' as const

export type LocalOcrItem = {
  poly: Array<[number, number] | { x: number; y: number }>
  text: string
  score: number
}

export function observationsFromOcrItems(items: LocalOcrItem[]): LocalOcrObservation[] {
  return items
    .filter((item) => item.text.trim() && Number.isFinite(item.score))
    .map((item, index) => {
      const polygon = item.poly.map((point) => ({
        x: Math.round(Array.isArray(point) ? point[0] : point.x),
        y: Math.round(Array.isArray(point) ? point[1] : point.y),
      }))
      const xs = polygon.map((point) => point.x)
      const ys = polygon.map((point) => point.y)
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      return {
        observation_id: `ocr_${String(index + 1).padStart(3, '0')}`,
        text: item.text.trim(),
        confidence: Math.round(item.score * 1000) / 1000,
        polygon,
        bounding_box: { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top },
        source: 'paddleocr-js',
        model: 'PP-OCRv5',
        assertion_level: 'observation',
      }
    })
}
