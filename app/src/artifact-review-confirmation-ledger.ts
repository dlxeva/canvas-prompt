export type ReviewCandidateStatus = 'pending' | 'revised' | 'rebound' | 'confirmed' | 'split' | 'rejected'

export type ReviewCandidateSeed = {
  candidateId: string
  pageNumber: number
  annotationId?: string
  transcriptSegmentIds: string[]
  text: string
}

export type ReviewCandidateState = ReviewCandidateSeed & {
  status: ReviewCandidateStatus
  parentCandidateId?: string
  lastActionId?: string
}

type ActionBase = {
  actionId: string
  candidateId: string
  atMs: number
}

export type ReviewConfirmationAction =
  | (ActionBase & { kind: 'confirm' })
  | (ActionBase & { kind: 'rewrite'; text: string })
  | (ActionBase & { kind: 'rebind'; pageNumber: number; annotationId: string })
  | (ActionBase & { kind: 'reject'; reason?: string })
  | (ActionBase & { kind: 'split'; parts: Array<{ candidateId: string; text: string }> })
  | { actionId: string; kind: 'undo'; targetActionId: string; atMs: number }

type EffectiveAction = Exclude<ReviewConfirmationAction, { kind: 'undo' }>

export type ReviewConfirmationReplay = {
  candidates: Record<string, ReviewCandidateState>
  effectiveActions: EffectiveAction[]
  undoneActionIds: string[]
}

/**
 * The only portable form of the ledger.  Candidate status fields are never a
 * credential: a consumer must replay these append-only actions to establish a
 * confirmed target.
 */
export type SerializedReviewConfirmationLedger = {
  schema_version: 'artifact-review-confirmation-ledger/0.1-draft'
  candidates: ReviewCandidateSeed[]
  actions: ReviewConfirmationAction[]
}

