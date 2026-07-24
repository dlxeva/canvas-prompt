import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const configDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(process.env.CANVAS_PROMPT_PROJECT_DIR ?? resolve(configDir, '..'))
const latestPackagePath = resolve(projectDir, '.canvas-prompt', 'latest-prompt-package.json')
const roundsDir = resolve(projectDir, '.canvas-prompt', 'rounds')
const runCommand = promisify(execFile)

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
  return {
    name: 'canvas-prompt-persistence',
    configureServer(server) {
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
            const roundPath = resolve(roundsDir, packageId)
            await mkdir(roundPath, { recursive: true })
            const contentType = String(req.headers['content-type'] ?? '')
            const extension = contentType.includes('ogg') ? 'ogg' : contentType.includes('mp4') ? 'm4a' : 'webm'
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
            const packageId = match[1]
            if (!safePackageId(packageId)) throw new Error('非法轮次标识')
            await rm(resolve(roundsDir, packageId), { recursive: true, force: false })
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
            await mkdir(dirname(latestPackagePath), { recursive: true })
            const serialized = `${JSON.stringify(payload, null, 2)}\n`
            const temporary = `${latestPackagePath}.${process.pid}.tmp`
            await writeFile(temporary, serialized, 'utf8')
            await rename(temporary, latestPackagePath)
            const roundPath = resolve(roundsDir, packageId)
            await mkdir(roundPath, { recursive: true })
            const roundPackagePath = resolve(roundPath, 'prompt-package.json')
            await writeFile(roundPackagePath, serialized, 'utf8')
            await persistCanvasSnapshot(payload, roundPath)
            const engine = await compileCoreEngine(roundPackagePath, roundPath)
            await writeFile(resolve(roundPath, 'round.json'), `${JSON.stringify({ package_id: packageId, exported_at: new Date().toISOString(), duration_ms: payload.meta?.duration_ms ?? null, status: engine.ok ? 'engine_compiled' : 'engine_compile_failed', engine }, null, 2)}\n`, 'utf8')
            await writeFile(resolve(roundPath, 'archive.json'), `${JSON.stringify({ schema_version: 1, storage: 'local_project', retention: 'kept_until_deleted_by_user', contents: ['prompt-package.json', 'canvas-snapshot.png', 'audio.* when recorded', 'engine/'], created_at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: engine.ok, path: latestPackagePath, roundPath, engine }))
          } catch (error) {
            res.statusCode = 400
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
