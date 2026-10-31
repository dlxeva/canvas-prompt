import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { withLatestLock, writeFileAtomically } from './round-store.mjs'
import { contentSha256, newestSuccessfulRound } from './round-candidates.mjs'
export { contentSha256 } from './round-candidates.mjs'

export class RoundSubmissionError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

async function readJson(path) {
  let raw
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest')
    return value
  } catch {
    throw new RoundSubmissionError('ROUND_INCOMPLETE', '本轮档案状态损坏，不能覆盖归档。')
  }
}

async function isTombstoned(roundPath, packageId) {
  const tombstonePath = resolve(roundPath, '..', '..', 'deleted-rounds', `${packageId}.json`)
  try { await readFile(tombstonePath); return true } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function readPackage(path) {
  const raw = await readOptional(path)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid package')
    return { raw, value, contentSha: contentSha256(raw) }
  } catch {
    throw new RoundSubmissionError('ROUND_INCOMPLETE', '本轮原始 Prompt Package 损坏，不能覆盖归档。')
  }
}

async function repairLatest({ roundPath, latestPackagePath }) {
  const roundsDir = dirname(roundPath)
  await withLatestLock(latestPackagePath, async () => {
    const newest = await newestSuccessfulRound(roundsDir)
    if (!newest) return
    const current = await readOptional(latestPackagePath)
    if (current === newest.packageContents) return
    await mkdir(dirname(latestPackagePath), { recursive: true })
    await writeFileAtomically(latestPackagePath, newest.packageContents)
  })
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
  const existingPackage = await readPackage(roundPackagePath)
  if (existingManifest) {
    if (!existingPackage) throw new RoundSubmissionError('ROUND_INCOMPLETE', '本轮归档不完整，不能重复提交。')
    if (typeof existingManifest.content_sha256 === 'string' && existingManifest.content_sha256 !== existingPackage.contentSha) {
      throw new RoundSubmissionError('ROUND_INCOMPLETE', '本轮原始 Prompt Package 与档案摘要不一致，不能覆盖归档。')
    }
    if (existingPackage.contentSha !== contentSha) throw new RoundSubmissionError('ROUND_CONTENT_CONFLICT', '同一轮的内容已变化。请开始新一轮后重新发送。')
    const compileFailed = existingManifest.engine?.ok !== true
    if (!compileFailed) {
      await repairLatest({ roundPath, latestPackagePath })
      return { roundPackagePath, engine: existingManifest.engine, artifacts: null, manifest: existingManifest, reused: true }
    }
    // A failed compile is retryable. Preserve the package and independent
    // audio/source artifacts while rebuilding only the engine on retry.
    await rm(resolve(roundPath, 'engine'), { recursive: true, force: true })
    const artifacts = await persistArtifacts()
    const engine = await compileCore(roundPackagePath)
    const manifest = { package_id: packageId, content_sha256: contentSha, exported_at: existingManifest.exported_at ?? now(), duration_ms: durationMs, status: engine.ok ? 'engine_compiled' : 'engine_compile_failed', retryable: !engine.ok, engine }
    await writeFileAtomically(resolve(roundPath, 'round.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    if (engine.ok) await repairLatest({ roundPath, latestPackagePath })
    return { roundPackagePath, engine, artifacts, manifest, reused: false }
  }

  if (existingPackage) {
    if (existingPackage.contentSha !== contentSha) throw new RoundSubmissionError('ROUND_CONTENT_CONFLICT', '同一轮的内容已变化。请开始新一轮后重新发送。')
    // A process may have stopped after the raw package became durable but
    // before round.json. Recover the same bytes; never replace them with a
    // differently formatted or stale retry payload.
    const originalWriteTime = (await stat(roundPackagePath)).mtime.toISOString()
    const artifacts = await persistArtifacts()
    const engine = await compileCore(roundPackagePath)
    const manifest = { package_id: packageId, content_sha256: existingPackage.contentSha, exported_at: originalWriteTime, duration_ms: durationMs, status: engine.ok ? 'engine_compiled' : 'engine_compile_failed', retryable: !engine.ok, engine }
    await writeFileAtomically(resolve(roundPath, 'round.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    if (engine.ok) await repairLatest({ roundPath, latestPackagePath })
    return { roundPackagePath, engine, artifacts, manifest, reused: false, recovered: true }
  }

  await mkdir(roundPath, { recursive: true })
  await writeFileAtomically(roundPackagePath, serializedPackage)
  const artifacts = await persistArtifacts()
  const engine = await compileCore(roundPackagePath)
  const manifest = { package_id: packageId, content_sha256: contentSha, exported_at: now(), duration_ms: durationMs, status: engine.ok ? 'engine_compiled' : 'engine_compile_failed', retryable: !engine.ok, engine }
  await writeFileAtomically(resolve(roundPath, 'round.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (engine.ok) await repairLatest({ roundPath, latestPackagePath })
  return { roundPackagePath, engine, artifacts, manifest, reused: false }
}
