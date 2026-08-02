#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolveConversationScope, threadScopeKey, validSessionId, validThreadId } from '../app/conversation-scope.mjs'
import { migrateLegacyArchive } from '../app/legacy-archive-migration.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const command = process.argv[2] ?? 'help'
const flag = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}
const conversationOnly = () => process.argv.includes('--conversation-only')
const threadId = () => flag('--thread-id') ?? process.env.CANVAS_PROMPT_CODEX_THREAD_ID ?? process.env.CANVAS_PROMPT_THREAD_ID ?? null
const sessionId = () => flag('--session-id') ?? process.env.CANVAS_PROMPT_SESSION_ID ?? null
const projectDir = ({ required = true } = {}) => {
  if (conversationOnly()) {
    return null
  }
  const candidate = resolve(flag('--project') ?? process.cwd())
  if (!existsSync(candidate)) throw new Error(`Project directory does not exist: ${candidate}`)
  return realpathSync(candidate)
}
// Plugin caches are replaced on update. The MCP reader must therefore live in
// the managed user runtime, not in a versioned cache path recorded by another
// host (for example Hermes).
const runtimeDir = () => resolve(process.env.CANVAS_PROMPT_RUNTIME_DIR ?? resolve(homedir(), '.canvas-prompt', 'runtime'))
const mcpRuntimeServerPath = () => resolve(runtimeDir(), 'mcp', 'server.mjs')
const ensureMcpRuntime = async () => {
  const targets = [
    ['mcp/server.mjs', resolve(runtimeDir(), 'mcp', 'server.mjs')],
    ['app/conversation-scope.mjs', resolve(runtimeDir(), 'app', 'conversation-scope.mjs')],
  ]
  await Promise.all(targets.map(async ([source, target]) => {
    await mkdir(dirname(target), { recursive: true })
    await copyFile(resolve(rootDir, source), target)
  }))
  return mcpRuntimeServerPath()
}
const mcpConfig = (project) => ({
  mcpServers: {
    canvas_prompt: {
      command: 'node',
      args: [mcpRuntimeServerPath()],
      env: {
        ...(project ? { CANVAS_PROMPT_PROJECT_DIR: project } : {}),
      },
    },
  },
})
// Keep the managed runtime outside the cache so an installed ASR environment
// and model can be reused across plugin versions without touching a user's
// global Python environment.
// This is a user interaction preference, not project or conversation state.
// Keep it outside project archives so "do not show this again" means the same
// thing when a person opens Canvas Prompt from another project.
const preferencesPath = () => resolve(process.env.CANVAS_PROMPT_PREFERENCES_PATH ?? resolve(homedir(), '.canvas-prompt', 'preferences.json'))
const sessionIndexPath = (id) => resolve(homedir(), '.canvas-prompt', 'session-index', `${threadScopeKey(id)}.json`)
const registerSession = async ({ id, project }) => {
  if (!validSessionId(id)) throw new Error('Canvas Prompt received an invalid session capability.')
  const path = sessionIndexPath(id)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ version: 1, session_id: id, project_dir: project, created_at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
}
const defaultPreferences = () => ({ schema_version: 1, show_launch_guidance: true })
const readPreferences = async () => {
  try {
    const candidate = JSON.parse(await readFile(preferencesPath(), 'utf8'))
    return {
      schema_version: 1,
      show_launch_guidance: candidate?.show_launch_guidance !== false,
    }
  } catch {
    return defaultPreferences()
  }
}
const writePreferences = async (preferences) => {
  const path = preferencesPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
}
const MANAGED_ASR_PORT_START = 18080
const MANAGED_ASR_PORT_END = 18100
const DEFAULT_MANAGED_ASR_PORT = String(MANAGED_ASR_PORT_START)
const asrUrl = (environment = process.env) => environment.CANVAS_PROMPT_ASR_URL ?? `http://127.0.0.1:${environment.CANVAS_PROMPT_ASR_PORT ?? DEFAULT_MANAGED_ASR_PORT}`
const runtimeEnvironment = (overrides = {}) => ({ ...process.env, ...overrides, CANVAS_PROMPT_RUNTIME_DIR: runtimeDir() })
const runBootstrap = (mode) => spawnSync('bash', [resolve(rootDir, 'scripts', 'bootstrap-runtime.sh'), mode], { stdio: 'inherit', env: runtimeEnvironment() })
const allowsExternalAsr = (environment = process.env) => environment.CANVAS_PROMPT_ALLOW_EXTERNAL_ASR === '1' || Boolean(environment.CANVAS_PROMPT_ASR_URL)
const probeAsr = async (environment = process.env) => {
  const endpoint = asrUrl(environment)
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1_500) })
    const value = response.ok ? await response.json() : null
    const ready = value?.status === 'ok'
      && value?.whisper_loaded !== false
      && (value?.canvas_prompt_asr === true || (allowsExternalAsr(environment) && (value?.backend === 'whisper' || value?.backend === 'faster-whisper')))
    return { endpoint, ready, response: value }
  } catch {
    return { endpoint, ready: false, response: null }
  }
}
const portInUse = (port) => spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' }).status === 0
const firstOpenAsrPort = () => {
  for (let port = MANAGED_ASR_PORT_START; port < MANAGED_ASR_PORT_END; port += 1) if (!portInUse(port)) return port
  throw new Error('Canvas Prompt could not find a free local ASR port between 18080 and 18099.')
}
const existingManagedAsrPort = async () => {
  const probes = await Promise.all(Array.from(
    { length: MANAGED_ASR_PORT_END - MANAGED_ASR_PORT_START },
    (_, index) => {
      const port = MANAGED_ASR_PORT_START + index
      return probeAsr({ CANVAS_PROMPT_ASR_PORT: String(port) }).then((result) => ({ port, ready: result.ready }))
    },
  ))
  return probes.find((probe) => probe.ready)?.port ?? null
}
const existingCanvasRuntime = async (project) => {
  for (let port = 43223; port < 43243; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runtime-identity`, { signal: AbortSignal.timeout(500) })
      const identity = response.ok ? await response.json() : null
      if (identity?.storage_kind === 'single_board' || identity?.project_dir === project) return { ...identity, port }
    } catch {
      // An occupied port is common. Only a matching Canvas runtime identity
      // may influence this project's ASR choice.
    }
  }
  return null
}
const localAsrPort = (endpoint) => {
  try {
    const url = new URL(endpoint)
    if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port) return url.port
  } catch {
    // A non-local endpoint is handled by the explicit environment contract.
  }
  return null
}
// A generic service on 8080 can be an older, slower ASR with a different
// lifecycle. Reuse only a Canvas Prompt-managed service by default; an
// explicit endpoint or opt-in flag remains available for advanced hosts.
const asrEnvironmentForOpen = async (project) => {
  if (process.env.CANVAS_PROMPT_ASR_URL) return {}
  // Reopening a project must reuse the exact ASR endpoint already published by
  // its healthy canvas. Choosing a new free port before noticing the reusable
  // canvas leaves an orphan ASR process and makes the readiness gate lie about
  // what the visible canvas will actually use.
  const existing = await existingCanvasRuntime(project)
  const existingPort = localAsrPort(existing?.asr_url)
  if (existingPort) return { CANVAS_PROMPT_ASR_PORT: existingPort }
  if (process.env.CANVAS_PROMPT_ASR_PORT) return {}
  // The managed runtime is shared across plugin-cache versions. Discover it
  // before picking a free port; otherwise each update leaks another ASR.
  const managedPort = await existingManagedAsrPort()
  if (managedPort) return { CANVAS_PROMPT_ASR_PORT: String(managedPort) }
  if (!portInUse(MANAGED_ASR_PORT_START)) return {}
  return { CANVAS_PROMPT_ASR_PORT: String(firstOpenAsrPort()) }
}
const help = () => console.log(`Canvas Prompt host-neutral entrypoint

Usage:
  canvas-prompt setup [--core-only]
  canvas-prompt open [--project <dir>] [--conversation-only] [--host codex|workbuddy|local]
  canvas-prompt read [--project <dir>]
  canvas-prompt read-artifact-review [--project <dir>]
  canvas-prompt init [--project <dir>] [--thread-id <id>] [--conversation-only]
  canvas-prompt doctor [--project <dir>] [--thread-id <id>] [--conversation-only]
  canvas-prompt migrate --from <legacy-project-or-.canvas-prompt-dir>
  canvas-prompt preferences [--guidance on|off]

setup installs Canvas Prompt-managed dependencies into its local runtime and
reuses validated existing dependencies. The local ASR model downloads on first
start. A supplied thread ID is provenance only, never inferred from project
history. init prints the single-board MCP configuration. migrate copies complete
legacy archives without deleting or scanning any source. read prints the latest
completed prompt package from the single active board. read-artifact-review
prints the latest compact PDF/PPTX review. Both use the same code paths as their
canvas_prompt MCP tools.`)

try {
  if (command === 'help' || command === '--help' || command === '-h') help()
  else if (command === 'preferences') {
    const guidance = flag('--guidance')
    if (guidance && guidance !== 'on' && guidance !== 'off') throw new Error('preferences --guidance must be on or off.')
    const preferences = await readPreferences()
    if (guidance) {
      preferences.show_launch_guidance = guidance === 'on'
      await writePreferences(preferences)
    }
    console.log(JSON.stringify(preferences, null, 2))
  }
  else if (command === 'migrate') {
    const from = flag('--from')
    if (!from) throw new Error('migrate requires --from <legacy-project-or-.canvas-prompt-dir>.')
    const scope = resolveConversationScope({ singleBoard: true })
    const result = await migrateLegacyArchive({ from, boardDir: scope.canvasDir })
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  }
  else {
    const project = projectDir()
    const boundThreadId = threadId()
    const suppliedSessionId = sessionId()
    if (boundThreadId && !validThreadId(boundThreadId)) throw new Error('Canvas Prompt received an invalid host thread ID.')
    if (suppliedSessionId && !validSessionId(suppliedSessionId)) throw new Error('Canvas Prompt received an invalid session capability.')
    const scope = resolveConversationScope({ projectDir: project, threadId: boundThreadId, sessionId: suppliedSessionId, singleBoard: true })
    if (command === 'setup') {
      await ensureMcpRuntime()
      const result = runBootstrap(flag('--core-only') ? '--core-only' : '--with-asr')
      process.exitCode = result.status ?? 1
    }
    else if (command === 'init') {
      await ensureMcpRuntime()
      console.log(JSON.stringify({ project_dir: project, storage_kind: scope.storageKind, thread_scope_key: scope.threadScopeKey, mcp_config: mcpConfig(project, boundThreadId) }, null, 2))
    }
    else if (command === 'doctor') {
      await ensureMcpRuntime()
      const asr = await probeAsr()
      console.log(JSON.stringify({
        ok: true,
        project_dir: project,
        storage_kind: scope.storageKind,
        thread_scope_key: scope.threadScopeKey,
        node: process.version,
        python_required: '3.11+',
        managed_runtime_dir: runtimeDir(),
        latest_package_exists: existsSync(scope.latestPackagePath),
        asr,
        mcp_config: mcpConfig(project, boundThreadId),
      }, null, 2))
    } else if (command === 'read' || command === 'read-artifact-review') {
      // Maintained CLI fallback for get_latest_prompt_package. Uses the exact
      // same code path as the canvas_prompt MCP server. This is NOT a
      // temporary Bash/Python read — it is a first-class CLI command that
      // imports and calls the MCP server's handler directly.
      process.env.CANVAS_PROMPT_MCP_TEST = '1'
      const { handleGetLatestPromptPackage, handleGetLatestArtifactReview } = await import('../mcp/server.mjs')
      const response = command === 'read'
        ? await handleGetLatestPromptPackage({})
        : await handleGetLatestArtifactReview({})
      const text = response.content?.[0]?.text
      if (response.isError) {
        console.error(text)
        process.exitCode = 1
      } else {
        console.log(text)
      }
    } else if (command === 'open') {
      const hostFlag = flag('--host')
      const host = hostFlag === 'codex' ? 'codex' : hostFlag === 'workbuddy' ? 'workbuddy' : 'local'
      await ensureMcpRuntime()
      const asrEnvironment = await asrEnvironmentForOpen(project)
      const environment = runtimeEnvironment(asrEnvironment)
      if (process.env.CANVAS_PROMPT_ASR !== 'disabled') {
        // Opening a session is a gate, not a race between an already-visible
        // canvas and a detached process that may die with its launcher. The
        // managed ASR script reports readiness only after the model endpoint
        // is usable; a person never starts a supposedly voice-enabled round
        // while the UI is still stuck in “Speech preparing”.
        console.error(`Canvas Prompt is checking local speech transcription at ${asrUrl(environment)}…`)
        const asr = spawnSync('bash', [resolve(rootDir, 'scripts', 'start-asr.sh')], { stdio: 'inherit', env: environment })
        if (asr.status !== 0) throw new Error(`Local speech transcription did not become ready (${asrUrl(environment)}). Set CANVAS_PROMPT_ASR=disabled only for an intentional visual-only session.`)
      }
      const result = spawnSync('bash', [resolve(rootDir, 'scripts', 'start-canvas.sh'), project ?? process.cwd()], {
        stdio: 'inherit',
        env: {
          ...environment,
          ...(project ? { CANVAS_PROMPT_PROJECT_DIR: project } : { CANVAS_PROMPT_PROJECT_MODE: 'conversation' }),
          CANVAS_PROMPT_DELIVERY_MODE: host,
        },
      })
      process.exitCode = result.status ?? 1
    } else throw new Error(`Unknown command: ${command}`)
  }
} catch (error) {
  console.error(`canvas-prompt: ${error.message}`)
  process.exitCode = 1
}
