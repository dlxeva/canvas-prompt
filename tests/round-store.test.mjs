import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { deleteRoundAndUpdateLatest, writeFileAtomically } from '../app/round-store.mjs'

async function setupRound(root, id, exportedAt, transcript, engineOk = true) {
  const path = resolve(root, 'rounds', id)
  await mkdir(path, { recursive: true })
  await writeFile(resolve(path, 'prompt-package.json'), JSON.stringify({ meta: { package_id: id }, transcript: { full_text: transcript } }))
  await writeFile(resolve(path, 'round.json'), JSON.stringify({ package_id: id, exported_at: exportedAt, engine: { ok: engineOk } }))
}

test('deleting a non-latest round leaves latest unchanged', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const latest = resolve(root, 'latest-prompt-package.json')
  await setupRound(root, 'round_a', '2026-01-01T00:00:00.000Z', 'A-only')
  await setupRound(root, 'round_b', '2026-01-02T00:00:00.000Z', 'B-only')
  await writeFile(latest, await readFile(resolve(root, 'rounds/round_b/prompt-package.json')))
  await deleteRoundAndUpdateLatest({ roundsDir: resolve(root, 'rounds'), latestPackagePath: latest, packageId: 'round_a' })
  assert.equal(JSON.parse(await readFile(latest, 'utf8')).meta.package_id, 'round_b')
})

test('deleting latest rewinds it and deleting the only round removes it', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const latest = resolve(root, 'latest-prompt-package.json')
  await setupRound(root, 'round_a', '2026-01-01T00:00:00.000Z', 'unique-A')
  await setupRound(root, 'round_b', '2026-01-02T00:00:00.000Z', 'unique-B')
  await writeFile(latest, await readFile(resolve(root, 'rounds/round_b/prompt-package.json')))
  await deleteRoundAndUpdateLatest({ roundsDir: resolve(root, 'rounds'), latestPackagePath: latest, packageId: 'round_b' })
  assert.equal(JSON.parse(await readFile(latest, 'utf8')).meta.package_id, 'round_a')
  await deleteRoundAndUpdateLatest({ roundsDir: resolve(root, 'rounds'), latestPackagePath: latest, packageId: 'round_a' })
  await assert.rejects(readFile(latest, 'utf8'), { code: 'ENOENT' })
})

test('latest fallback skips newer rounds whose engine compile failed', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const latest = resolve(root, 'latest-prompt-package.json')
  await setupRound(root, 'round_success', '2026-01-01T00:00:00.000Z', 'successful', true)
  await setupRound(root, 'round_failed', '2026-01-02T00:00:00.000Z', 'failed', false)
  await setupRound(root, 'round_latest', '2026-01-03T00:00:00.000Z', 'latest', true)
  await writeFile(latest, await readFile(resolve(root, 'rounds/round_latest/prompt-package.json')))
  await deleteRoundAndUpdateLatest({ roundsDir: resolve(root, 'rounds'), latestPackagePath: latest, packageId: 'round_latest' })
  assert.equal(JSON.parse(await readFile(latest, 'utf8')).meta.package_id, 'round_success')
})

test('concurrent atomic writes use collision-proof temporary paths', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = resolve(root, 'latest-prompt-package.json')
  await Promise.all([
    writeFileAtomically(target, 'first'),
    writeFileAtomically(target, 'second'),
    writeFileAtomically(target, 'third'),
  ])
  assert.ok(['first', 'second', 'third'].includes(await readFile(target, 'utf8')))
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), [])
})
