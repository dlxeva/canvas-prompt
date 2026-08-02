import type { ArtifactReviewPageVisit, ArtifactReviewVoiceSegment, PagePoint, ReviewMark, ReviewTool } from './artifact-review-package'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReviewTool(value: unknown): value is ReviewTool {
  return value === 'ink' || value === 'circle' || value === 'arrow'
}

function readPoints(value: unknown): PagePoint[] | null {
  if (!Array.isArray(value)) return null
  const points = value.map((point) => {
    if (!isRecord(point) || typeof point.x_ratio !== 'number' || typeof point.y_ratio !== 'number') return null
    if (point.x_ratio < 0 || point.x_ratio > 1 || point.y_ratio < 0 || point.y_ratio > 1) return null
    return { x: point.x_ratio, y: point.y_ratio }
  })
  return points.every((point): point is PagePoint => point !== null) ? points : null
}

function readVoiceSegments(value: unknown): ArtifactReviewVoiceSegment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('过程包包含无法恢复的语音时间线。')
  return value.map((segment) => {
    if (!isRecord(segment) || typeof segment.segment_id !== 'string' || typeof segment.start_ms !== 'number' || typeof segment.end_ms !== 'number' || typeof segment.text !== 'string') {
      throw new Error('过程包包含无法恢复的语音片段。')
    }
    if (segment.start_ms < 0 || segment.end_ms < segment.start_ms || (segment.confidence !== undefined && (typeof segment.confidence !== 'number' || segment.confidence < 0 || segment.confidence > 1))) {
      throw new Error('过程包包含无效的语音时间。')
    }
    return { segmentId: segment.segment_id, startMs: segment.start_ms, endMs: segment.end_ms, text: segment.text, ...(typeof segment.confidence === 'number' ? { confidence: segment.confidence } : {}) }
  })
}

function readPageVisits(value: unknown): ArtifactReviewPageVisit[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('过程包包含无法恢复的页面时间线。')
  return value.map((visit) => {
    if (!isRecord(visit) || typeof visit.page_number !== 'number' || typeof visit.at_ms !== 'number' || visit.page_number < 1 || visit.at_ms < 0) {
      throw new Error('过程包包含无效的页面时间。')
    }
    return { pageNumber: visit.page_number, atMs: visit.at_ms }
  })
}

export type RestoredReviewDraft = {
  marksByPage: Record<number, ReviewMark[]>
  voiceSegments: ArtifactReviewVoiceSegment[]
  pageVisits: ArtifactReviewPageVisit[]
}

/** The next live event must start after all restored evidence timestamps. */
export function latestDraftTimestamp(draft: RestoredReviewDraft) {
  return Math.max(
    0,
    ...Object.values(draft.marksByPage).flat().map((mark) => mark.createdAtMs),
    ...draft.voiceSegments.map((segment) => segment.endMs),
    ...draft.pageVisits.map((visit) => visit.atMs),
  )
}

