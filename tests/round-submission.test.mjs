import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { deleteRoundAndUpdateLatest, mutateRound, withLatestLock } from '../app/round-store.mjs'
import { RoundSubmissionError } from '../app/round-archive.mjs'
import { submitImmutableRound } from '../app/round-submission.mjs'

async function fixture(root, packageId = 'round_a', payload = { meta: { package_id: packageId }, value: 1 }) {
  const roundPath = resolve(root, 'rounds', packageId)
  return {
    roundPath,
    latestPackagePath: resolve(root, 'latest-prompt-package.json'),
    serializedPackage: `${JSON.stringify(payload)}\n`,
    packageId,
    durationMs: 10,
    persistArtifacts: async () => ({ snapshotPath: null, keyframePaths: [], rawTraceManifest: null }),
    compileCore: async () => ({ ok: true, process_ir_path: 'engine/process-ir.json' }),
  }
}

async function submit(options, startHandoff, retryHandoff = false, persistArchive = async () => undefined) {
  return await submitImmutableRound({
    archiveOptions: options,
    retryHandoff,
    persistArchive,
    startHandoff,
  })
}

test('same immutable package is idempotent and never starts a second Codex turn', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-submit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root)
  let turns = 0
  const startHandoff = async () => ({ status: 'accepted', attempted: true, accepted: true, delivered: false, handoff_attempt_id: `attempt-${++turns}` })
  const first = await submit(options, startHandoff)
  const second = await submit(options, startHandoff)
  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(second.handoff.status, 'accepted')
  assert.equal(turns, 1)
})

test('a metadata failure after commit is repaired on retry without reopening an ambiguous handoff', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-metadata-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root, 'round_metadata')
  let metadataCalls = 0
  let turns = 0
  const seenArtifacts = []
  const persistArchive = async (archived) => {
    seenArtifacts.push(archived.artifacts)
    metadataCalls += 1
    if (metadataCalls === 1) throw new Error('metadata write interrupted')
    await writeFile(resolve(options.roundPath, 'archive.json'), 'rebuilt')
  }
  const startHandoff = async () => {
    turns += 1
    return { status: 'accepted', attempted: true, accepted: true, delivered: false }
  }

  await assert.rejects(submit(options, startHandoff, false, persistArchive), /metadata write interrupted/)
  assert.equal(turns, 0)
  assert.equal(JSON.parse(await readFile(resolve(options.roundPath, 'round.json'))).engine.ok, true)
  assert.equal(await readFile(resolve(options.roundPath, 'archive.json')).catch(() => null), null)

  const recovered = await submit(options, startHandoff, false, persistArchive)
  assert.equal(recovered.reused, true)
  assert.equal(recovered.handoff, null)
  assert.equal(turns, 0)
  assert.equal(metadataCalls, 2)
  assert.ok(seenArtifacts[0])
  assert.equal(seenArtifacts[1], null)
  assert.equal(await readFile(resolve(options.roundPath, 'archive.json'), 'utf8'), 'rebuilt')
})

test('a failed compile stays retryable and preserves independently archived audio', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-retry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root, 'round_retry')
  let compiles = 0
  options.persistArtifacts = async () => {
    await writeFile(resolve(options.roundPath, 'audio.webm'), 'authoritative audio')
    return { snapshotPath: null, keyframePaths: [], rawTraceManifest: null }
  }
  options.compileCore = async () => compiles++ === 0
    ? { ok: false, error: 'compiler unavailable' }
    : { ok: true, process_ir_path: 'engine/process-ir.json' }
  const startHandoff = async () => ({ status: 'archived', attempted: false, accepted: false, delivered: false })

  const failed = await submit(options, startHandoff)
  assert.equal(failed.engine.ok, false)
  assert.equal(failed.manifest.retryable, true)
  assert.equal(await readFile(resolve(options.roundPath, 'audio.webm'), 'utf8'), 'authoritative audio')
  assert.equal(await readFile(options.latestPackagePath).catch(() => null), null)

  const retried = await submit(options, startHandoff)
  assert.equal(retried.reused, false)
  assert.equal(retried.engine.ok, true)
  assert.equal(compiles, 2)
  assert.equal(await readFile(resolve(options.roundPath, 'audio.webm'), 'utf8'), 'authoritative audio')
  assert.deepEqual(JSON.parse(await readFile(options.latestPackagePath)), { meta: { package_id: 'round_retry' }, value: 1 })
})

test('concurrent duplicate POSTs coalesce before the immutable archive exists', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-submit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root)
  let turns = 0
  const startHandoff = async () => {
    turns += 1
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    return { status: 'accepted', attempted: true, accepted: true, delivered: false, handoff_attempt_id: 'attempt-concurrent' }
  }
  const [first, second] = await Promise.all([submit(options, startHandoff), submit(options, startHandoff)])
  assert.equal(turns, 1)
  assert.equal(first.handoff.handoff_attempt_id, 'attempt-concurrent')
  assert.equal(second.handoff.handoff_attempt_id, 'attempt-concurrent')
})

test('accepted timeout is still accepted and cannot be retried into a duplicate turn', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-submit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root)
  let turns = 0
  const startHandoff = async () => ({ status: 'accepted_timeout', attempted: true, accepted: true, delivered: false, handoff_attempt_id: `attempt-${++turns}` })
  await submit(options, startHandoff)
  const repeated = await submit(options, startHandoff, true)
  assert.equal(repeated.handoff.status, 'accepted_timeout')
  assert.equal(turns, 1)
})

