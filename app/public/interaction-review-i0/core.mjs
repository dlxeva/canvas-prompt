import { validateAdapterDeclaration } from './adapter-contract.mjs'

export const PACKAGE_VERSION = 'interaction-review-package/0.1'
export const DELETION_RECEIPT_VERSION = 'interaction-review-deletion-receipt/0.1'
export const packageIdForSession = (sessionId) => `irp_${sessionId}`

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

export function packageForIntegrity(pkg) {
  const clone = structuredClone(pkg)
  if (clone.integrity) clone.integrity.value = ''
  return stableStringify(clone)
}

export function summarizeSession(events, feedback, proposals) {
  const routes = [...new Set(events.map((event) => event.route))]
  const actions = events.filter((event) => event.kind !== 'scroll').map((event) => event.element_id).filter(Boolean)
  const feedbackSummary = feedback.length === 0
    ? '本轮没有提交文字反馈。'
    : feedback.map((item) => item.text).join('；')
  const confirmation = proposals.length === 0
    ? '尚无修改建议。'
    : proposals.map((proposal) => `${proposal.id}:${proposal.confirmation.status}`).join('，')
  return {
    did: `走过 ${routes.join(' → ')}；关键操作：${[...new Set(actions)].join('、') || '无'}。`,
    happened: `记录 ${events.length} 个受控事件，其中 ${events.filter((event) => event.kind === 'input' && event.privacy === 'excluded').length} 个敏感输入已排除。`,
    issue: feedbackSummary,
    desired_change: confirmation,
  }
}

const SENSITIVE_SNAPSHOT_KEYS = new Set([
  'email', 'sensitiveemail', 'password', 'passcode', 'token', 'accesstoken',
  'refreshtoken', 'secret', 'authorization', 'cookie', 'sessioncookie',
])

const EXCLUDED_EVENT_PAYLOAD_KEYS = new Set([
  'value', 'inputvalue', 'rawvalue', 'text', 'content', 'payload',
])

function normalizedKey(key) {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function containsKey(value, prohibited) {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, prohibited))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, nested]) => prohibited.has(normalizedKey(key)) || containsKey(nested, prohibited))
}

export function captureBufferIsCleared(buffer) {
  return buffer?.session === null
    && Array.isArray(buffer.events) && buffer.events.length === 0
    && buffer.snapshots && Object.keys(buffer.snapshots).length === 0
    && Array.isArray(buffer.feedback) && buffer.feedback.length === 0
    && Array.isArray(buffer.proposals) && buffer.proposals.length === 0
    && buffer.packageText === ''
    && buffer.packageStatus === ''
    && buffer.feedbackText === ''
    && buffer.viewedEvidence === null
    && buffer.prototype?.sensitive_email === ''
}

export function deletionReceiptForIntegrity(receipt) {
  const clone = structuredClone(receipt)
  if (clone.integrity) clone.integrity.value = ''
  return stableStringify(clone)
}

export async function sealDeletionReceipt(receipt, digest) {
  const sealed = structuredClone(receipt)
  sealed.integrity.value = await digest(deletionReceiptForIntegrity(sealed))
  const check = validateDeletionReceipt(sealed, sealed.session_id)
  if (!check.valid) throw new Error(`删除回执签封失败：${check.errors.join(' ')}`)
  return sealed
}

