import { protectedLocalApiFetch } from './protected-local-api'

export type ArtifactReviewHandoffReceipt = {
  ok: boolean
  latestPath: string
  roundPath: string
}

/**
 * Persists a read-only Artifact Review package for the existing Codex handoff
 * flow. This never uploads the source PDF and never sends a chat message.
 */
export async function handoffArtifactReviewPackage(payload: unknown): Promise<ArtifactReviewHandoffReceipt> {
  const response = await protectedLocalApiFetch('/api/artifact-review-package', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const result = await response.json().catch(() => null) as Partial<ArtifactReviewHandoffReceipt> & { error?: string } | null
  if (!response.ok || !result?.ok || typeof result.latestPath !== 'string' || typeof result.roundPath !== 'string') {
    throw new Error(result?.error || `本轮 PDF 批阅未能保存（${response.status}）`)
  }
  return { ok: true, latestPath: result.latestPath, roundPath: result.roundPath }
}
