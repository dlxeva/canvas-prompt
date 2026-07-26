import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = async (path) => JSON.parse(await readFile(resolve(rootDir, path), 'utf8'))
const readText = async (path) => readFile(resolve(rootDir, path), 'utf8')
const stableSemVer = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const failures = []

const rootPackage = await readJson('package.json')
const rootLock = await readJson('package-lock.json')
const pluginManifest = await readJson('.codex-plugin/plugin.json')
const appPackage = await readJson('app/package.json')
const appLock = await readJson('app/package-lock.json')
const runtimeSource = await readText('app/vite.config.ts')
const mcpSource = await readText('mcp/server.mjs')
const handoffSource = await readText('app/codex-main-thread-handoff.mjs')
const expectedVersion = rootPackage.version
const cachebusterVersion = new RegExp(`^${expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\+codex\\.[A-Za-z0-9.-]+$`)

function sourceVersion(label, source, pattern) {
  const match = source.match(pattern)
  if (!match) {
    failures.push(`${label}: version marker not found`)
    return null
  }
  return match[1]
}

const versions = [
  ['root package', rootPackage.version],
  ['root lockfile', rootLock.version],
  ['root lockfile package', rootLock.packages?.['']?.version],
  ['plugin manifest', pluginManifest.version],
  ['app package', appPackage.version],
  ['app lockfile', appLock.version],
  ['app lockfile package', appLock.packages?.['']?.version],
  ['runtime service', sourceVersion('runtime service', runtimeSource, /service_version:\s*['"]([^'"]+)['"]/)],
  ['MCP server', sourceVersion('MCP server', mcpSource, /const SERVER_INFO\s*=\s*\{[\s\S]*?version:\s*['"]([^'"]+)['"]/)],
  ['handoff client', sourceVersion('handoff client', handoffSource, /clientInfo:\s*\{\s*name:\s*['"]canvas-prompt-handoff['"],\s*version:\s*['"]([^'"]+)['"]/)],
]

for (const [label, version] of versions) {
  const isPluginCachebuster = label === 'plugin manifest' && typeof version === 'string' && cachebusterVersion.test(version)
  if (typeof version !== 'string' || (!stableSemVer.test(version) && !isPluginCachebuster)) {
    failures.push(`${label}: expected stable SemVer, found ${JSON.stringify(version)}`)
  } else if (version !== expectedVersion && !isPluginCachebuster) {
    failures.push(`${label}: expected ${expectedVersion}, found ${version}`)
  }
}

if (failures.length) {
  console.error(`Release version verification failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Release version verified: ${expectedVersion} (${versions.length} identities)`)
}