export function validateDeletionReceipt(receipt, expectedSessionId = null) {
  const errors = []
  if (!receipt || typeof receipt !== 'object') return { valid: false, errors: ['删除回执不是对象。'] }
  if (receipt.schema !== DELETION_RECEIPT_VERSION) errors.push(`删除回执 schema 必须是 ${DELETION_RECEIPT_VERSION}。`)
  if (!receipt.session_id) errors.push('删除回执缺少 session_id。')
  if (receipt.package_id !== packageIdForSession(receipt.session_id)) errors.push('删除回执的 package_id 与 session_id 不属于同一 lineage。')
  if (expectedSessionId && receipt.session_id !== expectedSessionId) errors.push('删除回执指向了其他 session。')
  if (!receipt.discarded_at || Number.isNaN(Date.parse(receipt.discarded_at))) errors.push('删除回执缺少有效 discarded_at。')
  if (receipt.scope !== 'current-browser-capture-buffer-only') errors.push('删除回执超出当前浏览器缓冲区范围。')
  if (receipt.storage !== 'browser-memory' || receipt.status !== 'cleared') errors.push('删除回执的存储或状态无效。')
  if (receipt.exported_copy !== 'not-managed' || receipt.historical_packages !== 'untouched') errors.push('删除回执不能声称已处理下载副本或历史包。')
  if (receipt.integrity?.algorithm !== 'SHA-256' || receipt.integrity?.scope !== 'stable JSON with integrity.value blank') errors.push('删除回执缺少稳定完整性范围。')
  if (!/^$|^[a-f0-9]{64}$/.test(receipt.integrity?.value ?? 'invalid')) errors.push('删除回执完整性值必须为空或 64 位 SHA-256。')
  return { valid: errors.length === 0, errors }
}

export function discardCaptureBuffer(buffer, discardedAt) {
  if (!buffer?.session?.id) throw new Error('只能丢弃带 session.id 的当前浏览器采集缓冲区。')
  if (!discardedAt || Number.isNaN(Date.parse(discardedAt))) throw new Error('discardedAt 必须是有效时间。')
  const sessionId = buffer.session.id
  buffer.session = null
  buffer.events = []
  buffer.snapshots = {}
  buffer.feedback = []
  buffer.proposals = []
  buffer.packageText = ''
  buffer.packageStatus = ''
  buffer.feedbackText = ''
  buffer.viewedEvidence = null
  if (buffer.prototype) buffer.prototype.sensitive_email = ''
  if (!captureBufferIsCleared(buffer)) throw new Error('采集缓冲区未完全清空，不能生成删除回执。')
  const receipt = {
    schema: DELETION_RECEIPT_VERSION,
    session_id: sessionId,
    package_id: packageIdForSession(sessionId),
    discarded_at: discardedAt,
    scope: 'current-browser-capture-buffer-only',
    storage: 'browser-memory',
    status: 'cleared',
    exported_copy: 'not-managed',
    historical_packages: 'untouched',
    integrity: { algorithm: 'SHA-256', scope: 'stable JSON with integrity.value blank', value: '' },
  }
  const check = validateDeletionReceipt(receipt, sessionId)
  if (!check.valid) throw new Error(`删除回执校验失败：${check.errors.join(' ')}`)
  return receipt
}

