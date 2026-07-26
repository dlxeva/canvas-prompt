import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { deleteRoundAndUpdateLatest } from '../app/round-store.mjs'
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

async function submit(options, startHandoff, retryHandoff = false) {
  return await submitImmutableRound({
    archiveOptions: options,
    retryHandoff,
    persistArchive: async () => undefined,
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
