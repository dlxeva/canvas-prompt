import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { withLatestLock, writeFileAtomically } from './round-store.mjs'

export class RoundSubmissionError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
  }
  return value
}

export function contentSha256(serializedPackage) {
  const parsed = JSON.parse(serializedPackage)
  return createHash('sha256').update(JSON.stringify(canonicalValue(parsed))).digest('hex')
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

async function isTombstoned(roundPath, packageId) {
  const tombstonePath = resolve(roundPath, '..', '..', 'deleted-rounds', `${packageId}.json`)
  return await readJson(tombstonePath)
}

export async function updateRoundManifest(roundPath, patch) {
  const manifestPath = resolve(roundPath, 'round.json')
  const current = await readJson(manifestPath)
  if (!current) throw new RoundSubmissionError('ROUND_INCOMPLETE', '本轮归档不完整，不能更新交付状态。')
  const next = { ...current, ...patch }
  await writeFileAtomically(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/**
 * Commit an immutable round before its mutable latest pointer.
 *
 * The caller owns snapshot/raw-trace writes and compilation, but latest is
 * deliberately unreachable until both succeed. This small boundary is shared
 * by the Vite runtime and filesystem behaviour tests.
 */
/** @param {{
 * roundPath: string, latestPackagePath: string, serializedPackage: string,
 * packageId: string, durationMs?: number|null,
 * persistArtifacts: () => Promise<any>,
 * compileCore: (packagePath: string) => Promise<{ok: boolean, [key: string]: unknown}>,
 * now?: () => string,
 * }} options */
export async function archiveCompiledRound(options) {
  const {
    roundPath, latestPackagePath, serializedPackage, packageId,
    durationMs = null, persistArtifacts, compileCore,
    now = () => new Date().toISOString(),
  } = options
  const roundPackagePath = resolve(roundPath, 'prompt-package.json')
  const contentSha = contentSha256(serializedPackage)
  const tombstone = await isTombstoned(roundPath, packageId)
  if (tombstone) throw new RoundSubmissionError('ROUND_GONE', '本轮已删除。请开始新一轮后重新发送。')
  const existingManifest = await readJson(resolve(roundPath, 'round.json'))
  if (existingManifest) {
    const existingPackage = await readFile(roundPackagePath, 'utf8').catch(() => null)
    if (!existingPackage) throw new RoundSubmissionError('ROUND_INCOMPLETE', '本轮归档不完整，不能重复提交。')
    const existingSha = typeof existingManifest.content_sha256 === 'string'
      ? existingManifest.content_sha256
      : contentSha256(existingPackage)
    if (existingSha !== contentSha) throw new RoundSubmissionError('ROUND_CONTENT_CONFLICT', '同一轮的内容已变化。请开始新一轮后重新发送。')
    const compileFailed = existingManifest.engine?.ok !== true
    if (!compileFailed) return { roundPackagePath, engine: existingManifest.engine, artifacts: null, manifest: existingManifest, reused: true }
    // A failed compile is retryable. Preserve the package and independent
    // audio/source artifacts while rebuilding only the engine on retry.
    await rm(resolve(roundPath, 'engine'), { recursive: true, force: true })
    const artifacts = await persistArtifacts()
    const engine = await compileCore(roundPackagePath)
    const manifest = { package_id: packageId, content_sha256: contentSha, exported_at: now(), duration_ms: durationMs, status: engine.ok ? 'engine_compiled' : 'engine_compile_failed', retryable: !engine.ok, engine }
    await writeFileAtomically(resolve(roundPath, 'round.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    if (engine.ok) {
      await withLatestLock(latestPackagePath, async () => {
        await mkdir(dirname(latestPackagePath), { recursive: true })
        await writeFileAtomically(latestPackagePath, serializedPackage)
      })
    }
    return { roundPackagePath, engine, artifacts, manifest, reused: false }
  }
  await mkdir(roundPath, { recursive: true })
  await writeFileAtomically(roundPackagePath, serializedPackage)
  const artifacts = await persistArtifacts()
  const engine = await compileCore(roundPackagePath)
  const manifest = { package_id: packageId, content_sha256: contentSha, exported_at: now(), duration_ms: durationMs, status: engine.ok ? 'engine_compiled' : 'engine_compile_failed', retryable: !engine.ok, engine }
  await writeFileAtomically(resolve(roundPath, 'round.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (engine.ok) {
    await withLatestLock(latestPackagePath, async () => {
      await mkdir(dirname(latestPackagePath), { recursive: true })
      await writeFileAtomically(latestPackagePath, serializedPackage)
    })
  }
  return { roundPackagePath, engine, artifacts, manifest, reused: false }
}
