import { validateLocalWebSourceAdmission } from './local-web-source-contract.mjs'

export const LOCAL_WEB_PREFLIGHT_VERSION = 'interaction-review-local-web-preflight-receipt/0.1'
const REQUIRED_SENSITIVE_SELECTORS = ['input[type="password"]', 'input[type="email"]', '[data-sensitive="true"]']
const FORBIDDEN_FEATURES = new Set(['service-worker', 'cross-origin-navigation', 'remote-module', 'external-resource'])

const safePath = (value) => typeof value === 'string' && !value.startsWith('/') && !value.split('/').includes('..') && /^[A-Za-z0-9._/-]+$/.test(value)
const localReference = (value) => typeof value === 'string' && !/^(?:[a-z]+:)?\/\//i.test(value) && !value.startsWith('/') && !value.split('/').includes('..')

export function preflightLocalWebBundle({ admission, manifest, checkedAt }) {
  const checks = []
  const check = (code, passed) => checks.push({ code, status: passed ? 'passed' : 'failed' })
  const admissionValid = validateLocalWebSourceAdmission(admission).valid
  const files = Array.isArray(manifest?.files) ? manifest.files : []
  check('admission-valid', admissionValid)
  check('entrypoint-present', files.some((file) => file.path === admission?.entrypoint && file.kind === 'file'))
  check('paths-contained', files.length > 0 && files.every((file) => safePath(file.path)))
  check('no-symlinks', files.every((file) => file.kind === 'file'))
  check('references-local', files.every((file) => Array.isArray(file.references) && file.references.every(localReference)))
  check('features-safe', files.every((file) => Array.isArray(file.features) && file.features.every((feature) => !FORBIDDEN_FEATURES.has(feature))))
  check('stable-elements-declared', Array.isArray(manifest?.declared_element_attributes) && manifest.declared_element_attributes.includes('data-element-id'))
  check('sensitive-selectors-declared', Array.isArray(manifest?.sensitive_selectors) && REQUIRED_SENSITIVE_SELECTORS.every((selector) => manifest.sensitive_selectors.includes(selector)))
  check('reset-probe-passed', manifest?.reset_probe === 'reload-fixture-passed')
  const failures = checks.filter((item) => item.status === 'failed').map((item) => item.code)
  return {
    schema: LOCAL_WEB_PREFLIGHT_VERSION,
    source_id: admission?.source_id ?? 'unknown',
    source_sha256: admission?.source_sha256 ?? 'unknown',
    checked_at: checkedAt,
    inspection_scope: 'metadata-manifest-only',
    status: failures.length === 0 ? 'passed' : 'rejected',
    checks,
    failures,
    execution_authorized: false,
  }
}

export function validateLocalWebPreflightReceipt(receipt, admission) {
  const errors = []
  if (receipt?.schema !== LOCAL_WEB_PREFLIGHT_VERSION) errors.push(`schema 必须是 ${LOCAL_WEB_PREFLIGHT_VERSION}。`)
  if (receipt?.source_id !== admission?.source_id || receipt?.source_sha256 !== admission?.source_sha256) errors.push('预检回执与来源身份不一致。')
  if (typeof receipt?.checked_at !== 'string' || Number.isNaN(Date.parse(receipt.checked_at))) errors.push('checked_at 必须是有效时间。')
  if (receipt?.inspection_scope !== 'metadata-manifest-only') errors.push('预检只能声明 metadata-manifest-only。')
  if (!Array.isArray(receipt?.checks) || receipt.checks.length !== 9 || new Set(receipt.checks.map((item) => item.code)).size !== 9) errors.push('预检必须包含九项唯一检查。')
  const derivedFailures = Array.isArray(receipt?.checks) ? receipt.checks.filter((item) => item.status === 'failed').map((item) => item.code) : []
  if (JSON.stringify(receipt?.failures) !== JSON.stringify(derivedFailures)) errors.push('failures 必须与失败检查严格一致。')
  if (receipt?.status !== (derivedFailures.length === 0 ? 'passed' : 'rejected')) errors.push('预检状态与检查结果不一致。')
  if (receipt?.execution_authorized !== false) errors.push('预检回执不能授权执行。')
  return { valid: errors.length === 0, errors }
}
