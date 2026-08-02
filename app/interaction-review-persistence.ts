import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ViteDevServer } from 'vite'
import { enforceProtectedLocalApi, isJsonRequest, rejectLocalApiRequest, type LocalApiSecurity } from './local-api-guard'
import { isInteractionReviewPackage } from './src/interaction-review-contract'

async function writeAtomically(path: string, serialized: string) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try { await writeFile(temporary, serialized, 'utf8'); await rename(temporary, path) }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error }
}

export function registerInteractionReviewPersistence(server: Pick<ViteDevServer, 'middlewares'>, storageDir: string, security: LocalApiSecurity) {
  const latestPath = resolve(storageDir, 'latest-interaction-review-package.json')
  const roundsDir = resolve(storageDir, 'interaction-review-rounds')
  server.middlewares.use('/api/interaction-review-package', (req, res) => {
    if (req.method !== 'POST') { rejectLocalApiRequest(res, 405, 'Method Not Allowed'); return }
    if (!enforceProtectedLocalApi(req, res, security)) return
    if (!isJsonRequest(req.headers)) { rejectLocalApiRequest(res, 415, 'Interaction Review package requires application/json.'); return }
    let body = ''
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (tooLarge) return
      body += chunk
      if (Buffer.byteLength(body, 'utf8') > 8 * 1024 * 1024) {
        tooLarge = true; body = ''; res.statusCode = 413; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: '网页交互审阅过程包超过 8MB 限制。' }))
      }
    })
    req.on('end', async () => {
      if (tooLarge) return
      try {
        const value: unknown = JSON.parse(body)
        if (!isInteractionReviewPackage(value)) throw new Error('网页交互审阅过程包不符合本地隐私与证据边界。')
        const serialized = `${JSON.stringify(value, null, 2)}\n`
        const roundPath = resolve(roundsDir, value.package_id)
        await mkdir(roundsDir, { recursive: true })
        await mkdir(roundPath, { recursive: false })
        try {
          await writeFile(resolve(roundPath, 'interaction-review-package.json'), serialized, 'utf8')
          await writeFile(resolve(roundPath, 'archive.json'), `${JSON.stringify({ schema_version: 1, storage: 'local_board', source_bytes_in_archive: false, created_at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
          await writeAtomically(latestPath, serialized)
        } catch (error) { await rm(roundPath, { recursive: true, force: true }).catch(() => undefined); throw error }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, package_id: value.package_id }))
      } catch (error) {
        res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      }
    })
  })
}
