import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ViteDevServer } from 'vite'
import { handlePptxReviewRender } from './pptx-review-endpoint'
import { enforceProtectedLocalApi, isJsonRequest, rejectLocalApiRequest, type LocalApiSecurity } from './local-api-guard'
import { isArtifactReviewHandoffPayload } from './src/artifact-review-handoff-contract'
import { replaySerializedReviewConfirmationLedger, type SerializedReviewConfirmationLedger } from './src/artifact-review-confirmation-ledger'
import { compileArtifactReviewProposal } from './src/artifact-review-proposal'
import { handleArtifactReviewVisualEvidence } from './artifact-review-visual-persistence'

type UnknownRecord = Record<string, unknown>
type HandoffRequest = { package: unknown; confirmationLedger?: SerializedReviewConfirmationLedger }
type LatestLedgerSidecar = {
  schema_version: 'artifact-review-latest-ledger/0.1-draft'
  package_id: string
  confirmation_ledger: SerializedReviewConfirmationLedger
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function writeAtomically(path: string, serialized: string) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, serialized, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function parseHandoffRequest(value: unknown): HandoffRequest {
  // A bare package remains valid for older callers. Envelope parsing is
  // deliberately exact so a package cannot smuggle a forged ledger field.
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'package')) return { package: value }
  if (!Object.prototype.hasOwnProperty.call(value, 'confirmation_ledger')) {
    throw new Error('交互审阅交接 envelope 必须包含 confirmation_ledger。')
  }
  if (Object.keys(value).some((key) => key !== 'package' && key !== 'confirmation_ledger')) {
    throw new Error('交互审阅交接 envelope 包含未支持字段。')
  }
  try {
    replaySerializedReviewConfirmationLedger(value.confirmation_ledger)
  } catch {
    throw new Error('交互审阅确认账本无效，不能保存。')
  }
  return { package: value.package, confirmationLedger: value.confirmation_ledger as SerializedReviewConfirmationLedger }
}

function isLatestLedgerSidecar(value: unknown): value is LatestLedgerSidecar {
  return isRecord(value)
    && value.schema_version === 'artifact-review-latest-ledger/0.1-draft'
    && typeof value.package_id === 'string'
    && /^arp_[A-Za-z0-9_-]+$/.test(value.package_id)
    && Object.prototype.hasOwnProperty.call(value, 'confirmation_ledger')
}

