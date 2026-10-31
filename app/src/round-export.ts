import type { PromptPackage, EditableSourceImage } from './prompt-package-compiler'
import type { RecordingResult } from './voice-recorder'
import type { TraceEvent } from './excalidraw-adapter'
import type { HandoffReceipt } from './receipt-state'
import { protectedLocalApiFetch } from './protected-local-api'
import { splitRawTraceSegments } from './raw-trace-segments'
import { TRANSPORT_SEGMENT_BYTES } from './transport-budget'
import { roundRequestSha256 } from './round-request-identity'

export type EditableSourceUpload = { metadata: EditableSourceImage; blob: Blob }
export type RoundExportResult = { ok: boolean; error?: string; roundPath?: string; engine?: { error?: string }; handoff?: HandoffReceipt; reused?: boolean }
export type RoundExportInput = {
  packageToExport: PromptPackage
  recordingToArchive?: RecordingResult | null
  rawTrace: readonly TraceEvent[]
  editableSourceImages?: EditableSourceUpload[]
  retryHandoff?: boolean
}
type ApiFetch = (input: string, init: RequestInit) => Promise<Response>

/** One service instance coalesces repeated clicks, retaining one fixed payload per request. */
export function createRoundExporter(apiFetch: ApiFetch = protectedLocalApiFetch) {
  const active = new Map<string, Promise<RoundExportResult>>()
  return async (input: RoundExportInput): Promise<RoundExportResult> => {
    const { packageToExport, recordingToArchive = null, retryHandoff = false } = input
    const rawTrace = structuredClone([...input.rawTrace])
    const sourceImages = (input.editableSourceImages ?? []).map((source) => ({ metadata: { ...source.metadata }, blob: source.blob }))
    const payload = JSON.parse(JSON.stringify({
      ...packageToExport,
      source: { canvas: 'excalidraw', audio: recordingToArchive ? { mime_type: recordingToArchive.blob.type, duration_ms: recordingToArchive.duration } : null },
    }))
    const sha = await roundRequestSha256(payload)
    const packageId = payload.meta.package_id
    const key = `${packageId}:${sha}:${retryHandoff}`
    const prior = active.get(key)
    if (prior) return prior

    const post = async (body: unknown) => {
      const response = await apiFetch('/api/prompt-package', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(retryHandoff ? { 'x-canvas-prompt-retry-handoff': '1' } : {}) },
        body: JSON.stringify(body),
      })
      const result = await response.json().catch(() => null) as RoundExportResult | null
      if (!response.ok || !result?.ok) throw new Error(result?.error || result?.engine?.error || `本轮上下文未能归档（${response.status}）`)
      return result
    }
    const recover = async (): Promise<RoundExportResult | null> => {
      const response = await apiFetch(`/api/round-receipt/${packageId}`, { method: 'POST', cache: 'no-store' })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`无法核对本轮归档状态（${response.status}）`)
      const receipt = await response.json() as { committed?: boolean; request_sha256?: string }
      if (!receipt.committed) return null
      if (receipt.request_sha256 !== sha) throw new Error('同一轮的内容已变化。请开始新一轮后重新发送。')
      return post({ resume_round: true, package_id: packageId, request_sha256: sha })
    }
    const upload = async (url: string, body: BodyInit, type: string) => {
      const response = await apiFetch(url, { method: 'POST', headers: { 'content-type': type }, body })
      if (!response.ok) throw new Error(`本轮素材未能保存（${response.status}）`)
    }
    const work = (async () => {
      const saved = await recover()
      if (saved) return saved
      try {
        for (const source of sourceImages) {
          await upload(`/api/round-source-image/${packageId}/${encodeURIComponent(source.metadata.artifact_object_id)}`, source.blob, source.metadata.mime_type)
        }
        if (recordingToArchive) await upload(`/api/round-audio/${packageId}`, recordingToArchive.blob, recordingToArchive.blob.type || 'audio/webm')
        for (const [index, segment] of splitRawTraceSegments(rawTrace).entries()) {
          await upload(`/api/round-trace-segment/${packageId}/${String(index + 1).padStart(6, '0')}`, JSON.stringify(segment), 'application/json')
        }
        const body = new Blob([JSON.stringify(payload)], { type: 'application/json' })
        const usesPackageSegments = body.size > TRANSPORT_SEGMENT_BYTES
        if (usesPackageSegments) {
          let sequence = 1
          for (let offset = 0; offset < body.size; offset += TRANSPORT_SEGMENT_BYTES) {
            await upload(`/api/prompt-package-segment/${packageId}/${String(sequence++).padStart(6, '0')}`, body.slice(offset, offset + TRANSPORT_SEGMENT_BYTES), 'application/octet-stream')
          }
        }
        return await post(usesPackageSegments ? { segmented_package: true, package_id: packageId } : payload)
      } catch (originalError) {
        // A response can be lost after durable commit. Re-read once, never
        // blindly repeat media writes or implicitly authorize another handoff.
        try { const savedAfterFailure = await recover(); if (savedAfterFailure) return savedAfterFailure } catch { /* keep original failure */ }
        throw originalError
      }
    })()
    active.set(key, work)
    try { return await work } finally { if (active.get(key) === work) active.delete(key) }
  }
}

export const exportCanvasRound = createRoundExporter()
