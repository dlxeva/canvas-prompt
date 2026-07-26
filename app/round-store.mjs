import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cancelRoundHandoff, clearRoundHandoffCancellation } from './round-lifecycle.mjs'

function temporaryPath(path) {
  return `${path}.${process.pid}.${randomUUID()}.tmp`
}

export async function writeFileAtomically(path, contents) {
  const temporary = temporaryPath(path)
  await writeFile(temporary, contents, 'utf8')
  await rename(temporary, path)
}

async function tryRead(path) {
  try { return await readFile(path, 'utf8') } catch { return null }
}

async function replacementRound(roundsDir, removedPackageId) {
  const entries = await readdir(roundsDir, { withFileTypes: true }).catch(() => [])
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === removedPackageId) continue
    const roundPath = resolve(roundsDir, entry.name)
    const manifest = await tryRead(resolve(roundPath, 'round.json'))
    const packageContents = await tryRead(resolve(roundPath, 'prompt-package.json'))
    if (!manifest || !packageContents) continue
    try {
      const parsed = JSON.parse(manifest)
      // A failed or incomplete compile must never become the active latest
      // round merely because a newer successful round was deleted.
      if (parsed?.engine?.ok !== true) continue
      candidates.push({ exportedAt: String(parsed.exported_at ?? ''), packageContents })
    } catch {
      // An incomplete archive is never promoted to the latest pointer.
    }
  }
  candidates.sort((left, right) => right.exportedAt.localeCompare(left.exportedAt))
  return candidates[0]?.packageContents ?? null
}

/** Keep mutable latest consistent with immutable per-round storage on deletion. */
export async function deleteRoundAndUpdateLatest({ roundsDir, latestPackagePath, packageId }) {
  const roundPath = resolve(roundsDir, packageId)
  const tombstonesDir = resolve(roundsDir, '..', 'deleted-rounds')
  const tombstonePath = resolve(tombstonesDir, `${packageId}.json`)
  // Register cancellation before touching the filesystem. Any completion,
  // timeout, or child-exit event already in flight becomes a no-op.
  cancelRoundHandoff(roundPath)

  const latestContents = await tryRead(latestPackagePath)
  let latestPackageId = null
  let latestChanged = false
  try {
    if (latestContents) {
      try { latestPackageId = JSON.parse(latestContents)?.meta?.package_id ?? null } catch { /* invalid latest is not promoted */ }
    }
    if (latestPackageId === packageId) {
      const replacement = await replacementRound(roundsDir, packageId)
      if (replacement) await writeFileAtomically(latestPackagePath, replacement)
      else await unlink(latestPackagePath).catch((error) => { if (error?.code !== 'ENOENT') throw error })
      latestChanged = true
    }
    // Preserve a small tombstone outside the immutable Round directory. A
    // deleted package ID must never be silently resurrected by a stale retry.
    await mkdir(tombstonesDir, { recursive: true })
    await writeFileAtomically(tombstonePath, `${JSON.stringify({ package_id: packageId, deleted_at: new Date().toISOString() }, null, 2)}\n`)
    await rm(roundPath, { recursive: true, force: false })
  } catch (error) {
    // The round still exists when deletion fails, so allow its active handoff
    // to keep reporting status after restoring the mutable latest pointer.
    if (latestChanged && latestContents) await writeFileAtomically(latestPackagePath, latestContents)
    await unlink(tombstonePath).catch(() => undefined)
    clearRoundHandoffCancellation(roundPath)
    throw error
  }
}
