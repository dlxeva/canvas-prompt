import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

async function selectPort({ requestedProject, runningProject, requestedThreadScope = '', runningThreadScope = '', runningStorageKind = 'single_board', runningDeliveryMode = 'local', requestedDeliveryMode = 'local', runningCommand = `${root}/app node vite`, psUnavailable = false }) {
  const temp = await mkdtemp(resolve(tmpdir(), 'canvas-port-isolation-'))
  try {
    await mkdir(requestedProject, { recursive: true })
    const bin = resolve(temp, 'bin')
    await mkdir(bin)
    await fakeCommand(bin, 'lsof', '[[ "$*" == *"43223"* ]] && echo 4242')
    // When psUnavailable, mock ps to output nothing (simulates sandbox/restricted env).
    // Otherwise echo the runningCommand so is_healthy_canvas can verify the process.
    await fakeCommand(bin, 'ps', psUnavailable ? 'exit 0' : `echo ${JSON.stringify(runningCommand)}`)
    await fakeCommand(bin, 'curl', `if [[ "$*" == *"runtime-identity"* ]]; then echo ${JSON.stringify(JSON.stringify({ project_dir: runningProject, thread_scope_key: runningThreadScope, storage_kind: runningStorageKind, delivery_mode: runningDeliveryMode }))}; else echo '<title>Canvas Prompt</title>'; fi`)
    const { stdout, stderr } = await run('bash', ['-c', `source ${JSON.stringify(script)}; select_port`], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CANVAS_PROMPT_TEST_ONLY: '1',
        CANVAS_PROMPT_PROJECT_DIR: requestedProject,
        CANVAS_PROMPT_DELIVERY_MODE: requestedDeliveryMode,
        ...(requestedThreadScope ? { CANVAS_PROMPT_THREAD_ID: requestedThreadScope } : {}),
      },
    })
    return { stdout: stdout.trim(), stderr }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

test('a healthy single-board Canvas service is reused from another project', async () => {
  const projects = await mkdtemp(resolve(tmpdir(), 'canvas-port-projects-'))
  try {
    const projectA = resolve(projects, 'a')
    const projectB = resolve(projects, 'b')
    await mkdir(projectA, { recursive: true })
    const canonicalA = await realpath(projectA)
    const same = await selectPort({ requestedProject: projectA, runningProject: canonicalA })
    assert.equal(same.stdout, 'reuse:43223', same.stderr)
    const other = await selectPort({ requestedProject: projectB, runningProject: canonicalA })
    assert.equal(other.stdout, 'reuse:43223', other.stderr)
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})

test('a healthy single-board Canvas service is reused from another conversation', async () => {
  const projects = await mkdtemp(resolve(tmpdir(), 'canvas-port-thread-projects-'))
  try {
    const project = resolve(projects, 'shared')
    await mkdir(project, { recursive: true })
    const canonical = await realpath(project)
    const threadA = '019fa-thread-a-12345678'
    const threadB = '019fa-thread-b-12345678'
    const same = await selectPort({ requestedProject: project, runningProject: canonical, requestedThreadScope: threadA })
    assert.equal(same.stdout, 'reuse:43223', same.stderr)
    const other = await selectPort({ requestedProject: project, runningProject: canonical, requestedThreadScope: threadB })
    assert.equal(other.stdout, 'reuse:43223', other.stderr)
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
      runningStorageKind: '',
      runningCommand: '/tmp/canvas-prompt-cache/older/app/node_modules/vite/bin/vite.js --port 43223',
    })
    assert.equal(result.stdout, '43224', result.stderr)
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})

