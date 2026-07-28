import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const THREAD_ID = /^[A-Za-z0-9_-]{8,200}$/

/** @param {unknown} value */
export function validThreadId(value) {
  return typeof value === 'string' && THREAD_ID.test(value)
}

// Do not expose a Desktop conversation identifier in an on-disk directory
// name. The full ID remains only in the local binding metadata and immutable
// round provenance; paths use a stable one-way key instead.
/** @param {unknown} threadId */
export function threadScopeKey(threadId) {
  if (!validThreadId(threadId)) return null
  return createHash('sha256').update(threadId).digest('hex').slice(0, 24)
}

// A launch capability is an opaque, locally generated token retained by the
// host conversation. It is the compatibility bridge for hosts which do not
// expose their native conversation ID to a plugin process.
export function validSessionId(value) {
  return validThreadId(value)
}

export function sessionScopeKey(sessionId) {
  return threadScopeKey(sessionId)
}

/**
 * Resolve the one storage scope owned by a Canvas session.
 *
 * A project selects where a user-owned archive lives. A thread selects which
 * conversation can read and receive that archive. Never use recency as either
 * identity. Project-less conversations live under the user's private Canvas
 * runtime, while project conversations remain inside that project.
 */
/**
 * @param {{ projectDir?: string | null, threadId?: string | null, sessionId?: string | null, homeDir?: string, singleBoard?: boolean }} options
 */
export function resolveConversationScope({ projectDir = null, threadId = null, sessionId = null, homeDir = homedir(), singleBoard = false } = {}) {
  const normalizedProject = typeof projectDir === 'string' && projectDir.trim()
    ? resolve(projectDir)
    : null
  const key = threadScopeKey(threadId) ?? sessionScopeKey(sessionId)
  const bindingKind = threadScopeKey(threadId) ? 'thread' : sessionScopeKey(sessionId) ? 'session' : null

  if (singleBoard) {
    const canvasDir = resolve(homeDir, '.canvas-prompt', 'board')
    return {
      projectDir: normalizedProject,
      threadId: null,
      sessionId: null,
      bindingKind: 'single_board',
      threadScopeKey: null,
      storageKind: 'single_board',
      canvasDir,
      latestPackagePath: resolve(canvasDir, 'latest-prompt-package.json'),
      roundsDir: resolve(canvasDir, 'rounds'),
    }
  }

  if (!normalizedProject && !key) {
    throw new Error('Canvas Prompt requires a project directory or an explicit conversation thread ID.')
  }

  const storageRoot = normalizedProject
    ? resolve(normalizedProject, '.canvas-prompt')
    : resolve(homeDir, '.canvas-prompt', 'conversations', key)
  const canvasDir = key && normalizedProject
    ? resolve(storageRoot, bindingKind === 'thread' ? 'threads' : 'sessions', key)
    : storageRoot

  return {
    projectDir: normalizedProject,
    threadId: bindingKind === 'thread' ? threadId : null,
    sessionId: bindingKind === 'session' ? sessionId : null,
    bindingKind,
    threadScopeKey: key,
    storageKind: normalizedProject ? 'project' : 'conversation',
    canvasDir,
    latestPackagePath: resolve(canvasDir, 'latest-prompt-package.json'),
    roundsDir: resolve(canvasDir, 'rounds'),
  }
}
