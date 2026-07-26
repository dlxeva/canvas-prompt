import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const root = resolve(new URL('..', import.meta.url).pathname)
const script = resolve(root, 'scripts', 'start-canvas.sh')

async function fakeCommand(directory, name, contents) {
  const path = resolve(directory, name)
  await writeFile(path, `#!/usr/bin/env bash\n${contents}\n`)
  await chmod(path, 0o755)
}

async function selectPort({ requestedProject, runningProject, runningCommand = `${root}/app node vite` }) {
  const temp = await mkdtemp(resolve(tmpdir(), 'canvas-port-isolation-'))
  try {
    await mkdir(requestedProject, { recursive: true })
    const bin = resolve(temp, 'bin')
    await (await import('node:fs/promises')).mkdir(bin)
    await fakeCommand(bin, 'lsof', '[[ "$*" == *"43223"* ]] && echo 4242')
    await fakeCommand(bin, 'ps', `echo ${JSON.stringify(runningCommand)}`)
    await fakeCommand(bin, 'curl', `if [[ "$*" == *"runtime-identity"* ]]; then echo ${JSON.stringify(JSON.stringify({ project_dir: runningProject }))}; else echo '<title>Canvas Prompt</title>'; fi`)
    const { stdout, stderr } = await run('bash', ['-c', `source ${JSON.stringify(script)}; select_port`], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CANVAS_PROMPT_TEST_ONLY: '1',
        CANVAS_PROMPT_PROJECT_DIR: requestedProject,
      },
    })
    return { stdout: stdout.trim(), stderr }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

test('a healthy Canvas service is reused only by the exact same project', async () => {
  const projects = await mkdtemp(resolve(tmpdir(), 'canvas-port-projects-'))
  try {
    const projectA = resolve(projects, 'a')
    const projectB = resolve(projects, 'b')
    await mkdir(projectA, { recursive: true })
    const canonicalA = await realpath(projectA)
    const same = await selectPort({ requestedProject: projectA, runningProject: canonicalA })
    assert.equal(same.stdout, 'reuse:43223', same.stderr)
    const other = await selectPort({ requestedProject: projectB, runningProject: canonicalA })
    assert.equal(other.stdout, '43224', other.stderr)
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})

test('a healthy Canvas service from an earlier cache is not mistaken for stale', async () => {
  const projects = await mkdtemp(resolve(tmpdir(), 'canvas-port-cache-projects-'))
  try {
    const projectA = resolve(projects, 'a')
    const projectB = resolve(projects, 'b')
    await mkdir(projectA, { recursive: true })
    const canonicalA = await realpath(projectA)
    const result = await selectPort({
      requestedProject: projectB,
      runningProject: canonicalA,
      runningCommand: '/tmp/canvas-prompt-cache/older/app/node_modules/vite/bin/vite.js --port 43223',
    })
    assert.equal(result.stdout, '43224', result.stderr)
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})

test('macOS canvas service receives the configured ASR identity instead of reverting to port 8080', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'canvas-asr-identity-'))
  try {
    const bin = resolve(temp, 'bin')
    const submission = resolve(temp, 'launchctl-submit.txt')
    await mkdir(bin)
    await fakeCommand(bin, 'lsof', 'exit 0')
    await fakeCommand(bin, 'curl', "echo '<title>Canvas Prompt</title>'")
    await fakeCommand(bin, 'launchctl', `if [[ "$1" == "submit" ]]; then printf '%s\\n' "$@" > ${JSON.stringify(submission)}; fi`)
    const project = resolve(temp, 'project')
    await mkdir(project)
    await run('bash', [script, project], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CANVAS_PROMPT_PORT: '43319',
        CANVAS_PROMPT_ASR_PORT: '18081',
        CANVAS_PROMPT_ASR: 'disabled',
      },
    })
    const args = await (await import('node:fs/promises')).readFile(submission, 'utf8')
    assert.match(args, /http:\/\/127\.0\.0\.1:18081/)
    assert.match(args, /^disabled$/m)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