/** Rebuilds raw manual marks from an exported package only when it matches the open PDF. */
export function restoreReviewDraftFromExport(sourceHash: string, value: unknown): RestoredReviewDraft {
  if (!isRecord(value) || !isRecord(value.artifact) || value.artifact.source_sha256 !== sourceHash) {
    throw new Error('这个过程包不属于当前打开的 PDF。')
  }
  if (!Array.isArray(value.pages) || !Array.isArray(value.annotations)) {
    throw new Error('过程包缺少页面或批注数据。')
  }

  const pageNumberById = new Map<string, number>()
  for (const page of value.pages) {
    if (!isRecord(page) || typeof page.page_id !== 'string' || typeof page.page_number !== 'number') continue
    pageNumberById.set(page.page_id, page.page_number)
  }

  const voiceSegments = readVoiceSegments(value.voice_segments)
  const voiceSegmentIds = new Set(voiceSegments.map((segment) => segment.segmentId))
  const marksByPage: Record<number, ReviewMark[]> = {}
  for (const annotation of value.annotations) {
    if (!isRecord(annotation) || typeof annotation.annotation_id !== 'string' || !isReviewTool(annotation.kind) || typeof annotation.page_id !== 'string' || typeof annotation.created_at_ms !== 'number') {
      throw new Error('过程包包含无法恢复的批注。')
    }
    const pageNumber = pageNumberById.get(annotation.page_id)
    const points = readPoints(annotation.gesture_points)
    const minimumPoints = annotation.kind === 'ink' ? 2 : 2
    if (!pageNumber || !points || points.length < minimumPoints) throw new Error('过程包包含无效的页码或坐标。')
    const mark: ReviewMark = {
      id: annotation.annotation_id,
      kind: annotation.kind,
      pageNumber,
      points,
      createdAtMs: annotation.created_at_ms,
    }
    if (isRecord(annotation.voice_window) && typeof annotation.voice_window.start_ms === 'number' && typeof annotation.voice_window.end_ms === 'number' && Array.isArray(annotation.voice_window.transcript_segment_ids)) {
      const transcriptSegmentIds = annotation.voice_window.transcript_segment_ids
      if (annotation.voice_window.start_ms < 0 || annotation.voice_window.end_ms < annotation.voice_window.start_ms || !transcriptSegmentIds.every((id) => typeof id === 'string' && voiceSegmentIds.has(id))) {
        throw new Error('过程包包含无法恢复的语音关联。')
      }
      mark.voiceWindow = { startMs: annotation.voice_window.start_ms, endMs: annotation.voice_window.end_ms, transcriptSegmentIds }
    }
    if (annotation.binding_status === 'confirmed' || annotation.binding_status === 'candidate' || annotation.binding_status === 'clarification_required') mark.bindingStatus = annotation.binding_status
    if (annotation.binding_status === 'confirmed') {
      const confirmation = Array.isArray(value.evidence) ? value.evidence.find((item) => isRecord(item) && item.kind === 'clarification_response' && item.annotation_id === annotation.annotation_id) : undefined
      if (isRecord(confirmation) && isRecord(confirmation.time_window_ms) && typeof confirmation.time_window_ms.start_ms === 'number') mark.confirmedAtMs = confirmation.time_window_ms.start_ms
    }
    marksByPage[pageNumber] = [...(marksByPage[pageNumber] ?? []), mark]
  }
  return { marksByPage, voiceSegments, pageVisits: readPageVisits(value.page_visits) }
}

/** Rebuilds raw manual marks for legacy callers. */
export function restoreMarksFromExport(sourceHash: string, value: unknown): Record<number, ReviewMark[]> {
  return restoreReviewDraftFromExport(sourceHash, value).marksByPage
}

export function mergeVoiceSegments(current: ArtifactReviewVoiceSegment[], restored: ArtifactReviewVoiceSegment[]) {
  const existingIds = new Set(current.map((segment) => segment.segmentId))
  return [...current, ...restored.filter((segment) => !existingIds.has(segment.segmentId))].sort((left, right) => left.startMs - right.startMs)
}

export function mergePageVisits(current: ArtifactReviewPageVisit[], restored: ArtifactReviewPageVisit[]) {
  const visits = [...current]
  for (const visit of restored) {
    if (!visits.some((existing) => existing.pageNumber === visit.pageNumber && existing.atMs === visit.atMs)) visits.push(visit)
  }
  return visits.sort((left, right) => left.atMs - right.atMs)
}

export function mergeMarksByPage(current: Record<number, ReviewMark[]>, restored: Record<number, ReviewMark[]>) {
  const merged = { ...current }
  for (const [page, restoredMarks] of Object.entries(restored)) {
    const existing = merged[Number(page)] ?? []
    const existingIds = new Set(existing.map((mark) => mark.id))
    merged[Number(page)] = [...existing, ...restoredMarks.filter((mark) => !existingIds.has(mark.id))]
  }
  return merged
}
