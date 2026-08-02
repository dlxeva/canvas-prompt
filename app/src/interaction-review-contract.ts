type UnknownRecord = Record<string, unknown>

export type InteractionReviewPackage = {
  schema_version: 'interaction-review/0.1-draft'
  package_id: string
  source: { kind: 'local-static-html'; name: string; entry_path: string; sha256: string; source_bytes_in_export: false }
  session: { started_at: string; duration_ms: number; capture_scope: 'explicit-session-only' }
  events: unknown[]
  annotations: unknown[]
  transcript: unknown[]
  privacy: { processing: 'local_only'; sensitive_input_values: 'excluded'; external_network: 'blocked-by-frame-policy'; full_screen_video: false }
  execution_authorized: false
}

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null && !Array.isArray(value)
const finiteNonNegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0

function containsExcludedPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsExcludedPayload)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, nested]) => ['value', 'inputvalue', 'input_value', 'rawvalue', 'text', 'content', 'payload', 'password', 'token', 'cookie', 'secret'].includes(key.toLowerCase()) || containsExcludedPayload(nested))
}

export function isInteractionReviewPackage(value: unknown): value is InteractionReviewPackage {
  if (!isRecord(value)
    || value.schema_version !== 'interaction-review/0.1-draft'
    || typeof value.package_id !== 'string' || !/^irp_[A-Za-z0-9_-]+$/.test(value.package_id)
    || value.execution_authorized !== false
    || !isRecord(value.source)
    || value.source.kind !== 'local-static-html'
    || typeof value.source.name !== 'string' || typeof value.source.entry_path !== 'string'
    || typeof value.source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.source.sha256)
    || value.source.source_bytes_in_export !== false
    || !isRecord(value.session) || typeof value.session.started_at !== 'string' || !Number.isFinite(Date.parse(value.session.started_at))
    || !finiteNonNegative(value.session.duration_ms) || value.session.capture_scope !== 'explicit-session-only'
    || !Array.isArray(value.events) || !Array.isArray(value.annotations) || !Array.isArray(value.transcript)
    || !isRecord(value.privacy) || value.privacy.processing !== 'local_only'
    || value.privacy.sensitive_input_values !== 'excluded' || value.privacy.external_network !== 'blocked-by-frame-policy'
    || value.privacy.full_screen_video !== false) return false

  for (const event of value.events) {
    if (!isRecord(event) || typeof event.id !== 'string' || typeof event.kind !== 'string' || !finiteNonNegative(event.at_ms)
      || typeof event.route !== 'string' || !isRecord(event.viewport) || !finiteNonNegative(event.viewport.width)
      || !finiteNonNegative(event.viewport.height) || !finiteNonNegative(event.viewport.scroll_x) || !finiteNonNegative(event.viewport.scroll_y)
      || !isRecord(event.detail) || containsExcludedPayload(event.detail)) return false
    if (event.target !== null) {
      if (!isRecord(event.target) || typeof event.target.element_id !== 'string' || !event.target.element_id
        || typeof event.target.tag !== 'string' || typeof event.target.label !== 'string' || !isRecord(event.target.rect)) return false
    }
  }
  for (const annotation of value.annotations) {
    if (!isRecord(annotation) || typeof annotation.id !== 'string' || !['ink', 'circle', 'arrow'].includes(String(annotation.kind))
      || !finiteNonNegative(annotation.created_at_ms) || !Array.isArray(annotation.points) || annotation.points.length < 2
      || annotation.points.some((point) => !isRecord(point) || typeof point.x !== 'number' || point.x < 0 || point.x > 1 || typeof point.y !== 'number' || point.y < 0 || point.y > 1)) return false
  }
  for (const segment of value.transcript) {
    if (!isRecord(segment) || typeof segment.segment_id !== 'string' || !finiteNonNegative(segment.start_ms) || !finiteNonNegative(segment.end_ms)
      || Number(segment.end_ms) < Number(segment.start_ms) || typeof segment.text !== 'string' || typeof segment.confidence !== 'number') return false
  }
  return true
}
