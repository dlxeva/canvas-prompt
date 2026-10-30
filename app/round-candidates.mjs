import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
  }
  return value
}

export function contentSha256(serializedPackage) {
  const parsed = JSON.parse(serializedPackage)
  return createHash('sha256').update(JSON.stringify(canonicalValue(parsed))).digest('hex')
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function readJson(path) {
  const raw = await readOptional(path)
  if (raw === null) return null
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('Invalid round record')
  return value
}

async function readPackage(path) {
  const raw = await readOptional(path)
  if (raw === null) return null
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('Invalid round package')
  return { raw, value, contentSha: contentSha256(raw) }
}

/** Choose the newest intact, successful, non-deleted round for any latest update. */
export async function newestSuccessfulRound(roundsDir, excludedPackageId = null) {
  const entries = await readdir(roundsDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === excludedPackageId) continue
    try {
      const roundPath = resolve(roundsDir, entry.name)
      if (await readOptional(resolve(roundsDir, '..', 'deleted-rounds', `${entry.name}.json`)) !== null) continue
      const manifest = await readJson(resolve(roundPath, 'round.json'))
      if (manifest?.engine?.ok !== true) continue
      candidates.push({
        packageId: entry.name,
        exportedAt: String(manifest.exported_at ?? ''),
        roundPath,
        manifest,
      })
    } catch (error) {
      // A damaged candidate must never become latest, but it must not prevent
      // a different valid successful round from being selected.
      if (error instanceof SyntaxError) continue
      throw error
    }
  }
  candidates.sort((left, right) => {
    const byTime = right.exportedAt.localeCompare(left.exportedAt)
    return byTime || right.packageId.localeCompare(left.packageId)
  })
  // Only read the newest viable raw package. Reading every historical raw
  // package on every save makes archive cost grow with the user's lifetime data.
  for (const candidate of candidates) {
    try {
      const record = await readPackage(resolve(candidate.roundPath, 'prompt-package.json'))
      if (!record) continue
      if (typeof candidate.manifest.content_sha256 === 'string' && candidate.manifest.content_sha256 !== record.contentSha) continue
      const id = record.value?.meta?.package_id
      if (id !== undefined && id !== candidate.packageId) continue
      if (candidate.manifest.package_id !== undefined && candidate.manifest.package_id !== candidate.packageId) continue
      return { ...candidate, packageContents: record.raw }
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
  }
  return null
}
