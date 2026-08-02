export const ADAPTER_VERSION = 'interaction-review-adapter/0.1'
export const REQUIRED_UNSUPPORTED_TARGETS = ['arbitrary-web', 'figma', 'native-app']

const REQUIRED_CAPABILITIES = {
  capture_mode: 'explicit-session',
  element_identity: 'stable-id',
  route_scope: 'allowlist',
  state_snapshots: 'sanitized',
  sensitive_fields: 'excluded-by-default',
  background_monitoring: false,
  full_screen_video: false,
  audio_capture: 'none',
  mutation: 'proposal-only',
  network_egress: 'none',
}

export function buildControlledWebAdapter({ adapterId, sourceVersion, allowedRoutes }) {
  return {
    schema: ADAPTER_VERSION,
    adapter_id: adapterId,
    source_version: sourceVersion,
    artifact_kind: 'controlled-web-flow',
    allowed_routes: [...allowedRoutes],
    capabilities: { ...REQUIRED_CAPABILITIES },
    unsupported_targets: [...REQUIRED_UNSUPPORTED_TARGETS],
  }
}

export function validateAdapterDeclaration(adapter) {
  const errors = []
  if (!adapter || typeof adapter !== 'object') return { valid: false, errors: ['适配器声明不是对象。'] }
  if (adapter.schema !== ADAPTER_VERSION) errors.push(`schema 必须是 ${ADAPTER_VERSION}。`)
  if (!adapter.adapter_id || !adapter.source_version) errors.push('适配器缺少 adapter_id 或 source_version。')
  if (adapter.artifact_kind !== 'controlled-web-flow') errors.push('I0 适配器只能声明 controlled-web-flow。')
  if (!Array.isArray(adapter.allowed_routes) || adapter.allowed_routes.length === 0) {
    errors.push('适配器必须声明非空路由白名单。')
  } else {
    if (new Set(adapter.allowed_routes).size !== adapter.allowed_routes.length) errors.push('路由白名单不能重复。')
    for (const route of adapter.allowed_routes) {
      if (typeof route !== 'string' || !/^\/[A-Za-z0-9/_-]*$/.test(route)) errors.push(`路由 ${String(route)} 不是受控路径。`)
    }
  }
  for (const [key, expected] of Object.entries(REQUIRED_CAPABILITIES)) {
    if (adapter.capabilities?.[key] !== expected) errors.push(`能力 ${key} 必须为 ${String(expected)}。`)
  }
  const unsupported = adapter.unsupported_targets
  if (!Array.isArray(unsupported) || unsupported.length !== REQUIRED_UNSUPPORTED_TARGETS.length
    || REQUIRED_UNSUPPORTED_TARGETS.some((target) => !unsupported.includes(target))) {
    errors.push('适配器必须显式排除 arbitrary-web、figma 与 native-app。')
  }
  return { valid: errors.length === 0, errors }
}
