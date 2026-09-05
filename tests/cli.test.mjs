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
  copyFileSync(resolve('mcp', 'stdio-framer.mjs'), join(source, 'mcp', 'stdio-framer.mjs'))

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

test('read-recovery rereads the compiled round with a new context and supersedes the old policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-prompt-read-recovery-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })

  const boardDir = join(home, '.canvas-prompt', 'board')
  const packageId = 'pp_canvas_round_fixture_001'
  const fixturePath = resolve('prompt_package_builder/fixtures/context-source-canvas-round.json')
  const promptPackage = readFileSync(fixturePath, 'utf8')
  const roundDir = join(boardDir, 'rounds', packageId)
  mkdirSync(roundDir, { recursive: true })
  writeFileSync(join(roundDir, 'prompt-package.json'), promptPackage)
  writeFileSync(join(boardDir, 'latest-prompt-package.json'), promptPackage)

  const compile = spawnSync('python3', [
    resolve('prompt_package_builder/compile_runtime_package.py'),
    '--input', join(roundDir, 'prompt-package.json'),
    '--output-dir', join(roundDir, 'engine'),
  ], { encoding: 'utf8' })
  assert.equal(compile.status, 0, compile.stderr)
  const archivedPolicy = readFileSync(join(roundDir, 'engine', 'continuity-policy.json'), 'utf8')
  const archivedPack = readFileSync(join(roundDir, 'engine', 'minimal-context-pack.json'), 'utf8')

  const result = runWithEnvironment({ HOME: home }, 'read-recovery', '--project', project, '--correction', '我纠正：先确认本轮身份，再比较新旧理解。')
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.source.read_mode, 're_read')
  assert.equal(parsed.source.previous_context_id, 'ctx_round_pp_canvas_round_fixture_001')
  assert.notEqual(parsed.source.context_id, parsed.source.previous_context_id)
  assert.equal(parsed.context_pack.context_id, parsed.source.context_id)
  assert.equal(parsed.context_pack.round_id, 'round_fixture_001')
  assert.equal(parsed.continuity_policy.identity_receipt.round_id, 'round_fixture_001')
  assert.equal(parsed.continuity_policy.continuity.read_mode, 're_read')
  assert.equal(parsed.continuity_policy.continuity.status, 'reconciled')
  assert.equal(parsed.continuity_policy.continuity.supersedes[0].status, 'superseded')
  assert.equal(parsed.continuity_policy.continuity.supersedes[0].context_id, parsed.source.previous_context_id)
  assert.equal(parsed.continuity_policy.continuity.reconciliation.correction.source_layer, 'user_input')
  assert.equal(parsed.delivery.archive_mutated, false)
  assert.equal(parsed.delivery.execution_authorized, false)
  assert.equal(readFileSync(join(roundDir, 'engine', 'continuity-policy.json'), 'utf8'), archivedPolicy)
  assert.equal(readFileSync(join(roundDir, 'engine', 'minimal-context-pack.json'), 'utf8'), archivedPack)
})

test('read-recovery continues only from an explicit prior receipt and retains bounded corrections', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-prompt-read-recovery-chain-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })

  const boardDir = join(home, '.canvas-prompt', 'board')
  const packageId = 'pp_canvas_round_fixture_001'
  const fixturePath = resolve('prompt_package_builder/fixtures/context-source-canvas-round.json')
  const promptPackage = readFileSync(fixturePath, 'utf8')
  const roundDir = join(boardDir, 'rounds', packageId)
  mkdirSync(roundDir, { recursive: true })
  writeFileSync(join(roundDir, 'prompt-package.json'), promptPackage)
  writeFileSync(join(boardDir, 'latest-prompt-package.json'), promptPackage)

  const compile = spawnSync('python3', [
    resolve('prompt_package_builder/compile_runtime_package.py'),
    '--input', join(roundDir, 'prompt-package.json'),
    '--output-dir', join(roundDir, 'engine'),
  ], { encoding: 'utf8' })
  assert.equal(compile.status, 0, compile.stderr)
  const archivedPolicy = readFileSync(join(roundDir, 'engine', 'continuity-policy.json'), 'utf8')
  const archivedPack = readFileSync(join(roundDir, 'engine', 'minimal-context-pack.json'), 'utf8')

  const firstResult = runWithEnvironment(
    { HOME: home },
    'read-recovery', '--project', project,
    '--correction', '第一条纠正：保留用户原话，不要把候选当结论。',
  )
  assert.equal(firstResult.status, 0, firstResult.stderr)
  const first = JSON.parse(firstResult.stdout)
  const firstReceiptPath = join(root, 'first-recovery.json')
  writeFileSync(firstReceiptPath, firstResult.stdout)

  const secondResult = runWithEnvironment(
    { HOME: home },
    'read-recovery', '--project', project,
    '--previous-recovery', firstReceiptPath,
    '--correction', '第二条纠正：只按当前 round 的证据继续。',
  )
  assert.equal(secondResult.status, 0, secondResult.stderr)
  const second = JSON.parse(secondResult.stdout)
  assert.equal(second.source.recovery_input, 'explicit_previous_recovery_receipt')
  assert.equal(second.source.previous_context_id, first.source.context_id)
  assert.equal(second.context_pack.parent_context_id, first.source.context_id)
  assert.deepEqual(second.continuity_policy.continuity.context_lineage, [
    'ctx_round_pp_canvas_round_fixture_001',
    first.source.context_id,
    second.source.context_id,
  ])
  assert.deepEqual(
    second.continuity_policy.continuity.reconciliation.correction_history.map((item) => item.text),
    ['第一条纠正：保留用户原话，不要把候选当结论。', '第二条纠正：只按当前 round 的证据继续。'],
  )
  assert.equal(second.continuity_policy.continuity.status, 'reconciled')
  assert.equal(second.continuity_policy.continuity.reconciliation.previous_context_id, first.source.context_id)
  assert.equal(second.continuity_policy.continuity.supersedes[0].context_id, first.source.context_id)
  assert.equal(second.delivery.archive_mutated, false)
  assert.equal(second.delivery.execution_authorized, false)
  assert.equal(second.context_pack.execution_authorized, false)
  assert.equal(second.context_pack.constraints.execution_authorized, false)
  assert.ok(second.continuity_policy.continuity.reconciliation.correction_history.every((item) => {
    return item.status === 'user_stated'
      && item.source_layer === 'user_input'
      && !Object.hasOwn(item, 'claim_ids')
      && !Object.hasOwn(item, 'evidence_refs')
  }))
  assert.equal(readFileSync(join(roundDir, 'engine', 'continuity-policy.json'), 'utf8'), archivedPolicy)
  assert.equal(readFileSync(join(roundDir, 'engine', 'minimal-context-pack.json'), 'utf8'), archivedPack)
})

