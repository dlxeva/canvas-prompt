import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { isRoundHandoffCancelled } from './round-lifecycle.mjs'

// The receipt is persisted as soon as the target turn accepts it.  This guard
// only bounds the optional completion watcher, so it must never leave the UI
// looking as if export itself is still running.
// Acceptance is the user-facing completion point: the person can continue in
// the main conversation immediately.  Completion is a background observer
// only, so it must accommodate a genuinely long model turn rather than turn a
// healthy handoff into an artificial timeout after 75 seconds.
export const HANDOFF_COMPLETION_TIMEOUT_MS = 10 * 60_000
// Resuming a large legacy Desktop thread can take longer than the original
// 20-second handshake budget. This is still pre-acceptance, so wait a bounded
// minute instead of reporting a false send failure.
const HANDOFF_STARTUP_TIMEOUT_MS = 60_000

export function isVerifiedMainThreadBinding(value, projectDir) {
  // Project cwd and recency are not an identity for the conversation that is
  // currently visible in a Desktop host. A binding is usable only when the
  // host supplied it through an explicit current-conversation integration.
  return value?.version === 3
    && value?.enabled === true
    && typeof value.thread_id === 'string'
    && Boolean(value.thread_id.trim())
    && value.project_dir === projectDir
    && value.source === 'host-provided'
}

/**
 * A browser sidecar cannot discover the user's focused Desktop conversation.
 * Never use project cwd / recency to guess one: several historical threads
 * legitimately share a workspace and a wrong guess silently leaks context.
 */
export function selectMainThreadId(explicitThreadId, savedBinding) {
  if (typeof explicitThreadId === 'string' && explicitThreadId.trim()) return { threadId: explicitThreadId.trim(), source: 'explicit_host_context' }
  // A previous project's binding is not evidence that the same conversation
  // is currently visible. The Canvas service receives a host-provided thread
  // ID for every scoped launch; without it, archive only rather than routing
  // a new round to a historical conversation.
  void savedBinding
  return null
}

/**
 * Stable client-side identity for the visible Canvas Prompt input in a Codex
 * thread. Reusing it on a retry lets Desktop coalesce the same round instead
 * of presenting duplicate snapshot attachments as separate user actions.
 */
export function deliveryReceiptMessageId(roundPath) {
  return `canvas-prompt:${basename(resolve(roundPath))}`
}

async function persistHandoffStatus(roundPath, result) {
  const path = resolve(roundPath, 'handoff.json')
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const attemptId = typeof result.handoff_attempt_id === 'string' ? result.handoff_attempt_id : null
  const attemptPath = attemptId ? resolve(roundPath, 'handoff-attempts', `${attemptId}.json`) : null
  const attemptTemporary = attemptPath ? `${attemptPath}.${process.pid}.${randomUUID()}.tmp` : null
  try {
    // The immutable round must already exist. Never recreate a user-deleted
    // round merely because the App Server reports a late terminal event.
    if (isRoundHandoffCancelled(roundPath) || !existsSync(roundPath)) return false
    const receipt = `${JSON.stringify({ updated_at: new Date().toISOString(), ...result }, null, 2)}\n`
    if (attemptPath && attemptTemporary) {
      await mkdir(dirname(attemptPath), { recursive: true })
      await writeFile(attemptTemporary, receipt, 'utf8')
    }
    await writeFile(temporary, receipt, 'utf8')
    if (isRoundHandoffCancelled(roundPath) || !existsSync(roundPath)) {
      await unlink(temporary).catch(() => undefined)
      if (attemptTemporary) await unlink(attemptTemporary).catch(() => undefined)
      return false
    }
    if (attemptPath && attemptTemporary) await rename(attemptTemporary, attemptPath)
    await rename(temporary, path)
    return true
  } catch {
    await unlink(temporary).catch(() => undefined)
    if (attemptTemporary) await unlink(attemptTemporary).catch(() => undefined)
    // Handoff observability must not change the export result.
    return false
  }
}

/**
 * Serialize all receipt writes. Explicit Codex terminal states are never
 * overwritten by a later observer event from the same App Server process.
 */
