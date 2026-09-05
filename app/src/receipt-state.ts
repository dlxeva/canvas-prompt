export type ExportReceiptStatus = 'idle' | 'exporting' | 'archived' | 'accepted' | 'delivered' | 'failed'

export type HandoffReceipt = {
  attempted?: boolean
  accepted?: boolean
  delivered?: boolean
  /** Keep archived receipts forward/read compatible with older status names. */
  status?: string
  host?: 'codex' | 'local'
  reason?: string
}

const HISTORICAL_ACCEPTED_STATUSES = new Set([
  'accepted_timeout',
  'accepted_observer_lost',
  'completed_failed',
  'completed_cancelled',
  'accepted_failed',
])

/**
 * A local archive and a Codex delivery are separate facts. Never turn an
 * engine/archive success into a delivery success unless the handoff receipt
 * actually proves it.
 */
export function deriveExportReceiptStatus(handoff: HandoffReceipt | null | undefined): ExportReceiptStatus {
  if (handoff?.status === 'archived') return 'archived'
  if (handoff?.delivered || handoff?.status === 'delivered') return 'delivered'
  // The whiteboard promises receipt by the current conversation, not a
  // successful downstream model response. Preserve only known historical
  // receipt names when reading archived rounds; unknown statuses stay failed.
  const historicalStatus = handoff?.status ?? ''
  if (handoff?.accepted || historicalStatus === 'accepted' || HISTORICAL_ACCEPTED_STATUSES.has(historicalStatus)) return 'accepted'
  if (handoff?.status === 'failed' || handoff?.status === 'timed_out') return 'failed'
  if (handoff?.attempted) return 'failed'
  return 'archived'
}

export function isReceiptComplete(status: ExportReceiptStatus) {
  return status === 'archived' || status === 'accepted' || status === 'delivered' || status === 'failed'
}
