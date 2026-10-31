import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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

async function selectPort({ requestedProject, runningProject, requestedThreadScope = '', runningThreadScope = '', runningStorageKind = 'single_board', runningDeliveryMode = 'local', requestedDeliveryMode = 'local', runningCommand = `${root}/app node vite`, runningIdentity = null, dataHome = '', psUnavailable = false }) {
  const temp = await mkdtemp(resolve(tmpdir(), 'canvas-port-isolation-'))
  try {
    await mkdir(requestedProject, { recursive: true })
    const bin = resolve(temp, 'bin')
    await mkdir(bin)
    const identity = runningIdentity ?? {
      project_dir: runningProject,
      project_hash: null,
      storage_kind: runningStorageKind,
      conversation_bound: false,
      thread_scope_key: runningThreadScope || null,
      session_scope_key: null,
      service_version: '0.1.36',
      delivery_mode: runningDeliveryMode,
    }
    await fakeCommand(bin, 'lsof', '[[ "$*" == *"43223"* ]] && echo 4242')
    await fakeCommand(bin, 'shasum', 'echo "shasum is unavailable on this minimal host" >&2; exit 127')
    // Keep both ps modes to prove selection is based on runtime identity, not
    // on command-line labels or host process inspection.
    await fakeCommand(bin, 'ps', psUnavailable ? 'exit 0' : `echo ${JSON.stringify(runningCommand)}`)
    await fakeCommand(bin, 'curl', `if [[ "$*" == *"runtime-identity"* ]]; then echo ${JSON.stringify(JSON.stringify(identity))}; else echo '<title>Canvas Prompt</title>'; fi`)
    const { stdout, stderr } = await run('bash', ['-c', `source ${JSON.stringify(script)}; select_port`], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CANVAS_PROMPT_TEST_ONLY: '1',
        CANVAS_PROMPT_PROJECT_DIR: requestedProject,
        CANVAS_PROMPT_DELIVERY_MODE: requestedDeliveryMode,
        CANVAS_PROMPT_DATA_HOME: dataHome,
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
      runningStorageKind: 'project',
      runningCommand: '/tmp/canvas-prompt-cache/older/app/node_modules/vite/bin/vite.js --port 43223',
    })
    assert.equal(result.stdout, '43224', result.stderr)
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})