export function createHandoffStatusWriter(roundPath, persist = persistHandoffStatus) {
  let queue = Promise.resolve()
  let terminal = false
  return {
    write(result) {
      queue = queue.then(async () => {
        if (terminal) return
        await persist(roundPath, result)
        if (['delivered', 'completed_failed', 'completed_cancelled'].includes(result.status)) terminal = true
      })
      return queue
    },
    flush() { return queue },
  }
}

export function turnIdFrom(value) {
  const candidate = value?.turn?.id ?? value?.turn_id ?? value?.id
  return typeof candidate === 'string' && candidate.trim() ? candidate : null
}

export function matchesExpectedTurn(expectedTurnId, completed) {
  return Boolean(expectedTurnId) && turnIdFrom(completed) === expectedTurnId
}

/**
 * Known desktop CLI locations. The Canvas service is frequently launched by
 * launchd with a deliberately reduced PATH, while Codex Desktop bundles its
 * CLI inside ChatGPT.app rather than installing it into a shell directory.
 */
export function appServerCommandCandidates(home = homedir(), environment = process.env) {
  return [
    environment.CANVAS_PROMPT_CODEX_COMMAND,
    environment.CODEX_EXECUTABLE,
    // A Desktop handoff should speak the bundled Desktop CLI's protocol before
    // trying a potentially older shell-installed Codex binary.
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    resolve(home, '.npm-global', 'bin', 'codex'),
    resolve(home, '.local', 'bin', 'codex'),
  ]
}

/** Resolve the desktop CLI without depending on Vite's reduced PATH. */
export function resolveAppServerCommand(override) {
  if (typeof override === 'string' && override.trim()) return override.trim()
  for (const candidate of appServerCommandCandidates()) {
    if (typeof candidate === 'string' && candidate.trim() && existsSync(candidate)) return candidate
  }
  // Retain PATH lookup as a final compatibility fallback. The resulting
  // failure is persisted in handoff.json instead of being reported as sent.
  return 'codex'
}

/**
 * launchd starts the Canvas service with a deliberately small PATH. The
 * desktop CLI installed by npm uses `#!/usr/bin/env node`, so preserve the
 * Node locations that can execute that shim instead of relying on the shell
 * environment that happened to launch Vite.
 */
export function appServerEnvironment(base = process.env) {
  const pathEntries = [
    dirname(process.execPath),
    resolve(homedir(), '.local', 'bin'),
    resolve(homedir(), '.npm-global', 'bin'),
    base.PATH,
  ].filter((value, index, values) => typeof value === 'string' && value && values.indexOf(value) === index)
  return { ...base, PATH: pathEntries.join(delimiter) }
}

export function handoffMessage({ packagePath, roundPath, engine, snapshotPath, keyframePaths = [] }) {
  const enginePaths = [engine?.process_ir_path, engine?.compact_package_path].filter(Boolean)
  return [
    '[Canvas Prompt｜本轮推演上下文]',
    snapshotPath ? '上方附件是本轮画布最终快照；完整上下文已随本轮一同接收。' : '本轮完整上下文已接收。',
    '请将下面的本地文件作为本轮输入上下文读取；它记录的是画布、语音、时间、空间关系和变换过程。',
    `Prompt Package：${packagePath}`,
    `本轮目录：${roundPath}`,
    ...(keyframePaths.length ? [`状态帧（仅在需要理解沉默的空间重组时查看）：${keyframePaths.join('；')}`] : []),
    ...(enginePaths.length ? [`核心编译产物：${enginePaths.join('；')}`] : []),
    [
      '快速读取规则：先用 Canvas Prompt MCP 读取 Compact Package；不要打开浏览器画布、索取 Base64 截图，或回放原始笔迹作为第一步。只有 Compact Package 明确留下重要视觉歧义时，才查看一个本地快照。',
      '交接规则：这是一轮已经结束、不可变的富输入，不是要求用户继续操作画布。先读取 Prompt Package 与核心编译产物。',
      '回复规则：先用 2–4 句说明“我这样理解你这一轮”的目标、结构或修改请求；明确区分观察、合理推断和待确认。随后直接继续讨论或执行用户已经表达的下一步。',
      '不要把 package ID、事件数量、本地路径或读取步骤当作主要回复；不要要求用户手动调用 Skill、重新上传截图或回到画布来解释已经导出的内容。',
      '若语义不足但有空间重组：报告可直接观察到的创建、移动、缩放、删除与状态帧变化；不要给对象杜撰名称或优先级。只提出一个最小澄清问题，并说明回答后你能继续做什么。',
      '把“观察”“合理推断”“待确认”明确分开。位置、颜色、缩放、停顿只能作为弱线索，不能单独证明意图。',
    ].join('\n'),
  ].join('\n')
}

