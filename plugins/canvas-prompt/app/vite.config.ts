import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const configDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(process.env.CANVAS_PROMPT_PROJECT_DIR ?? resolve(configDir, '..'))
const appPackagePath = resolve(configDir, 'package.json')
const appLockfilePath = resolve(configDir, 'package-lock.json')
const latestPackagePath = resolve(projectDir, '.canvas-prompt', 'latest-prompt-package.json')
const roundsDir = resolve(projectDir, '.canvas-prompt', 'rounds')
const roundStagingDir = resolve(projectDir, '.canvas-prompt', 'round-staging')
const roundTombstonesDir = resolve(projectDir, '.canvas-prompt', 'round-tombstones')
const runCommand = promisify(execFile)

function fileSha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const runtimeIdentity = {
  service: 'canvas-prompt',
  package_json_sha256: fileSha256(appPackagePath),
  package_lock_sha256: fileSha256(appLockfilePath),
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function writeAtomically(path: string, serialized: string) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, serialized, 'utf8')
  await rename(temporary, path)
}

function contentSha256(serialized: string) {
  return createHash('sha256').update(serialized, 'utf8').digest('hex')
}

const roundLocks = new Map<string, Promise<unknown>>()
const LATEST_ROUND_LOCK_KEY = '\u0000latest-round-pointer'

async function withRoundLock<T>(packageId: string, task: () => Promise<T>) {
  const previous = roundLocks.get(packageId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task)
  roundLocks.set(packageId, current)
  try {
    return await current
  } finally {
    if (roundLocks.get(packageId) === current) roundLocks.delete(packageId)
  }
}

function roundTombstonePath(packageId: string) {
  return resolve(roundTombstonesDir, `${packageId}.json`)
}

async function isRoundDeleted(packageId: string) {
  return pathExists(roundTombstonePath(packageId))
}

async function removeLatestRoundIf(packageId: string) {
  await withRoundLock(LATEST_ROUND_LOCK_KEY, async () => {
    try {
      const latest = JSON.parse(await readFile(latestPackagePath, 'utf8')) as { meta?: { package_id?: string } }
      if (latest.meta?.package_id === packageId) await unlink(latestPackagePath)
    } catch (error) {
      const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      if (!missing) throw error
    }
  })
}

async function writeLatestRound(serialized: string) {
  await withRoundLock(LATEST_ROUND_LOCK_KEY, () => writeAtomically(latestPackagePath, serialized))
}

function statusError(message: string, statusCode: number) {
  const error = new Error(message) as Error & { statusCode?: number }
  error.statusCode = statusCode
  return error
}

const macPasteboardReader = String.raw`
import AppKit
import Foundation

let boardName = CommandLine.arguments.dropFirst().first ?? "general"
let board = NSPasteboard(name: boardName == "drag" ? .drag : .general)
if let png = board.data(forType: .png) {
  print(png.base64EncodedString())
}
`

async function readMacPasteboardPng(board: 'general' | 'drag') {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await runCommand('swift', ['-e', macPasteboardReader, board], {
      timeout: 12_000,
      maxBuffer: 40 * 1024 * 1024,
    })
    const encoded = stdout.trim()
    return encoded ? Buffer.from(encoded, 'base64') : null
  } catch {
    return null
  }
}

type EngineResult = { ok: boolean; error?: string; process_ir_path?: string; compact_package_path?: string }
type RoundRecord = {
  package_id: string
  exported_at: string
  duration_ms: number | null
  status: string
  has_snapshot: boolean
  has_audio: boolean
}
type RoundManifest = {
  package_id?: string
  exported_at?: string
  duration_ms?: number | null
  status?: string
}

function safePackageId(packageId: string) {
  return /^[a-zA-Z0-9_-]+$/.test(packageId)
}

function relocateEnginePaths(engine: EngineResult, fromDir: string, toDir: string): EngineResult {
  const relocate = (path: string | undefined) => {
    if (!path) return path
    const prefix = `${fromDir}${sep}`
    return path.startsWith(prefix) ? `${toDir}${path.slice(fromDir.length)}` : path
  }
  return {
    ...engine,
    process_ir_path: relocate(engine.process_ir_path),
    compact_package_path: relocate(engine.compact_package_path),
  }
}

