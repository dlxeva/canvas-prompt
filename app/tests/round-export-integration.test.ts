import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRoundExporter, type RoundExportInput } from '../src/round-export'
import { canonicalRoundRequest, roundRequestSha256 } from '../src/round-request-identity'

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown
const routes: Array<{ path: string; handler: Handler }> = []
const server = createServer((req, res) => {
  const route = routes.find(({ path }) => req.url === path || req.url?.startsWith(path.endsWith('/') ? path : `${path}/`))
  if (!route) { res.statusCode = 404; res.end(); return }
  req.url = `/${req.url!.slice(route.path.length).replace(/^\//, '')}`
  void route.handler(req, res)
})
let root: string
let origin: string
const token = 'synthetic-integration-session-token-0123456789'
let calls: string[] = []

function input(id: string, extra: Record<string, unknown> = {}): RoundExportInput {
  return {
    packageToExport: {
      meta: { package_id: id, duration_ms: 0 }, transcript: { language: 'zh-CN', segments: [] },
      timeline: [], objects: [], strokes: [], canvas_snapshot: { final: { url: '', format: 'png' } }, ...extra,
    } as unknown as RoundExportInput['packageToExport'],
    recordingToArchive: { blob: new Blob(['synthetic audio'], { type: 'audio/webm' }), duration: 1 } as RoundExportInput['recordingToArchive'],
    rawTrace: [],
  }
}

async function apiFetch(path: string, init: RequestInit) {
  calls.push(path)
  const headers = new Headers(init.headers)
  headers.set('origin', origin)
  headers.set('sec-fetch-site', 'same-origin')
  headers.set('x-canvas-prompt-token', token)
  return fetch(`${origin}${path}`, { ...init, headers })
}

beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'canvas-export-integration-'))
  vi.stubEnv('CANVAS_PROMPT_DATA_HOME', root)
  vi.stubEnv('CANVAS_PROMPT_DELIVERY_MODE', 'local')
  vi.stubEnv('CANVAS_PROMPT_ASR', 'disabled')
  vi.resetModules()
  const { registerCanvasApi } = await import('../canvas-api')
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address() as { port: number }
  origin = `http://127.0.0.1:${address.port}`
  registerCanvasApi({ middlewares: { use: (path: string, handler: Handler) => routes.push({ path, handler }) } } as never,
    { expectedHost: `127.0.0.1:${address.port}`, expectedOrigin: origin, token })
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true, force: true })
})

