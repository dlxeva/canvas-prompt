export const REMOTE_WEB_AUTHORIZATION_VERSION = 'interaction-review-remote-web-authorization/0.1'

const CAPTURE_FIELDS = ['route', 'stable-element-id', 'state-diff-redacted', 'viewport', 'visible-cursor', 'step-status']
const EXCLUDED_FIELDS = ['credentials', 'cookies', 'tokens', 'raw-input-values', 'full-screen-video']

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isExactHttpsOrigin(value) {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.origin === value && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

function isExactRoute(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('*') && !value.includes('..') && !value.includes('?') && !value.includes('#')
}

function sameList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index])
}

export function buildRemoteWebAuthorization({ authorizationId, origin, deploymentVersion, grantedAt, expiresAt, routeAllowlist }) {
  const receipt = {
    schema: REMOTE_WEB_AUTHORIZATION_VERSION,
    authorization_id: authorizationId,
    target: 'remote-authorized-web',
    source: { origin, deployment_version: deploymentVersion },
    consent: {
      mediated_by: 'user',
      purpose: 'interaction-review',
      granted_at: grantedAt,
      expires_at: expiresAt,
      route_allowlist: [...routeAllowlist],
    },
    capture_policy: {
      explicit_session_required: true,
      fields: [...CAPTURE_FIELDS],
      excluded: [...EXCLUDED_FIELDS],
      background_monitoring: false,
      network: 'exact-origin-read-only-candidate',
    },
    lifecycle: { status: 'active', revoked_at: null, revocation_reason: null },
    dangerous_effects: 'fail-closed',
    execution_authorized: false,
  }
  const result = validateRemoteWebAuthorization(receipt)
  if (!result.valid) throw new Error(result.errors.join('\n'))
  return receipt
}

export function revokeRemoteWebAuthorization(receipt, { revokedAt, reason }) {
  const current = validateRemoteWebAuthorization(receipt)
  if (!current.valid) throw new Error(current.errors.join('\n'))
  if (receipt.lifecycle.status !== 'active') throw new Error('只有 active 授权可以撤销。')
  const revoked = structuredClone(receipt)
  revoked.lifecycle = { status: 'revoked', revoked_at: revokedAt, revocation_reason: reason }
  const result = validateRemoteWebAuthorization(revoked)
  if (!result.valid) throw new Error(result.errors.join('\n'))
  return revoked
}

export function evaluateRemoteReviewAdmission(receipt, { origin, deploymentVersion, route, at }) {
  const validation = validateRemoteWebAuthorization(receipt)
  if (!validation.valid) return { admitted: false, reason: 'invalid-authorization', execution_authorized: false }
  if (receipt.lifecycle.status !== 'active') return { admitted: false, reason: 'authorization-revoked', execution_authorized: false }
  if (!isIsoTime(at) || Date.parse(at) < Date.parse(receipt.consent.granted_at) || Date.parse(at) >= Date.parse(receipt.consent.expires_at)) {
    return { admitted: false, reason: 'authorization-outside-time-window', execution_authorized: false }
  }
  if (origin !== receipt.source.origin || deploymentVersion !== receipt.source.deployment_version) {
    return { admitted: false, reason: 'source-identity-mismatch', execution_authorized: false }
  }
  if (!receipt.consent.route_allowlist.includes(route)) return { admitted: false, reason: 'route-not-authorized', execution_authorized: false }
  return { admitted: true, reason: 'explicit-review-session-candidate', execution_authorized: false }
}

export function validateRemoteWebAuthorization(receipt) {
  const errors = []
  if (receipt?.schema !== REMOTE_WEB_AUTHORIZATION_VERSION) errors.push(`schema 必须是 ${REMOTE_WEB_AUTHORIZATION_VERSION}。`)
  if (!/^rwa_[a-z0-9_-]{8,64}$/.test(receipt?.authorization_id ?? '')) errors.push('authorization_id 格式无效。')
  if (receipt?.target !== 'remote-authorized-web') errors.push('target 必须是 remote-authorized-web。')
  if (!isExactHttpsOrigin(receipt?.source?.origin)) errors.push('origin 必须是精确 HTTPS origin，不能包含路径、查询、片段或凭据。')
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(receipt?.source?.deployment_version ?? '')) errors.push('deployment_version 必须是精确且稳定的版本标识。')
  if (receipt?.consent?.mediated_by !== 'user' || receipt?.consent?.purpose !== 'interaction-review') errors.push('授权必须由用户为 interaction-review 明确授予。')
  if (!isIsoTime(receipt?.consent?.granted_at) || !isIsoTime(receipt?.consent?.expires_at)) errors.push('授权起止时间必须是有效时间。')
  else if (Date.parse(receipt.consent.expires_at) <= Date.parse(receipt.consent.granted_at)) errors.push('expires_at 必须晚于 granted_at。')
  const routes = receipt?.consent?.route_allowlist
  if (!Array.isArray(routes) || routes.length === 0 || routes.some((route) => !isExactRoute(route)) || new Set(routes).size !== routes.length) errors.push('route_allowlist 必须是非空、唯一且无通配的精确站内路径。')
  const policy = receipt?.capture_policy
  if (policy?.explicit_session_required !== true || policy?.background_monitoring !== false) errors.push('只能在显式会话内采集，禁止后台监控。')
  if (!sameList(policy?.fields, CAPTURE_FIELDS) || !sameList(policy?.excluded, EXCLUDED_FIELDS)) errors.push('采集字段与敏感排除清单必须保持最小固定集合。')
  if (policy?.network !== 'exact-origin-read-only-candidate') errors.push('网络边界必须保持 exact-origin-read-only-candidate。')
  const lifecycle = receipt?.lifecycle
  if (lifecycle?.status === 'active') {
    if (lifecycle.revoked_at !== null || lifecycle.revocation_reason !== null) errors.push('active 授权不能携带撤销信息。')
  } else if (lifecycle?.status === 'revoked') {
    if (!isIsoTime(lifecycle.revoked_at) || Date.parse(lifecycle.revoked_at) < Date.parse(receipt?.consent?.granted_at ?? '')) errors.push('撤销时间必须有效且不早于授权时间。')
    if (typeof lifecycle.revocation_reason !== 'string' || lifecycle.revocation_reason.trim().length < 3) errors.push('撤销必须携带明确原因。')
  } else errors.push('lifecycle.status 只能是 active 或 revoked。')
  if (receipt?.dangerous_effects !== 'fail-closed') errors.push('危险副作用必须 fail-closed。')
  if (receipt?.execution_authorized !== false) errors.push('授权回执不能授权执行。')
  return { valid: errors.length === 0, errors }
}