async function persistRound(
  roundsDir: string,
  packageId: string,
  packageSerialized: string,
  proposalSerialized: string,
  ledgerSerialized: string | undefined,
) {
  await mkdir(roundsDir, { recursive: true })
  const roundPath = resolve(roundsDir, packageId)
  const stagingPath = resolve(roundsDir, `.${packageId}.${randomUUID()}.tmp`)
  const contents = ['artifact-review-package.json', 'review-brief.json']
  if (ledgerSerialized !== undefined) contents.push('confirmation-ledger.json')
  try {
    await mkdir(stagingPath)
    await writeFile(resolve(stagingPath, 'artifact-review-package.json'), packageSerialized, 'utf8')
    await writeFile(resolve(stagingPath, 'review-brief.json'), proposalSerialized, 'utf8')
    if (ledgerSerialized !== undefined) await writeFile(resolve(stagingPath, 'confirmation-ledger.json'), ledgerSerialized, 'utf8')
    await writeFile(resolve(stagingPath, 'archive.json'), `${JSON.stringify({
      schema_version: 1,
      storage: 'local_project',
      retention: 'kept_until_deleted_by_user',
      contents: [...contents, 'archive.json'],
      source_bytes_in_archive: false,
      created_at: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8')
    // A directory rename makes all package/brief/ledger files visible as one
    // completed round. The latest reference is written only afterwards.
    await rename(stagingPath, roundPath)
    return roundPath
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function readLatestPackage(latestPackagePath: string, latestLedgerPath: string) {
  const payload: unknown = JSON.parse(await readFile(latestPackagePath, 'utf8'))
  let confirmationLedger: SerializedReviewConfirmationLedger | undefined
  try {
    const sidecar: unknown = JSON.parse(await readFile(latestLedgerPath, 'utf8'))
    if (!isLatestLedgerSidecar(sidecar) || !isRecord(payload) || sidecar.package_id !== payload.package_id) {
      throw new Error('最新交互审阅确认账本与过程包不匹配。')
    }
    replaySerializedReviewConfirmationLedger(sidecar.confirmation_ledger)
    confirmationLedger = sidecar.confirmation_ledger
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
    if (!missing) throw error
  }
  if (!isArtifactReviewHandoffPayload(payload, confirmationLedger)) {
    throw new Error('最新交互审阅档案不符合本地隐私边界。')
  }
  return { payload, confirmationLedger }
}

export function registerArtifactReviewPersistence(server: Pick<ViteDevServer, 'middlewares'>, storageDir: string, security: LocalApiSecurity) {
  const latestPackagePath = resolve(storageDir, 'latest-artifact-review-package.json')
  const latestLedgerPath = resolve(storageDir, 'latest-artifact-review-confirmation-ledger.json')
  const roundsDir = resolve(storageDir, 'artifact-review-rounds')

  server.middlewares.use('/api/artifact-review-latest', async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('Method Not Allowed'); return }
    if (!enforceProtectedLocalApi(req, res, security)) return
    try {
      const { payload, confirmationLedger } = await readLatestPackage(latestPackagePath, latestLedgerPath)
      const brief = compileArtifactReviewProposal(payload, confirmationLedger)
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify({ ok: true, package: payload, brief }))
    } catch (error) {
      const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      res.statusCode = missing ? 404 : 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: missing ? '还没有已交给 AI 的交互审阅。' : (error instanceof Error ? error.message : String(error)) }))
    }
  })

  server.middlewares.use('/api/artifact-review-pptx-render', (req, res) => {
    if (!enforceProtectedLocalApi(req, res, security)) return
    handlePptxReviewRender(req, res)
  })

  server.middlewares.use('/api/artifact-review-visual-evidence', (req, res) => {
    if (!enforceProtectedLocalApi(req, res, security)) return
    if (req.method === 'POST' && !isJsonRequest(req.headers)) { rejectLocalApiRequest(res, 415, 'Artifact Review visual evidence requires application/json.'); return }
    handleArtifactReviewVisualEvidence(req, res, storageDir)
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
        res.end(JSON.stringify({ ok: false, error: '交互审阅过程包超过 8MB 限制。' }))
      }
    })
    req.on('end', async () => {
      if (tooLarge) return
      try {
        const { package: payload, confirmationLedger } = parseHandoffRequest(JSON.parse(body))
        if (!isArtifactReviewHandoffPayload(payload, confirmationLedger)) throw new Error('只接受只读、无源文件或媒体数据且确认可验证的本地交互审阅过程包。')
        const serialized = `${JSON.stringify(payload, null, 2)}\n`
        const proposalBrief = compileArtifactReviewProposal(payload, confirmationLedger)
        const proposalSerialized = `${JSON.stringify(proposalBrief, null, 2)}\n`
        const ledgerSerialized = confirmationLedger === undefined ? undefined : `${JSON.stringify(confirmationLedger, null, 2)}\n`
        const packageId = (payload as { package_id: string }).package_id
        const roundPath = await persistRound(roundsDir, packageId, serialized, proposalSerialized, ledgerSerialized)
        const previousLedger = await readFile(latestLedgerPath, 'utf8').catch((error) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
          throw error
        })
        try {
          if (confirmationLedger === undefined) await rm(latestLedgerPath, { force: true })
          else await writeAtomically(latestLedgerPath, `${JSON.stringify({
            schema_version: 'artifact-review-latest-ledger/0.1-draft',
            package_id: packageId,
            confirmation_ledger: confirmationLedger,
          } satisfies LatestLedgerSidecar, null, 2)}\n`)
          // Keep the established latest-package path for MCP/CLI compatibility.
          // It advances last, after the immutable round and its ledger exist.
          await writeAtomically(latestPackagePath, serialized)
        } catch (error) {
          if (previousLedger === null) await rm(latestLedgerPath, { force: true }).catch(() => undefined)
          else await writeAtomically(latestLedgerPath, previousLedger).catch(() => undefined)
          throw error
        }
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
