import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteRoundAndUpdateLatest } from '../round-store.mjs'
import { HANDOFF_COMPLETION_TIMEOUT_MS, appServerCommandCandidates, appServerEnvironment, createHandoffStatusWriter, deliveryReceiptMessageId, handoffMessage, handoffToMainThread, isVerifiedMainThreadBinding, matchesExpectedTurn, resolveAppServerCommand, selectMainThreadId, visibleReceiptMessage } from '../codex-main-thread-handoff.mjs'

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 1_500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (accept(value)) return value
    } catch (error) {
      lastError = error
    }
    await delay(10)
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`)
}

async function readReceipt(roundPath: string) {
  return JSON.parse(await readFile(resolve(roundPath, 'handoff.json'), 'utf8'))
}

async function waitForReceipt(roundPath: string, status: string, timeoutMs = 1_500) {
  return await waitFor(() => readReceipt(roundPath), (receipt) => receipt.status === status, `receipt status ${status}`, timeoutMs)
}

async function assertPathStaysAbsent(path: string, stabilityMs = 120) {
  const deadline = Date.now() + stabilityMs
  while (Date.now() < deadline) {
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await delay(10)
  }
}

async function createRound(project: string, packageId: string, exportedAt = new Date().toISOString()) {
  const roundPath = resolve(project, '.canvas-prompt', 'rounds', packageId)
  await mkdir(roundPath, { recursive: true })
  const packageContents = JSON.stringify({ meta: { package_id: packageId } })
  await writeFile(resolve(roundPath, 'prompt-package.json'), packageContents)
  await writeFile(resolve(roundPath, 'round.json'), JSON.stringify({ package_id: packageId, exported_at: exportedAt, engine: { ok: true } }))
  return { roundPath, packageContents }
}

async function installFakeAppServer(root: string, name: string, canonicalProject: string, turnStartBehavior: string) {
  const markerPath = resolve(root, `${name}.terminal`)
  const turnStartPath = resolve(root, `${name}.turn-start.json`)
  const scriptPath = resolve(root, `${name}.mjs`)
  const commandPath = resolve(root, name)
  await writeFile(scriptPath, `
    import { writeFileSync } from 'node:fs'
    import readline from 'node:readline'
    const markerPath = ${JSON.stringify(markerPath)}
    const markTerminal = (value) => { try { writeFileSync(markerPath, value) } catch {} }
    process.on('SIGTERM', () => { markTerminal('sigterm'); process.exit(0) })
    const rl = readline.createInterface({ input: process.stdin })
    for await (const line of rl) {
      const message = JSON.parse(line)
      if (message.id === 1) console.log(JSON.stringify({ id: 1, result: {} }))
      if (message.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ id: 'thread_${name}', cwd: ${JSON.stringify(canonicalProject)} }] } }))
      if (message.id === 3) console.log(JSON.stringify({ id: 3, result: {} }))
      if (message.id === 4) {
        writeFileSync(${JSON.stringify(turnStartPath)}, JSON.stringify(message.params))
        ${turnStartBehavior}
      }
    }
  `)
  await writeFile(commandPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}\n`)
  await chmod(commandPath, 0o755)
  return { commandPath, markerPath, turnStartPath }
}

const temporaryRoots: string[] = []