export function validatePackage(pkg) {
  const errors = []
  if (!pkg || typeof pkg !== 'object') return { valid: false, errors: ['包不是对象。'] }
  if (pkg.schema !== PACKAGE_VERSION) errors.push(`schema 必须是 ${PACKAGE_VERSION}。`)
  if (pkg.package_id !== packageIdForSession(pkg.capture?.session_id)) errors.push('package_id 与 capture.session_id 不属于同一 lineage。')
  if (pkg.capture?.mode !== 'explicit-review-session') errors.push('capture.mode 必须表明显式会话。')
  if (pkg.capture?.background_monitoring !== false) errors.push('包不能声明后台监控。')
  if (!Array.isArray(pkg.capture?.allowed_routes) || pkg.capture.allowed_routes.length === 0) errors.push('capture.allowed_routes 必须声明受控路由。')
  if (pkg.capture?.privacy?.retention !== 'browser-memory-until-explicit-discard-or-page-close') errors.push('capture.privacy.retention 必须与真实清理触发条件一致。')
  if (pkg.retention?.capture_buffer?.storage !== 'browser-memory') errors.push('采集缓冲区必须限定在浏览器内存。')
  if (pkg.retention?.capture_buffer?.state !== 'retained') errors.push('尚未实现删除动作时，采集缓冲区只能声明 retained。')
  if (pkg.retention?.capture_buffer?.clear_trigger !== 'explicit-discard-or-page-close') errors.push('采集缓冲区必须声明明确清理触发条件。')
  if (pkg.retention?.exported_copy?.management !== 'user-controlled-after-download') errors.push('导出副本必须声明由用户在下载后管理。')
  if (pkg.retention?.deletion_receipt !== null) errors.push('尚未执行可验证删除时，不能生成删除回执。')
  if (!Array.isArray(pkg.events) || pkg.events.length === 0) errors.push('至少需要一个事件。')
  if (!Array.isArray(pkg.evidence)) errors.push('evidence 必须是数组。')
  const allowedRoutes = new Set(pkg.capture?.allowed_routes ?? [])
  const evidenceIds = new Set((pkg.evidence ?? []).map((evidence) => evidence.id))
  const eventIds = new Set()
  const feedbackIds = new Set()
  const proposalIds = new Set()
  const eventsById = new Map()
  const feedbackById = new Map()
  const referencedSnapshotIds = new Set()
  for (const event of pkg.events ?? []) {
    if (!event.id || !event.route || !event.kind || typeof event.at_ms !== 'number') errors.push('事件缺少 id、route、kind 或 at_ms。')
    if (eventIds.has(event.id)) errors.push(`事件 ID ${event.id} 重复。`)
    eventIds.add(event.id)
    eventsById.set(event.id, event)
    if (!allowedRoutes.has(event.route)) errors.push(`事件 ${event.id} 超出受控路由范围。`)
    if (event.before_snapshot_id && !pkg.snapshots?.[event.before_snapshot_id]) errors.push(`事件 ${event.id} 缺少前状态快照。`)
    if (event.after_snapshot_id && !pkg.snapshots?.[event.after_snapshot_id]) errors.push(`事件 ${event.id} 缺少后状态快照。`)
    if (event.before_snapshot_id) referencedSnapshotIds.add(event.before_snapshot_id)
    if (event.after_snapshot_id) referencedSnapshotIds.add(event.after_snapshot_id)
    if (event.privacy === 'excluded' && containsKey(event, EXCLUDED_EVENT_PAYLOAD_KEYS)) errors.push(`排除事件 ${event.id} 仍含敏感输入载荷。`)
  }
  for (const [snapshotId, snapshot] of Object.entries(pkg.snapshots ?? {})) {
    if (!referencedSnapshotIds.has(snapshotId)) errors.push(`快照 ${snapshotId} 未被本轮事件引用。`)
    if (!allowedRoutes.has(snapshot?.route)) errors.push(`快照 ${snapshotId} 超出受控路由范围。`)
    if (containsKey(snapshot, SENSITIVE_SNAPSHOT_KEYS)) errors.push(`快照 ${snapshotId} 含敏感状态字段。`)
  }
  for (const item of pkg.feedback ?? []) {
    if (feedbackIds.has(item.id)) errors.push(`反馈 ID ${item.id} 重复。`)
    feedbackIds.add(item.id)
    feedbackById.set(item.id, item)
    if (!item.id || !item.time_window || !Array.isArray(item.evidence_ids)) errors.push('反馈缺少 ID、时间窗或证据。')
    for (const id of item.evidence_ids ?? []) if (!evidenceIds.has(id)) errors.push(`反馈 ${item.id} 引用了未知证据 ${id}。`)
    if (item.anchor?.binding === 'ambiguous' && item.confirmation?.status !== 'needs_clarification') errors.push(`歧义反馈 ${item.id} 必须要求澄清。`)
    if (item.anchor?.binding === 'ambiguous' && (!item.anchor.region_candidate || item.anchor.element_id)) errors.push(`歧义反馈 ${item.id} 必须只保留区域候选。`)
    if (item.anchor?.binding === 'confirmed' && item.confirmation?.status !== 'confirmed-by-reviewer') errors.push(`确认锚点 ${item.id} 必须由批阅者确认。`)
    if (item.anchor?.binding === 'confirmed' && (!item.anchor.element_id || item.anchor.region_candidate)) errors.push(`确认锚点 ${item.id} 必须只保留元素 ID。`)
    if (item.anchor?.route && !allowedRoutes.has(item.anchor.route)) errors.push(`反馈 ${item.id} 超出受控路由范围。`)
    if (item.anchor?.binding === 'confirmed' && ![...eventsById.values()].some((event) => (
      event.route === item.anchor.route && event.element_id === item.anchor.element_id
    ))) errors.push(`反馈 ${item.id} 的确认锚点没有对应事件。`)
  }
  for (const evidence of pkg.evidence ?? []) {
    if (evidence.kind === 'interaction_event' && !eventsById.has(evidence.event_id)) errors.push(`证据 ${evidence.id} 引用了未知事件 ${evidence.event_id}。`)
    if (evidence.kind === 'feedback' && !feedbackById.has(evidence.feedback_id)) errors.push(`证据 ${evidence.id} 引用了未知反馈 ${evidence.feedback_id}。`)
  }
  for (const proposal of pkg.proposals ?? []) {
    if (proposalIds.has(proposal.id)) errors.push(`建议 ID ${proposal.id} 重复。`)
    proposalIds.add(proposal.id)
    if (proposal.execution !== 'proposal-only') errors.push(`建议 ${proposal.id} 必须保持 proposal-only。`)
    for (const id of proposal.evidence_ids ?? []) if (!evidenceIds.has(id)) errors.push(`建议 ${proposal.id} 引用了未知证据 ${id}。`)
    if (!['pending', 'accepted', 'rejected', 'needs_clarification'].includes(proposal.confirmation?.status)) errors.push(`建议 ${proposal.id} 缺少确认状态。`)
  }
  return { valid: errors.length === 0, errors }
}

