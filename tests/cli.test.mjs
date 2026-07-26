import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const cli = resolve('bin/canvas-prompt.mjs')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

test('init emits project-bound MCP configuration', () => {
  const project = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-'))
  const result = run('init', '--project', project)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  const canonicalProject = realpathSync(project)
  assert.equal(parsed.project_dir, canonicalProject)
  assert.equal(parsed.mcp_config.mcpServers.canvas_prompt.env.CANVAS_PROMPT_PROJECT_DIR, canonicalProject)
})

test('doctor reports a missing package without treating it as a failure', () => {
  const project = mkdtempSync(join(tmpdir(), 'canvas-prompt-cli-'))
  const result = run('doctor', '--project', project)
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
