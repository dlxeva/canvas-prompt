import { describe, expect, it } from 'vitest'
import { countIncludedBaselineObjects, projectLiveRoundElementIds } from '../src/baseline-projection'

describe('baseline projection', () => {
  it('does not count a baseline image after it is deleted during the round', () => {
    const baselineIds = new Set(['image_base', 'text_base'])
    const projected = projectLiveRoundElementIds([
      { id: 'image_base', isDeleted: true },
      { id: 'new_mark', isDeleted: false },
    ], [
      { kind: 'delete', element: { id: 'image_base' } },
      { kind: 'create', element: { id: 'new_mark' } },
    ], new Set(['image_base']))
    expect([...projected]).toEqual(['new_mark'])
    expect(countIncludedBaselineObjects(baselineIds, projected)).toBe(0)
  })

  it('includes only live baseline images and baseline objects actively transformed in this round', () => {
    const projected = projectLiveRoundElementIds([
      { id: 'image_base', isDeleted: false },
      { id: 'text_base', isDeleted: false },
      { id: 'deleted_mark', isDeleted: true },
    ], [
      { kind: 'update', element: { id: 'text_base' } },
      { kind: 'create', element: { id: 'deleted_mark' } },
      { kind: 'delete', element: { id: 'deleted_mark' } },
    ], new Set(['image_base']))
    expect([...projected].sort()).toEqual(['image_base', 'text_base'])
    expect(countIncludedBaselineObjects(new Set(['image_base', 'text_base']), projected)).toBe(2)
  })
})
