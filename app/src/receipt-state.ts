export type ExportReceiptStatus = 'idle' | 'exporting' | 'archived' | 'accepted' | 'delivered' | 'failed'

export type HandoffReceipt = {
  attempted?: boolean
  accepted?: boolean
  delivered?: boolean
  status?: 'archived' | 'accepted' | 'delivered' | 'accepted_timeout' | 'accepted_observer_lost' | 'completed_failed' | 'completed_cancelled' | 'accepted_failed' | 'failed' | 'timed_out'
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
  // The whiteboard promises delivery into the current conversation, not a
  // successful downstream model response. Once turn/start accepted a round,
  // later completion failures remain diagnosable in handoff.json but must not
  // retroactively tell the user that their round was not sent.
  if (handoff?.accepted || handoff?.status === 'accepted' || handoff?.status === 'accepted_timeout' || handoff?.status === 'accepted_observer_lost' || handoff?.status === 'completed_failed' || handoff?.status === 'completed_cancelled' || handoff?.status === 'accepted_failed') return 'accepted'
  if (handoff?.status === 'failed' || handoff?.status === 'timed_out') return 'failed'
  if (handoff?.attempted) return 'failed'
  return 'archived'
}

export function isReceiptComplete(status: ExportReceiptStatus) {
  return status === 'archived' || status === 'accepted' || status === 'delivered' || status === 'failed'
}