describe('round export over the real persistence/compile API', () => {
  it('guards receipt and upload requests before filesystem side effects', async () => {
    expect((await fetch(`${origin}/api/rounds`)).status).toBe(403)
    // Node fetch may normalize Host; send an actual raw HTTP Host override.
    const rebindingStatus = await new Promise<number | undefined>((done, reject) => {
      request(`${origin}/api/runtime-identity`, { headers: { host: 'rebinding.invalid' } }, (response) => {
        response.resume()
        done(response.statusCode)
      }).on('error', reject).end()
    })
    expect(rebindingStatus).toBe(403)
    expect((await apiFetch('/api/rounds', { method: 'GET' })).status).toBe(200)
    for (const path of ['/api/round-receipt/pp_private', '/api/round-audio/pp_private']) {
      expect((await fetch(`${origin}${path}`, { method: 'POST' })).status).toBe(403)
    }
    expect(await readdir(resolve(root, '.canvas-prompt')).catch(() => [])).toEqual([])
  })

  it('recovers a lost commit response without uploading media again', async () => {
    calls = []
    let lose = true
    const exporting = createRoundExporter(async (path, init) => {
      const response = await apiFetch(path, init)
      if (lose && path === '/api/prompt-package' && response.ok) {
        lose = false
        await response.text()
        throw new TypeError('synthetic lost response after commit')
      }
      return response
    })
    const result = await exporting(input('pp_lost'))
    expect(result.ok).toBe(true)
    expect(result.reused).toBe(true)
    expect(result.handoff?.host).toBe('local')
    expect(calls.filter((path) => path.includes('/round-audio/'))).toHaveLength(1)
    const dir = resolve(root, '.canvas-prompt/board/rounds/pp_lost')
    expect(await readFile(resolve(dir, 'audio.webm'), 'utf8')).toBe('synthetic audio')
    const before = await readFile(resolve(dir, 'prompt-package.json'), 'utf8')
    expect((await exporting(input('pp_lost'))).reused).toBe(true)
    expect(await readFile(resolve(dir, 'prompt-package.json'), 'utf8')).toBe(before)
    expect(calls.filter((path) => path.includes('/round-audio/'))).toHaveLength(1)
    expect((await apiFetch('/api/round-audio/pp_lost', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: 'late bytes' })).status).toBe(409)
  })

  it('coalesces duplicate clicks and rejects changed content before touching media', async () => {
    calls = []
    const exporting = createRoundExporter(apiFetch)
    const [a, b] = await Promise.all([exporting(input('pp_duplicate')), exporting(input('pp_duplicate'))])
    expect(a).toEqual(b)
    expect(calls.filter((path) => path === '/api/prompt-package')).toHaveLength(1)
    await expect(exporting(input('pp_duplicate', { intent_summary: 'changed' }))).rejects.toThrow('内容已变化')
    expect(calls.filter((path) => path.includes('/round-audio/'))).toHaveLength(1)
  })

  it('repairs missing derived metadata and latest without altering committed content or handoff', async () => {
    const exporting = createRoundExporter(apiFetch)
    await exporting(input('pp_metadata_recovery'))
    const board = resolve(root, '.canvas-prompt/board')
    const dir = resolve(board, 'rounds/pp_metadata_recovery')
    const before = await Promise.all(['prompt-package.json', 'handoff.json', 'round.json'].map((name) => readFile(resolve(dir, name), 'utf8')))
    await Promise.all(['session-manifest.json', 'archive.json'].map((name) => rm(resolve(dir, name))))
    await rm(resolve(board, 'latest-prompt-package.json'))
    calls = []
    expect((await exporting(input('pp_metadata_recovery'))).reused).toBe(true)
    expect(JSON.parse(await readFile(resolve(dir, 'session-manifest.json'), 'utf8')).artifacts.package_transport).toBe('recovered_from_committed_round')
    expect(JSON.parse(await readFile(resolve(dir, 'archive.json'), 'utf8')).retention).toBe('kept_until_deleted_by_user')
    expect(await Promise.all(['prompt-package.json', 'handoff.json', 'round.json'].map((name) => readFile(resolve(dir, name), 'utf8')))).toEqual(before)
    expect(await readFile(resolve(board, 'latest-prompt-package.json'), 'utf8')).toBe(before[0])
    expect(calls.some((path) => path.includes('/round-audio/'))).toBe(false)
  })

  it('does not resurrect a deleted round', async () => {
    const exporting = createRoundExporter(apiFetch)
    await exporting(input('pp_delete'))
    expect((await apiFetch('/api/rounds/pp_delete', { method: 'DELETE' })).ok).toBe(true)
    await expect(exporting(input('pp_delete'))).rejects.toThrow('410')
  })

  it('resumes a large segmented package after its staging segments were removed', async () => {
    const exporting = createRoundExporter(apiFetch)
    const large = input('pp_segmented', { test_padding: '中'.repeat(2_000_000) })
    expect((await exporting(large)).ok).toBe(true)
    const parts = resolve(root, '.canvas-prompt/board/rounds/pp_segmented/package-segments')
    expect(await readdir(parts).catch(() => [])).toEqual([])
    calls = []
    expect((await exporting(large)).reused).toBe(true)
    expect(calls.some((path) => path.includes('/prompt-package-segment/'))).toBe(false)
  }, 20_000)
})

it('request identity tolerates key order and server provenance but preserves user changes', async () => {
  const a = { meta: { package_id: 'a' }, source: { canvas: 'excalidraw' }, text: '中文' }
  const b = { text: '中文', source: { trace: [1], canvas: 'excalidraw' }, meta: { conversation_binding: { private: 'local' }, package_id: 'a' } }
  expect(canonicalRoundRequest(a)).toBe(canonicalRoundRequest(b))
  expect(await roundRequestSha256(a)).toBe(await roundRequestSha256(b))
  expect(await roundRequestSha256({ ...a, text: '不同' })).not.toBe(await roundRequestSha256(a))
})