afterEach(async () => {
  const roots = temporaryRoots.splice(0)
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function createHarness(name: string, turnStartBehavior: string) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-handoff-'))
  temporaryRoots.push(root)
  const project = resolve(root, 'project')
  await mkdir(project, { recursive: true })
  const canonicalProject = await realpath(project)
  const { roundPath, packageContents } = await createRound(project, name)
  const server = await installFakeAppServer(root, name, canonicalProject, turnStartBehavior)
  return { root, project, canonicalProject, roundPath, packageContents, ...server }
}

function startHandoff(harness: Awaited<ReturnType<typeof createHarness>>, overrides: Record<string, unknown> = {}) {
  return handoffToMainThread({
    projectDir: harness.project,
    packagePath: resolve(harness.roundPath, 'prompt-package.json'),
    roundPath: harness.roundPath,
    engine: { ok: true },
    appServerCommand: harness.commandPath,
    mainThreadId: `thread_${nameFromRound(harness.roundPath)}`,
    // The fake App Server starts a fresh Node process. Give it the same
    // headroom under the full Vitest suite as it has in isolated execution;
    // two seconds is intermittently too short when the browser bundle tests
    // are compiling in parallel.
    startupTimeoutMs: 5_000,
    completionTimeoutMs: 500,
    focusThread: async () => false,
    ...overrides,
  })
}

function nameFromRound(roundPath: string) {
  return roundPath.split('/').at(-1) ?? ''
}

describe('main-thread handoff routing', () => {
  const projectDir = '/workspaces/canvas-prompt'

  it('keeps completion observation long enough for a real main-thread response', () => {
    expect(HANDOFF_COMPLETION_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000)
  })

  it('keeps the public handoff declaration aligned with terminal receipt states', async () => {
    const declaration = await readFile(resolve(import.meta.dirname, '..', 'codex-main-thread-handoff.d.ts'), 'utf8')
    expect(declaration).toContain("| 'archived'")
    expect(declaration).toContain("'accepted_observer_lost'")
    expect(declaration).toContain("'completed_failed'")
    expect(declaration).toContain("'completed_cancelled'")
    expect(declaration).toContain('handoffAttemptId?: string')
  })

  it('uses only an explicit host thread identity, never project cwd or recency', () => {
    expect(selectMainThreadId('current-host-thread', { threadId: 'saved-thread' })).toEqual({ threadId: 'current-host-thread', source: 'explicit_host_context' })
  })

  it('does not route when the host did not provide a current thread identity', () => {
    expect(selectMainThreadId(undefined, null)).toBeNull()
  })

  it('only falls back to a host-provided binding verified for the exact canonical project path', () => {
    expect(isVerifiedMainThreadBinding({ version: 1, enabled: true, thread_id: 'legacy' }, projectDir)).toBe(false)
    expect(isVerifiedMainThreadBinding({ version: 2, enabled: true, thread_id: 'wrong-project', project_dir: '/archive/canvas-prompt' }, projectDir)).toBe(false)
    expect(isVerifiedMainThreadBinding({ version: 2, enabled: true, thread_id: 'automatic', project_dir: projectDir, source: 'automatic-project-recency' }, projectDir)).toBe(false)
    expect(isVerifiedMainThreadBinding({ version: 3, enabled: true, thread_id: 'correct-project', project_dir: projectDir, source: 'host-provided' }, projectDir)).toBe(true)
    expect(selectMainThreadId(undefined, { threadId: 'correct-project' })).toEqual({ threadId: 'correct-project', source: 'verified_binding' })
  })

  it('archives without starting App Server when host context is unavailable', async () => {
    const harness = await createHarness('no_host_context', '')
    const result = await handoffToMainThread({ projectDir: harness.project, packagePath: resolve(harness.roundPath, 'prompt-package.json'), roundPath: harness.roundPath, engine: { ok: true }, appServerCommand: harness.commandPath })
    expect(result).toMatchObject({ status: 'archived', attempted: false, accepted: false, delivered: false })
    expect((await readReceipt(harness.roundPath)).stage).toBe('host_context_unavailable')
  })

  it('accepts completion only for the turn that this handoff started', () => {
    expect(matchesExpectedTurn('turn_expected', { turn: { id: 'turn_other' } })).toBe(false)
    expect(matchesExpectedTurn('turn_expected', { turn: { id: 'turn_expected' } })).toBe(true)
    expect(matchesExpectedTurn(null, { turn: { id: 'turn_expected' } })).toBe(false)
  })

  it('uses an explicit app-server command before PATH discovery', () => {
    expect(resolveAppServerCommand('/tmp/codex-test')).toBe('/tmp/codex-test')
  })

  it('discovers the Codex CLI bundled in ChatGPT.app when PATH is sparse', () => {
    expect(appServerCommandCandidates('/tmp/example', { PATH: '/usr/bin' })).toContain('/Applications/ChatGPT.app/Contents/Resources/codex')
  })

  it('tells the receiving task to read Compact Package, acknowledge its understanding, and continue', () => {
    const message = handoffMessage({
      packagePath: '/project/.canvas-prompt/rounds/r1/prompt-package.json',
      roundPath: '/project/.canvas-prompt/rounds/r1',
      engine: { compact_package_path: '/project/.canvas-prompt/rounds/r1/engine/compact-package.json' },
      snapshotPath: '/project/.canvas-prompt/rounds/r1/canvas-snapshot.png',
    })
    expect(message).toContain('先用 Canvas Prompt MCP 读取 Compact Package')
    expect(message).toContain('不要打开浏览器画布')
    expect(message).toContain('先用 2–4 句说明“我这样理解你这一轮”')
    expect(message).toContain('不要把 package ID、事件数量、本地路径或读取步骤当作主要回复')
  })

  it('keeps the visible attachment message separate from the internal handoff instructions', async () => {
    expect(visibleReceiptMessage()).toBe('Canvas Prompt｜本轮画布上下文已注入当前对话。')
    const harness = await createHarness('visible_message', `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_visible_message' } } }))
    `)
    await startHandoff(harness)
    const turnStart = JSON.parse(await readFile(harness.turnStartPath, 'utf8'))
    expect(turnStart.input).toContainEqual({ type: 'text', text: visibleReceiptMessage() })
    expect(turnStart.input.some((item: { text?: string }) => item.text?.includes('Compact Package'))).toBe(false)
    expect(turnStart.additionalContext['canvas-prompt-handoff']).toMatchObject({ kind: 'application' })
    expect(turnStart.additionalContext['canvas-prompt-handoff'].value).toContain('先用 Canvas Prompt MCP 读取 Compact Package')
  })

  it('gives the visible snapshot anchor a stable client message identity', async () => {
    expect(deliveryReceiptMessageId('/project/.canvas-prompt/rounds/pp_same')).toBe('canvas-prompt:pp_same')
    const harness = await createHarness('visible_receipt', `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_visible_receipt' } } }))
    `)
    const snapshotPath = resolve(harness.roundPath, 'canvas-snapshot.png')
    await writeFile(snapshotPath, 'snapshot')
    const accepted = await startHandoff(harness, { snapshotPath })
    expect(accepted).toMatchObject({
      status: 'accepted',
      visible_receipt: { requested: true, client_user_message_id: 'canvas-prompt:visible_receipt', snapshot_attached: true },
    })
    const turnStart = JSON.parse(await readFile(harness.turnStartPath, 'utf8'))
    expect(turnStart.clientUserMessageId).toBe('canvas-prompt:visible_receipt')
    expect(turnStart.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'localImage', path: snapshotPath, detail: 'high' }),
    ]))
  })

  it('keeps Node lookup paths when the Canvas service starts with a sparse PATH', () => {
    const environment = appServerEnvironment({ PATH: '/usr/bin' })
    expect(environment.PATH).toContain('/usr/bin')
    expect(environment.PATH.split(':').length).toBeGreaterThan(1)
  })

  it('serializes terminal transitions and never regresses an explicit Codex terminal state', async () => {
    const writes: string[] = []
    let releaseAccepted!: () => void
    let acceptedEntered!: () => void
    const acceptedGate = new Promise<void>((resolveGate) => { releaseAccepted = resolveGate })
    const acceptedStarted = new Promise<void>((resolveStarted) => { acceptedEntered = resolveStarted })
    const writer = createHandoffStatusWriter('/tmp/round', async (_path, result) => {
      if (result.status === 'accepted') {
        acceptedEntered()
        await acceptedGate
      }
      writes.push(result.status)
    })
    void writer.write({ status: 'accepted' })
    await acceptedStarted
    void writer.write({ status: 'accepted_timeout' })
    void writer.write({ status: 'delivered' })
    void writer.write({ status: 'completed_failed' })
    void writer.write({ status: 'delivered' })
    releaseAccepted()
    await writer.flush()
    expect(writes).toEqual(['accepted', 'accepted_timeout', 'delivered'])
  })

  it('never accepts turn/start without a valid turn ID', async () => {
    const harness = await createHarness('missing_turn', `
      console.log(JSON.stringify({ id: 4, result: { turn: {} } }))
    `)
    const result = await startHandoff(harness)
    expect(result).toMatchObject({ status: 'failed', accepted: false, delivered: false })
    const receipt = await waitForReceipt(harness.roundPath, 'failed')
    expect(receipt.expected_turn_id).toBeUndefined()
  })

  it('does not force Desktop to navigate away after a handoff is accepted', async () => {
    let focusCalls = 0
    const harness = await createHarness('no_forced_navigation', `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_stays_put' } } }))
    `)
    const result = await startHandoff(harness, { completionTimeoutMs: 60, focusThread: async () => { focusCalls += 1; return true } })
    expect(result).toMatchObject({ status: 'accepted', accepted: true })
    expect(result.activationRequested).toBeUndefined()
    expect(focusCalls).toBe(0)
    await waitForReceipt(harness.roundPath, 'accepted_timeout')
  })

  it('records accepted_timeout after a valid turn is accepted but never completes', async () => {
    const harness = await createHarness('accepted_timeout', `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_timeout' } } }))
    `)
    const result = await startHandoff(harness, { completionTimeoutMs: 60 })
    expect(result).toMatchObject({ status: 'accepted', accepted: true, delivered: false, expected_turn_id: 'turn_timeout' })
    const receipt = await waitForReceipt(harness.roundPath, 'accepted_timeout')
    expect(receipt).toMatchObject({ accepted: true, delivered: false, expected_turn_id: 'turn_timeout' })
  })

  it('records accepted_observer_lost when the App Server exits after acceptance', async () => {
    const harness = await createHarness('accepted_exit', `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_exit' } } }))
      setTimeout(() => { markTerminal('exit'); process.exit(17) }, 25)
    `)
    const result = await startHandoff(harness)
    expect(result).toMatchObject({ status: 'accepted', accepted: true, expected_turn_id: 'turn_exit' })
    const receipt = await waitForReceipt(harness.roundPath, 'accepted_observer_lost')
    expect(receipt).toMatchObject({ accepted: true, delivered: false, expected_turn_id: 'turn_exit' })
  })

  it('ignores unrelated completion and delivers only the matching turn', async () => {
    const harness = await createHarness('matching_completion', `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_expected' } } }))
      setTimeout(() => console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_other' } } })), 10)
      setTimeout(() => console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_expected' } } })), 35)
    `)
    const result = await startHandoff(harness)
    expect(result).toMatchObject({ status: 'accepted', expected_turn_id: 'turn_expected' })
    const delivered = await waitForReceipt(harness.roundPath, 'delivered')
    expect(delivered).toMatchObject({ accepted: true, delivered: true, expected_turn_id: 'turn_expected' })
  })

  it.each([
    ['failed', 'turn/failed', 'completed_failed'],
    ['cancelled', 'turn/cancelled', 'completed_cancelled'],
  ])('records only the matching turn/%s terminal state', async (_kind, event, expectedStatus) => {
    const harness = await createHarness(`terminal_${expectedStatus}`, `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_expected' } } }))
      setTimeout(() => console.log(JSON.stringify({ method: ${JSON.stringify(event)}, params: { turn: { id: 'turn_other' } } })), 10)
      setTimeout(() => console.log(JSON.stringify({ method: ${JSON.stringify(event)}, params: { turn: { id: 'turn_expected' }, error: { message: 'terminal reason' } } })), 25)
      setTimeout(() => console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_expected' } } })), 45)
    `)
    const result = await startHandoff(harness)
    expect(result).toMatchObject({ status: 'accepted', expected_turn_id: 'turn_expected' })
    const receipt = await waitForReceipt(harness.roundPath, expectedStatus)
    expect(receipt).toMatchObject({ accepted: true, delivered: false, expected_turn_id: 'turn_expected', reason: 'terminal reason' })
    await delay(80)
    expect((await readReceipt(harness.roundPath)).status).toBe(expectedStatus)
  })

  it('keeps concurrent A/B handoffs isolated through matching completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-handoff-ab-'))
    temporaryRoots.push(root)
    const project = resolve(root, 'project')
    await mkdir(project, { recursive: true })
    const canonicalProject = await realpath(project)
    const roundA = await createRound(project, 'round_a', '2026-01-01T00:00:00.000Z')
    const roundB = await createRound(project, 'round_b', '2026-01-02T00:00:00.000Z')
    const serverA = await installFakeAppServer(root, 'server_a', canonicalProject, `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_a' } } }))
      setTimeout(() => console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_a' } } })), 35)
    `)
    const serverB = await installFakeAppServer(root, 'server_b', canonicalProject, `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_b' } } }))
      setTimeout(() => console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_b' } } })), 10)
    `)
    const base = { projectDir: project, engine: { ok: true }, startupTimeoutMs: 5_000, completionTimeoutMs: 500, focusThread: async () => false }
    const [acceptedA, acceptedB] = await Promise.all([
      handoffToMainThread({ ...base, packagePath: resolve(roundA.roundPath, 'prompt-package.json'), roundPath: roundA.roundPath, appServerCommand: serverA.commandPath, mainThreadId: 'thread_server_a' }),
      handoffToMainThread({ ...base, packagePath: resolve(roundB.roundPath, 'prompt-package.json'), roundPath: roundB.roundPath, appServerCommand: serverB.commandPath, mainThreadId: 'thread_server_b' }),
    ])
    expect(acceptedA).toMatchObject({ status: 'accepted', expected_turn_id: 'turn_a' })
    expect(acceptedB, JSON.stringify(acceptedB)).toMatchObject({ status: 'accepted', expected_turn_id: 'turn_b' })
    const [deliveredA, deliveredB] = await Promise.all([
      waitForReceipt(roundA.roundPath, 'delivered'),
      waitForReceipt(roundB.roundPath, 'delivered'),
    ])
    expect(deliveredA.expected_turn_id).toBe('turn_a')
    expect(deliveredB.expected_turn_id).toBe('turn_b')
  })

  it.each([
    ['completion', `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_deleted' } } }))
      setTimeout(() => console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_deleted' } } })), 80)
    `, 500],
    ['timeout', `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_deleted' } } }))
    `, 80],
    ['exit', `
      console.log(JSON.stringify({ id: 4, result: { turn: { id: 'turn_deleted' } } }))
      setTimeout(() => { markTerminal('exit'); process.exit(19) }, 80)
    `, 500],
  ])('does not recreate a deleted accepted round after late %s', async (kind, behavior, completionTimeoutMs) => {
    const harness = await createHarness(`deleted_${kind}`, behavior)
    const roundsDir = resolve(harness.project, '.canvas-prompt', 'rounds')
    const latestPackagePath = resolve(harness.project, '.canvas-prompt', 'latest-prompt-package.json')
    await writeFile(latestPackagePath, harness.packageContents)
    const accepted = await startHandoff(harness, { completionTimeoutMs })
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ status: 'accepted', accepted: true })
    await deleteRoundAndUpdateLatest({ roundsDir, latestPackagePath, packageId: `deleted_${kind}` })
    await expect(access(harness.roundPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await waitFor(() => access(harness.markerPath).then(() => true), Boolean, `${kind} terminal marker`)
    await assertPathStaysAbsent(harness.roundPath)
  })
})
