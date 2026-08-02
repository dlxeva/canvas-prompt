import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ViteDevServer } from 'vite'
import { describe, expect, it } from 'vitest'
import { registerArtifactReviewPersistence } from '../artifact-review-persistence'
import type { LocalApiSecurity } from '../local-api-guard'
import { buildArtifactReviewPackage } from '../src/artifact-review-package'
import { serializeReviewConfirmationLedger } from '../src/artifact-review-confirmation-ledger'

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
  evidence: [],
  privacy: { processing: 'local_only', source_bytes_in_export: false, retention: 'session_only' },
  review_state: { interpretation_status: 'clarification_required', execution_authorized: false },
}

function png(width: number, height: number) {
  const bytes = Buffer.alloc(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

const confirmationLedger = serializeReviewConfirmationLedger([{
  candidateId: 'candidate_confirmed',
  pageNumber: 1,
  annotationId: 'ann_confirmed',
  transcriptSegmentIds: ['voice_confirmed'],
  text: '这里要改',
}], [{
  actionId: 'action_confirmed',
  candidateId: 'candidate_confirmed',
  kind: 'confirm',
  atMs: 2_000,
}])

const confirmedPayload = buildArtifactReviewPackage({
  sourceHash,
  pages: [{ pageNumber: 1, width: 595, height: 842, rotationDegrees: 0 }],
  marksByPage: {
    1: [{
      id: 'ann_confirmed',
      kind: 'circle',
      pageNumber: 1,
      createdAtMs: 1_000,
      points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }],
      voiceWindow: { startMs: 1_100, endMs: 1_500, transcriptSegmentIds: ['voice_confirmed'] },
    }],
  },
  voiceSegments: [{ segmentId: 'voice_confirmed', startMs: 1_100, endMs: 1_500, text: '这里要改' }],
  confirmationLedger,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
})

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
      expect(await response.json()).toEqual({ ok: false, error: '还没有已交给 AI 的交互审阅。' })
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
      await expect(readFile(join(projectDir, '.canvas-prompt', 'latest-artifact-review-confirmation-ledger.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

      const latest = await protectedFetch(`${baseUrl}/api/artifact-review-latest`)
      expect(latest.status).toBe(200)
      expect(await latest.json()).toMatchObject({ ok: true, package: cleanPayload, brief: { execution_authorized: false } })
    })
  })

  it('persists and replays an explicit confirmation ledger without authorizing execution', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const posted = await protectedFetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ package: confirmedPayload, confirmation_ledger: confirmationLedger }),
      })
      expect(posted.status).toBe(200)

      const storageDir = join(projectDir, '.canvas-prompt')
      expect(JSON.parse(await readFile(join(storageDir, 'latest-artifact-review-package.json'), 'utf8'))).toEqual(confirmedPayload)
      expect(JSON.parse(await readFile(join(storageDir, 'latest-artifact-review-confirmation-ledger.json'), 'utf8'))).toEqual({
        schema_version: 'artifact-review-latest-ledger/0.1-draft',
        package_id: confirmedPayload.package_id,
        confirmation_ledger: confirmationLedger,
      })
      const roundDir = join(storageDir, 'artifact-review-rounds', confirmedPayload.package_id)
      expect(JSON.parse(await readFile(join(roundDir, 'confirmation-ledger.json'), 'utf8'))).toEqual(confirmationLedger)

      const latest = await protectedFetch(`${baseUrl}/api/artifact-review-latest`)
      expect(latest.status).toBe(200)
      expect(await latest.json()).toMatchObject({
        ok: true,
        package: confirmedPayload,
        brief: {
          execution_authorized: false,
          proposal_items: [{ state: 'user_confirmed_target', annotation_id: 'ann_confirmed' }],
        },
      })
    })
  })

  it('rejects a confirmed package when its confirmation ledger is omitted', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const response = await protectedFetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(confirmedPayload),
      })
      expect(response.status).toBe(400)
      await expect(readFile(join(projectDir, '.canvas-prompt', 'latest-artifact-review-package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('fails closed when the latest confirmation sidecar belongs to another package', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const storageDir = join(projectDir, '.canvas-prompt')
      await mkdir(storageDir, { recursive: true })
      await writeFile(join(storageDir, 'latest-artifact-review-package.json'), JSON.stringify(confirmedPayload), 'utf8')
      await writeFile(join(storageDir, 'latest-artifact-review-confirmation-ledger.json'), JSON.stringify({
        schema_version: 'artifact-review-latest-ledger/0.1-draft',
        package_id: 'arp_wrong_package',
        confirmation_ledger: confirmationLedger,
      }), 'utf8')

      const response = await protectedFetch(`${baseUrl}/api/artifact-review-latest`)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ ok: false, error: '最新交互审阅确认账本与过程包不匹配。' })
    })
  })

  it('removes a stale latest ledger when a later unconfirmed package becomes latest', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const confirmed = await protectedFetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ package: confirmedPayload, confirmation_ledger: confirmationLedger }),
      })
      expect(confirmed.status).toBe(200)

      const unconfirmed = await protectedFetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cleanPayload),
      })
      expect(unconfirmed.status).toBe(200)
      const sidecarPath = join(projectDir, '.canvas-prompt', 'latest-artifact-review-confirmation-ledger.json')
      await expect(readFile(sidecarPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

      const latest = await protectedFetch(`${baseUrl}/api/artifact-review-latest`)
      expect(latest.status).toBe(200)
      expect(await latest.json()).toMatchObject({ ok: true, package: cleanPayload })
    })
  })

  it('archives page-bound visual evidence after the immutable round exists and reuses identical retries', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const packageResponse = await protectedFetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cleanPayload),
      })
      expect(packageResponse.status).toBe(200)
      const request = {
        package_id: cleanPayload.package_id,
        pages: [{ page_id: 'page_1', media_type: 'image/png', data_base64: png(1200, 800).toString('base64') }],
      }
      const first = await protectedFetch(`${baseUrl}/api/artifact-review-visual-evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      })
      expect(first.status).toBe(200)
      const firstResult = await first.json() as { reused: boolean; manifest: { pages: Array<{ render_ref: string; sha256: string }> } }
      expect(firstResult.reused).toBe(false)
      expect(firstResult.manifest.pages[0].render_ref).toMatch(/^vre_[a-f0-9]{36}$/)

      const visualDir = join(projectDir, '.canvas-prompt', 'artifact-review-rounds', cleanPayload.package_id, 'visual-evidence')
      expect(JSON.parse(await readFile(join(visualDir, 'manifest.json'), 'utf8'))).toEqual(firstResult.manifest)
      expect(await readFile(join(visualDir, `${firstResult.manifest.pages[0].render_ref}.png`))).toEqual(png(1200, 800))

      const retry = await protectedFetch(`${baseUrl}/api/artifact-review-visual-evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      })
      expect(retry.status).toBe(200)
      expect(await retry.json()).toMatchObject({ ok: true, reused: true, manifest: firstResult.manifest })
    })
  })

  it('fails closed for missing packages, unknown pages and conflicting retries without leaving staging directories', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const missing = await protectedFetch(`${baseUrl}/api/artifact-review-visual-evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          package_id: 'arp_missing', pages: [{ page_id: 'page_1', media_type: 'image/png', data_base64: png(1, 1).toString('base64') }],
        }),
      })
      expect(missing.status).toBe(404)

      await protectedFetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cleanPayload),
      })
      const unknown = await protectedFetch(`${baseUrl}/api/artifact-review-visual-evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          package_id: cleanPayload.package_id, pages: [{ page_id: 'page_unknown', media_type: 'image/png', data_base64: png(1, 1).toString('base64') }],
        }),
      })
      expect(unknown.status).toBe(400)

      const validRequest = { package_id: cleanPayload.package_id, pages: [{ page_id: 'page_1', media_type: 'image/png', data_base64: png(2, 2).toString('base64') }] }
      expect((await protectedFetch(`${baseUrl}/api/artifact-review-visual-evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validRequest),
      })).status).toBe(200)
      const conflict = await protectedFetch(`${baseUrl}/api/artifact-review-visual-evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          ...validRequest, pages: [{ ...validRequest.pages[0], data_base64: png(3, 3).toString('base64') }],
        }),
      })
      expect(conflict.status).toBe(400)
      expect((await conflict.json()).error).toContain('不能覆盖')

      const roundDir = join(projectDir, '.canvas-prompt', 'artifact-review-rounds', cleanPayload.package_id)
      expect((await readdir(roundDir)).filter((name) => name.startsWith('.visual-evidence.'))).toEqual([])
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

  it('rejects a semantically inconsistent package without creating the latest pointer', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const response = await protectedFetch(`${baseUrl}/api/artifact-review-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...cleanPayload, artifact: { ...cleanPayload.artifact, page_count: 2 } }),
      })
      expect(response.status).toBe(400)
      expect((await response.json()).ok).toBe(false)
      await expect(readFile(join(projectDir, '.canvas-prompt', 'latest-artifact-review-package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('rejects a semantically corrupted latest package on read', async () => {
    await withPersistenceServer(async (baseUrl, projectDir, protectedFetch) => {
      const latestPath = join(projectDir, '.canvas-prompt', 'latest-artifact-review-package.json')
      await mkdir(join(projectDir, '.canvas-prompt'), { recursive: true })
      await writeFile(latestPath, JSON.stringify({
        ...cleanPayload,
        pages: [{ page_id: 'page_1', page_number: 2 }],
      }), 'utf8')

      const response = await protectedFetch(`${baseUrl}/api/artifact-review-latest`)
      expect(response.status).toBe(400)
      expect((await response.json()).ok).toBe(false)
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
      expect(await response.json()).toEqual({ ok: false, error: '交互审阅过程包超过 8MB 限制。' })
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
