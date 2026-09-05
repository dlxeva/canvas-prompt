export type MainThreadHandoffInput = {
  projectDir: string
  packagePath: string
  roundPath: string
  snapshotPath?: string | null
  keyframePaths?: string[]
  engine: {
    ok: boolean
    error?: string
    process_ir_path?: string
    compact_package_path?: string
    minimal_context_pack_path?: string
    continuity_policy_path?: string
    context_id?: string
  }
  appServerCommand?: string
  startupTimeoutMs?: number
  handoffAttemptId?: string
  /** Supplied by an explicit host integration; cwd/recency are never used to guess it. */
  mainThreadId?: string
}

export type MainThreadHandoffStatus =
  | 'archived'
  | 'accepted'
  | 'failed'

export type MainThreadHandoffResult = {
  status: MainThreadHandoffStatus
  attempted: boolean
  accepted: boolean
  delivered: boolean
  threadId?: string
  expected_turn_id?: string | null
  reason?: string
  turn?: unknown
  handoff_attempt_id?: string
}

export function isVerifiedMainThreadBinding(value: unknown, projectDir: string): boolean

export function selectMainThreadId(
  explicitThreadId?: string | null,
  savedBinding?: { threadId: string } | null,
): { threadId: string; source: 'explicit_host_context' } | null

export function handoffToMainThread(input: MainThreadHandoffInput): Promise<MainThreadHandoffResult>
export function deliveryReceiptMessageId(roundPath: string): string
export function visibleReceiptMessage(): string

export function appServerCommandCandidates(home?: string, environment?: NodeJS.ProcessEnv): Array<string | undefined>
export function resolveAppServerCommand(override?: string): string
export function appServerEnvironment(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
