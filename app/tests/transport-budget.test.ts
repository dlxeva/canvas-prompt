import { describe, expect, it } from 'vitest'
import { measureTransportBudget, transportBudgetError, TRANSPORT_LIMIT_BYTES, TRANSPORT_SEGMENT_BYTES } from '../src/transport-budget'

describe('transport budget', () => {
  it('measures compact wire JSON and identifies its largest fields', () => {
    const budget = measureTransportBudget({ small: 'x', timeline: Array.from({ length: 1000 }, () => ({ event: 'move' })) })
    expect(budget.total_bytes).toBeGreaterThan(0)
    expect(budget.fields[0].field).toBe('timeline')
  })

  it('turns a package above the single-request guard into a segmented archive', () => {
    const budget = measureTransportBudget({ transformations: 'x'.repeat(TRANSPORT_LIMIT_BYTES) })
    expect(transportBudgetError(budget)).toContain('自动分段归档')
    expect(TRANSPORT_SEGMENT_BYTES).toBeLessThan(TRANSPORT_LIMIT_BYTES)
  })
})
