import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { archiveCompiledRound } from '../app/round-archive.mjs'

async function archive(root, id, ok) {
  return archiveCompiledRound({
    roundPath: resolve(root, 'rounds', id), latestPackagePath: resolve(root, 'latest-prompt-package.json'),
    serializedPackage: JSON.stringify({ meta: { package_id: id } }), packageId: id,
    persistArtifacts: async () => ({ snapshotPath: null }),
    compileCore: async () => ok ? { ok: true } : { ok: false, error: 'compiler failed' },
    now: () => `2026-07-25T00:00:0${id.at(-1)}.000Z`,
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