test('a single-board canvas is reused regardless of delivery_mode (codex started, workbuddy reuses)', async () => {
  const projects = await mkdtemp(resolve(tmpdir(), 'canvas-port-dm-cross-wb-'))
  try {
    const project = resolve(projects, 'proj')
    await mkdir(project, { recursive: true })
    const canonical = await realpath(project)
    // Canvas started by codex, now workbuddy requests open → reuse, no restart
    const reuse = await selectPort({
      requestedProject: project, runningProject: canonical,
      runningDeliveryMode: 'codex', requestedDeliveryMode: 'workbuddy',
    })
    assert.equal(reuse.stdout, 'reuse:43223', reuse.stderr)
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})

test('a single-board canvas is reused regardless of delivery_mode (workbuddy started, codex reuses)', async () => {
  const projects = await mkdtemp(resolve(tmpdir(), 'canvas-port-dm-cross-cx-'))
  try {
    const project = resolve(projects, 'proj')
    await mkdir(project, { recursive: true })
    const canonical = await realpath(project)
    // Canvas started by workbuddy, now codex requests open → reuse, no restart
    const reuse = await selectPort({
      requestedProject: project, runningProject: canonical,
      runningDeliveryMode: 'workbuddy', requestedDeliveryMode: 'codex',
    })
    assert.equal(reuse.stdout, 'reuse:43223', reuse.stderr)
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})

test('when ps is unavailable, a single-board canvas is still reused via runtime-identity fallback', async () => {
  const projects = await mkdtemp(resolve(tmpdir(), 'canvas-port-ps-na-reuse-'))
  try {
    const project = resolve(projects, 'proj')
    await mkdir(project, { recursive: true })
    const canonical = await realpath(project)
    // ps unavailable → is_healthy_canvas falls through to runtime-identity
    // single_board → reuse regardless of delivery_mode
    const reuse = await selectPort({
      requestedProject: project, runningProject: canonical,
      runningDeliveryMode: 'codex', requestedDeliveryMode: 'workbuddy',
      psUnavailable: true,
    })
    assert.equal(reuse.stdout, 'reuse:43223', reuse.stderr)
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})

test('when ps is unavailable and port hosts a non-Canvas service, kill is not called and next port is selected', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'canvas-port-ps-na-nokill-'))
  try {
    const bin = resolve(temp, 'bin')
    await mkdir(bin)
    // lsof: port 43223 has a PID, port 43224 is free
    await fakeCommand(bin, 'lsof', '[[ "$*" == *"43223"* ]] && echo 4242')
    // ps: unavailable (returns nothing)
    await fakeCommand(bin, 'ps', 'exit 0')
    // curl: non-Canvas service — no Canvas Prompt page, no runtime-identity
    await fakeCommand(bin, 'curl', 'echo "Not a Canvas service"')

    const project = resolve(temp, 'project')
    await mkdir(project)

    // kill() writes to a marker file because select_port runs in a subshell
    // ($(…)) and variable assignments inside it don't propagate back.
    const killMarker = resolve(temp, 'kill-marker')
    const { stdout, stderr } = await run('bash', ['-c', [
      `KILL_MARKER=${JSON.stringify(killMarker)}`,
      'kill() { echo 1 > "$KILL_MARKER"; }',
      `source ${JSON.stringify(script)}`,
      'result=$(select_port)',
      'echo "RESULT=$result"',
      'if [ -f "$KILL_MARKER" ]; then echo "KILL_CALLED=1"; else echo "KILL_CALLED=0"; fi',
    ].join('\n')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CANVAS_PROMPT_TEST_ONLY: '1',
        CANVAS_PROMPT_PROJECT_DIR: project,
      },
    })

    assert.match(stdout, /RESULT=43224/, `expected next port, got: ${stdout}\nstderr: ${stderr}`)
    assert.match(stdout, /KILL_CALLED=0/, `kill should not be called, got: ${stdout}\nstderr: ${stderr}`)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('when ps is unavailable and port hosts a stale Canvas (runtime-identity confirms), kill is called', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'canvas-port-ps-na-stale-'))
  try {
    const bin = resolve(temp, 'bin')
    await mkdir(bin)
    // lsof: port 43223 has a PID, port 43224 is free
    await fakeCommand(bin, 'lsof', '[[ "$*" == *"43223"* ]] && echo 4242')
    // ps: unavailable (returns nothing)
    await fakeCommand(bin, 'ps', 'exit 0')
    // curl: runtime-identity responds with Canvas Prompt identity (has service_version),
    // but the root page does NOT have <title>Canvas Prompt</title> → is_healthy_canvas fails
    // → stop_stale_canvas should kill it because runtime_identity provides positive evidence.
    await fakeCommand(bin, 'curl', 'if [[ "$*" == *"runtime-identity"* ]]; then echo \'{"service_version":"0.1.30","storage_kind":"single_board","delivery_mode":"codex"}\'; else echo "<html><title>Something Else</title></html>"; fi')

    const project = resolve(temp, 'project')
    await mkdir(project)

    const killMarker = resolve(temp, 'kill-marker')
    const { stdout, stderr } = await run('bash', ['-c', [
      `KILL_MARKER=${JSON.stringify(killMarker)}`,
      'kill() { echo 1 > "$KILL_MARKER"; }',
      `source ${JSON.stringify(script)}`,
      'result=$(select_port)',
      'echo "RESULT=$result"',
      'if [ -f "$KILL_MARKER" ]; then echo "KILL_CALLED=1"; else echo "KILL_CALLED=0"; fi',
    ].join('\n')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CANVAS_PROMPT_TEST_ONLY: '1',
        CANVAS_PROMPT_PROJECT_DIR: project,
      },
    })

    assert.match(stdout, /KILL_CALLED=1/, `kill should be called for stale Canvas, got: ${stdout}\nstderr: ${stderr}`)
    assert.match(stdout, /RESULT=43224/, `expected next port after kill, got: ${stdout}\nstderr: ${stderr}`)
  } finally {
    await rm(temp, { recursive: true, force: true })
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
    // This test only verifies the macOS launch arguments. On Linux CI, force
    // the same branch so the script never execs a long-lived Vite process.
    await fakeCommand(bin, 'uname', "echo Darwin")
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
        CANVAS_PROMPT_DELIVERY_MODE: 'codex',
      },
    })
    const args = await (await import('node:fs/promises')).readFile(submission, 'utf8')
    assert.match(args, /http:\/\/127\.0\.0\.1:18081/)
    assert.match(args, /^disabled$/m)
    assert.match(args, /^codex$/m)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
