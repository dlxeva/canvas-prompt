import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { resolveConversationScope, sessionScopeKey, threadScopeKey } from '../app/conversation-scope.mjs'

test('a project conversation is stored beneath that project but isolated by a non-reversible thread key', () => {
  const threadId = '019fa-thread-route-12345678'
  const scope = resolveConversationScope({ projectDir: '/workspace/alpha', threadId, homeDir: '/tmp/canvas-prompt-test-home' })
  assert.equal(scope.storageKind, 'project')
  assert.equal(scope.threadId, threadId)
  assert.equal(scope.threadScopeKey, threadScopeKey(threadId))
  assert.equal(scope.canvasDir, resolve('/workspace/alpha/.canvas-prompt/threads', scope.threadScopeKey))
  assert.equal(scope.canvasDir.includes(threadId), false)
})

test('a project-less conversation receives a user-private conversation archive', () => {
  const threadId = '019fa-temporary-chat-12345678'
  const isolatedHome = join('/tmp', 'canvas-prompt-test-home')
  const scope = resolveConversationScope({ threadId, homeDir: isolatedHome })
  assert.equal(scope.storageKind, 'conversation')
  assert.equal(scope.projectDir, null)
  assert.equal(scope.canvasDir, resolve(isolatedHome, '.canvas-prompt/conversations', threadScopeKey(threadId)))
})

test('a launch capability isolates a session when a host did not expose a native thread ID', () => {
  const sessionId = 'cpsessiona1b2c3d4e5f6g7h8'
  const scope = resolveConversationScope({ projectDir: '/workspace/alpha', sessionId, homeDir: '/tmp/canvas-prompt-test-home' })
  assert.equal(scope.threadId, null)
  assert.equal(scope.sessionId, sessionId)
  assert.equal(scope.bindingKind, 'session')
  assert.equal(scope.threadScopeKey, sessionScopeKey(sessionId))
  assert.equal(scope.canvasDir, resolve('/workspace/alpha/.canvas-prompt/sessions', sessionScopeKey(sessionId)))
  assert.equal(scope.canvasDir.includes(sessionId), false)
})

test('the product default can resolve one plugin-private board without a project or conversation ID', () => {
  const scope = resolveConversationScope({ homeDir: '/tmp/canvas-prompt-test-home', singleBoard: true })
  assert.equal(scope.storageKind, 'single_board')
  assert.equal(scope.bindingKind, 'single_board')
  assert.equal(scope.canvasDir, resolve('/tmp/canvas-prompt-test-home/.canvas-prompt/board'))
  assert.equal(scope.threadId, null)
})

test('a project can keep legacy project-only storage but an anonymous conversation cannot be invented', () => {
  const projectScope = resolveConversationScope({ projectDir: '/workspace/alpha' })
  assert.equal(projectScope.threadId, null)
  assert.equal(projectScope.canvasDir, resolve('/workspace/alpha/.canvas-prompt'))
  assert.throws(() => resolveConversationScope({ homeDir: homedir() }), /project directory or an explicit conversation thread ID/)
})
