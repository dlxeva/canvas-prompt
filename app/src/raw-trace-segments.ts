export const RAW_TRACE_SEGMENT_BYTES = 4 * 1024 * 1024

/**
 * Split only at event boundaries, so every stored segment remains readable
 * NDJSON/JSON on its own. The final Prompt Package never needs to carry this
 * high-frequency replay stream over the 32MB package endpoint.
 */
export function splitRawTraceSegments<T>(events: readonly T[], maxBytes = RAW_TRACE_SEGMENT_BYTES): T[][] {
  const encoder = new TextEncoder()
  const segments: T[][] = []
  let current: T[] = []
  let currentBytes = 2 // JSON array brackets
  for (const event of events) {
    const eventBytes = encoder.encode(JSON.stringify(event)).byteLength + (current.length ? 1 : 0)
    if (current.length > 0 && currentBytes + eventBytes > maxBytes) {
      segments.push(current)
      current = []
      currentBytes = 2
    }
    current.push(event)
    currentBytes += encoder.encode(JSON.stringify(event)).byteLength + (current.length > 1 ? 1 : 0)
  }
  if (current.length > 0) segments.push(current)
  return segments
}
