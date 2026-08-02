import type { ArtifactReviewPageVisit } from './artifact-review-package'

export function restoredReviewPage(pageVisits: ArtifactReviewPageVisit[], pageCount: number) {
  if (!Number.isInteger(pageCount) || pageCount < 1) return 1
  const latest = pageVisits.at(-1)?.pageNumber
  return Number.isInteger(latest) && Number(latest) >= 1 && Number(latest) <= pageCount ? Number(latest) : 1
}

export function reviewPageNavigationState(pageNumber: number, pageCount: number, rendering = false) {
  const hasValidDocument = Number.isInteger(pageCount) && pageCount > 0
  const currentPage = hasValidDocument && Number.isInteger(pageNumber)
    ? Math.max(1, Math.min(pageCount, pageNumber))
    : 1
  return {
    previousDisabled: rendering || !hasValidDocument || currentPage <= 1,
    nextDisabled: rendering || !hasValidDocument || currentPage >= pageCount,
  }
}

export function reviewPageShortcutDelta(event: {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
}) {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return 0
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') return -1
  if (event.key === 'ArrowRight' || event.key === 'PageDown') return 1
  return 0
}

export function isEditableReviewShortcutTarget(target: EventTarget | null) {
  if (!target || typeof target !== 'object') return false
  const element = target as { tagName?: unknown; isContentEditable?: unknown; closest?: (selector: string) => unknown }
  const tagName = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : ''
  return tagName === 'input'
    || tagName === 'textarea'
    || tagName === 'select'
    || element.isContentEditable === true
    || (typeof element.closest === 'function' && Boolean(element.closest('[contenteditable="true"]')))
}
