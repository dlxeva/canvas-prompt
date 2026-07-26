import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const viteConfigPath = fileURLToPath(new URL('../vite.config.ts', import.meta.url))

describe('Prompt Package persistence handoff contract', () => {
  it('hands the immutable package owned by the archived round to the main thread', async () => {
    const source = await readFile(viteConfigPath, 'utf8')

    // This stays intentionally close to the persistence boundary. The Vite
    // middleware has external compiler/Codex dependencies, while this test
    // guards the exact invariant that prevents round A's handoff from reading
    // the mutable latest pointer after round B has exported.
    expect(source).toContain('submitImmutableRound')
    expect(source).toContain('packagePath: archived.roundPackagePath, roundPath')
    expect(source).not.toContain('packagePath: latestPackagePath, roundPath')
  })

  it('treats handoff.json as the final delivery-status authority for archive reads', async () => {
    const source = await readFile(viteConfigPath, 'utf8')

    expect(source).toContain("readFile(resolve(roundPath, 'handoff.json'), 'utf8')")
    expect(source).toContain("status: handoff?.status ?? raw.status ?? 'unknown'")
    expect(source).toContain("handoff: handoff")
  })
})
