export type ConversationScope = {
  projectDir: string | null
  threadId: string | null
  threadScopeKey: string | null
  storageKind: 'project' | 'conversation'
  canvasDir: string
  latestPackagePath: string
  roundsDir: string
}

export function validThreadId(value: unknown): boolean
export function threadScopeKey(threadId: unknown): string | null
export function resolveConversationScope(options?: {
  projectDir?: string | null
  threadId?: string | null
  homeDir?: string
}): ConversationScope
