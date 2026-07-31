import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync } from 'node:fs'
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

test('init emits MCP configuration with optional project provenance', () => {
  const project = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-home-'))
  const result = runWithEnvironment({ HOME: home }, 'init', '--project', project)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  const canonicalProject = realpathSync(project)
  assert.equal(parsed.project_dir, canonicalProject)
  assert.equal(parsed.mcp_config.mcpServers.canvas_prompt.env.CANVAS_PROMPT_PROJECT_DIR, canonicalProject)
  assert.equal(parsed.mcp_config.mcpServers.canvas_prompt.command, 'node')
  assert.equal(parsed.mcp_config.mcpServers.canvas_prompt.args[0], join(home, '.canvas-prompt', 'runtime', 'mcp', 'server.mjs'))
  assert.equal(existsSync(parsed.mcp_config.mcpServers.canvas_prompt.args[0]), true)
  const handshake = spawnSync(process.execPath, [parsed.mcp_config.mcpServers.canvas_prompt.args[0]], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cli-test', version: '1' } } })}\n`,
  })
  assert.equal(handshake.status, 0, handshake.stderr)
  assert.match(handshake.stdout, /ai-thinking-whiteboard-mcp/)
})

test('managed MCP runtime survives removal of the versioned plugin source', () => {
  const source = mkdtempSync(join(tmpdir(), 'canvas-prompt-versioned-cache-'))
  const home = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-home-'))
  const project = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-'))
  mkdirSync(join(source, 'bin'), { recursive: true })
  mkdirSync(join(source, 'app'), { recursive: true })
  mkdirSync(join(source, 'mcp'), { recursive: true })
  copyFileSync(cli, join(source, 'bin', 'canvas-prompt.mjs'))
  for (const entry of readdirSync(resolve('app'))) {
    if (entry.endsWith('.mjs')) copyFileSync(resolve('app', entry), join(source, 'app', entry))
  }
  copyFileSync(resolve('mcp', 'server.mjs'), join(source, 'mcp', 'server.mjs'))

  const isolatedCli = join(source, 'bin', 'canvas-prompt.mjs')
  const initialized = spawnSync(process.execPath, [isolatedCli, 'init', '--project', project], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
  assert.equal(initialized.status, 0, initialized.stderr)
  const runtimeServer = JSON.parse(initialized.stdout).mcp_config.mcpServers.canvas_prompt.args[0]
  rmSync(source, { recursive: true, force: true })
  assert.equal(existsSync(source), false)

  const handshake = spawnSync(process.execPath, [runtimeServer], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cache-removal-test', version: '1' } } })}\n`,
  })
  assert.equal(handshake.status, 0, handshake.stderr)
  assert.match(handshake.stdout, /ai-thinking-whiteboard-mcp/)
})

