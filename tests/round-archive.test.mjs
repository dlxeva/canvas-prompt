import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { archiveCompiledRound, contentSha256 } from '../app/round-archive.mjs'
import { mutateRound } from '../app/round-store.mjs'

async function archive(root, id, ok) {
  return archiveCompiledRound({
    roundPath: resolve(root, 'rounds', id), latestPackagePath: resolve(root, 'latest-prompt-package.json'),
    serializedPackage: JSON.stringify({ meta: { package_id: id } }), packageId: id,
    persistArtifacts: async () => ({ snapshotPath: null }),
    compileCore: async () => ok ? { ok: true } : { ok: false, error: 'compiler failed' },
    now: () => `2026-07-25T00:00:${String(id.charCodeAt(id.length - 1) - 97).padStart(2, '0')}.000Z`,
  })
}

test('A/B archives keep immutable packages while latest advances only after successful compilation', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-round-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await archive(root, 'round_a', true)
  await archive(root, 'round_b', true)
  await archive(root, 'round_c', false)
  assert.equal(JSON.parse(await readFile(resolve(root, 'latest-prompt-package.json'))).meta.package_id, 'round_b')
  assert.equal(JSON.parse(await readFile(resolve(root, 'rounds/round_a/prompt-package.json'))).meta.package_id, 'round_a')
  assert.equal(JSON.parse(await readFile(resolve(root, 'rounds/round_b/prompt-package.json'))).meta.package_id, 'round_b')
  assert.equal(JSON.parse(await readFile(resolve(root, 'rounds/round_c/round.json'))).status, 'engine_compile_failed')
})

test('corrupt or non-object manifests cannot reopen an immutable round', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-corrupt-manifest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await archive(root, 'round_a', true)
  const roundPath = resolve(root, 'rounds/round_a')
  const original = await readFile(resolve(roundPath, 'prompt-package.json'))
  for (const value of ['{broken', 'null', 'false', '[]']) {
    await writeFile(resolve(roundPath, 'round.json'), value)
    await assert.rejects(archive(root, 'round_a', true), { code: 'ROUND_INCOMPLETE' })
    await assert.rejects(mutateRound(roundPath, () => assert.fail('must not write')), { code: 'ROUND_INCOMPLETE' })
    assert.deepEqual(await readFile(resolve(roundPath, 'prompt-package.json')), original)
  }
})

test('a damaged deletion tombstone still prevents resurrection', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-corrupt-tombstone-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(resolve(root, 'deleted-rounds'))
  await writeFile(resolve(root, 'deleted-rounds/round_a.json'), '')
  await assert.rejects(archive(root, 'round_a', true), { code: 'ROUND_GONE' })
})

test('a raw-only round recovers without rewriting bytes, while changed or corrupt raw fails closed', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-raw-only-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const roundPath = resolve(root, 'rounds/round_raw')
  const latestPackagePath = resolve(root, 'latest-prompt-package.json')
  await mkdir(roundPath, { recursive: true })
  const raw = '{\n  "meta": { "package_id": "round_raw" },\n  "value": 1\n}\n'
  await writeFile(resolve(roundPath, 'prompt-package.json'), raw)
  let persisted = 0
  let compiled = 0
  const options = {
    roundPath,
    latestPackagePath,
    serializedPackage: JSON.stringify({ meta: { package_id: 'round_raw' }, value: 1 }),
    packageId: 'round_raw',
    persistArtifacts: async () => { persisted += 1; return { snapshotPath: null } },
    compileCore: async () => { compiled += 1; return { ok: true } },
    now: () => '2026-07-25T00:00:00.000Z',
  }
  const recovered = await archiveCompiledRound(options)
  assert.equal(recovered.recovered, true)
  assert.equal(await readFile(resolve(roundPath, 'prompt-package.json'), 'utf8'), raw)
  assert.equal(JSON.parse(await readFile(resolve(roundPath, 'round.json'), 'utf8')).content_sha256, contentSha256(raw))
  assert.equal(persisted, 1)
  assert.equal(compiled, 1)

  await rm(resolve(roundPath, 'round.json'))
  const original = await readFile(resolve(roundPath, 'prompt-package.json'))
  await assert.rejects(archiveCompiledRound({ ...options, serializedPackage: JSON.stringify({ meta: { package_id: 'round_raw' }, value: 2 }) }), { code: 'ROUND_CONTENT_CONFLICT' })
  assert.deepEqual(await readFile(resolve(roundPath, 'prompt-package.json')), original)

  await writeFile(resolve(roundPath, 'prompt-package.json'), '{broken')
  await assert.rejects(archiveCompiledRound(options), { code: 'ROUND_INCOMPLETE' })
  assert.equal(await readFile(resolve(roundPath, 'prompt-package.json'), 'utf8'), '{broken')
})

test('a committed round with a raw/manifest hash mismatch fails closed without overwriting raw', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-hash-mismatch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await archive(root, 'round_hash', true)
  const roundPath = resolve(root, 'rounds/round_hash')
  const packagePath = resolve(roundPath, 'prompt-package.json')
  const corrupted = JSON.stringify({ meta: { package_id: 'round_hash' }, changed: true })
  await writeFile(packagePath, corrupted)
  await assert.rejects(archive(root, 'round_hash', true), { code: 'ROUND_INCOMPLETE' })
  assert.equal(await readFile(packagePath, 'utf8'), corrupted)
})

test('reused success repairs missing or stale latest but cannot roll latest back to an older round', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-latest-repair-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const latestPackagePath = resolve(root, 'latest-prompt-package.json')
  await archive(root, 'round_a', true)
  await archive(root, 'round_b', true)
  const roundA = await readFile(resolve(root, 'rounds/round_a/prompt-package.json'))
  const roundB = await readFile(resolve(root, 'rounds/round_b/prompt-package.json'))
  assert.deepEqual(await readFile(latestPackagePath), roundB)

  await rm(latestPackagePath)
  await archive(root, 'round_b', true)
  assert.deepEqual(await readFile(latestPackagePath), roundB)

  await writeFile(latestPackagePath, roundA)
  await archive(root, 'round_a', true)
  assert.deepEqual(await readFile(latestPackagePath), roundB)
})

test('raw-only recovery retains original write time and cannot displace a later successful round', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'canvas-old-raw-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const roundPath = resolve(root, 'rounds/round_a')
  await mkdir(roundPath, { recursive: true })
  const raw = JSON.stringify({ meta: { package_id: 'round_a' } })
  await writeFile(resolve(roundPath, 'prompt-package.json'), raw)
  const originalTime = new Date('2026-07-25T00:00:00.000Z')
  await utimes(resolve(roundPath, 'prompt-package.json'), originalTime, originalTime)
  await archive(root, 'round_b', true)
  const recovered = await archiveCompiledRound({
    roundPath, latestPackagePath: resolve(root, 'latest-prompt-package.json'),
    serializedPackage: raw, packageId: 'round_a',
    persistArtifacts: async () => ({}), compileCore: async () => ({ ok: true }),
    now: () => '2026-07-25T00:10:00.000Z',
  })
  assert.equal(recovered.manifest.exported_at, originalTime.toISOString())
  assert.equal(JSON.parse(await readFile(resolve(root, 'latest-prompt-package.json'))).meta.package_id, 'round_b')
})
