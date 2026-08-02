import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Artifact Review two-phase user flow', () => {
  const source = readFileSync(new URL('../src/PdfReviewSpike.tsx', import.meta.url), 'utf8')

  it('does not expose low-level evidence binding confirmation in the review player', () => {
    expect(source).not.toContain('候选确认')
    expect(source).not.toContain('deriveConfirmationCandidates')
    expect(source).not.toContain('confirmationLedger')
  })

  it('hands off the complete review immediately after transcription', () => {
    expect(source).toContain('await handoffProcessPackage(completedVoiceSegments)')
    expect(source).toContain('AI 会先复述理解；你确认修改方案后才会执行。')
    expect(source).toContain("export: '导出审阅记录'")
  })
})