test('init refreshes an existing stale managed MCP runtime before emitting config', () => {
  const home = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-home-'))
  const project = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-'))
  const runtimeServer = join(home, '.canvas-prompt', 'runtime', 'mcp', 'server.mjs')
  const runtimeScope = join(home, '.canvas-prompt', 'runtime', 'app', 'conversation-scope.mjs')
  mkdirSync(join(runtimeServer, '..'), { recursive: true })
  mkdirSync(join(runtimeScope, '..'), { recursive: true })
  writeFileSync(runtimeServer, 'stale server\n')
  writeFileSync(runtimeScope, 'stale scope\n')

  const result = runWithEnvironment({ HOME: home }, 'init', '--project', project)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(runtimeServer, 'utf8'), readFileSync(resolve('mcp', 'server.mjs'), 'utf8'))
  assert.equal(readFileSync(runtimeScope, 'utf8'), readFileSync(resolve('app', 'conversation-scope.mjs'), 'utf8'))
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.mcp_config.mcpServers.canvas_prompt.args[0], runtimeServer)

  const handshake = spawnSync(process.execPath, [runtimeServer], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'runtime-refresh-test', version: '1' } } })}\n`,
  })
  assert.equal(handshake.status, 0, handshake.stderr)
  assert.match(handshake.stdout, /ai-thinking-whiteboard-mcp/)
})

test('init keeps a host thread as provenance but configures the single board', () => {
  const project = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-'))
  const home = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-home-'))
  const threadId = '019fa-codex-thread-12345678'
  const result = runWithEnvironment({ HOME: home }, 'init', '--project', project, '--thread-id', threadId)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.storage_kind, 'single_board')
  assert.equal(parsed.thread_scope_key, null)
  assert.equal(parsed.mcp_config.mcpServers.canvas_prompt.env.CANVAS_PROMPT_THREAD_ID, undefined)
})

test('init supports a project-less single board without a host thread ID', () => {
  const home = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-home-'))
  const result = runWithEnvironment({ HOME: home }, 'init', '--conversation-only')
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

test('help text lists workbuddy as a valid host', () => {
  const result = run('help')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /workbuddy/)
})

test('read returns the latest prompt package from the single board via the formal MCP handler', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-prompt-read-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })

  const boardDir = join(home, '.canvas-prompt', 'board')
  mkdirSync(boardDir, { recursive: true })

  const packageId = 'pp_test_read_e2e_001'
  const promptPackage = {
    meta: {
      package_id: packageId,
      version: '2.1',
      created_at: '2026-07-30T00:00:00.000Z',
      duration_ms: 5000,
      canvas_size: { width: 800, height: 600, unit: 'scene' },
      coordinate_system: { space: 'excalidraw_scene', unit: 'scene', origin: { x: 0, y: 0 }, x_axis: 'right', y_axis: 'down' },
      tags: ['canvas-prompt', 'excalidraw'],
      conversation_binding: { version: 1, storage_kind: 'single_board', project_dir: null, source_thread_id: null, session_id: null, thread_scope_key: null },
    },
    canvas_snapshot: { final: { inline_data: 'excluded', format: 'png', width: 800, height: 600 }, scene_bounds: { x: 0, y: 0, width: 800, height: 600 } },
    strokes: [],
    transcript: { full_text: 'test transcript for CLI read', segments: [], language: 'zh', alignment_status: 'timestamped' },
    timeline: [],
    objects: [],
    baseline_context: { scene_sha256: 'abc123', object_count: 0, image_count: 0, included_object_count: 0, status: 'none' },
  }

  writeFileSync(join(boardDir, 'latest-prompt-package.json'), JSON.stringify(promptPackage))

  const result = runWithEnvironment({ HOME: home }, 'read', '--project', project)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.package.meta.package_id, packageId)
  assert.equal(parsed.source.raw_package_path, realpathSync(join(boardDir, 'latest-prompt-package.json')))
  assert.equal(parsed.delivery.inline_image_data, 'excluded')
})

test('read reports an error when no prompt package exists on the board', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-prompt-read-empty-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })

  const result = runWithEnvironment({ HOME: home }, 'read', '--project', project)
  assert.equal(result.status, 1, result.stderr)
  const parsed = JSON.parse(result.stderr)
  assert.ok(parsed.error.includes('not found'), `unexpected error: ${result.stderr}`)
})

test('workbuddy plugin manifest exists and is valid', () => {
  const manifestPath = resolve('.workbuddy-plugin', 'plugin.json')
  assert.equal(existsSync(manifestPath), true)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.name, 'canvas-prompt')
  assert.match(manifest.version, /workbuddy/)
  assert.equal(manifest.mcpServers, './.mcp.json')
  assert.equal(manifest.skills, './skills/')
  assert.ok(Array.isArray(manifest.interface.capabilities))
})

test('workbuddy skills exist and are non-empty', () => {
  for (const skill of ['canvas-prompt-workbuddy-open', 'canvas-prompt-workbuddy-read']) {
    const skillPath = resolve('skills', skill, 'SKILL.md')
    assert.equal(existsSync(skillPath), true, `missing skill: ${skill}`)
    const content = readFileSync(skillPath, 'utf8')
    assert.ok(content.length > 100, `skill too short: ${skill}`)
    assert.match(content, new RegExp(`name: ${skill}`))
  }
})
