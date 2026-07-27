import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('automatic round handoff flow', () => {
  it('treats ending a completed round as archive-and-send, not a separate save action', async () => {
    const source = await readFile(resolve(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8')
    const finishTrace = source.slice(source.indexOf('const finishTrace'), source.indexOf('const pollHandoffReceipt'))

    expect(finishTrace).toContain('await exportPromptPackage({ packageToExport: pkg, recordingToArchive: audio })')
    expect(source).toContain('recordingToArchive = lastRecording')
    expect(finishTrace).not.toContain('导出后会作为主对话的上下文')
  })
})