test('a healthy single-board service is reused even when its runtime directory has no Canvas Prompt or Vite label', async () => {
  const projects = await mkdtemp(resolve(tmpdir(), 'canvas-port-runtime-identity-'))
  try {
    const project = resolve(projects, 'proj')
    await mkdir(project, { recursive: true })
    const canonical = await realpath(project)
    const reuse = await selectPort({
      requestedProject: project,
      runningProject: canonical,
      runningCommand: '/private/other-board/runtime/server.js --port 43223',
    })
    assert.equal(reuse.stdout, 'reuse:43223', reuse.stderr)
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})

test('an incomplete runtime identity is not reused as a single-board Canvas service', async () => {
  const projects = await mkdtemp(resolve(tmpdir(), 'canvas-port-invalid-identity-'))
  try {
    const project = resolve(projects, 'proj')
    await mkdir(project, { recursive: true })
    const result = await selectPort({
      requestedProject: project,
      runningProject: await realpath(project),
      runningIdentity: { storage_kind: 'single_board', delivery_mode: 'local' },
      runningCommand: '/private/other-board/runtime/server.js --port 43223',
    })
    assert.equal(result.stdout, '43224', result.stderr)
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})

test('runtime reuse checks data scope and minor-version compatibility', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'canvas-data-scope-'))
  try {
    const identity = { service_version: '0.1.36', storage_kind: 'single_board' }
    const options = { requestedProject: directory, runningProject: directory, dataHome: directory }
    assert.equal((await selectPort({ ...options, runningIdentity: identity })).stdout, '43224')
    const matching = { ...identity, storage_scope_key: createHash('sha256').update(resolve(directory, '.canvas-prompt/board')).digest('hex') }
    assert.equal((await selectPort({ ...options, runningIdentity: matching })).stdout, 'reuse:43223')
    assert.equal((await selectPort({ ...options, runningIdentity: { ...matching, storage_scope_key: 'different' } })).stdout, '43224')
    assert.equal((await selectPort({ ...options, runningIdentity: { ...matching, service_version: '1.0.0' } })).stdout, '43224')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an invalid runtime identity never authorizes killing a listener', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'canvas-port-invalid-kill-identity-'))
  try {
    const bin = resolve(temp, 'bin')
    const killMarker = resolve(temp, 'kill-marker')
    await mkdir(bin)
    await fakeCommand(bin, 'lsof', '[[ "$*" == *"43223"* ]] && echo 4242')
    await fakeCommand(bin, 'ps', `echo ${JSON.stringify('/private/other-board/runtime/server.js --port 43223')}`)
    await fakeCommand(bin, 'curl', `if [[ "$*" == *"runtime-identity"* ]]; then echo ${JSON.stringify(JSON.stringify({ service_version: 'not-a-semver', storage_kind: 'single_board' }))}; else echo '<title>Canvas Prompt</title>'; fi`)

    const project = resolve(temp, 'project')
    await mkdir(project)
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
    assert.match(stdout, /KILL_CALLED=0/, `invalid identity must not authorize kill, got: ${stdout}\nstderr: ${stderr}`)
  } finally {
    await rm(temp, { recursive: true, force: true })
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
    // ps unavailable must not affect identity-based detection. A single-board
    // service is reused regardless of delivery_mode.
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

test('an unhealthy Canvas-looking listener is preserved rather than killed', async () => {
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
    // HTTP identity cannot authorize terminating an existing user process.
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

    assert.match(stdout, /KILL_CALLED=0/, `existing listener must remain intact, got: ${stdout}\nstderr: ${stderr}`)
    assert.match(stdout, /RESULT=43224/, `expected next free port, got: ${stdout}\nstderr: ${stderr}`)
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
        CANVAS_PROMPT_SOFFICE_BIN: '/private/test/soffice',
        CANVAS_PROMPT_DATA_HOME: resolve(temp, 'data'),
      },
    })
    const args = await (await import('node:fs/promises')).readFile(submission, 'utf8')
    assert.match(args, /http:\/\/127\.0\.0\.1:18081/)
    assert.match(args, /^disabled$/m)
    assert.match(args, /^codex$/m)
    assert.match(args, /^\/private\/test\/soffice$/m)
    assert.ok(args.split('\n').includes(resolve(temp, 'data')))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('macOS falls back when launchctl accepts a job that never starts', async (t) => {
  const temp = await mkdtemp(resolve(tmpdir(), 'canvas-launch-fallback-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const bin = resolve(temp, 'bin')
  const scripts = resolve(temp, 'scripts')
  const app = resolve(temp, 'app')
  for (const dir of [bin, scripts, app]) await mkdir(dir)
  await writeFile(resolve(app, 'package.json'), '{}')
  await writeFile(resolve(scripts, 'start-canvas.sh'), await readFile(script))
  await fakeCommand(scripts, 'bootstrap-runtime.sh', 'exit 0')
  const ready = resolve(temp, 'ready')
  await fakeCommand(scripts, 'run-canvas-service.sh', `touch ${JSON.stringify(ready)}`)
  await fakeCommand(bin, 'lsof', 'exit 0')
  await fakeCommand(bin, 'uname', 'echo Darwin')
  await fakeCommand(bin, 'launchctl', 'exit 0')
  // Preserve the launcher's real readiness window: a detached process may
  // start after more than 200ms on a busy host. Shortening sleep here races
  // fixture cleanup against that process and tests scheduler timing instead.
  await fakeCommand(bin, 'curl', `[[ -f ${JSON.stringify(ready)} ]] && echo '<title>Canvas Prompt</title>'`)
  const { stdout, stderr } = await run('bash', [resolve(scripts, 'start-canvas.sh'), temp], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CANVAS_PROMPT_PORT: '45380', CANVAS_PROMPT_DATA_HOME: resolve(temp, 'data') },
    timeout: 20_000,
  })
  assert.match(stderr, /retrying directly/)
  assert.match(stdout, /is running at/)
  assert.ok(existsSync(ready))
})