test('read-recovery rejects an explicit receipt from another round without touching the archive', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-prompt-read-recovery-cross-round-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })

  const boardDir = join(home, '.canvas-prompt', 'board')
  const packageId = 'pp_canvas_round_fixture_001'
  const fixturePath = resolve('prompt_package_builder/fixtures/context-source-canvas-round.json')
  const promptPackage = readFileSync(fixturePath, 'utf8')
  const roundDir = join(boardDir, 'rounds', packageId)
  mkdirSync(roundDir, { recursive: true })
  writeFileSync(join(roundDir, 'prompt-package.json'), promptPackage)
  writeFileSync(join(boardDir, 'latest-prompt-package.json'), promptPackage)
  const compile = spawnSync('python3', [
    resolve('prompt_package_builder/compile_runtime_package.py'),
    '--input', join(roundDir, 'prompt-package.json'),
    '--output-dir', join(roundDir, 'engine'),
  ], { encoding: 'utf8' })
  assert.equal(compile.status, 0, compile.stderr)
  const archivedPolicy = readFileSync(join(roundDir, 'engine', 'continuity-policy.json'), 'utf8')
  const archivedPack = readFileSync(join(roundDir, 'engine', 'minimal-context-pack.json'), 'utf8')

  const firstResult = runWithEnvironment({ HOME: home }, 'read-recovery', '--project', project, '--correction', '先读当前 round。')
  assert.equal(firstResult.status, 0, firstResult.stderr)
  const foreign = JSON.parse(firstResult.stdout)
  foreign.context_pack.package_id = 'pp_other_round'
  foreign.continuity_policy.identity_receipt.package_id = 'pp_other_round'
  const foreignReceiptPath = join(root, 'foreign-recovery.json')
  writeFileSync(foreignReceiptPath, JSON.stringify(foreign))

  const rejected = runWithEnvironment(
    { HOME: home },
    'read-recovery', '--project', project,
    '--previous-recovery', foreignReceiptPath,
    '--correction', '不要跨 round 接续。',
  )
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /不同 round/)
  assert.equal(readFileSync(join(roundDir, 'engine', 'continuity-policy.json'), 'utf8'), archivedPolicy)
  assert.equal(readFileSync(join(roundDir, 'engine', 'minimal-context-pack.json'), 'utf8'), archivedPack)
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

test('read-artifact-review returns compact review evidence through the formal MCP handler', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-prompt-artifact-read-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const board = join(home, '.canvas-prompt', 'board')
  const packageId = 'arp_cli_reader'
  const round = join(board, 'artifact-review-rounds', packageId)
  mkdirSync(project, { recursive: true })
  mkdirSync(round, { recursive: true })
  writeFileSync(join(board, 'latest-artifact-review-package.json'), JSON.stringify({
    schema_version: 'artifact-review/0.2-draft', package_id: packageId,
    artifact: { artifact_kind: 'pptx', source_sha256: 'b'.repeat(64), page_count: 1, read_only: true },
    pages: [{ page_id: 'page_cli_1', page_number: 1 }], annotations: [], voice_segments: [], page_visits: [],
    review_state: { interpretation_status: 'clarification_required', execution_authorized: false },
  }))
  writeFileSync(join(round, 'review-brief.json'), JSON.stringify({ schema_version: 'artifact-review-proposal/0.1-draft', execution_authorized: false }))

  const result = runWithEnvironment({ HOME: home }, 'read-artifact-review', '--project', project)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.package.package_id, packageId)
  assert.equal(parsed.package.artifact.artifact_kind, 'pptx')
  assert.equal(parsed.delivery.mode, 'progressive_disclosure')
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
