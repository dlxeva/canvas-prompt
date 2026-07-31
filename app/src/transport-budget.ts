export const TRANSPORT_WARN_BYTES = 24 * 1024 * 1024
export const TRANSPORT_LIMIT_BYTES = 32 * 1024 * 1024
export const TRANSPORT_SEGMENT_BYTES = 4 * 1024 * 1024

export type TransportBudget = {
  total_bytes: number
  fields: Array<{ field: string, bytes: number }>
}

/** Measure the compact JSON body that will actually be sent to the local host. */
export function measureTransportBudget(payload: Record<string, unknown>): TransportBudget {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength
  return {
    total_bytes: bytes(payload),
    fields: Object.entries(payload)
      .map(([field, value]) => ({ field, bytes: bytes(value) }))
      .sort((a, b) => b.bytes - a.bytes),
  }
}

export function transportBudgetError(budget: TransportBudget): string | null {
  if (budget.total_bytes <= TRANSPORT_WARN_BYTES) return null
  const top = budget.fields.slice(0, 3).map(({ field, bytes }) => `${field} ${(bytes / 1024 / 1024).toFixed(1)}MB`).join('、')
  if (budget.total_bytes > TRANSPORT_LIMIT_BYTES) return `本轮上下文预计 ${(budget.total_bytes / 1024 / 1024).toFixed(1)}MB，将自动分段归档（主要字段：${top}）。`
  return `本轮画布包预计 ${(budget.total_bytes / 1024 / 1024).toFixed(1)}MB，接近 32MB 限制（主要字段：${top}）。`
}
