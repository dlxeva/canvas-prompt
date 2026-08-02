import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Artifact Review selected tool styling', () => {
  it('keeps the selected tool color stable while the pointer hovers it', () => {
    const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    expect(styles).toContain('.artifact-review-tools button.active:hover:not(:disabled)')
  })

  it('keeps the zoomed review stage pannable without exposing native scrollbars', () => {
    const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    expect(styles).toContain('.artifact-review-stage-scroll { min-height: 420px; overflow: auto;')
    expect(styles).toContain('scrollbar-width: none;')
    expect(styles).toContain('.artifact-review-stage-scroll::-webkit-scrollbar { width: 0; height: 0; }')
  })
})
