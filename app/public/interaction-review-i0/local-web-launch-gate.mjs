import { validateLocalWebPreflightReceipt } from './local-web-preflight.mjs'

export const LOCAL_WEB_LAUNCH_GATE_VERSION = 'interaction-review-local-web-launch-gate/0.1'
const MAX_APPROVAL_WINDOW_MS = 30 * 60 * 1000

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function createLocalWebLaunchGate(preflight, admission, { gateId, requestedAt }) {
  const validation = validateLocalWebPreflightReceipt(preflight, admission)
  if (!validation.valid) throw new Error(validation.errors.join('\n'))
  if (preflight.status !== 'passed') throw new Error('只有 passed 预检可以进入启动确认门。')
  const gate = {
    schema: LOCAL_WEB_LAUNCH_GATE_VERSION,
    gate_id: gateId,
    preflight: {
      source_id: preflight.source_id,
      source_sha256: preflight.source_sha256,
      checked_at: preflight.checked_at,
      status: 'passed',
      inspection_scope: 'metadata-manifest-only',
    },
    requested_at: requestedAt,
    notice: {
      runtime: 'ephemeral-loopback',
      network: 'deny-all',
      source_access: 'read-only',
      capture: 'explicit-session-only',
      agent_execution: 'not-authorized',
    },
    decision: { status: 'awaiting-confirmation', decided_by: null, decided_at: null, expires_at: null },
    runtime_start_authorized: false,
    execution_authorized: false,
  }
  const result = validateLocalWebLaunchGate(gate)
  if (!result.valid) throw new Error(result.errors.join('\n'))
  return gate
}

export function approveLocalWebLaunchGate(gate, { confirmedBy, confirmedAt, expiresAt }) {
  const validation = validateLocalWebLaunchGate(gate)
  if (!validation.valid) throw new Error(validation.errors.join('\n'))
  if (gate.decision.status !== 'awaiting-confirmation') throw new Error('只有 awaiting-confirmation 启动门可以批准。')
  if (confirmedBy !== 'user') throw new Error('运行时启动必须由用户明确确认。')
  const approved = structuredClone(gate)
  approved.decision = { status: 'approved', decided_by: 'user', decided_at: confirmedAt, expires_at: expiresAt }
  approved.runtime_start_authorized = true
  const result = validateLocalWebLaunchGate(approved)
  if (!result.valid) throw new Error(result.errors.join('\n'))
  return approved
}

export function declineLocalWebLaunchGate(gate, { confirmedBy, confirmedAt }) {
  const validation = validateLocalWebLaunchGate(gate)
  if (!validation.valid) throw new Error(validation.errors.join('\n'))
  if (gate.decision.status !== 'awaiting-confirmation') throw new Error('只有 awaiting-confirmation 启动门可以拒绝。')
  if (confirmedBy !== 'user') throw new Error('运行时启动拒绝必须由用户明确确认。')
  const declined = structuredClone(gate)
  declined.decision = { status: 'declined', decided_by: 'user', decided_at: confirmedAt, expires_at: null }
  return declined
}

export function evaluateLocalWebRuntimeStart(gate, { sourceId, sourceSha256, preflightCheckedAt, at }) {
  const validation = validateLocalWebLaunchGate(gate)
  if (!validation.valid) return { allowed: false, reason: 'invalid-launch-gate', runtime_start_authorized: false, execution_authorized: false }
  if (gate.decision.status !== 'approved') return { allowed: false, reason: 'explicit-confirmation-required', runtime_start_authorized: false, execution_authorized: false }
  if (sourceId !== gate.preflight.source_id || sourceSha256 !== gate.preflight.source_sha256 || preflightCheckedAt !== gate.preflight.checked_at) {
    return { allowed: false, reason: 'preflight-lineage-mismatch', runtime_start_authorized: false, execution_authorized: false }
  }
  if (!isIsoTime(at) || Date.parse(at) < Date.parse(gate.decision.decided_at) || Date.parse(at) >= Date.parse(gate.decision.expires_at)) {
    return { allowed: false, reason: 'approval-outside-time-window', runtime_start_authorized: false, execution_authorized: false }
  }
  return { allowed: true, reason: 'ephemeral-loopback-start-only', runtime_start_authorized: true, execution_authorized: false }
}

export function validateLocalWebLaunchGate(gate) {
  const errors = []
  if (gate?.schema !== LOCAL_WEB_LAUNCH_GATE_VERSION) errors.push(`schema 必须是 ${LOCAL_WEB_LAUNCH_GATE_VERSION}。`)
  if (!/^lwg_[a-z0-9_-]{8,64}$/.test(gate?.gate_id ?? '')) errors.push('gate_id 格式无效。')
  if (!gate?.preflight?.source_id || !/^[a-f0-9]{64}$/.test(gate?.preflight?.source_sha256 ?? '')) errors.push('启动门必须绑定预检来源身份。')
  if (!isIsoTime(gate?.preflight?.checked_at) || gate?.preflight?.status !== 'passed' || gate?.preflight?.inspection_scope !== 'metadata-manifest-only') errors.push('启动门只能绑定 passed 的元数据预检。')
  if (!isIsoTime(gate?.requested_at) || (isIsoTime(gate?.preflight?.checked_at) && Date.parse(gate.requested_at) < Date.parse(gate.preflight.checked_at))) errors.push('requested_at 必须有效且不早于预检时间。')
  const notice = gate?.notice
  if (notice?.runtime !== 'ephemeral-loopback' || notice?.network !== 'deny-all' || notice?.source_access !== 'read-only' || notice?.capture !== 'explicit-session-only' || notice?.agent_execution !== 'not-authorized') errors.push('启动告知必须完整声明隔离、零网络、只读、显式采集与不授权 Agent 执行。')
  const decision = gate?.decision
  if (decision?.status === 'awaiting-confirmation') {
    if (decision.decided_by !== null || decision.decided_at !== null || decision.expires_at !== null || gate?.runtime_start_authorized !== false) errors.push('等待确认时不能授权启动或携带决定时间。')
  } else if (decision?.status === 'approved') {
    if (decision.decided_by !== 'user' || !isIsoTime(decision.decided_at) || !isIsoTime(decision.expires_at) || gate?.runtime_start_authorized !== true) errors.push('批准必须由用户完成并携带有效时间窗。')
    else {
      const duration = Date.parse(decision.expires_at) - Date.parse(decision.decided_at)
      if (duration <= 0 || duration > MAX_APPROVAL_WINDOW_MS) errors.push('启动批准窗口必须大于 0 且不超过 30 分钟。')
    }
  } else if (decision?.status === 'declined') {
    if (decision.decided_by !== 'user' || !isIsoTime(decision.decided_at) || decision.expires_at !== null || gate?.runtime_start_authorized !== false) errors.push('拒绝必须由用户完成且不能授权启动。')
  } else errors.push('decision.status 只能是 awaiting-confirmation、approved 或 declined。')
  if (gate?.execution_authorized !== false) errors.push('启动门不能授权 Agent 执行。')
  return { valid: errors.length === 0, errors }
}
