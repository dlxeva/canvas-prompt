import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { archiveCompiledRound, updateRoundManifest } from './round-archive.mjs'
import { withRoundLock, writeFileAtomically } from './round-store.mjs'

const inFlightSubmissions = new Map()

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

export async function readRoundHandoff(roundPath) {
  return await readJson(resolve(roundPath, 'handoff.json'))
}

export async function persistRoundHandoff(roundPath, handoff) {
  const receipt = `${JSON.stringify({ updated_at: new Date().toISOString(), ...handoff }, null, 2)}\n`
  await writeFileAtomically(resolve(roundPath, 'handoff.json'), receipt)
  if (typeof handoff?.handoff_attempt_id === 'string' && handoff.handoff_attempt_id) {
    const attemptsDir = resolve(roundPath, 'handoff-attempts')
    await mkdir(attemptsDir, { recursive: true })
    await writeFileAtomically(resolve(attemptsDir, `${handoff.handoff_attempt_id}.json`), receipt)
  }
}

function manifestPatch(engine, handoff) {
  return {
    status: engine.ok ? (handoff?.accepted ? 'handoff_accepted' : 'engine_compiled') : 'engine_compile_failed',
    handoff,
  }
}

/**
 * A package ID names one immutable round, not one browser request. Repeating
 * the same request must return its durable receipt and never start another
 * Codex turn. Only an explicit retry after a pre-accept failure may open a
 * second handoff attempt for the same archived content.
 */
async function submitImmutableRoundOnce({
  archiveOptions,
  retryHandoff = false,
  persistArchive,
  startHandoff,
  readExistingHandoff = readRoundHandoff,
}) {
  const archived = await archiveCompiledRound(archiveOptions)
  const { roundPath } = archiveOptions

  if (archived.reused) {
    const existingHandoff = await readExistingHandoff(roundPath)
    const canExplicitlyRetry = retryHandoff && archived.engine?.ok === true && existingHandoff?.accepted !== true
    if (!canExplicitlyRetry) {
      return { ...archived, handoff: existingHandoff, handoffStarted: false }
    }
    const handoff = await startHandoff({ ...archived, retry: true })
    await persistRoundHandoff(roundPath, handoff)
    const manifest = await updateRoundManifest(roundPath, manifestPatch(archived.engine, handoff))
    return { ...archived, manifest, handoff, handoffStarted: true }
  }

  await persistArchive(archived)
  const handoff = archived.engine.ok
    ? await startHandoff({ ...archived, retry: false })
    : { status: 'failed', attempted: false, accepted: false, delivered: false, reason: '核心引擎未完成编译' }
  await persistRoundHandoff(roundPath, handoff)
  const manifest = await updateRoundManifest(roundPath, manifestPatch(archived.engine, handoff))
  return { ...archived, manifest, handoff, handoffStarted: archived.engine.ok }
}

/** Coalesce duplicate POSTs that arrive before the first immutable write commits. */
export async function submitImmutableRound(options) {
  const key = resolve(options.archiveOptions.roundPath)
  const active = inFlightSubmissions.get(key)
  if (active) return await active
  const work = withRoundLock(key, () => submitImmutableRoundOnce(options))
  inFlightSubmissions.set(key, work)
  try {
    return await work
  } finally {
    if (inFlightSubmissions.get(key) === work) inFlightSubmissions.delete(key)
  }
}