async function persistCanvasSnapshot(payload: { canvas_snapshot?: { final?: { url?: string } } }, roundPath: string) {
  const dataUrl = payload.canvas_snapshot?.final?.url
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/)
  if (!match) return null
  const snapshotPath = resolve(roundPath, 'canvas-snapshot.png')
  await writeFile(snapshotPath, Buffer.from(match[1], 'base64'))
  return snapshotPath
}

async function compileCoreEngine(packagePath: string, roundPath: string): Promise<EngineResult> {
  // The compiler is shipped with the plugin. Session artifacts still belong to
  // the active project, so installation does not require a private source tree.
  const compilerPath = resolve(configDir, '..', 'prompt_package_builder', 'compile_runtime_package.py')
  try {
    const { stdout } = await runCommand('python3', [compilerPath, '--input', packagePath, '--output-dir', resolve(roundPath, 'engine')], { cwd: projectDir, maxBuffer: 1024 * 1024 })
    return JSON.parse(stdout) as EngineResult
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    return { ok: false, error: stderr || (error instanceof Error ? error.message : String(error)) }
  }
}

function promptPackagePersistence(): Plugin {
  const configurePersistence = (server: ViteDevServer) => {
      server.middlewares.use('/api/runtime-identity', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method Not Allowed'); return }
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(runtimeIdentity))
      })

      server.middlewares.use('/api/native-pasteboard-image', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method Not Allowed'); return }
        const board = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('board') === 'drag' ? 'drag' : 'general'
        const image = await readMacPasteboardPng(board)
        if (!image) { res.statusCode = 404; res.end('No PNG image on native pasteboard'); return }
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-type', 'image/png')
        res.end(image)
      })

      server.middlewares.use('/api/round-audio/', (req, res) => {
        const packageId = (req.url?.split('?')[0] ?? '').replace(/^\//, '')
        if (req.method !== 'POST' || !safePackageId(packageId)) { res.statusCode = 405; res.end('Method Not Allowed'); return }
        const chunks: Buffer[] = []
        let total = 0
        const maxBytes = 256 * 1024 * 1024
        req.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > maxBytes) { req.destroy(new Error('录音超过 256MB 限制')) } else chunks.push(chunk)
        })
        req.on('error', (error) => { res.statusCode = 413; res.end(error.message) })
        req.on('end', async () => {
          try {
            await withRoundLock(packageId, async () => {
              if (await isRoundDeleted(packageId)) throw statusError('这轮本地档案已被删除，迟到的录音不会恢复它。', 410)
              if (await pathExists(resolve(roundsDir, packageId, 'prompt-package.json'))) {
                throw statusError('这轮本地档案已经归档，不能追加录音。', 409)
              }
              const stagingPath = resolve(roundStagingDir, packageId)
              await mkdir(stagingPath, { recursive: true })
              const contentType = String(req.headers['content-type'] ?? '')
              const extension = contentType.includes('ogg') ? 'ogg' : contentType.includes('mp4') ? 'm4a' : 'webm'
              const existingFiles = await readdir(stagingPath).catch(() => [])
              await Promise.all(existingFiles.filter((file) => file.startsWith('audio.')).map((file) => rm(resolve(stagingPath, file), { force: true })))
              await writeFile(resolve(stagingPath, `audio.${extension}`), Buffer.concat(chunks))
            })
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
          } catch (error) {
            res.statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500
            res.end(error instanceof Error ? error.message : String(error))
          }
        })
      })

      server.middlewares.use('/api/rounds', async (req, res) => {
        try {
          const match = req.url?.match(/^\/([^/?]+)$/)
          if (req.method === 'DELETE' && match) {
            const packageId = match[1]
            if (!safePackageId(packageId)) throw new Error('非法轮次标识')
            await withRoundLock(packageId, async () => {
              await mkdir(roundTombstonesDir, { recursive: true })
              await writeAtomically(roundTombstonePath(packageId), `${JSON.stringify({ package_id: packageId, deleted_at: new Date().toISOString() }, null, 2)}\n`)
              await rm(resolve(roundsDir, packageId), { recursive: true, force: true })
              await rm(resolve(roundStagingDir, packageId), { recursive: true, force: true })
              await removeLatestRoundIf(packageId)
            })
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true, deleted: true, package_id: packageId }))
            return
          }
          if (req.method !== 'GET' || (req.url && req.url !== '/' && req.url !== '')) { res.statusCode = 405; res.end('Method Not Allowed'); return }
          const entries = await readdir(roundsDir, { withFileTypes: true }).catch(() => [])
          const rounds = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry): Promise<RoundRecord | null> => {
            try {
              if (await isRoundDeleted(entry.name)) return null
              const roundPath = resolve(roundsDir, entry.name)
              const files = await readdir(roundPath)
              let raw: RoundManifest | null = null
              try {
                raw = JSON.parse(await readFile(resolve(roundPath, 'round.json'), 'utf8')) as RoundManifest
              } catch {
                // A browser or server interruption can happen after the audio is
                // durably written but before the package is compiled. It is still
                // a recoverable local artifact, so do not hide it from the user.
              }
              if (!raw) {
                const info = await stat(roundPath)
                return {
                  package_id: entry.name,
                  exported_at: info.birthtime.toISOString(),
                  duration_ms: null,
                  status: 'incomplete',
                  has_snapshot: files.includes('canvas-snapshot.png'),
                  has_audio: files.some((file) => file.startsWith('audio.')),
                }
              }
              const exportedAt = raw.exported_at ?? (await stat(roundPath)).birthtime.toISOString()
              return {
                package_id: raw.package_id ?? entry.name,
                exported_at: exportedAt,
                duration_ms: raw.duration_ms ?? null,
                status: raw.status ?? 'unknown',
                has_snapshot: files.includes('canvas-snapshot.png'),
                has_audio: files.some((file) => file.startsWith('audio.')),
              }
            } catch { return null }
          }))).filter((round): round is RoundRecord => round !== null)
          const committedIds = new Set(rounds.map((round) => round.package_id))
          const stagingEntries = await readdir(roundStagingDir, { withFileTypes: true }).catch(() => [])
          const retryableRounds = (await Promise.all(stagingEntries
            .filter((entry) => entry.isDirectory() && safePackageId(entry.name) && !committedIds.has(entry.name))
            .map(async (entry): Promise<RoundRecord | null> => {
              try {
                if (await isRoundDeleted(entry.name)) return null
                const roundPath = resolve(roundStagingDir, entry.name)
                const files = await readdir(roundPath)
                const info = await stat(roundPath)
                let payload: { meta?: { package_id?: string; created_at?: string; duration_ms?: number } } = {}
                try {
                  payload = JSON.parse(await readFile(resolve(roundPath, 'prompt-package.json'), 'utf8')) as typeof payload
                } catch {
                  // Keep the directory visible even if the browser died before
                  // the package JSON itself was fully written.
                }
                return {
                  package_id: payload.meta?.package_id ?? entry.name,
                  exported_at: payload.meta?.created_at ?? info.birthtime.toISOString(),
                  duration_ms: payload.meta?.duration_ms ?? null,
                  status: 'compile_retryable',
                  has_snapshot: files.includes('canvas-snapshot.png'),
                  has_audio: files.some((file) => file.startsWith('audio.')),
                }
              } catch { return null }
            }))).filter((round): round is RoundRecord => round !== null)
          rounds.push(...retryableRounds)
          rounds.sort((a, b) => b.exported_at.localeCompare(a.exported_at))
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ rounds }))
        } catch (error) {
          res.statusCode = 500
          res.end(error instanceof Error ? error.message : String(error))
        }
      })

      server.middlewares.use('/api/prompt-package', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return }
        let body = ''
        const maxPayloadBytes = 32 * 1024 * 1024
        req.setEncoding('utf8')
        req.on('data', (chunk) => {
          body += chunk
          if (Buffer.byteLength(body, 'utf8') > maxPayloadBytes) {
            res.statusCode = 413
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: '本轮画布包超过 32MB 限制；原始录音已保留在本地档案。' }))
            req.destroy()
          }
        })
        req.on('end', async () => {
          try {
            const payload = JSON.parse(body) as { meta?: { package_id?: string; duration_ms?: number }; canvas_snapshot?: { final?: { url?: string } } }
            const packageId = payload.meta?.package_id ?? ''
            if (!safePackageId(packageId)) throw new Error('Prompt Package requires a safe package_id.')
            const serialized = `${JSON.stringify(payload, null, 2)}\n`
            const contentHash = contentSha256(serialized)
            await withRoundLock(packageId, async () => {
              if (await isRoundDeleted(packageId)) throw statusError('这轮本地档案已被删除，迟到的请求不会恢复它。', 410)
              const roundPath = resolve(roundsDir, packageId)
              const roundPackagePath = resolve(roundPath, 'prompt-package.json')
              if (await pathExists(roundPackagePath)) {
                const existingSerialized = await readFile(roundPackagePath, 'utf8')
                if (contentSha256(existingSerialized) !== contentHash) throw statusError('相同 package_id 已存在不同内容，拒绝覆盖。', 409)
                await writeLatestRound(serialized)
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({ ok: true, reused: true, path: latestPackagePath, roundPath }))
                return
              }

              const stagingPath = resolve(roundStagingDir, packageId)
              await mkdir(stagingPath, { recursive: true })
              // Keep the durable recording while replacing only generated retry state.
              await Promise.all(['prompt-package.json', 'canvas-snapshot.png', 'round.json', 'archive.json', 'compile-failure.json'].map((file) => rm(resolve(stagingPath, file), { force: true })))
              await rm(resolve(stagingPath, 'engine'), { recursive: true, force: true })
              const stagingPackagePath = resolve(stagingPath, 'prompt-package.json')
              await writeAtomically(stagingPackagePath, serialized)
              await persistCanvasSnapshot(payload, stagingPath)
              const engine = await compileCoreEngine(stagingPackagePath, stagingPath)
              if (!engine.ok) {
                await writeAtomically(resolve(stagingPath, 'compile-failure.json'), `${JSON.stringify({ package_id: packageId, content_sha256: contentHash, failed_at: new Date().toISOString(), engine }, null, 2)}\n`)
                res.statusCode = 422
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({ ok: false, retryable: true, stagedPath: stagingPath, engine }))
                return
              }
              const promotedEngine = relocateEnginePaths(engine, stagingPath, roundPath)
              await writeAtomically(resolve(stagingPath, 'round.json'), `${JSON.stringify({ package_id: packageId, exported_at: new Date().toISOString(), duration_ms: payload.meta?.duration_ms ?? null, status: 'engine_compiled', engine: promotedEngine }, null, 2)}\n`)
              await writeAtomically(resolve(stagingPath, 'archive.json'), `${JSON.stringify({ schema_version: 2, storage: 'local_project', retention: 'kept_until_deleted_by_user', contents: ['prompt-package.json', 'canvas-snapshot.png', 'audio.* when recorded', 'engine/'], content_sha256: contentHash, created_at: new Date().toISOString() }, null, 2)}\n`)
              await mkdir(roundsDir, { recursive: true })
              await rename(stagingPath, roundPath)
              // Promotion is complete before the latest pointer moves. If this
              // final write fails, the next identical request reuses the round
              // and repairs the pointer instead of recompiling or overwriting it.
              await writeLatestRound(serialized)
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: true, reused: false, path: latestPackagePath, roundPath, engine: promotedEngine }))
            })
          } catch (error) {
            res.statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          }
        })
      })

  }
  return {
    name: 'canvas-prompt-persistence',
    configureServer(server) { configurePersistence(server) },
    configurePreviewServer(server) { configurePersistence(server as unknown as ViteDevServer) },
  }
}

export default defineConfig({
  plugins: [react(), promptPackagePersistence()],
  server: { host: '127.0.0.1', port: 43223, strictPort: true },
})
