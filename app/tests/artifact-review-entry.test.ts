import { describe, expect, it } from 'vitest'
import { isArtifactReviewFile } from '../src/artifact-review-entry'

describe('unified Canvas Prompt file entry', () => {
  it('routes PDF and PPTX files to page-aware interaction review', () => {
    expect(isArtifactReviewFile({ name: 'review.pdf', type: 'application/pdf' })).toBe(true)
    expect(isArtifactReviewFile({ name: 'slides.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })).toBe(true)
    expect(isArtifactReviewFile({ name: 'MIMELESS.PDF', type: '' })).toBe(true)
  })

  it('keeps images on the existing canvas', () => {
    expect(isArtifactReviewFile({ name: 'direction.png', type: 'image/png' })).toBe(false)
    expect(isArtifactReviewFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false)
  })
})
