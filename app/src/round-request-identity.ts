function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

/** Browser request identity excludes only server-owned provenance and local replay. */
export function canonicalRoundRequest(value: unknown): string {
  const payload = JSON.parse(JSON.stringify(value))
  if (payload.meta) delete payload.meta.conversation_binding
  if (payload.source) delete payload.source.trace
  return JSON.stringify(canonical(payload))
}

export async function roundRequestSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRoundRequest(value))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
