import { evaluateLocalWebRuntimeStart, validateLocalWebLaunchGate } from './local-web-launch-gate.mjs'
import { validateLocalWebSourceAdmission } from './local-web-source-contract.mjs'
import { validateObservableAgentSession } from './observable-agent-session.mjs'
import { evaluateRemoteReviewAdmission, validateRemoteWebAuthorization } from './remote-web-authorization.mjs'

export const OBSERVABLE_AGENT_LINEAGE_VERSION = 'interaction-review-observable-agent-lineage/0.1'

const sameList = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index])
const exactRoute = (value) => typeof value === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(value) && !value.includes('*')

export function bindObservableAgentSessionAuthority({ bindingId, session, authority, boundAt }) {
  const sessionValidation = validateObservableAgentSession(session)
  if (!sessionValidation.valid) throw new Error(sessionValidation.errors.join('\n'))

  let target
  let authoritySummary
  let source
  let authorizedRoutes
  if (authority?.kind === 'local-launch-gate') {
    const gateValidation = validateLocalWebLaunchGate(authority.receipt)
    const admissionValidation = validateLocalWebSourceAdmission(authority.admission)
    if (!gateValidation.valid || !admissionValidation.valid) throw new Error([...gateValidation.errors, ...admissionValidation.errors].join('\n'))
    const admission = evaluateLocalWebRuntimeStart(authority.receipt, {
      sourceId: authority.admission.source_id,
      sourceSha256: authority.admission.source_sha256,
      preflightCheckedAt: authority.receipt.preflight.checked_at,
      at: boundAt,
    })
    if (!admission.allowed) throw new Error(`本地启动许可不可用于会话：${admission.reason}`)
    target = 'local-static-web'
    authoritySummary = { kind: authority.kind, id: authority.receipt.gate_id, status: 'admitted', bound_at: boundAt }
    source = { identity_kind: 'sha256-bundle', identity_value: authority.admission.source_sha256, origin: null }
    authorizedRoutes = authority.admission.allowed_routes
  } else if (authority?.kind === 'remote-web-authorization') {
    const authValidation = validateRemoteWebAuthorization(authority.receipt)
    if (!authValidation.valid) throw new Error(authValidation.errors.join('\n'))
    for (const route of session.artifact.allowed_routes) {
      const admission = evaluateRemoteReviewAdmission(authority.receipt, {
        origin: authority.receipt.source.origin,
        deploymentVersion: authority.receipt.source.deployment_version,
        route,
        at: boundAt,
      })
      if (!admission.admitted) throw new Error(`远程授权不可用于会话：${admission.reason}`)
    }
    target = 'remote-authorized-web'
    authoritySummary = { kind: authority.kind, id: authority.receipt.authorization_id, status: 'admitted', bound_at: boundAt }
    source = { identity_kind: 'deployment-version', identity_value: authority.receipt.source.deployment_version, origin: authority.receipt.source.origin }
    authorizedRoutes = authority.receipt.consent.route_allowlist
  } else throw new Error('authority.kind 不受支持。')

  if (session.artifact.adapter_id !== target) throw new Error('会话 adapter_id 与授权目标不一致。')
  if (session.artifact.source_version !== source.identity_value) throw new Error('会话 source_version 与授权来源身份不一致。')
  if (session.artifact.allowed_routes.some((route) => !authorizedRoutes.includes(route))) throw new Error('会话路由超出授权范围。')

  const binding = {
    schema: OBSERVABLE_AGENT_LINEAGE_VERSION,
    binding_id: bindingId,
    target,
    session: {
      session_id: session.session_id,
      adapter_id: session.artifact.adapter_id,
      source_version: session.artifact.source_version,
      allowed_routes: [...session.artifact.allowed_routes],
    },
    authority: authoritySummary,
    source,
    route_scope: [...session.artifact.allowed_routes],
    human_observer_required: true,
    execution_authorized: false,
  }
  const result = validateObservableAgentLineage(binding)
  if (!result.valid) throw new Error(result.errors.join('\n'))
  return binding
}

export function validateObservableAgentLineage(binding) {
  const errors = []
  if (binding?.schema !== OBSERVABLE_AGENT_LINEAGE_VERSION) errors.push(`schema 必须是 ${OBSERVABLE_AGENT_LINEAGE_VERSION}。`)
  if (!/^oal_[a-z0-9_-]{8,64}$/.test(binding?.binding_id ?? '')) errors.push('binding_id 格式无效。')
  if (!['local-static-web', 'remote-authorized-web'].includes(binding?.target)) errors.push('target 不受支持。')
  if (!binding?.session?.session_id) errors.push('必须绑定 session_id。')
  if (binding?.session?.adapter_id !== binding?.target) errors.push('session.adapter_id 必须与 target 一致。')
  const routes = binding?.session?.allowed_routes
  if (!Array.isArray(routes) || routes.length === 0 || routes.some((route) => !exactRoute(route)) || new Set(routes).size !== routes.length) errors.push('会话路由必须是非空、唯一且受控的精确路径。')
  if (!sameList(routes, binding?.route_scope)) errors.push('route_scope 必须逐项匹配会话路由。')
  if (!binding?.source?.identity_value || binding?.session?.source_version !== binding?.source?.identity_value) errors.push('会话 source_version 必须与来源身份一致。')
  if (binding?.target === 'local-static-web') {
    if (binding?.authority?.kind !== 'local-launch-gate' || binding?.source?.identity_kind !== 'sha256-bundle' || binding?.source?.origin !== null || !/^[a-f0-9]{64}$/.test(binding?.source?.identity_value ?? '')) errors.push('本地会话必须绑定启动门与 SHA-256 bundle。')
  } else if (binding?.authority?.kind !== 'remote-web-authorization' || binding?.source?.identity_kind !== 'deployment-version' || typeof binding?.source?.origin !== 'string') errors.push('远程会话必须绑定授权回执、部署版本与 origin。')
  if (!binding?.authority?.id || binding?.authority?.status !== 'admitted' || typeof binding?.authority?.bound_at !== 'string' || Number.isNaN(Date.parse(binding.authority.bound_at))) errors.push('authority 必须携带已准入身份与有效绑定时间。')
  if (binding?.human_observer_required !== true) errors.push('可观察会话必须要求人类观察者。')
  if (binding?.execution_authorized !== false) errors.push('lineage 回执不能授权执行。')
  return { valid: errors.length === 0, errors }
}
