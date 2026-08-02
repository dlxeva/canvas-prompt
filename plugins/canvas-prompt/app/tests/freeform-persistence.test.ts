import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ViteDevServer } from 'vite'
import { describe, expect, it } from 'vitest'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

async function withFreeformPersistence(run: (baseUrl: string, projectDir: string) => Promise<void>) {
  const projectDir = await mkdtemp(join(tmpdir(), 'freeform-persistence-test-'))
  const previousProjectDir = process.env.CANVAS_PROMPT_PROJECT_DIR
  process.env.CANVAS_PROMPT_PROJECT_DIR = projectDir
  const routes: Array<{ prefix: string; handler: Handler }> = []
  const fakeServer = {
    middlewares: {
      use(prefix: string, handler: Handler) { routes.push({ prefix, handler }) },
    },
  } as unknown as Pick<ViteDevServer, 'middlewares'>

  try {
    const { default: config } = await import('../vite.config')
    const plugin = (config.plugins as Array<unknown>).find((candidate) => typeof candidate === 'object' && candidate !== null && 'name' in candidate && candidate.name === 'canvas-prompt-persistence') as { configureServer?: (server: Pick<ViteDevServer, 'middlewares'>) => void } | undefined
    if (!plugin?.configureServer) throw new Error('Canvas Prompt persistence plugin was not found')
    plugin.configureServer(fakeServer)

    const server = createServer((req, res) => {
      const url = req.url ?? '/'
      const route = routes.find(({ prefix }) => url === prefix || url.startsWith(`${prefix}?`) || url.startsWith(`${prefix}/`) || (prefix.endsWith('/') && url.startsWith(prefix)))
      if (!route) { res.statusCode = 404; res.end('Not Found'); return }
      req.url = url.slice(route.prefix.length) || '/'
      Promise.resolve(route.handler(req, res)).catch((error) => {
        if (!res.headersSent) res.statusCode = 500
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      await run(`http://127.0.0.1:${port}`, projectDir)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  } finally {
    if (previousProjectDir === undefined) delete process.env.CANVAS_PROMPT_PROJECT_DIR
    else process.env.CANVAS_PROMPT_PROJECT_DIR = previousProjectDir
    await rm(projectDir, { recursive: true, force: true })
  }
}

describe('Freeform persistence routes', () => {
  it('stages audio, promotes compiled paths, reuses identical packages, and tombstones late writes', async () => {
    await withFreeformPersistence(async (baseUrl, projectDir) => {
      const packageId = 'pp_freeform_persistence_001'
      const packageBody = JSON.stringify({ meta: { package_id: packageId, duration_ms: 1000 } })

      const audio = await fetch(`${baseUrl}/api/round-audio/${packageId}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: 'audio-bytes',
      })
      expect(audio.status).toBe(200)

      const stagedRounds = await fetch(`${baseUrl}/api/rounds`)
      expect(await stagedRounds.json()).toMatchObject({ rounds: [{ package_id: packageId, status: 'compile_retryable', has_audio: true }] })

      const posted = await fetch(`${baseUrl}/api/prompt-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: packageBody,
      })
      expect(posted.status).toBe(200)
      const postedBody = await posted.json() as { engine?: { process_ir_path?: string; compact_package_path?: string } }
      expect(postedBody.engine?.process_ir_path).toContain(`/rounds/${packageId}/engine/`)
      expect(postedBody.engine?.compact_package_path).toContain(`/rounds/${packageId}/engine/`)

      const roundDir = join(projectDir, '.canvas-prompt', 'rounds', packageId)
      expect(JSON.parse(await readFile(join(roundDir, 'archive.json'), 'utf8'))).toMatchObject({ schema_version: 2 })
      expect(JSON.parse(await readFile(join(roundDir, 'round.json'), 'utf8')).engine.process_ir_path).toBe(postedBody.engine?.process_ir_path)

      const reused = await fetch(`${baseUrl}/api/prompt-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: packageBody,
      })
      expect(reused.status).toBe(200)
      expect(await reused.json()).toMatchObject({ ok: true, reused: true })

      const conflict = await fetch(`${baseUrl}/api/prompt-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meta: { package_id: packageId, duration_ms: 2000 } }),
      })
      expect(conflict.status).toBe(409)

      const deleted = await fetch(`${baseUrl}/api/rounds/${packageId}`, { method: 'DELETE' })
      expect(deleted.status).toBe(200)
      expect(await readFile(join(projectDir, '.canvas-prompt', 'round-tombstones', `${packageId}.json`), 'utf8')).toContain(packageId)

      const latePackage = await fetch(`${baseUrl}/api/prompt-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: packageBody,
      })
      expect(latePackage.status).toBe(410)

      const lateAudio = await fetch(`${baseUrl}/api/round-audio/${packageId}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: 'late-audio',
      })
      expect(lateAudio.status).toBe(410)
    })
  })
})