function requireIdentifier(value: string, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} 不能为空。`)
  return value.trim()
}

function requirePageNumber(value: number) {
  if (!Number.isInteger(value) || value < 1) throw new Error('候选页码必须是从 1 开始的整数。')
  return value
}

function requireText(value: string) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('候选文本不能为空。')
  return value.trim()
}

function initialCandidates(seeds: ReviewCandidateSeed[]) {
  const candidates = new Map<string, ReviewCandidateState>()
  for (const seed of seeds) {
    const candidateId = requireIdentifier(seed.candidateId, 'candidateId')
    if (candidates.has(candidateId)) throw new Error(`重复的候选 ID：${candidateId}`)
    const transcriptSegmentIds = seed.transcriptSegmentIds.map((id) => requireIdentifier(id, 'transcriptSegmentId'))
    if (new Set(transcriptSegmentIds).size !== transcriptSegmentIds.length) throw new Error(`候选 ${candidateId} 包含重复语音片段。`)
    candidates.set(candidateId, {
      candidateId,
      pageNumber: requirePageNumber(seed.pageNumber),
      ...(seed.annotationId ? { annotationId: requireIdentifier(seed.annotationId, 'annotationId') } : {}),
      transcriptSegmentIds,
      text: requireText(seed.text),
      status: 'pending',
    })
  }
  return candidates
}

function requireMutableCandidate(candidates: Map<string, ReviewCandidateState>, candidateId: string) {
  const candidate = candidates.get(candidateId)
  if (!candidate) throw new Error(`找不到候选：${candidateId}`)
  if (candidate.status === 'split' || candidate.status === 'rejected') {
    throw new Error(`候选 ${candidateId} 已${candidate.status === 'split' ? '拆分' : '拒绝'}，不能继续修改。`)
  }
  return candidate
}

function applyEffectiveActions(seeds: ReviewCandidateSeed[], actions: EffectiveAction[]) {
  const candidates = initialCandidates(seeds)
  for (const action of actions) {
    const candidateId = requireIdentifier(action.candidateId, 'candidateId')
    const candidate = requireMutableCandidate(candidates, candidateId)
    if (action.kind === 'confirm') {
      candidates.set(candidateId, { ...candidate, status: 'confirmed', lastActionId: action.actionId })
      continue
    }
    if (action.kind === 'rewrite') {
      candidates.set(candidateId, { ...candidate, text: requireText(action.text), status: 'revised', lastActionId: action.actionId })
      continue
    }
    if (action.kind === 'rebind') {
      candidates.set(candidateId, {
        ...candidate,
        pageNumber: requirePageNumber(action.pageNumber),
        annotationId: requireIdentifier(action.annotationId, 'annotationId'),
        status: 'rebound',
        lastActionId: action.actionId,
      })
      continue
    }
    if (action.kind === 'reject') {
      candidates.set(candidateId, { ...candidate, status: 'rejected', lastActionId: action.actionId })
      continue
    }

    if (!Array.isArray(action.parts) || action.parts.length < 2) throw new Error('拆分至少需要两个子候选。')
    const childIds = new Set<string>()
    const children = action.parts.map((part) => {
      const childId = requireIdentifier(part.candidateId, '拆分候选 ID')
      if (childIds.has(childId) || candidates.has(childId)) throw new Error(`拆分候选 ID 冲突：${childId}`)
      childIds.add(childId)
      return {
        ...candidate,
        candidateId: childId,
        text: requireText(part.text),
        status: 'pending' as const,
        parentCandidateId: candidateId,
        lastActionId: action.actionId,
      }
    })
    candidates.set(candidateId, { ...candidate, status: 'split', lastActionId: action.actionId })
    for (const child of children) candidates.set(child.candidateId, child)
  }
  return Object.fromEntries(candidates)
}

/**
 * Replays the user-visible confirmation ledger without inferring intent.
 * Undo is deliberately limited to the latest effective action so replay never
 * leaves dependent child candidates or bindings in an ambiguous state.
 */
export function replayReviewConfirmationLedger(
  seeds: ReviewCandidateSeed[],
  actions: ReviewConfirmationAction[],
): ReviewConfirmationReplay {
  const effectiveActions: EffectiveAction[] = []
  const undoneActionIds: string[] = []
  const actionIds = new Set<string>()
  let previousAtMs = -1

  for (const action of actions) {
    const actionId = requireIdentifier(action.actionId, 'actionId')
    if (actionIds.has(actionId)) throw new Error(`重复的确认动作 ID：${actionId}`)
    actionIds.add(actionId)
    if (!Number.isFinite(action.atMs) || action.atMs < 0 || action.atMs < previousAtMs) {
      throw new Error('确认动作时间必须是非递减的本地毫秒值。')
    }
    previousAtMs = action.atMs

    if (action.kind === 'undo') {
      const latest = effectiveActions.at(-1)
      if (!latest || latest.actionId !== action.targetActionId) throw new Error('只能撤销最近一个仍生效的确认动作。')
      effectiveActions.pop()
      undoneActionIds.push(latest.actionId)
    } else {
      effectiveActions.push({ ...action, actionId })
    }

    // Validate every prefix so a later undo cannot hide an invalid historical action.
    applyEffectiveActions(seeds, effectiveActions)
  }

  return {
    candidates: applyEffectiveActions(seeds, effectiveActions),
    effectiveActions,
    undoneActionIds,
  }
}

export function serializeReviewConfirmationLedger(
  candidates: ReviewCandidateSeed[],
  actions: ReviewConfirmationAction[],
): SerializedReviewConfirmationLedger {
  // Replay before cloning: callers cannot serialize an invalid or internally
  // inconsistent history as a "credential".
  replayReviewConfirmationLedger(candidates, actions)
  return {
    schema_version: 'artifact-review-confirmation-ledger/0.1-draft',
    candidates: structuredClone(candidates),
    actions: structuredClone(actions),
  }
}

export function replaySerializedReviewConfirmationLedger(value: unknown): ReviewConfirmationReplay {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value)
    || (value as { schema_version?: unknown }).schema_version !== 'artifact-review-confirmation-ledger/0.1-draft'
    || !Array.isArray((value as { candidates?: unknown }).candidates)
    || !Array.isArray((value as { actions?: unknown }).actions)
  ) throw new Error('确认账本凭据格式无效。')
  return replayReviewConfirmationLedger(
    structuredClone((value as { candidates: ReviewCandidateSeed[] }).candidates),
    structuredClone((value as { actions: ReviewConfirmationAction[] }).actions),
  )
}
