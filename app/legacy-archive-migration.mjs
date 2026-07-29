import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileAtomically } from './round-store.mjs'

const SAFE_PACKAGE_ID = /^[A-Za-z0-9_-]{1,128}$/
const COMPLETE_ROUND_STATUSES = new Set(['engine_compiled', 'handoff_accepted'])

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

async function directory(path) {
  try { return (await readdir(path, { withFileTypes: true })).length >= 0 } catch { return false }
}

export function resolveLegacyArchive(from) {
  const input = resolve(from)
  if (basename(input) === 'rounds') return resolve(input, '..')
  if (basename(input) === '.canvas-prompt') return input
  return resolve(input, '.canvas-prompt')
}

async function completedRounds(roundsDir) {
  const entries = await readdir(roundsDir, { withFileTypes: true })
  const complete = []
  const skipped = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_PACKAGE_ID.test(entry.name)) continue
    const roundPath = resolve(roundsDir, entry.name)
    const [manifest, packageJson] = await Promise.all([
      readJson(resolve(roundPath, 'round.json')),
      readJson(resolve(roundPath, 'prompt-package.json')),
    ])
    if (!COMPLETE_ROUND_STATUSES.has(manifest?.status) || packageJson?.meta?.package_id !== entry.name) {
      skipped.push(entry.name)
      continue
    }
    complete.push(entry.name)
  }
  return { complete, skipped }
}

async function samePackage(sourceRound, destinationRound) {
  try {
    const [source, destination] = await Promise.all([
      readFile(resolve(sourceRound, 'prompt-package.json')),
      readFile(resolve(destinationRound, 'prompt-package.json')),
    ])
    return source.equals(destination)
  } catch {
    return false
  }
}

/**
 * Copy complete legacy project archives into the private single-board archive.
 * Never scans for sources, never deletes the source, and preflights every
 * collision before any destination round is changed.
 */
export async function migrateLegacyArchive({ from, boardDir }) {
  const sourceArchive = resolveLegacyArchive(from)
  const destinationArchive = resolve(boardDir)
  if (sourceArchive === destinationArchive) throw new Error('The selected archive is already the active single-board archive.')
  const sourceRounds = resolve(sourceArchive, 'rounds')
  if (!await directory(sourceRounds)) throw new Error(`No legacy Canvas Prompt archive found at: ${sourceArchive}`)

  const { complete, skipped } = await completedRounds(sourceRounds)
  if (complete.length === 0) throw new Error('The selected archive contains no complete Canvas Prompt rounds to copy.')

  const destinationRounds = resolve(destinationArchive, 'rounds')
  await mkdir(destinationRounds, { recursive: true })
  const conflicts = []
  const existing = []
  const pending = []
  for (const packageId of complete) {
    const sourceRound = resolve(sourceRounds, packageId)
    const destinationRound = resolve(destinationRounds, packageId)
    if (!existsSync(destinationRound)) {
      pending.push(packageId)
    } else if (await samePackage(sourceRound, destinationRound)) {
      existing.push(packageId)
    } else {
      conflicts.push(packageId)
    }
  }
  if (conflicts.length) throw new Error(`Migration stopped: ${conflicts.length} conflicting package ID(s): ${conflicts.join(', ')}. Nothing was copied.`)

  for (const packageId of pending) {
    const sourceRound = resolve(sourceRounds, packageId)
    const temporaryRound = resolve(destinationRounds, `.migrating-${packageId}-${randomUUID()}`)
    const destinationRound = resolve(destinationRounds, packageId)
    try {
      await cp(sourceRound, temporaryRound, { recursive: true, errorOnExist: true, force: false })
      await rename(temporaryRound, destinationRound)
    } catch (error) {
      await rm(temporaryRound, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  let latestUpdated = false
  const destinationLatest = resolve(destinationArchive, 'latest-prompt-package.json')
  const sourceLatest = await readJson(resolve(sourceArchive, 'latest-prompt-package.json'))
  const sourceLatestId = sourceLatest?.meta?.package_id
  if (!existsSync(destinationLatest) && typeof sourceLatestId === 'string' && complete.includes(sourceLatestId)) {
    await writeFileAtomically(destinationLatest, `${JSON.stringify(sourceLatest, null, 2)}\n`)
    latestUpdated = true
  }

  const recordDir = resolve(destinationArchive, 'migrations')
  await mkdir(recordDir, { recursive: true })
  const recordPath = resolve(recordDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`)
  await writeFile(recordPath, `${JSON.stringify({
    schema_version: 1,
    copied_at: new Date().toISOString(),
    source_archive: sourceArchive,
    copied_package_ids: pending,
    already_present_package_ids: existing,
    skipped_incomplete_package_ids: skipped,
    latest_updated: latestUpdated,
  }, null, 2)}\n`, 'utf8')

  return { sourceArchive, destinationArchive, copied: pending, alreadyPresent: existing, skippedIncomplete: skipped, latestUpdated, recordPath }
}
