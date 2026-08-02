import { describe, expect, it } from 'vitest'
import { isEditableReviewShortcutTarget, restoredReviewPage, reviewPageNavigationState, reviewPageShortcutDelta } from '../src/pdf-review-navigation'

describe('Artifact Review page navigation', () => {
  it('restores the latest valid visited page', () => {
    expect(restoredReviewPage([{ pageNumber: 1, atMs: 0 }, { pageNumber: 7, atMs: 500 }], 22)).toBe(7)
    expect(restoredReviewPage([{ pageNumber: 99, atMs: 500 }], 22)).toBe(1)
    expect(restoredReviewPage([], 22)).toBe(1)
  })

  it.each([
    ['ArrowLeft', -1], ['PageUp', -1], ['ArrowRight', 1], ['PageDown', 1], ['Enter', 0],
  ])('maps %s to the expected page delta', (key, expected) => {
    expect(reviewPageShortcutDelta({ key })).toBe(expected)
  })

  it('ignores modified and composing shortcuts', () => {
    expect(reviewPageShortcutDelta({ key: 'ArrowRight', isComposing: true })).toBe(0)
    expect(reviewPageShortcutDelta({ key: 'ArrowRight', metaKey: true })).toBe(0)
    expect(reviewPageShortcutDelta({ key: 'PageDown', shiftKey: true })).toBe(0)
  })

  it('recognizes editable targets', () => {
    expect(isEditableReviewShortcutTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isEditableReviewShortcutTarget({ tagName: 'textarea' } as unknown as EventTarget)).toBe(true)
    expect(isEditableReviewShortcutTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
    expect(isEditableReviewShortcutTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false)
  })

  it('disables only the unavailable page-edge direction', () => {
    expect(reviewPageNavigationState(1, 21)).toEqual({ previousDisabled: true, nextDisabled: false })
    expect(reviewPageNavigationState(10, 21)).toEqual({ previousDisabled: false, nextDisabled: false })
    expect(reviewPageNavigationState(21, 21)).toEqual({ previousDisabled: false, nextDisabled: true })
    expect(reviewPageNavigationState(1, 0)).toEqual({ previousDisabled: true, nextDisabled: true })
    expect(reviewPageNavigationState(10, 21, true)).toEqual({ previousDisabled: true, nextDisabled: true })
  })
})
