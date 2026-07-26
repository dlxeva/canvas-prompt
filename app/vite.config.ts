import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { handoffToMainThread } from './codex-main-thread-handoff.mjs'
import { deleteRoundAndUpdateLatest } from './round-store.mjs'
import { submitImmutableRound } from './round-submission.mjs'
import {
  enforceProtectedLocalApi,
  enforceRuntimeSession,
  isJsonRequest,
  isSupportedAudioRequest,
  normalizedMediaType,
  rejectLocalApiRequest,
  type LocalApiSecurity,
} from './local-api-guard'

const configDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(process.env.CANVAS_PROMPT_PROJECT_DIR ?? resolve(configDir, '..'))
const latestPackagePath = resolve(projectDir, '.canvas-prompt', 'latest-prompt-package.json')
const roundsDir = resolve(projectDir, '.canvas-prompt', 'rounds')
const runCommand = promisify(execFile)
const deliveryMode = process.env.CANVAS_PROMPT_DELIVERY_MODE === 'codex' ? 'codex' : 'local'
const configuredAsrUrl = process.env.CANVAS_PROMPT_ASR_URL ?? `http://127.0.0.1:${process.env.CANVAS_PROMPT_ASR_PORT ?? '8080'}`

function localAsrUrl() {
  try {
    const value = new URL(configuredAsrUrl)
    if (value.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(value.hostname)) return null
    return value.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function runtimeIdentity() {
  return realpath(projectDir).catch(() => projectDir).then((canonicalProjectDir) => ({
    project_dir: canonicalProjectDir,
    project_hash: createHash('sha256').update(canonicalProjectDir).digest('hex'),
    service_version: '0.1.6',
    delivery_mode: deliveryMode,
    asr_url: localAsrUrl(),
    asr_enabled: process.env.CANVAS_PROMPT_ASR !== 'disabled',
  }))
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
type HandoffStatus = 'archived' | 'accepted' | 'delivered' | 'accepted_timeout' | 'accepted_observer_lost' | 'completed_failed' | 'completed_cancelled' | 'accepted_failed' | 'failed' | 'timed_out'
type HandoffResult = { status?: HandoffStatus; attempted: boolean; accepted?: boolean; delivered: boolean; host?: 'codex' | 'local'; threadId?: string; reason?: string; turn?: unknown; handoff_attempt_id?: string }
type RoundRecord = {
  package_id: string
  exported_at: string
  duration_ms: number | null
  status: string
  has_snapshot: boolean
  has_audio: boolean
  handoff?: Pick<HandoffResult, 'status' | 'accepted' | 'delivered'>
}
type RoundManifest = {
  package_id?: string
  exported_at?: string
  duration_ms?: number | null
  status?: string
  handoff?: Pick<HandoffResult, 'status' | 'accepted' | 'delivered'>
}

function safePackageId(packageId: string) {
  return /^[a-zA-Z0-9_-]+$/.test(packageId)
}

function decodePngDataUrl(value: unknown) {
  const match = typeof value === 'string' && value.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/)
  return match ? Buffer.from(match[1], 'base64') : null
}

async function persistCanvasSnapshots(payload: { canvas_snapshot?: { final?: { url?: string }, keyframes?: Array<{ timestamp_ms?: number, image?: { url?: string } }> } }, roundPath: string) {
  const finalBytes = decodePngDataUrl(payload.canvas_snapshot?.final?.url)
  const snapshotPath = finalBytes ? resolve(roundPath, 'canvas-snapshot.png') : null
  if (snapshotPath && finalBytes) await writeFile(snapshotPath, finalBytes)

  const keyframePaths: string[] = []
  for (const [index, keyframe] of (payload.canvas_snapshot?.keyframes ?? []).slice(0, 8).entries()) {
    const bytes = decodePngDataUrl(keyframe.image?.url)
    if (!bytes) continue
    const timestamp = Math.max(0, Math.round(keyframe.timestamp_ms ?? 0))
    const framePath = resolve(roundPath, 'state-frames', `${String(index + 1).padStart(2, '0')}-${timestamp}ms.png`)
    await mkdir(dirname(framePath), { recursive: true })
    await writeFile(framePath, bytes)
    keyframePaths.push(framePath)
  }
  return { snapshotPath, keyframePaths }
}

async function persistRawTrace(rawTrace: unknown, roundPath: string) {
  if (!Array.isArray(rawTrace)) return null
  const ndjson = rawTrace.map((event) => JSON.stringify(event)).join('\n') + (rawTrace.length ? '\n' : '')
  const uncompressed = Buffer.from(ndjson, 'utf8')
  const compressed = gzipSync(uncompressed)
  await writeFile(resolve(roundPath, 'raw-trace.ndjson.gz'), compressed)
  const manifest = {
    schema_version: 'excalidraw-trace-v1',
    compression: 'gzip',
    event_count: rawTrace.length,
    uncompressed_bytes: uncompressed.byteLength,
    compressed_bytes: compressed.byteLength,
    content_sha256: createHash('sha256').update(uncompressed).digest('hex'),
    retention: 'local_round_archive_only',
    model_context: 'excluded',
  }
  await writeFile(resolve(roundPath, 'raw-trace-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

async function existingRoundArtifacts(roundPath: string) {
  const snapshotPath = resolve(roundPath, 'canvas-snapshot.png')
  const snapshot = await stat(snapshotPath).then(() => snapshotPath).catch(() => null)
  const stateFramesDir = resolve(roundPath, 'state-frames')
  const keyframePaths = (await readdir(stateFramesDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => resolve(stateFramesDir, entry.name))
    .sort()
  return { snapshotPath: snapshot, keyframePaths }
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
  const runtimeToken = randomBytes(32).toString('base64url')

  return {
    name: 'canvas-prompt-persistence',
    configureServer(server) {
      const port = Number(server.config.server.port ?? 43223)
      const security: LocalApiSecurity = {
        expectedHost: `127.0.0.1:${port}`,
        expectedOrigin: `http://127.0.0.1:${port}`,
        token: runtimeToken,
      }

      server.middlewares.use('/api/runtime-session', (req, res) => {
        if (req.method !== 'POST') { rejectLocalApiRequest(res, 405, 'Method Not Allowed'); return }
        if (!enforceRuntimeSession(req, res, security)) return
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('x-content-type-options', 'nosniff')
        res.end(JSON.stringify({ token: runtimeToken }))
      })

      server.middlewares.use('/api/runtime-identity', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method Not Allowed'); return }
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(await runtimeIdentity()))
      })

      server.middlewares.use('/api/native-pasteboard-image', async (req, res) => {
        if (req.method !== 'POST') { rejectLocalApiRequest(res, 405, 'Method Not Allowed'); return }
        if (!enforceProtectedLocalApi(req, res, security)) return
        const board = new URL(req.url ?? '/', security.expectedOrigin).searchParams.get('board') === 'drag' ? 'drag' : 'general'
        const image = await readMacPasteboardPng(board)
        if (!image) { res.statusCode = 404; res.end('No PNG image on native pasteboard'); return }
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-type', 'image/png')
        res.setHeader('x-content-type-options', 'nosniff')
        res.end(image)
      })

      server.middlewares.use('/api/round-audio/', (req, res) => {
        const packageId = (req.url?.split('?')[0] ?? '').replace(/^\//, '')
        if (req.method !== 'POST' || !safePackageId(packageId)) { rejectLocalApiRequest(res, 405, 'Method Not Allowed'); return }
        if (!enforceProtectedLocalApi(req, res, security)) return
        if (!isSupportedAudioRequest(req.headers)) { rejectLocalApiRequest(res, 415, 'Unsupported audio content type.'); return }
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
            const roundPath = resolve(roundsDir, packageId)
            await mkdir(roundPath, { recursive: true })
            const contentType = normalizedMediaType(req.headers['content-type'])
            const extension = contentType === 'audio/ogg' ? 'ogg' : contentType === 'audio/mp4' ? 'm4a' : 'webm'
            await writeFile(resolve(roundPath, `audio.${extension}`), Buffer.concat(chunks))
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
          } catch (error) {
            res.statusCode = 500
            res.end(error instanceof Error ? error.message : String(error))
          }
        })
      })

      server.middlewares.use('/api/rounds', async (req, res) => {
        try {
          const match = req.url?.match(/^\/([^/?]+)$/)
          if (req.method === 'DELETE' && match) {
            if (!enforceProtectedLocalApi(req, res, security)) return
            const packageId = match[1]
            if (!safePackageId(packageId)) throw new Error('非法轮次标识')
            await deleteRoundAndUpdateLatest({ roundsDir, latestPackagePath, packageId })
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
            return
          }
          if (req.method !== 'GET' || (req.url && req.url !== '/' && req.url !== '')) { res.statusCode = 405; res.end('Method Not Allowed'); return }
          const entries = await readdir(roundsDir, { withFileTypes: true }).catch(() => [])
          const rounds = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry): Promise<RoundRecord | null> => {
            try {
              const roundPath = resolve(roundsDir, entry.name)
              const files = await readdir(roundPath)
              let raw: RoundManifest | null = null
              let handoff: HandoffResult | null = null
              try {
                raw = JSON.parse(await readFile(resolve(roundPath, 'round.json'), 'utf8')) as RoundManifest
              } catch {
                // A browser or server interruption can happen after the audio is
                // durably written but before the package is compiled. It is still
                // a recoverable local artifact, so do not hide it from the user.
              }
              try {
                handoff = JSON.parse(await readFile(resolve(roundPath, 'handoff.json'), 'utf8')) as HandoffResult
              } catch {
                // Historical rounds may only carry the original round.json
                // receipt. New handoffs own their final status in handoff.json.
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
                status: handoff?.status ?? raw.status ?? 'unknown',
                has_snapshot: files.includes('canvas-snapshot.png'),
                has_audio: files.some((file) => file.startsWith('audio.')),
                handoff: handoff
                  ? { status: handoff.status, accepted: Boolean(handoff.accepted), delivered: Boolean(handoff.delivered) }
                  : raw.handoff
                    ? { status: raw.handoff.status, accepted: Boolean(raw.handoff.accepted), delivered: Boolean(raw.handoff.delivered) }
                    : undefined,
              }
            } catch { return null }
          }))).filter((round): round is RoundRecord => round !== null)
          rounds.sort((a, b) => b.exported_at.localeCompare(a.exported_at))
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ rounds }))
        } catch (error) {
          res.statusCode = 500
          res.end(error instanceof Error ? error.message : String(error))
        }
      })

      server.middlewares.use('/api/prompt-package', (req, res) => {
        if (req.method !== 'POST') { rejectLocalApiRequest(res, 405, 'Method Not Allowed'); return }
        if (!enforceProtectedLocalApi(req, res, security)) return
        if (!isJsonRequest(req.headers)) { rejectLocalApiRequest(res, 415, 'Prompt Package requires application/json.'); return }
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
            const received = JSON.parse(body) as { meta?: { package_id?: string; duration_ms?: number }; canvas_snapshot?: { final?: { url?: string } }; source?: { trace?: unknown[] } }
            const rawTrace = received.source?.trace
            // The raw trace is a local replay artifact, never an input to the
            // compiler or MCP package reader. Keep the durable Prompt Package
            // free of this high-volume renderer history.
            const payload = { ...received }
            if (payload.source && typeof payload.source === 'object') {
              const { trace: _trace, ...sourceWithoutTrace } = payload.source
              payload.source = sourceWithoutTrace
            }
            const packageId = payload.meta?.package_id ?? ''
            if (!safePackageId(packageId)) throw new Error('Prompt Package requires a safe package_id.')
            const serialized = `${JSON.stringify(payload, null, 2)}\n`
            const roundPath = resolve(roundsDir, packageId)
            const retryHandoff = req.headers['x-canvas-prompt-retry-handoff'] === '1'
            const submitted = await submitImmutableRound({
              archiveOptions: {
                roundPath, latestPackagePath, serializedPackage: serialized, packageId,
                durationMs: payload.meta?.duration_ms ?? null,
                persistArtifacts: async () => {
                  const rawTraceManifest = await persistRawTrace(rawTrace, roundPath)
                  const snapshots = await persistCanvasSnapshots(payload, roundPath)
                  return { rawTraceManifest, ...snapshots }
                },
                compileCore: (roundPackagePath: string) => compileCoreEngine(roundPackagePath, roundPath),
              },
              retryHandoff,
              persistArchive: async (archived: { artifacts: { rawTraceManifest?: unknown } }) => {
                await writeFile(resolve(roundPath, 'archive.json'), `${JSON.stringify({ schema_version: 1, storage: 'local_project', retention: 'kept_until_deleted_by_user', contents: ['prompt-package.json', 'canvas-snapshot.png', 'state-frames/ when captured', 'audio.* when recorded', 'raw-trace.ndjson.gz when available', 'raw-trace-manifest.json when available', 'engine/', 'handoff.json when sent'], raw_trace: archived.artifacts.rawTraceManifest ?? undefined, created_at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
              },
              startHandoff: async (archived: { roundPackagePath: string; engine: EngineResult; artifacts: { snapshotPath?: string | null; keyframePaths?: string[] } | null }) => {
                if (deliveryMode === 'local') {
                  return { status: 'archived', attempted: false, accepted: false, delivered: false, host: 'local', reason: 'Context is saved locally for the active AI host to read through Canvas Prompt MCP.' } satisfies HandoffResult
                }
                const artifacts = archived.artifacts ?? await existingRoundArtifacts(roundPath)
                return { ...await handoffToMainThread({ projectDir, packagePath: archived.roundPackagePath, roundPath, snapshotPath: artifacts.snapshotPath ?? null, keyframePaths: artifacts.keyframePaths ?? [], engine: archived.engine }) as HandoffResult, host: 'codex' }
              },
            })
            const { roundPackagePath, engine, handoff } = submitted
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: engine.ok, path: latestPackagePath, roundPath, engine, handoff, reused: submitted.reused }))
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
            res.statusCode = code === 'ROUND_CONTENT_CONFLICT' ? 409 : code === 'ROUND_GONE' ? 410 : 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), promptPackagePersistence()],
  server: { host: '127.0.0.1', port: 43223, strictPort: true },
})
