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

  it('never delivers to a Codex thread when delivery_mode is workbuddy or local', async () => {
    const source = await readFile(viteConfigPath, 'utf8')

    // The startHandoff must short-circuit for any non-codex host, recording
    // host: deliveryMode and status: 'archived' without attempting Codex
    // thread injection. This guards against host-switch contamination: a
    // WorkBuddy round must never post to an old Codex conversation thread.
    expect(source).toContain("if (deliveryMode !== 'codex')")
    expect(source).toContain("host: deliveryMode")
    expect(source).toContain("status: 'archived'")
  })

  it('archives high-frequency replay as bounded local checkpoint segments before sending the compact package', async () => {
    const appSource = await readFile(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8')
    const viteSource = await readFile(viteConfigPath, 'utf8')

    expect(appSource).toContain('splitRawTraceSegments(trace.current)')
    expect(appSource).toContain('/api/round-trace-segment/${packageToExport.meta.package_id}/')
    expect(appSource).toContain("source: { canvas: 'excalidraw', audio:")
    expect(viteSource).toContain("server.middlewares.use('/api/round-trace-segment/'")
    expect(viteSource).toContain("'raw-trace.ndjson.gz or raw-trace-segments/ when available'")
    expect(appSource).toContain('usesPackageSegments')
    expect(viteSource).toContain("server.middlewares.use('/api/prompt-package-segment/'")
    expect(viteSource).toContain('MAX_SEGMENTED_PACKAGE_BYTES')
    expect(viteSource).toContain("'session-manifest.json'")
    expect(viteSource).toContain("continuity: 'single_continuous_session'")
  })
})