export function validatePackageAgainstAdapter(pkg, adapter) {
  const errors = [...validateAdapterDeclaration(adapter).errors]
  if (pkg?.artifact?.adapter_id !== adapter?.adapter_id) errors.push('Package adapter_id 与适配器声明不一致。')
  if (pkg?.artifact?.source_version !== adapter?.source_version) errors.push('Package source_version 与适配器声明不一致。')
  if (pkg?.artifact?.kind !== adapter?.artifact_kind) errors.push('Package artifact kind 与适配器声明不一致。')
  const packageRoutes = pkg?.capture?.allowed_routes ?? []
  const adapterRoutes = adapter?.allowed_routes ?? []
  if (packageRoutes.length !== adapterRoutes.length || packageRoutes.some((route, index) => route !== adapterRoutes[index])) {
    errors.push('Package allowed_routes 与适配器白名单不一致。')
  }
  return { valid: errors.length === 0, errors }
}

export function buildPackage({ adapter, session, events, snapshots, feedback, proposals }) {
  const adapterCheck = validateAdapterDeclaration(adapter)
  if (!adapterCheck.valid) throw new Error(`适配器声明无效：${adapterCheck.errors.join(' ')}`)
  const evidence = [
    ...events.map((event) => ({ id: `ev_${event.id}`, kind: 'interaction_event', event_id: event.id, route: event.route, element_id: event.element_id ?? null, at_ms: event.at_ms })),
    ...feedback.map((item) => ({ id: `ev_${item.id}`, kind: 'feedback', feedback_id: item.id, at_ms: item.time_window.end_ms })),
  ]
  return {
    schema: PACKAGE_VERSION,
    package_id: packageIdForSession(session.id),
    created_at: session.exported_at ?? new Date().toISOString(),
    artifact: {
      artifact_id: 'controlled-ai-web-prototype',
      adapter_id: adapter.adapter_id,
      source_version: adapter.source_version,
      kind: adapter.artifact_kind,
    },
    capture: {
      mode: 'explicit-review-session',
      session_id: session.id,
      started_at: session.started_at,
      ended_at: session.ended_at,
      background_monitoring: false,
      allowed_routes: [...adapter.allowed_routes],
      privacy: { sensitive_fields: 'excluded-by-default', audio: 'not-captured', retention: 'browser-memory-until-explicit-discard-or-page-close' },
    },
    retention: {
      capture_buffer: {
        storage: 'browser-memory',
        state: 'retained',
        clear_trigger: 'explicit-discard-or-page-close',
      },
      exported_copy: { management: 'user-controlled-after-download' },
      deletion_receipt: null,
    },
    events,
    snapshots,
    feedback,
    evidence,
    proposals,
    summary: summarizeSession(events, feedback, proposals),
    agent_boundary: 'Agent may propose changes only. Prototype mutation requires explicit per-proposal confirmation.',
    integrity: { algorithm: 'SHA-256', scope: 'stable JSON with integrity.value blank', value: '' },
  }
}
