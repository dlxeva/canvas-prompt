#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const command = process.argv[2] ?? 'help'
const flag = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}
const projectDir = () => {
  const candidate = resolve(flag('--project') ?? process.cwd())
  if (!existsSync(candidate)) throw new Error(`Project directory does not exist: ${candidate}`)
  return realpathSync(candidate)
}
const mcpConfig = (project) => ({
  mcpServers: {
    canvas_prompt: {
      command: 'bash',
      args: [resolve(rootDir, 'scripts', 'start-mcp.sh')],
      env: { CANVAS_PROMPT_PROJECT_DIR: project },
    },
  },
})
// Plugin caches are replaced on update. Keep the managed runtime outside the
// cache so an installed ASR environment and model can be reused across plugin
// versions without touching a user's global Python environment.
const runtimeDir = () => resolve(process.env.CANVAS_PROMPT_RUNTIME_DIR ?? resolve(homedir(), '.canvas-prompt', 'runtime'))
const asrUrl = (environment = process.env) => environment.CANVAS_PROMPT_ASR_URL ?? `http://127.0.0.1:${environment.CANVAS_PROMPT_ASR_PORT ?? '8080'}`
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
  for (let port = 18080; port < 18100; port += 1) if (!portInUse(port)) return port
  throw new Error('Canvas Prompt could not find a free local ASR port between 18080 and 18099.')
}
// A generic service on 8080 can be an older, slower ASR with a different
// lifecycle. Reuse only a Canvas Prompt-managed service by default; an
// explicit endpoint or opt-in flag remains available for advanced hosts.
const asrEnvironmentForOpen = async () => {
  if (process.env.CANVAS_PROMPT_ASR_URL) return {}
  const current = await probeAsr()
  if (current.ready || !portInUse(Number(process.env.CANVAS_PROMPT_ASR_PORT ?? '8080'))) return {}
  return { CANVAS_PROMPT_ASR_PORT: String(firstOpenAsrPort()) }
}
const help = () => console.log(`Canvas Prompt host-neutral entrypoint

Usage:
  canvas-prompt setup [--core-only]
  canvas-prompt open [--project <dir>] [--host codex|local]
  canvas-prompt init [--project <dir>]
  canvas-prompt doctor [--project <dir>]

setup installs Canvas Prompt-managed dependencies into its local runtime and
reuses validated existing dependencies. The local ASR model downloads on first
start. init prints the MCP configuration for the active project.`)

try {
  if (command === 'help' || command === '--help' || command === '-h') help()
  else {
    const project = projectDir()
    if (command === 'setup') {
      const result = runBootstrap(flag('--core-only') ? '--core-only' : '--with-asr')
      process.exitCode = result.status ?? 1
    }
    else if (command === 'init') console.log(JSON.stringify({ project_dir: project, mcp_config: mcpConfig(project) }, null, 2))
    else if (command === 'doctor') {
      const latest = resolve(project, '.canvas-prompt', 'latest-prompt-package.json')
      const asr = await probeAsr()
      console.log(JSON.stringify({
        ok: true,
        project_dir: project,
        node: process.version,
        python_required: '3.11+',
        managed_runtime_dir: runtimeDir(),
        latest_package_exists: existsSync(latest),
        asr,
        mcp_config: mcpConfig(project),
      }, null, 2))
    } else if (command === 'open') {
      const host = flag('--host') === 'codex' ? 'codex' : 'local'
      const asrEnvironment = await asrEnvironmentForOpen()
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
      const result = spawnSync('bash', [resolve(rootDir, 'scripts', 'start-canvas.sh'), project], { stdio: 'inherit', env: { ...environment, CANVAS_PROMPT_DELIVERY_MODE: host } })
      process.exitCode = result.status ?? 1
    } else throw new Error(`Unknown command: ${command}`)
  }
} catch (error) {
  console.error(`canvas-prompt: ${error.message}`)
  process.exitCode = 1
}
