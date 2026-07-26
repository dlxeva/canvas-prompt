import { describe, expect, it } from 'vitest'
import { deriveExportReceiptStatus, isReceiptComplete } from '../src/receipt-state'

describe('export receipt truthfulness', () => {
  it.each([
    [undefined, 'archived'],
    [{ attempted: false, delivered: false }, 'archived'],
    [{ attempted: false, status: 'archived', delivered: false, host: 'local' }, 'archived'],
    [{ attempted: true, status: 'failed', accepted: false, delivered: false }, 'failed'],
    [{ attempted: true, status: 'timed_out', accepted: true, delivered: false }, 'failed'],
    [{ attempted: true, status: 'accepted_timeout', accepted: true, delivered: false }, 'accepted'],
    [{ attempted: true, status: 'accepted_observer_lost', accepted: true, delivered: false }, 'accepted'],
    [{ attempted: true, status: 'completed_failed', accepted: true, delivered: false }, 'failed'],
    [{ attempted: true, status: 'completed_cancelled', accepted: true, delivered: false }, 'failed'],
    [{ attempted: true, status: 'accepted_failed', accepted: true, delivered: false }, 'failed'],
    [{ attempted: true, status: 'accepted', accepted: true, delivered: false }, 'accepted'],
    [{ attempted: true, status: 'delivered', accepted: true, delivered: true }, 'delivered'],
  ] as const)('maps %j to %s', (handoff, expected) => {
    expect(deriveExportReceiptStatus(handoff)).toBe(expected)
  })

  it('never treats an accepted receipt as delivered', () => {
    const status = deriveExportReceiptStatus({ attempted: true, accepted: true, delivered: false })
    expect(status).toBe('accepted')
    expect(status).not.toBe('delivered')
  })

  it('recognizes persisted terminal receipt states', () => {
    expect(isReceiptComplete('archived')).toBe(true)
    expect(isReceiptComplete('accepted')).toBe(true)
    expect(isReceiptComplete('delivered')).toBe(true)
    expect(isReceiptComplete('failed')).toBe(true)
    expect(isReceiptComplete('exporting')).toBe(false)
  })
})