test('only an explicit retry after pre-accept failure starts a new attempt', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-submit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root)
  let turns = 0
  const startHandoff = async () => {
    turns += 1
    return turns === 1
      ? { status: 'failed', attempted: true, accepted: false, delivered: false, handoff_attempt_id: 'attempt-1' }
      : { status: 'accepted', attempted: true, accepted: true, delivered: false, handoff_attempt_id: 'attempt-2' }
  }
  await submit(options, startHandoff)
  const repeated = await submit(options, startHandoff, true)
  assert.equal(repeated.handoff.handoff_attempt_id, 'attempt-2')
  assert.equal(turns, 2)
  const attempts = await readFile(resolve(options.roundPath, 'round.json'), 'utf8')
  assert.equal(JSON.parse(attempts).handoff.handoff_attempt_id, 'attempt-2')
  assert.equal(JSON.parse(await readFile(resolve(options.roundPath, 'handoff-attempts', 'attempt-1.json'), 'utf8')).status, 'failed')
  assert.equal(JSON.parse(await readFile(resolve(options.roundPath, 'handoff-attempts', 'attempt-2.json'), 'utf8')).status, 'accepted')
})

test('same ID with different contents conflicts and a deleted ID is gone', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-submit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root)
  await submit(options, async () => ({ status: 'accepted', attempted: true, accepted: true, delivered: false }))
  const conflicting = { ...options, serializedPackage: `${JSON.stringify({ meta: { package_id: 'round_a' }, value: 2 })}\n` }
  await assert.rejects(() => submit(conflicting, async () => ({ status: 'accepted', attempted: true, accepted: true, delivered: false })), (error) => error instanceof RoundSubmissionError && error.code === 'ROUND_CONTENT_CONFLICT')
  await deleteRoundAndUpdateLatest({ roundsDir: resolve(root, 'rounds'), latestPackagePath: options.latestPackagePath, packageId: 'round_a' })
  await assert.rejects(() => submit(options, async () => ({ status: 'accepted', attempted: true, accepted: true, delivered: false })), (error) => error instanceof RoundSubmissionError && error.code === 'ROUND_GONE')
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('a media upload waits for commit and cannot append to the committed round', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root)
  const entered = deferred()
  const release = deferred()
  options.compileCore = async () => { entered.resolve(); await release.promise; return { ok: true } }
  const commit = submit(options, async () => ({ status: 'archived' }))
  await entered.promise
  let wrote = false
  const upload = mutateRound(options.roundPath, async () => { wrote = true })
  const rejected = assert.rejects(upload, { code: 'ROUND_COMMITTED' })
  release.resolve()
  await commit
  await rejected
  assert.equal(wrote, false)
})

test('commit waits for an in-flight upload, and delete cannot resurrect a round', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root)
  const entered = deferred()
  const release = deferred()
  const upload = mutateRound(options.roundPath, async () => { entered.resolve(); await release.promise })
  await entered.promise
  let compiled = false
  options.compileCore = async () => { compiled = true; return { ok: true } }
  const commit = submit(options, async () => ({ status: 'archived' }))
  await new Promise((done) => setImmediate(done))
  assert.equal(compiled, false)
  release.resolve()
  await Promise.all([upload, commit])
  await deleteRoundAndUpdateLatest({ roundsDir: resolve(root, 'rounds'), latestPackagePath: options.latestPackagePath, packageId: options.packageId })
  await assert.rejects(mutateRound(options.roundPath, async () => {}), { code: 'ROUND_GONE' })
  await assert.rejects(submit(options, async () => ({})), { code: 'ROUND_GONE' })
})

test('deletion waits for latest-pointer writes from a different round', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const a = await fixture(root, 'round_a')
  await submit(a, async () => ({ status: 'archived' }))
  const entered = deferred()
  const release = deferred()
  const latestUpdate = withLatestLock(a.latestPackagePath, async () => {
    entered.resolve(); await release.promise
    await writeFile(a.latestPackagePath, JSON.stringify({ meta: { package_id: 'round_b' } }))
  })
  await entered.promise
  const deleting = deleteRoundAndUpdateLatest({ roundsDir: resolve(root, 'rounds'), latestPackagePath: a.latestPackagePath, packageId: 'round_a' })
  release.resolve()
  await Promise.all([latestUpdate, deleting])
  assert.equal(JSON.parse(await readFile(a.latestPackagePath)).meta.package_id, 'round_b')
})

test('concurrent same-ID different content is rejected instead of coalesced', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-conflict-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root)
  const entered = deferred()
  const release = deferred()
  options.compileCore = async () => { entered.resolve(); await release.promise; return { ok: true } }
  const first = submit(options, async () => ({ status: 'archived' }))
  await entered.promise
  try {
    await assert.rejects(submit({ ...options, serializedPackage: JSON.stringify({ meta: { package_id: options.packageId }, changed: true }) }, async () => ({})), { code: 'ROUND_CONTENT_CONFLICT' })
  } finally { release.resolve(); await first }
})

test('missing or ambiguous handoff evidence never authorizes another turn', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-unknown-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = await fixture(root)
  let turns = 0
  const startHandoff = async () => { turns++; return { status: 'accepted', accepted: true } }
  await submit(options, startHandoff)
  for (const receipt of [null, { status: 'failed' }, { status: 'pending', accepted: false }]) {
    await submitImmutableRound({ archiveOptions: options, retryHandoff: true, persistArchive: async () => {}, startHandoff, readExistingHandoff: async () => receipt })
  }
  assert.equal(turns, 1)
})
