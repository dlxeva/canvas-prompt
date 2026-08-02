import { protectedLocalApiFetch } from './protected-local-api'
import type { InteractionReviewPackage } from './interaction-review-contract'

export async function handoffInteractionReviewPackage(packageData: InteractionReviewPackage) {
  const response = await protectedLocalApiFetch('/api/interaction-review-package', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(packageData),
  })
  const result = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null
  if (!response.ok || result?.ok !== true) throw new Error(result?.error || `HTTP ${response.status}`)
  return result
}
