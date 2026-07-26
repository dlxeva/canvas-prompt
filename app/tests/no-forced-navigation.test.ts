import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appPath = fileURLToPath(new URL('../src/App.tsx', import.meta.url))

describe('accepted handoff UI', () => {
  it('keeps the canvas browser in place after the main conversation accepts a round', async () => {
    const source = await readFile(appPath, 'utf8')
    expect(source).not.toContain('codex://threads/')
    expect(source).not.toContain('window.location.href')
  })
})
