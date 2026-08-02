import { protectedLocalApiFetch } from './protected-local-api'
import type { SerializedReviewConfirmationLedger } from './artifact-review-confirmation-ledger'

export type ArtifactReviewHandoffReceipt = {
  ok: boolean
  latestPath: string
  roundPath: string
}

/**
 * Persists a read-only Artifact Review package for the existing Codex handoff
 * flow. This never uploads the source PDF and never sends a chat message.
 */
export async function handoffArtifactReviewPackage(
  payload: unknown,
  confirmationLedger?: SerializedReviewConfirmationLedger,
): Promise<ArtifactReviewHandoffReceipt> {
  const response = await protectedLocalApiFetch('/api/artifact-review-package', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Keep the original bare-package transport for packages that have no
    // confirmations. A ledger is an explicit, separately replayable
    // credential, never a field silently merged into the review package.
    body: JSON.stringify(confirmationLedger === undefined
      ? payload
      : { package: payload, confirmation_ledger: confirmationLedger }),
  })
  const result = await response.json().catch(() => null) as Partial<ArtifactReviewHandoffReceipt> & { error?: string } | null
  if (!response.ok || !result?.ok || typeof result.latestPath !== 'string' || typeof result.roundPath !== 'string') {
    throw new Error(result?.error || `本轮交互审阅未能保存（${response.status}）`)
  }
  return { ok: true, latestPath: result.latestPath, roundPath: result.roundPath }
}
