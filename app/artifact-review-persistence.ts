import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ViteDevServer } from 'vite'
import { handlePptxReviewRender } from './pptx-review-endpoint'
import { enforceProtectedLocalApi, isJsonRequest, rejectLocalApiRequest, type LocalApiSecurity } from './local-api-guard'
import { isArtifactReviewHandoffPayload } from './src/artifact-review-handoff-contract'
import { compileArtifactReviewProposal } from './src/artifact-review-proposal'

async function writeAtomically(path: string, serialized: string) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, serialized, 'utf8')
  await rename(temporary, path)
}

export function registerArtifactReviewPersistence(server: Pick<ViteDevServer, 'middlewares'>, storageDir: string, security: LocalApiSecurity) {
  const latestPackagePath = resolve(storageDir, 'latest-artifact-review-package.json')
  const roundsDir = resolve(storageDir, 'artifact-review-rounds')

  server.middlewares.use('/api/artifact-review-latest', async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('Method Not Allowed'); return }
    if (!enforceProtectedLocalApi(req, res, security)) return
    try {
      const payload: unknown = JSON.parse(await readFile(latestPackagePath, 'utf8'))
      if (!isArtifactReviewHandoffPayload(payload)) throw new Error('最新 PDF 批阅档案不符合本地隐私边界。')
      const brief = compileArtifactReviewProposal(payload)
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify({ ok: true, package: payload, brief }))
    } catch (error) {
      const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      res.statusCode = missing ? 404 : 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: missing ? '还没有已交给 AI 的 PDF 批阅。' : (error instanceof Error ? error.message : String(error)) }))
    }
  })

  server.middlewares.use('/api/artifact-review-pptx-render', (req, res) => {
    if (!enforceProtectedLocalApi(req, res, security)) return
    handlePptxReviewRender(req, res)
  })

  server.middlewares.use('/api/artifact-review-package', (req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return }
    if (!enforceProtectedLocalApi(req, res, security)) return
    if (!isJsonRequest(req.headers)) { rejectLocalApiRequest(res, 415, 'Artifact Review package requires application/json.'); return }
    let body = ''
    let tooLarge = false
    const maxPayloadBytes = 8 * 1024 * 1024
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (tooLarge) return
      body += chunk
      if (Buffer.byteLength(body, 'utf8') > maxPayloadBytes) {
        tooLarge = true
        body = ''
        res.statusCode = 413
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'PDF 批阅过程包超过 8MB 限制。' }))
      }
    })
    req.on('end', async () => {
      if (tooLarge) return
      try {
        const payload: unknown = JSON.parse(body)
        if (!isArtifactReviewHandoffPayload(payload)) throw new Error('只接受只读、无源文件或媒体数据的本地 Artifact Review 过程包。')
        const serialized = `${JSON.stringify(payload, null, 2)}\n`
        const proposalBrief = compileArtifactReviewProposal(payload)
        const proposalSerialized = `${JSON.stringify(proposalBrief, null, 2)}\n`
        const roundPath = resolve(roundsDir, payload.package_id)
        await writeAtomically(latestPackagePath, serialized)
        await mkdir(roundPath, { recursive: true })
        await writeAtomically(resolve(roundPath, 'artifact-review-package.json'), serialized)
        await writeAtomically(resolve(roundPath, 'review-brief.json'), proposalSerialized)
        await writeAtomically(resolve(roundPath, 'archive.json'), `${JSON.stringify({
          schema_version: 1,
          storage: 'local_project',
          retention: 'kept_until_deleted_by_user',
          contents: ['artifact-review-package.json', 'review-brief.json'],
          source_bytes_in_archive: false,
          created_at: new Date().toISOString(),
        }, null, 2)}\n`)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, latestPath: latestPackagePath, roundPath }))
      } catch (error) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      }
    })
  })
}
