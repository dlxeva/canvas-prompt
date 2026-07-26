#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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
const help = () => console.log(`Canvas Prompt host-neutral entrypoint

Usage:
  canvas-prompt open [--project <dir>] [--host codex|local]
  canvas-prompt init [--project <dir>]
  canvas-prompt doctor [--project <dir>]

init prints the MCP configuration for the active project. Do not replace the
Canvas app with a copy/paste implementation: use this CLI and MCP reader.`)

try {
  if (command === 'help' || command === '--help' || command === '-h') help()
  else {
    const project = projectDir()
    if (command === 'init') console.log(JSON.stringify({ project_dir: project, mcp_config: mcpConfig(project) }, null, 2))
    else if (command === 'doctor') {
      const latest = resolve(project, '.canvas-prompt', 'latest-prompt-package.json')
      console.log(JSON.stringify({ ok: true, project_dir: project, node: process.version, python_required: 'python3', latest_package_exists: existsSync(latest), mcp_config: mcpConfig(project) }, null, 2))
    } else if (command === 'open') {
      const host = flag('--host') === 'codex' ? 'codex' : 'local'
      const result = spawnSync('bash', [resolve(rootDir, 'scripts', 'start-canvas.sh'), project], { stdio: 'inherit', env: { ...process.env, CANVAS_PROMPT_DELIVERY_MODE: host } })
      process.exitCode = result.status ?? 1
    } else throw new Error(`Unknown command: ${command}`)
  }
} catch (error) {
  console.error(`canvas-prompt: ${error.message}`)
  process.exitCode = 1
}
