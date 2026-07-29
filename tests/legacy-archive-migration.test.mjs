import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { migrateLegacyArchive, resolveLegacyArchive } from '../app/legacy-archive-migration.mjs'

const fixtureRound = async (archiveDir, packageId, content = packageId, status = 'engine_compiled') => {
  const roundDir = resolve(archiveDir, 'rounds', packageId)
  await mkdir(resolve(roundDir, 'engine'), { recursive: true })
  await writeFile(resolve(roundDir, 'prompt-package.json'), `${JSON.stringify({ meta: { package_id: packageId }, content })}\n`)
  await writeFile(resolve(roundDir, 'round.json'), `${JSON.stringify({ package_id: packageId, status })}\n`)
  await writeFile(resolve(roundDir, 'engine', 'compact-package.json'), '{}\n')
  await writeFile(resolve(roundDir, 'engine', 'process-ir.json'), '{}\n')
}

test('resolves either a legacy project or its archive directory', () => {
  assert.equal(resolveLegacyArchive('/tmp/project'), '/tmp/project/.canvas-prompt')
  assert.equal(resolveLegacyArchive('/tmp/project/.canvas-prompt'), '/tmp/project/.canvas-prompt')
  assert.equal(resolveLegacyArchive('/tmp/project/.canvas-prompt/rounds'), '/tmp/project/.canvas-prompt')
})

test('copies complete legacy rounds without deleting the source and seeds empty-board latest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-prompt-migrate-'))
  const project = resolve(root, 'legacy-project')
  const source = resolve(project, '.canvas-prompt')
  const board = resolve(root, 'home', '.canvas-prompt', 'board')
  await fixtureRound(source, 'pp_legacy_a')
  await writeFile(resolve(source, 'latest-prompt-package.json'), `${JSON.stringify({ meta: { package_id: 'pp_legacy_a' } })}\n`)

  const result = await migrateLegacyArchive({ from: project, boardDir: board })
  assert.deepEqual(result.copied, ['pp_legacy_a'])
  assert.equal(result.latestUpdated, true)
  assert.equal(existsSync(resolve(source, 'rounds', 'pp_legacy_a', 'prompt-package.json')), true)
  assert.equal(JSON.parse(await readFile(resolve(board, 'latest-prompt-package.json'), 'utf8')).meta.package_id, 'pp_legacy_a')

  const repeated = await migrateLegacyArchive({ from: source, boardDir: board })
  assert.deepEqual(repeated.copied, [])
  assert.deepEqual(repeated.alreadyPresent, ['pp_legacy_a'])
})

test('migrates a complete round after its Codex handoff was accepted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-prompt-migrate-handoff-'))
  const source = resolve(root, 'legacy-project', '.canvas-prompt')
  const board = resolve(root, 'home', '.canvas-prompt', 'board')
  await fixtureRound(source, 'pp_handoff_accepted', 'accepted content', 'handoff_accepted')
  await writeFile(resolve(source, 'latest-prompt-package.json'), `${JSON.stringify({ meta: { package_id: 'pp_handoff_accepted' } })}\n`)

  const result = await migrateLegacyArchive({ from: source, boardDir: board })
  assert.deepEqual(result.copied, ['pp_handoff_accepted'])
  assert.equal(result.latestUpdated, true)
  assert.equal(existsSync(resolve(board, 'rounds', 'pp_handoff_accepted', 'prompt-package.json')), true)
})

test('preflights conflicts and leaves all not-yet-copied rounds untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-prompt-migrate-conflict-'))
  const source = resolve(root, 'legacy', '.canvas-prompt')
  const board = resolve(root, 'home', '.canvas-prompt', 'board')
  await fixtureRound(source, 'pp_conflict', 'source')
  await fixtureRound(source, 'pp_pending')
  await fixtureRound(board, 'pp_conflict', 'different-destination')

  await assert.rejects(
    () => migrateLegacyArchive({ from: source, boardDir: board }),
    /Migration stopped: 1 conflicting package ID\(s\): pp_conflict/,
  )
  assert.equal(existsSync(resolve(board, 'rounds', 'pp_pending')), false)
})
