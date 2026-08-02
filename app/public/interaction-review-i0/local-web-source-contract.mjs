export const LOCAL_WEB_SOURCE_VERSION = 'interaction-review-local-web-source/0.1'

const SENSITIVE_SELECTORS = ['input[type="password"]', 'input[type="email"]', '[data-sensitive="true"]']

export function buildLocalWebSourceAdmission({ sourceId, sourceSha256, entrypoint, allowedRoutes }) {
  return {
    schema: LOCAL_WEB_SOURCE_VERSION,
    source_id: sourceId,
    source_sha256: sourceSha256,
    source_kind: 'static-local-bundle',
    entrypoint,
    allowed_routes: [...allowedRoutes],
    stable_element_attribute: 'data-element-id',
    sensitive_selectors: [...SENSITIVE_SELECTORS],
    isolation: {
      origin: 'ephemeral-loopback',
      root_access: 'selected-directory-only',
      symlink_policy: 'reject',
      network_policy: 'deny-all',
      external_resources: false,
      cross_origin_navigation: false,
      service_workers: false,
      script_policy: 'local-bundle-only',
    },
    reset_strategy: 'reload-fixture',
    execution_authorized: false,
  }
}

export function validateLocalWebSourceAdmission(source) {
  const errors = []
  if (!source || typeof source !== 'object') return { valid: false, errors: ['本地 Web 来源声明不是对象。'] }
  if (source.schema !== LOCAL_WEB_SOURCE_VERSION) errors.push(`schema 必须是 ${LOCAL_WEB_SOURCE_VERSION}。`)
  if (typeof source.source_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(source.source_id)) errors.push('source_id 必须是稳定安全标识。')
  if (typeof source.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.source_sha256)) errors.push('source_sha256 必须是 64 位小写 SHA-256。')
  if (source.source_kind !== 'static-local-bundle') errors.push('首个本地来源只能是 static-local-bundle。')
  if (typeof source.entrypoint !== 'string' || source.entrypoint.startsWith('/') || source.entrypoint.split('/').includes('..') || !/^[A-Za-z0-9._/-]+\.html$/.test(source.entrypoint)) {
    errors.push('entrypoint 必须是 bundle 内不含路径穿越的相对 HTML 文件。')
  }
  if (!Array.isArray(source.allowed_routes) || source.allowed_routes.length === 0) errors.push('本地来源必须声明非空路由白名单。')
  else {
    if (new Set(source.allowed_routes).size !== source.allowed_routes.length) errors.push('本地来源路由不能重复。')
    for (const route of source.allowed_routes) if (typeof route !== 'string' || !/^\/[A-Za-z0-9/_-]*$/.test(route)) errors.push(`路由 ${String(route)} 不是受控路径。`)
  }
  if (source.stable_element_attribute !== 'data-element-id') errors.push('稳定元素属性必须是 data-element-id。')
  if (!Array.isArray(source.sensitive_selectors) || source.sensitive_selectors.length !== SENSITIVE_SELECTORS.length || SENSITIVE_SELECTORS.some((selector) => !source.sensitive_selectors.includes(selector))) {
    errors.push('必须声明固定敏感字段选择器。')
  }
  const requiredIsolation = {
    origin: 'ephemeral-loopback', root_access: 'selected-directory-only', symlink_policy: 'reject',
    network_policy: 'deny-all', external_resources: false, cross_origin_navigation: false,
    service_workers: false, script_policy: 'local-bundle-only',
  }
  for (const [key, expected] of Object.entries(requiredIsolation)) {
    if (source.isolation?.[key] !== expected) errors.push(`隔离项 ${key} 必须为 ${String(expected)}。`)
  }
  if (source.reset_strategy !== 'reload-fixture') errors.push('本地来源必须可通过 reload-fixture 重置。')
  if (source.execution_authorized !== false) errors.push('本地来源不能授权真实执行。')
  return { valid: errors.length === 0, errors }
}
