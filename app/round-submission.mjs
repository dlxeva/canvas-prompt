import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { archiveCompiledRound, contentSha256, RoundSubmissionError, updateRoundManifest } from './round-archive.mjs'
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
    // A successful immutable round may have lost only its derived archive
    // metadata during a crash. The callback is required to be idempotent and
    // to fill only missing files; artifacts is intentionally null here.
    await persistArchive(archived)
    const existingHandoff = await readExistingHandoff(roundPath)
    const failedBeforeAcceptance = existingHandoff?.accepted === false && ['failed', 'timed_out'].includes(existingHandoff?.status)
    const canExplicitlyRetry = retryHandoff && archived.engine?.ok === true && failedBeforeAcceptance
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
  const contentSha = contentSha256(options.archiveOptions.serializedPackage)
  const active = inFlightSubmissions.get(key)
  if (active) {
    if (active.contentSha !== contentSha) throw new RoundSubmissionError('ROUND_CONTENT_CONFLICT', '同一轮的内容已变化。请开始新一轮后重新发送。')
    return await active.work
  }
  const work = withRoundLock(key, () => submitImmutableRoundOnce(options))
  const entry = { work, contentSha }
  inFlightSubmissions.set(key, entry)
  try {
    return await work
  } finally {
    if (inFlightSubmissions.get(key) === entry) inFlightSubmissions.delete(key)
  }
}
