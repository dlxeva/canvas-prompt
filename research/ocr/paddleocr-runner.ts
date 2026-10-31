import { PaddleOCR } from '@paddleocr/paddleocr-js'
import { observationsFromOcrItems, type LocalOcrItem, type LocalOcrObservation } from '../../app/src/local-ocr'

type LocalOcrResult = {
  items: LocalOcrItem[]
  metrics: { detMs: number; recMs: number; totalMs: number; detectedBoxes: number; recognizedCount: number }
}

type LocalOcrRunner = {
  predict(input: Blob): Promise<LocalOcrResult[]>
}

let registeredRunner: LocalOcrRunner | null = null

export class LocalOcrUnavailableError extends Error {
  constructor() {
    super('The optional OCR experiment has not registered an OCR runner.')
    this.name = 'LocalOcrUnavailableError'
  }
}

/** Opt-in only: the runner registry stays inside the research package. */
export function setLocalOcrRunner(runner: LocalOcrRunner | null): void {
  registeredRunner = runner
}

export function hasLocalOcrRunner(): boolean {
  return registeredRunner !== null
}

export async function createPaddleOcrRunner(): Promise<LocalOcrRunner> {
  return PaddleOCR.create({
    lang: 'ch',
    ocrVersion: 'PP-OCRv5',
    ortOptions: { backend: 'wasm', numThreads: 1, simd: true },
  }) as unknown as LocalOcrRunner
}

export async function registerPaddleOcrRunner(): Promise<void> {
  setLocalOcrRunner(await createPaddleOcrRunner())
}

export async function recognizeCanvasText(image: Blob, runnerOverride?: LocalOcrRunner): Promise<{ observations: LocalOcrObservation[]; elapsed_ms: number }> {
  const runner = runnerOverride ?? registeredRunner
  if (!runner) throw new LocalOcrUnavailableError()
  const [result] = await runner.predict(image)
  return { observations: observationsFromOcrItems(result?.items ?? []), elapsed_ms: result?.metrics.totalMs ?? 0 }
}