/** The only text placed beside the user-visible snapshot attachment. */
export function visibleReceiptMessage() {
  return 'Canvas Prompt｜本轮画布已整理，可继续讨论。'
}

/**
 * Starts a turn in the existing Codex Desktop thread. This is intentionally
 * separate from the old bridge, which spawned a new child Codex conversation.
 */
export async function handoffToMainThread({
  projectDir,
  packagePath,
  roundPath,
  snapshotPath,
  keyframePaths,
  engine,
  appServerCommand = undefined,
  startupTimeoutMs = HANDOFF_STARTUP_TIMEOUT_MS,
  completionTimeoutMs = HANDOFF_COMPLETION_TIMEOUT_MS,
  handoffAttemptId = randomUUID(),
  mainThreadId,
}) {
  const selectedThread = selectMainThreadId(mainThreadId)
  if (!selectedThread) {
    const receipt = {
      status: 'archived', stage: 'host_context_unavailable', attempted: false, accepted: false, delivered: false,
      reason: '本轮已保存到本地；当前宿主没有提供正在使用的主对话标识，因此没有尝试推送，避免误投到历史对话。',
      handoff_attempt_id: handoffAttemptId,
    }
    await persistHandoffStatus(roundPath, receipt)
    return receipt
  }
  const resolvedAppServerCommand = resolveAppServerCommand(appServerCommand)
  const receiptMessageId = deliveryReceiptMessageId(roundPath)

  return await new Promise((resolveHandoff) => {
    const child = spawn(resolvedAppServerCommand, ['app-server', '--stdio'], {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: appServerEnvironment(),
    })
    let buffer = ''
    let settled = false
    let initialized = false
    let resumed = false
    let stage = 'spawned'
    let targetThreadId = selectedThread.threadId
    let expectedTurnId = null
    let startupTimer = null
    let completionTimer = null
    const statusWriter = createHandoffStatusWriter(roundPath)

    const withAttempt = (result) => ({ ...result, handoff_attempt_id: handoffAttemptId })
    const finish = (result, { terminate = true } = {}) => {
      if (settled) return
      settled = true
      if (startupTimer) clearTimeout(startupTimer)
      if (completionTimer) clearTimeout(completionTimer)
      if (terminate) child.kill('SIGTERM')
      const receipt = withAttempt(result)
      void statusWriter.write(receipt).finally(() => resolveHandoff(receipt))
    }
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    startupTimer = setTimeout(() => finish({ status: 'failed', stage, attempted: true, accepted: false, delivered: false, threadId: targetThreadId, reason: '主对话桥接未能在初始化阶段建立连接。' }), startupTimeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1 && message.result && !initialized) {
          initialized = true
          stage = 'initialized'
          send({ method: 'initialized', params: {} })
          stage = 'thread_selected'
          send({ id: 3, method: 'thread/resume', params: { threadId: targetThreadId } })
          continue
        }
        if (message.id === 3) {
          if (message.error) return finish({ status: 'failed', stage, attempted: true, accepted: false, delivered: false, reason: message.error.message ?? '无法连接当前主对话' })
          resumed = true
          stage = 'resumed'
          send({
            id: 4,
            method: 'turn/start',
            params: {
              threadId: targetThreadId,
              // This is a client message, not invisible extra context. It
              // carries the final snapshot into the target thread so Desktop
              // can render a user-visible delivery anchor alongside the
              // complete context below.
              clientUserMessageId: receiptMessageId,
              input: [
                ...(snapshotPath ? [{ type: 'localImage', path: snapshotPath, detail: 'high' }] : []),
                { type: 'text', text: visibleReceiptMessage() },
              ],
              additionalContext: {
                'canvas-prompt-export': {
                  kind: 'application',
                  value: JSON.stringify({ package_path: packagePath, round_path: roundPath, engine }),
                },
                // Keep compiler paths and reasoning instructions out of the
                // user-visible attachment message. They remain application
                // context for the receiving main conversation.
                'canvas-prompt-handoff': {
                  kind: 'application',
                  value: handoffMessage({ packagePath, roundPath, snapshotPath, keyframePaths, engine }),
                },
              },
            },
          })
          continue
        }
        if (message.id === 4) {
          if (message.error) return finish({ status: 'failed', stage, attempted: true, accepted: false, delivered: false, reason: message.error.message ?? '主对话未接受本轮上下文' })
          expectedTurnId = turnIdFrom(message.result)
          if (!expectedTurnId) {
            stage = 'turn_start_invalid'
            return finish({
              status: 'failed', stage, attempted: true, accepted: false, delivered: false,
              threadId: targetThreadId,
              reason: '主对话未返回有效的 turn ID，本轮未确认接收。',
            })
          }
          // A turn has only been accepted here; killing app-server at this
          // point aborts that turn before Desktop can receive it. Keep this
          // process alive until the server reports completion or times out.
          stage = 'turn_accepted'
          if (startupTimer) clearTimeout(startupTimer)
          completionTimer = setTimeout(() => finish({
            status: 'accepted_timeout', stage, attempted: true, accepted: true, delivered: false,
            threadId: targetThreadId, expected_turn_id: expectedTurnId,
            reason: `主对话已接受本轮，但未在 ${Math.round(completionTimeoutMs / 1000)} 秒内报告完成。`,
          }), completionTimeoutMs)
          const accepted = withAttempt({
            status: 'accepted', stage, attempted: true, accepted: true, delivered: false,
            threadId: targetThreadId, expected_turn_id: expectedTurnId,
            visible_receipt: { requested: true, client_user_message_id: receiptMessageId, snapshot_attached: Boolean(snapshotPath) },
            accepted_at: new Date().toISOString(), turn: message.result ?? null,
          })
          void statusWriter.write(accepted)
          resolveHandoff(accepted)
          continue
        }
        if (message.method === 'turn/completed') {
          if (!matchesExpectedTurn(expectedTurnId, message.params)) continue
          stage = 'turn_completed'
          const completed = {
            status: 'delivered', stage, attempted: true, accepted: true, delivered: true,
            threadId: targetThreadId, expected_turn_id: expectedTurnId,
            visible_receipt: { requested: true, client_user_message_id: receiptMessageId, snapshot_attached: Boolean(snapshotPath) },
            completed_at: new Date().toISOString(), turn: message.params?.turn ?? null,
          }
          return finish(completed)
        }
        if (message.method === 'turn/failed' || message.method === 'turn/cancelled') {
          if (!matchesExpectedTurn(expectedTurnId, message.params)) continue
          const cancelled = message.method === 'turn/cancelled'
          stage = cancelled ? 'turn_cancelled' : 'turn_failed'
          return finish({
            status: cancelled ? 'completed_cancelled' : 'completed_failed',
            stage, attempted: true, accepted: true, delivered: false,
            threadId: targetThreadId, expected_turn_id: expectedTurnId,
            completed_at: new Date().toISOString(),
            reason: message.params?.error?.message ?? message.params?.reason ?? (cancelled ? '主对话取消了本轮处理。' : '主对话未能完成本轮处理。'),
            turn: message.params?.turn ?? null,
          })
        }
      }
    })
    const failureReceipt = (reason) => expectedTurnId
      ? {
          status: 'accepted_observer_lost', stage, attempted: true, accepted: true, delivered: false,
          threadId: targetThreadId ?? undefined, expected_turn_id: expectedTurnId, reason,
        }
      : {
          status: 'failed', stage, attempted: true, accepted: false, delivered: false,
          threadId: targetThreadId ?? undefined, reason,
        }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => undefined)
    child.once('error', (error) => finish(failureReceipt(error.message)))
    child.once('exit', (code) => {
      if (!settled) finish(failureReceipt(`主对话桥接已退出 (${code ?? 'unknown'})`), { terminate: false })
    })
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'canvas-prompt-handoff', version: '0.1.14' },
        capabilities: { experimentalApi: true },
      },
    })
  })
}
