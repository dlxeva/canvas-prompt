import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ViteDevServer } from 'vite'
import { describe, expect, it } from 'vitest'
import { registerArtifactReviewPersistence } from '../artifact-review-persistence'
import type { LocalApiSecurity } from '../local-api-guard'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const sourceHash = 'a'.repeat(64)
const cleanPayload = {
  schema_version: 'artifact-review/0.2-draft',
  package_id: 'arp_persistence_001',
  artifact: {
    artifact_id: 'artifact_local_pdf',
    artifact_kind: 'pdf',
    read_only: true,
    source_sha256: sourceHash,
    source_version_id: `sha256:${sourceHash}`,
    page_count: 1,
  },
  pages: [{ page_id: 'page_1', page_number: 1 }],
  annotations: [],
  privacy: { processing: 'local_only', source_bytes_in_export: false },
}

async function withPersistenceServer(run: (baseUrl: string, projectDir: string, protectedFetch: typeof fetch) => Promise<void>) {
  const projectDir = await mkdtemp(join(tmpdir(), 'artifact-review-persistence-test-'))
  const routes: Array<{ prefix: string; handler: Handler }> = []
  const fakeServer = {
    middlewares: {
      use(prefix: string, handler: Handler) { routes.push({ prefix, handler }) },
    },
  } as unknown as Pick<ViteDevServer, 'middlewares'>
  const security: LocalApiSecurity = { expectedHost: '', expectedOrigin: '', token: 't'.repeat(43) }
  registerArtifactReviewPersistence(fakeServer, join(projectDir, '.canvas-prompt'), security)

  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const route = routes.find(({ prefix }) => url === prefix || url.startsWith(`${prefix}?`) || url.startsWith(`${prefix}/`))
    if (!route) { res.statusCode = 404; res.end('Not Found'); return }
    req.url = url.slice(route.prefix.length) || '/'
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.headersSent) res.statusCode = 500
      if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`
  security.expectedHost = `127.0.0.1:${port}`
  security.expectedOrigin = baseUrl
  const protectedFetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('origin', baseUrl)
    headers.set('sec-fetch-site', 'same-origin')
    headers.set('x-canvas-prompt-token', security.token)
    return fetch(input, { ...init, headers })
  }
  try {
    await run(baseUrl, projectDir, protectedFetch)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(projectDir, { recursive: true, force: true })
  }
}

describe('Artifact Review persistence routes', () => {
  it('returns a local 404 before any package has been handed off', async () => {
    await withPersistenceServer(async (baseUrl, _projectDir, protectedFetch) => {
      const response = await protectedFetch(`${baseUrl}/api/artifact-review-latest`)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ ok: false, error: '还没有已交给 AI 的 PDF 批阅。' })
    })
  })

  it('atomically persists a valid package and returns its proposal-only brief', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const posted = await protectedFetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cleanPayload),
      })
      expect(posted.status).toBe(200)
      expect((await posted.json()).ok).toBe(true)

      const latestPath = join(projectDir, '.canvas-prompt', 'latest-artifact-review-package.json')
      expect(JSON.parse(await readFile(latestPath, 'utf8'))).toEqual(cleanPayload)
      const roundDir = join(projectDir, '.canvas-prompt', 'artifact-review-rounds', cleanPayload.package_id)
      expect(JSON.parse(await readFile(join(roundDir, 'artifact-review-package.json'), 'utf8'))).toEqual(cleanPayload)
      expect(JSON.parse(await readFile(join(roundDir, 'review-brief.json'), 'utf8'))).toMatchObject({ execution_authorized: false })
      expect(JSON.parse(await readFile(join(roundDir, 'archive.json'), 'utf8'))).toMatchObject({ source_bytes_in_archive: false })

      const latest = await protectedFetch(`${baseUrl}/api/artifact-review-latest`)
      expect(latest.status).toBe(200)
      expect(await latest.json()).toMatchObject({ ok: true, package: cleanPayload, brief: { execution_authorized: false } })
    })
  })

  it('rejects an invalid package without creating the latest pointer', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const response = await protectedFetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...cleanPayload, privacy: { processing: 'cloud' } }),
      })
      expect(response.status).toBe(400)
      expect((await response.json()).ok).toBe(false)
      await expect(readFile(join(projectDir, '.canvas-prompt', 'latest-artifact-review-package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('returns a stable 413 and drains an oversized request without writing files', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const response = await protectedFetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(8 * 1024 * 1024 + 1),
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ ok: false, error: 'PDF 批阅过程包超过 8MB 限制。' })
      await expect(readFile(join(projectDir, '.canvas-prompt', 'latest-artifact-review-package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('rejects an unprotected package request without writing local files', async () => {
    await withPersistenceServer(async (baseUrl, projectDir) => {
      const response = await fetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cleanPayload),
      })
      expect(response.status).toBe(403)
      await expect(readFile(join(projectDir, '.canvas-prompt', 'latest-artifact-review-package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })
})
