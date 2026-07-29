import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const cli = resolve('bin/canvas-prompt.mjs')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
const runWithPreferences = (preferencesPath, ...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8',
  env: { ...process.env, CANVAS_PROMPT_PREFERENCES_PATH: preferencesPath },
})
const runWithEnvironment = (environment, ...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', env: { ...process.env, ...environment },
})

test('init emits project-bound MCP configuration', () => {
  const project = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-'))
  const result = run('init', '--project', project)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  const canonicalProject = realpathSync(project)
  assert.equal(parsed.project_dir, canonicalProject)
  assert.equal(parsed.mcp_config.mcpServers.canvas_prompt.env.CANVAS_PROMPT_PROJECT_DIR, canonicalProject)
})

test('init keeps a host thread as provenance but configures the single board', () => {
  const project = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-'))
  const threadId = '019fa-codex-thread-12345678'
  const result = run('init', '--project', project, '--thread-id', threadId)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.storage_kind, 'single_board')
  assert.equal(parsed.thread_scope_key, null)
  assert.equal(parsed.mcp_config.mcpServers.canvas_prompt.env.CANVAS_PROMPT_THREAD_ID, undefined)
})

test('init supports a project-less single board without a host thread ID', () => {
  const threadId = '019fa-temporary-thread-12345678'
  const result = run('init', '--conversation-only')
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.project_dir, null)
  assert.equal(parsed.storage_kind, 'single_board')
  assert.equal(parsed.mcp_config.mcpServers.canvas_prompt.env.CANVAS_PROMPT_PROJECT_DIR, undefined)
  assert.equal(parsed.mcp_config.mcpServers.canvas_prompt.env.CANVAS_PROMPT_THREAD_ID, undefined)
})

test('doctor reports a missing package without treating it as a failure', () => {
  const project = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-home-'))
  const result = runWithEnvironment({ HOME: home }, 'doctor', '--project', project)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.latest_package_exists, false)
  assert.equal(typeof report.managed_runtime_dir, 'string')
  assert.equal(typeof report.asr.ready, 'boolean')
  assert.equal(typeof report.asr.endpoint, 'string')
})

test('setup can prepare only the core runtime without changing a global environment', () => {
  const project = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-'))
  const result = run('setup', '--core-only', '--project', project)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Canvas Prompt app dependencies|Reusing Canvas Prompt app dependencies/)
})

test('launch guidance preference defaults on and can be changed without a project', () => {
  const preferencesPath = join(mkdtempSync(join(tmpdir(), 'canvas-prompt-preferences-')), 'preferences.json')
  const initial = runWithPreferences(preferencesPath, 'preferences')
  assert.equal(initial.status, 0, initial.stderr)
  assert.equal(JSON.parse(initial.stdout).show_launch_guidance, true)

  const disabled = runWithPreferences(preferencesPath, 'preferences', '--guidance', 'off')
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.equal(JSON.parse(disabled.stdout).show_launch_guidance, false)

  const persisted = runWithPreferences(preferencesPath, 'preferences')
  assert.equal(persisted.status, 0, persisted.stderr)
  assert.equal(JSON.parse(persisted.stdout).show_launch_guidance, false)
})

test('migrate copies an explicitly named legacy archive into the single-board home without deleting its source', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-migrate-'))
  const project = join(root, 'legacy-project')
  const round = join(project, '.canvas-prompt', 'rounds', 'pp_cli_legacy')
  mkdirSync(join(round, 'engine'), { recursive: true })
  writeFileSync(join(round, 'prompt-package.json'), JSON.stringify({ meta: { package_id: 'pp_cli_legacy' } }))
  writeFileSync(join(round, 'round.json'), JSON.stringify({ package_id: 'pp_cli_legacy', status: 'engine_compiled' }))
  writeFileSync(join(project, '.canvas-prompt', 'latest-prompt-package.json'), JSON.stringify({ meta: { package_id: 'pp_cli_legacy' } }))
  const home = join(root, 'isolated-home')

  const result = runWithEnvironment({ HOME: home }, 'migrate', '--from', project)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.copied, ['pp_cli_legacy'])
  assert.equal(existsSync(join(project, '.canvas-prompt', 'rounds', 'pp_cli_legacy')), true)
  assert.equal(existsSync(join(home, '.canvas-prompt', 'board', 'rounds', 'pp_cli_legacy')), true)
})
