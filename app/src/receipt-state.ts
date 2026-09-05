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

/**
 * A local archive and a Codex delivery are separate facts. Never turn an
 * engine/archive success into a delivery success unless the handoff receipt
 * actually proves it.
 */
export function deriveExportReceiptStatus(handoff: HandoffReceipt | null | undefined): ExportReceiptStatus {
  if (handoff?.status === 'archived') return 'archived'
  if (handoff?.delivered || handoff?.status === 'delivered') return 'delivered'
  // The whiteboard promises receipt by the current conversation, not a
  // successful downstream model response. Preserve the old accepted-prefixed
  // and completed-prefixed receipt names when reading archived rounds.
  const historicalStatus = handoff?.status ?? ''
  if (handoff?.accepted || historicalStatus === 'accepted' || historicalStatus.startsWith('accepted_') || historicalStatus.startsWith('completed_')) return 'accepted'
  if (handoff?.status === 'failed' || handoff?.status === 'timed_out') return 'failed'
  if (handoff?.attempted) return 'failed'
  return 'archived'
}

export function isReceiptComplete(status: ExportReceiptStatus) {
  return status === 'archived' || status === 'accepted' || status === 'delivered' || status === 'failed'
}
