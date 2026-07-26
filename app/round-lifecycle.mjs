import { resolve } from 'node:path'

// Deletion and handoff run in the same long-lived Canvas service process.
// Keep a process-lifetime cancellation registry so an accepted handoff cannot
// recreate, or write into, a round that the user has already deleted.
const cancelledRoundPaths = new Set()

function canonicalRoundPath(roundPath) {
  return resolve(roundPath)
}

export function cancelRoundHandoff(roundPath) {
  cancelledRoundPaths.add(canonicalRoundPath(roundPath))
}

export function clearRoundHandoffCancellation(roundPath) {
  cancelledRoundPaths.delete(canonicalRoundPath(roundPath))
}

export function isRoundHandoffCancelled(roundPath) {
  return cancelledRoundPaths.has(canonicalRoundPath(roundPath))
}
