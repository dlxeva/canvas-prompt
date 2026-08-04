import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Artifact Review selected tool styling', () => {
  it('keeps the selected tool color stable while the pointer hovers it', () => {
    const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    expect(styles).toContain('.artifact-review-tools button.active:hover:not(:disabled)')
  })

  it('keeps the zoomed review stage pannable without exposing native scrollbars', () => {
    const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    expect(styles).toContain('.artifact-review-stage-scroll { width: 100%; min-height: 0; min-width: 0; height: 100%; flex: 1 1 auto; overflow: auto;')
    expect(styles).toContain('scrollbar-width: none;')
    expect(styles).toContain('.artifact-review-stage-scroll::-webkit-scrollbar { width: 0; height: 0; }')
  })

  it('lets the stage occupy the remaining viewport below the toolbar', () => {
    const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    expect(styles).toContain('.artifact-review-content { display: flex;')
    expect(styles).toContain('.artifact-review-shell { display: flex; height: 100dvh;')
    expect(styles).toContain('.artifact-review-stage-shell { position: relative; display: flex;')
    expect(styles).toContain('.artifact-review-stage-shell.artifact-review-stage-compact { flex: 0 0 auto; }')
  })

  it('anchors page-edge navigation to the visible page geometry', () => {
    const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    const source = readFileSync(new URL('../src/PdfReviewSpike.tsx', import.meta.url), 'utf8')
    expect(styles).toContain('top: var(--artifact-review-page-center-y, 50%)')
    expect(styles).toContain('left: var(--artifact-review-page-previous-left, 12px)')
    expect(styles).toContain('right: var(--artifact-review-page-next-right, 12px)')
    expect(source).toContain('getBoundingClientRect()')
    expect(source).toContain('pageVisibleBottom > pageVisibleTop')
  })
})
