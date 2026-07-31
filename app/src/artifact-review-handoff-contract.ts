type UnknownRecord = Record<string, unknown>
type ArtifactReviewKind = 'pdf' | 'pptx'
type RenderDerivative = {
  artifact_kind: 'pdf_derivative'
  source_sha256: string
  page_count: number
  renderer: { name: string; version?: string }
}

export type ArtifactReviewHandoffPayload = {
  package_id: string
  schema_version: 'artifact-review/0.2-draft'
  artifact: {
    artifact_kind: ArtifactReviewKind
    read_only: true
    source_sha256: string
    source_version_id: string
    page_count?: number
    render_derivative?: RenderDerivative
  }
  annotations: unknown[]
  privacy: { processing: 'local_only'; source_bytes_in_export: false }
}

const PROHIBITED_EXPORT_KEYS = new Set([
  'sourcelocator', 'sourcepath', 'sourcebytes', 'pdfbytes', 'audiobytes', 'recording',
  'recordingurl', 'media', 'mediaurl', 'audiourl', 'blob', 'bloburl', 'dataurl',
  'absolutepath', 'filepath',
])

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasProhibitedExportField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasProhibitedExportField)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, nested]) => (
    PROHIBITED_EXPORT_KEYS.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase())
    || hasProhibitedExportField(nested)
  ))
}

function hasValidRenderDerivative(artifact: UnknownRecord) {
  const derivative = artifact.render_derivative
  if (derivative === undefined) return true
  if (artifact.artifact_kind !== 'pptx' || !isRecord(derivative)) return false
  const renderer = derivative.renderer
  if (!isRecord(renderer) || typeof renderer.name !== 'string' || renderer.name.trim().length === 0) return false
  if (renderer.version !== undefined && typeof renderer.version !== 'string') return false
  if (
    derivative.artifact_kind !== 'pdf_derivative'
    || typeof derivative.source_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(derivative.source_sha256)
    || !Number.isInteger(derivative.page_count)
    || Number(derivative.page_count) < 1
  ) return false
  return artifact.page_count === undefined || artifact.page_count === derivative.page_count
}

/** Rejects source bytes, media and private source locations at the handoff boundary. */
export function isArtifactReviewHandoffPayload(value: unknown): value is ArtifactReviewHandoffPayload {
  if (!isRecord(value) || hasProhibitedExportField(value)) return false
  const artifact = value.artifact
  const privacy = value.privacy
  return value.schema_version === 'artifact-review/0.2-draft'
    && typeof value.package_id === 'string'
    && /^arp_[A-Za-z0-9_-]+$/.test(value.package_id)
    && Array.isArray(value.annotations)
    && isRecord(artifact)
    && (artifact.artifact_kind === 'pdf' || artifact.artifact_kind === 'pptx')
    && artifact.read_only === true
    && typeof artifact.source_sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(artifact.source_sha256)
    && artifact.source_version_id === `sha256:${artifact.source_sha256}`
    && hasValidRenderDerivative(artifact)
    && isRecord(privacy)
    && privacy.processing === 'local_only'
    && privacy.source_bytes_in_export === false
}
