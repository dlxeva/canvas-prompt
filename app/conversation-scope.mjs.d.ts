export type ConversationScope = {
  projectDir: string | null
  threadId: string | null
  sessionId: string | null
  bindingKind: 'thread' | 'session' | 'single_board' | null
  threadScopeKey: string | null
  storageKind: 'project' | 'conversation' | 'single_board'
  canvasDir: string
  latestPackagePath: string
  roundsDir: string
}

export function validThreadId(value: unknown): boolean
export function threadScopeKey(threadId: unknown): string | null
export function validSessionId(sessionId: unknown): boolean
export function sessionScopeKey(sessionId: unknown): string | null
export function resolveConversationScope(options?: {
  projectDir?: string | null
  threadId?: string | null
  sessionId?: string | null
  singleBoard?: boolean
  homeDir?: string
}): ConversationScope
