export type ExportReceiptStatus = 'idle' | 'exporting' | 'archived' | 'accepted' | 'delivered' | 'failed'

export type HandoffReceipt = {
  attempted?: boolean
  accepted?: boolean
  delivered?: boolean
  status?: 'accepted' | 'delivered' | 'accepted_timeout' | 'accepted_observer_lost' | 'completed_failed' | 'completed_cancelled' | 'accepted_failed' | 'failed' | 'timed_out'
  reason?: string
}

/**
 * A local archive and a Codex delivery are separate facts. Never turn an
 * engine/archive success into a delivery success unless the handoff receipt
 * actually proves it.
 */
export function deriveExportReceiptStatus(handoff: HandoffReceipt | null | undefined): ExportReceiptStatus {
  if (handoff?.delivered || handoff?.status === 'delivered') return 'delivered'
  if (handoff?.status === 'failed' || handoff?.status === 'timed_out' || handoff?.status === 'completed_failed' || handoff?.status === 'completed_cancelled' || handoff?.status === 'accepted_failed') return 'failed'
  if (handoff?.status === 'accepted_timeout' || handoff?.status === 'accepted_observer_lost') return 'accepted'
  if (handoff?.accepted || handoff?.status === 'accepted') return 'accepted'
  if (handoff?.attempted) return 'failed'
  return 'archived'
}

export function isReceiptComplete(status: ExportReceiptStatus) {
  return status === 'archived' || status === 'accepted' || status === 'delivered' || status === 'failed'
}
