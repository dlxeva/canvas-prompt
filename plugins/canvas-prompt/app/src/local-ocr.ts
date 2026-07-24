/**
 * Local browser OCR adapter.
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

type OcrRunner = {
  predict(input: Blob): Promise<Array<{
    items: Array<{ poly: Array<[number, number]>; text: string; score: number }>
    metrics: { detMs: number; recMs: number; totalMs: number; detectedBoxes: number; recognizedCount: number }
  }>>
}

let runnerPromise: Promise<OcrRunner> | null = null

async function getRunner(): Promise<OcrRunner> {
  if (!runnerPromise) {
    runnerPromise = (async () => {
      const { PaddleOCR } = await import('@paddleocr/paddleocr-js')
      // Keep the first demo implementation conservative: a single-threaded
      // WASM runtime needs no COOP/COEP configuration and does not interfere
      // with drawing while a user is actively making marks.
      return PaddleOCR.create({
        lang: 'ch',
        ocrVersion: 'PP-OCRv5',
        ortOptions: { backend: 'wasm', numThreads: 1, simd: true },
      }) as unknown as Promise<OcrRunner>
    })()
  }
  return runnerPromise
}

export function observationsFromOcrItems(items: Array<{ poly: Array<[number, number] | { x: number; y: number }>; text: string; score: number }>): LocalOcrObservation[] {
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

export async function recognizeCanvasText(image: Blob): Promise<{ observations: LocalOcrObservation[]; elapsed_ms: number }> {
  const runner = await getRunner()
  const [result] = await runner.predict(image)
  return { observations: observationsFromOcrItems(result?.items ?? []), elapsed_ms: result?.metrics.totalMs ?? 0 }
}

