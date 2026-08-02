import { buildControlledWebAdapter } from './adapter-contract.mjs'
import { buildPackage, discardCaptureBuffer, packageForIntegrity, sealDeletionReceipt, validatePackage, validatePackageAgainstAdapter } from './core.mjs'
import { approveLocalWebLaunchGate, createLocalWebLaunchGate, declineLocalWebLaunchGate, evaluateLocalWebRuntimeStart } from './local-web-launch-gate.mjs'
import { bindObservableAgentSessionAuthority } from './observable-agent-lineage.mjs'
import { createObservableAgentPlayer } from './observable-agent-player.mjs'
import { buildObservableAgentSession } from './observable-agent-session.mjs'

const app = document.querySelector('#app')
const syntheticSource = {
  schema: 'interaction-review-local-web-source/0.1', source_id: 'i0-synthetic-launch-fixture', source_sha256: 'c'.repeat(64), source_kind: 'static-local-bundle',
  entrypoint: 'dist/index.html', allowed_routes: ['/brief', '/generate', '/gallery', '/review'], stable_element_attribute: 'data-element-id',
  sensitive_selectors: ['input[type="password"]', 'input[type="email"]', '[data-sensitive="true"]'],
  isolation: { origin: 'ephemeral-loopback', root_access: 'selected-directory-only', symlink_policy: 'reject', network_policy: 'deny-all', external_resources: false, cross_origin_navigation: false, service_workers: false, script_policy: 'local-bundle-only' },
  reset_strategy: 'reload-fixture', execution_authorized: false,
}
const preflightCodes = ['admission-valid', 'entrypoint-present', 'paths-contained', 'no-symlinks', 'references-local', 'features-safe', 'stable-elements-declared', 'sensitive-selectors-declared', 'reset-probe-passed']
function createSyntheticLaunchGate() {
  const checkedAt = new Date().toISOString()
  const preflight = { schema: 'interaction-review-local-web-preflight-receipt/0.1', source_id: syntheticSource.source_id, source_sha256: syntheticSource.source_sha256, checked_at: checkedAt, inspection_scope: 'metadata-manifest-only', status: 'passed', checks: preflightCodes.map((code) => ({ code, status: 'passed' })), failures: [], execution_authorized: false }
  return createLocalWebLaunchGate(preflight, syntheticSource, { gateId: 'lwg_ui_synthetic_001', requestedAt: checkedAt })
}
const state = {
  route: '/brief', session: null, events: [], snapshots: {}, feedback: [], proposals: [],
  prototype: { template: 'landing', generation: 'idle', concept: null, plan: 'starter', sensitive_email: '' },
  feedbackText: '', feedbackAnchor: 'auto', feedbackAmbiguous: false, packageText: '', packageStatus: '', viewedEvidence: null,
  discardConfirm: false, deletionReceipt: null,
  agentPlayer: { status: 'idle', current_step: 0, target_element_id: null, cursor: null, viewport: null, receipt: [], failure: null, explicit_resume_required: false },
  agentReplayIndex: null,
  launchGate: createSyntheticLaunchGate(),
  agentLineage: null,
}

const routes = [
  ['/brief', '1 了解任务'], ['/generate', '2 选择方案'], ['/gallery', '3 比较结果'], ['/review', '4 完成确认'],
]
const reviewAdapter = buildControlledWebAdapter({
  adapterId: 'local-static-web',
  sourceVersion: syntheticSource.source_sha256,
  allowedRoutes: routes.map(([route]) => route),
})
const labels = { '/brief': '第 1 步 · 了解任务', '/generate': '第 2 步 · 选择方案', '/gallery': '第 3 步 · 比较结果', '/review': '第 4 步 · 完成确认' }
const elementLabels = {
  'review-session-start': '开始本轮体验',
  'brief-start-flow': '开始配置活动页',
  'template-landing': '选择叙事落地页',
  'template-catalog': '选择作品目录',
  'generate-run': '生成页面概念',
  'concept-warm': '选择概念 A',
  'concept-direct': '选择概念 B',
  'gallery-continue': '确认选择',
  'review-plan': '选择预览方式',
  'review-complete': '完成体验',
}
const agentSteps = [
  { step_id: 'agent-step-1', seq: 1, route: '/brief', kind: 'click', element_id: 'brief-start-flow' },
  { step_id: 'agent-step-2', seq: 2, route: '/generate', kind: 'click', element_id: 'generate-run' },
]
const launchGateTtlOverride = new URLSearchParams(window.location.search).get('launch-gate-ttl-ms')
const launchGateTtlMs = /^\d+$/.test(launchGateTtlOverride ?? '') ? Math.min(15 * 60 * 1000, Math.max(100, Number(launchGateTtlOverride))) : 15 * 60 * 1000
const previewOverride = new URLSearchParams(window.location.search).get('agent-preview-ms')
const agentPreviewMs = /^\d+$/.test(previewOverride ?? '') ? Math.min(5000, Math.max(600, Number(previewOverride))) : 600
const failureOverride = new URLSearchParams(window.location.search).get('agent-failure')
const agentPlaybackSteps = failureOverride === 'missing-target'
  ? agentSteps.map((step) => step.seq === 2 ? { ...step, element_id: 'qa-missing-target' } : step)
  : agentSteps
const clone = (value) => JSON.parse(JSON.stringify(value))
const nowMs = () => state.session ? Math.max(0, Date.now() - state.session.started_epoch_ms) : 0
const id = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`

function safeStateSnapshot() {
  return { route: state.route, state: { template: state.prototype.template, generation: state.prototype.generation, concept: state.prototype.concept, plan: state.prototype.plan } }
}
function saveSnapshot() { const snapshotId = id('snap'); state.snapshots[snapshotId] = safeStateSnapshot(); return snapshotId }
function active() { return Boolean(state.session && !state.session.ended_at) }
function launchGateAdmission(at = new Date().toISOString()) {
  return evaluateLocalWebRuntimeStart(state.launchGate, { sourceId: syntheticSource.source_id, sourceSha256: syntheticSource.source_sha256, preflightCheckedAt: state.launchGate.preflight.checked_at, at })
}
function launchGateReady() {
  return launchGateAdmission().allowed
}
let launchGateExpiryTimer = null
function clearLaunchGateExpiryTimer() { if (launchGateExpiryTimer !== null) clearTimeout(launchGateExpiryTimer); launchGateExpiryTimer = null }
function scheduleLaunchGateExpiry() {
  clearLaunchGateExpiryTimer()
  const expiresAt = Date.parse(state.launchGate.decision.expires_at)
  launchGateExpiryTimer = setTimeout(() => { launchGateExpiryTimer = null; render() }, Math.max(0, expiresAt - Date.now() + 5))
}
function approveSyntheticLaunch() {
  const confirmedAt = new Date()
  state.launchGate = approveLocalWebLaunchGate(state.launchGate, { confirmedBy: 'user', confirmedAt: confirmedAt.toISOString(), expiresAt: new Date(confirmedAt.getTime() + launchGateTtlMs).toISOString() })
  scheduleLaunchGateExpiry()
  render()
}
function declineSyntheticLaunch() { clearLaunchGateExpiryTimer(); state.launchGate = declineLocalWebLaunchGate(state.launchGate, { confirmedBy: 'user', confirmedAt: new Date().toISOString() }); render() }
function resetSyntheticLaunch() { clearLaunchGateExpiryTimer(); state.launchGate = createSyntheticLaunchGate(); render() }
function createSyntheticAgentLineage() {
  const session = buildObservableAgentSession({
    sessionId: state.session.id,
    mode: 'agent-walkthrough',
    adapter: reviewAdapter,
    actions: agentSteps.map((step) => ({
      action_id: `observable-${step.step_id}`,
      actor: 'agent',
      kind: step.kind,
      route: step.route,
      element_id: step.element_id,
      before_state_id: `agent-before-${step.seq}`,
      after_state_id: `agent-after-${step.seq}`,
      cursor: { x_normalized: step.seq === 1 ? 0.42 : 0.58, y_normalized: 0.55 },
      viewport: { width: window.innerWidth, height: window.innerHeight, scroll_x: 0, scroll_y: 0 },
    })),
  })
  return bindObservableAgentSessionAuthority({
    bindingId: `oal_${state.session.id}`,
    session,
    authority: { kind: 'local-launch-gate', receipt: state.launchGate, admission: syntheticSource },
    boundAt: new Date().toISOString(),
  })
}
function capture(kind, elementId, mutate, detail = {}, privacy = 'captured') {
  if (!active()) {
    mutate?.()
    render()
    return
  }
  const before = saveSnapshot()
  mutate?.()
  const after = saveSnapshot()
  state.events.push({ id: id('evt'), kind, route: state.route, element_id: elementId, at_ms: nowMs(), before_snapshot_id: before, after_snapshot_id: after, privacy, ...detail })
  render()
}
function navigate(route, source = 'route-nav') {
  capture('route', source, () => { state.route = route }, { to_route: route })
}
function beginSession() {
  if (!launchGateReady()) return
  state.session = { id: id('session'), started_at: new Date().toISOString(), started_epoch_ms: Date.now(), ended_at: null }
  state.agentLineage = createSyntheticAgentLineage()
  state.events = []; state.snapshots = {}; state.feedback = []; state.proposals = []; state.packageText = ''; state.packageStatus = ''
  state.discardConfirm = false; state.deletionReceipt = null
  capture('session_start', 'review-session-start', null, { consent: 'explicit', scope: 'controlled-ai-web-prototype' })
}
function startHumanExperience() {
  if (!launchGateReady()) {
    approveSyntheticLaunch()
  }
  beginSession()
}
function endSession() {
  if (!active()) return
  capture('session_end', 'review-session-end', null, { consent: 'explicit' })
  state.session.ended_at = new Date().toISOString()
  render()
}
function eventEvidenceIds() { return state.events.slice(-5).map((event) => `ev_${event.id}`) }
function addFeedback() {
  const text = state.feedbackText.trim()
  if (!active() || !text) return
  const target = state.feedbackAnchor === 'auto' ? state.events.at(-1) : state.events.find((event) => event.element_id === state.feedbackAnchor)
  const evidenceIds = [...new Set([...(target ? [`ev_${target.id}`] : []), ...eventEvidenceIds()])]
  const ambiguous = state.feedbackAmbiguous || !target?.element_id
  const feedback = { id: id('fb'), text, time_window: { start_ms: Math.max(0, nowMs() - 15000), end_ms: nowMs() }, evidence_ids: evidenceIds, anchor: ambiguous ? { route: state.route, region_candidate: '当前页面中心区域', binding: 'ambiguous' } : { route: target.route, element_id: target.element_id, binding: 'confirmed' }, confirmation: { status: ambiguous ? 'needs_clarification' : 'confirmed-by-reviewer' } }
  state.feedback.push(feedback)
  state.proposals.push({ id: id('prop'), title: proposalTitle(text, feedback), reproduction: target ? `${target.route} → ${target.element_id}` : `${state.route} → 区域候选`, evidence_ids: [`ev_${feedback.id}`, ...evidenceIds], execution: 'proposal-only', confirmation: { status: ambiguous ? 'needs_clarification' : 'pending' } })
  capture('feedback_submit', 'feedback-submit', null, { feedback_id: feedback.id, evidence_ids: [`ev_${feedback.id}`, ...evidenceIds] })
  state.feedbackText = ''; state.feedbackAmbiguous = false
  render()
}
function proposalTitle(text, feedback) {
  if (feedback.confirmation.status === 'needs_clarification') return '先确认这条意见具体指向哪个元素或状态'
  if (/进度|等待|生成/.test(text)) return '在生成动作后展示可见进度与下一步状态'
  if (/价格|付费|套餐/.test(text)) return '在套餐选择前补充价格与限制说明'
  return '根据已绑定反馈生成一个可审阅的界面修改建议'
}
function setProposal(idValue, status) { const proposal = state.proposals.find((item) => item.id === idValue); if (!proposal) return; capture('proposal_confirmation', `proposal-${status}`, () => { proposal.confirmation.status = status }, { proposal_id: idValue, status }) }
function viewEvidence(eventId) {
  const event = state.events.find((item) => item.id === eventId)
  if (!event) return
  capture('evidence_view', `evidence-${event.element_id ?? event.id}`, () => { state.viewedEvidence = eventId }, { viewed_event_id: eventId })
}
async function sha256(text) { const bytes = new TextEncoder().encode(text); const digest = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('') }
async function makePackage(download = false) {
  if (!state.session) return
  const sourceSession = { id: state.session.id, started_at: state.session.started_at, ended_at: state.session.ended_at ?? new Date().toISOString() }
  const pkg = buildPackage({ adapter: reviewAdapter, session: sourceSession, events: state.events, snapshots: state.snapshots, feedback: state.feedback, proposals: state.proposals })
  pkg.integrity.value = await sha256(packageForIntegrity(pkg))
  const packageCheck = validatePackage(pkg)
  const adapterCheck = validatePackageAgainstAdapter(pkg, reviewAdapter)
  const check = { valid: packageCheck.valid && adapterCheck.valid, errors: [...packageCheck.errors, ...adapterCheck.errors] }
  state.packageText = JSON.stringify(pkg, null, 2); state.packageStatus = check.valid ? `结构校验通过，SHA-256：${pkg.integrity.value.slice(0, 16)}…` : `校验失败：${check.errors.join(' ')}`
  render()
  if (download && check.valid) { const url = URL.createObjectURL(new Blob([`${state.packageText}\n`], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${pkg.package_id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0) }
}
async function discardCurrentSession() {
  if (!state.session || !state.discardConfirm) return
  const pendingReceipt = discardCaptureBuffer(state, new Date().toISOString())
  const receipt = await sealDeletionReceipt(pendingReceipt, sha256)
  state.discardConfirm = false
  state.deletionReceipt = receipt
  state.agentLineage = null
  state.feedbackAnchor = 'auto'
  state.feedbackAmbiguous = false
  render()
}
function setInput(name, value, sensitive = false, elementId = `brief-${name}`) {
  const update = () => { state.prototype[name] = value }
  if (sensitive) capture('input', elementId, update, { excluded_reason: 'sensitive-field' }, 'excluded')
  else capture('input', elementId, update, { value_length: value.length })
}
let agentReplayScrollGuardUntil = 0
function recordScroll() { if (!active() || state.agentReplayIndex !== null || Date.now() < agentReplayScrollGuardUntil) return; const last = state.events.at(-1); if (last?.kind === 'scroll' && nowMs() - last.at_ms < 900) return; capture('scroll', 'controlled-prototype-viewport', null, { scroll_y: Math.round(window.scrollY) }) }
let scrollTimer = null
window.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(recordScroll, 250) }, { passive: true })

function page() {
  if (state.route === '/brief') return `<section class="page"><div class="page-head"><p class="eyebrow">体验任务</p><h1>帮“夏末胶片展”选一个活动页方案。</h1><p>像真实用户一样走完整个流程。哪里看不懂、哪里不顺手，直接写在右侧；系统会自动记住你当时停在哪一步。</p></div><div class="grid two"><article class="flow-preview"><p class="mono">NEON / 活动页生成器</p><h2>夏末胶片展</h2><p>从一句策展提示，生成一个可以分享和购票的活动页。</p><div class="hero-actions"><button class="button primary" data-action="navigate" data-route="/generate" data-element-id="brief-start-flow">开始配置活动页</button></div></article><article class="card guide-card"><h2>你可以这样体验</h2><ol><li>自己点击，判断流程是否顺手</li><li>随时让 AI 演示它会怎么操作</li><li>把问题写在右侧，形成修改建议</li></ol><p>这是演示内容，不会真的发送、购买或发布任何东西。</p></article></div></section>`
  if (state.route === '/generate') return `<section class="page"><div class="page-head"><p class="eyebrow">第 2 步 · 选择方案</p><h1>你会从哪种页面结构开始？</h1><p>先选择一种结构，再生成两个可以比较的页面概念。</p></div><div class="grid two"><button class="card template ${state.prototype.template === 'landing' ? 'selected' : ''}" aria-pressed="${state.prototype.template === 'landing'}" data-action="template" data-template="landing" data-element-id="template-landing"><span class="swatch"></span><h2>叙事落地页</h2><p>先让用户理解主题，再给出明确行动。</p></button><button class="card template alt" aria-pressed="${state.prototype.template === 'catalog' ? 'true' : 'false'}" data-action="template" data-template="catalog" data-element-id="template-catalog"><span class="swatch"></span><h2>作品目录</h2><p>先比较内容与价格，再进入预约。</p></button></div><article class="card generator" style="margin-top:16px"><div class="spark">✦</div><p class="mono">${state.prototype.generation === 'complete' ? '已生成' : '等待生成'}</p><h2>${state.prototype.generation === 'complete' ? '两个概念已经准备好' : '生成两个页面概念'}</h2><div class="progress" style="--progress:${state.prototype.generation === 'complete' ? '100%' : '12%'}"><i></i></div><button class="button primary" data-action="generate" data-element-id="generate-run">${state.prototype.generation === 'complete' ? '查看两个概念' : '开始生成'}</button></article></section>`
  if (state.route === '/gallery') return `<section class="page"><div class="page-head"><p class="eyebrow">第 3 步 · 比较结果</p><h1>哪个版本更适合这个活动？</h1><p>选择一个概念继续。如果做决定时缺少关键信息，也可以直接写在右侧。</p></div><div class="grid two"><button class="card concept" aria-pressed="${state.prototype.concept === 'warm' ? 'true' : 'false'}" data-action="concept" data-concept="warm" data-element-id="concept-warm"><div class="mock"></div><h2>概念 A · 叙事优先</h2><p>首屏用一句策展主张，购票动作留在第二段。</p></button><button class="card concept" aria-pressed="${state.prototype.concept === 'direct' ? 'true' : 'false'}" data-action="concept" data-concept="direct" data-element-id="concept-direct"><div class="mock"></div><h2>概念 B · 行动优先</h2><p>首屏先展示日期、价格和购票按钮。</p></button></div><div class="actions"><button class="button primary" data-action="navigate" data-route="/review" data-element-id="gallery-continue" ${state.prototype.concept ? '' : 'disabled'}>确认选择并继续</button></div></section>`
  return `<section class="page"><div class="page-head"><p class="eyebrow">第 4 步 · 完成确认</p><h1>最后确认你的选择。</h1><p>这里的所有按钮都只作用于演示页面，不会真的发布或购买。</p></div><div class="grid two"><article class="card receipt"><h2>你选择了</h2><p>${state.prototype.concept === 'direct' ? '概念 B · 行动优先' : state.prototype.concept === 'warm' ? '概念 A · 叙事优先' : '尚未选择'}</p><div class="actions"><button class="button" data-action="navigate" data-route="/gallery" data-element-id="review-back-gallery">返回重新选择</button></div></article><article class="card"><h2>预览方式</h2><label class="field">选择一种方式<select data-input="plan" data-element-id="review-plan"><option value="starter" ${state.prototype.plan === 'starter' ? 'selected' : ''}>仅查看预览</option><option value="launch" ${state.prototype.plan === 'launch' ? 'selected' : ''}>模拟准备发布</option></select></label><div class="actions"><button class="button primary" data-action="complete" data-element-id="review-complete">完成体验</button></div></article></div></section>`
}
function eventList() { if (!state.events.length) return '<p class="mono">会话尚未开始。</p>'; return state.events.slice().reverse().map((event) => `<button class="event" data-action="evidence" data-event="${event.id}" data-element-id="evidence-${event.id}"><strong>${event.kind}</strong> · ${event.route}<span class="mono">${event.element_id ?? 'route state'} · ${event.at_ms}ms · ${event.privacy}</span></button>`).join('') }
function evidenceViewer() {
  const event = state.events.find((item) => item.id === state.viewedEvidence)
  if (!event) return '<p class="mono">点击一条事件，查看它的前后状态。</p>'
  const before = state.snapshots[event.before_snapshot_id] ?? null
  const after = state.snapshots[event.after_snapshot_id] ?? null
  return `<div class="status"><strong>${event.id}</strong><br><span class="mono">before ${event.before_snapshot_id ?? 'none'}</span><br>${JSON.stringify(before)}<br><span class="mono">after ${event.after_snapshot_id ?? 'none'}</span><br>${JSON.stringify(after)}</div>`
}
function feedbackAnchorOptions() { const options = [...new Map(state.events.filter((event) => event.element_id && elementLabels[event.element_id]).map((event) => [event.element_id, event])).values()]; return `<option value="auto">自动关联到刚才的操作</option>${options.map((event) => `<option value="${event.element_id}">${labels[event.route] ?? '当前页面'} · ${elementLabels[event.element_id]}</option>`).join('')}` }
function proposalLocation(proposal) { const route = proposal.reproduction.split(' → ')[0]; return `关联位置：${labels[route] ?? '当前页面'}` }
function proposalList() { if (!state.proposals.length) return '<p class="empty-copy">记录反馈后，AI 会在这里复述它的理解，等你确认。</p>'; return state.proposals.map((proposal) => `<article class="proposal"><h4>${proposal.title}</h4><p>${proposalLocation(proposal)}</p>${proposal.confirmation.status === 'pending' ? `<div class="actions"><button class="button" data-action="proposal" data-proposal="${proposal.id}" data-status="accepted">理解正确</button><button class="button quiet" data-action="proposal" data-proposal="${proposal.id}" data-status="rejected">理解有误</button></div>` : `<span class="proposal-state">${proposal.confirmation.status === 'accepted' ? '已确认' : '已退回'}</span>`}</article>`).join('') }
function retentionControls(isActive) {
  if (state.deletionReceipt) return `<p class="status good" data-deletion-receipt>当前浏览器缓冲区已清空 · ${state.deletionReceipt.session_id}<br><span class="mono">${state.deletionReceipt.package_id} · SHA-256 ${state.deletionReceipt.integrity.value.slice(0, 16)}…<br>下载副本不受影响 · 历史包未触碰</span></p>`
  if (!state.session || isActive) return '<p class="status">结束本轮后可显式丢弃当前页面内存中的采集缓冲区。</p>'
  if (state.discardConfirm) return `<p class="status warn">确认后只清空当前页面内存。已下载 JSON 与历史包不会被删除。</p><div class="actions"><button class="button stop" data-action="discard" data-element-id="discard-confirm">确认丢弃当前缓冲区</button><button class="button quiet" data-action="cancel-discard">取消</button></div>`
  return `<p class="status warn">只清空当前页面内存中的本轮记录；已下载 JSON 与历史包不在此操作范围。</p><button class="button quiet" data-action="prepare-discard" data-element-id="discard-prepare">丢弃本轮本地缓冲区</button>`
}
function launchGatePanel() {
  const gate = state.launchGate
  const status = gate.decision.status
  const admission = launchGateAdmission()
  const displayStatus = status === 'approved' && !admission.allowed && admission.reason === 'approval-outside-time-window' ? 'expired' : status
  const labels = { 'awaiting-confirmation': '开始前，先说明这次会发生什么', approved: '体验已准备好', declined: '你已取消本次体验', expired: '本次体验准备已过期' }
  const statusClass = displayStatus === 'approved' ? 'good' : ['declined', 'expired'].includes(displayStatus) ? 'warn' : ''
  const controls = displayStatus === 'awaiting-confirmation'
    ? `<div class="launch-gate-actions"><button class="button primary" data-action="experience-start" data-element-id="launch-gate-approve">开始体验</button><a class="button quiet" href="/?artifact-review-spike=1">暂不体验</a></div>`
    : ['declined', 'expired'].includes(displayStatus) ? `<button class="button" data-action="launch-reset" data-element-id="launch-gate-reset">重新开始</button>` : ''
  return `<section class="launch-gate ${displayStatus === 'approved' ? 'launch-gate-compact' : ''}" data-launch-gate-status="${displayStatus}"><div><span class="eyebrow">交互原型审阅</span><strong>${labels[displayStatus]}</strong><p>这是一个使用演示内容的可点击流程。开始后会记录你在本页的操作和文字反馈，方便 AI 理解问题发生在哪一步。</p></div><ul class="human-scope"><li>只记录当前演示流程</li><li>不会访问真实账号或外部网络</li><li>不会真的发送、购买、发布或删除</li></ul><details class="technical-details"><summary>隐私与技术详情</summary><div class="status ${statusClass}" data-launch-gate-receipt>临时本地运行 · 来源只读 · 敏感内容默认排除<br><span class="mono">runtime_start_authorized=${admission.allowed} · execution_authorized=false${displayStatus === 'approved' ? ' · 短时有效' : displayStatus === 'expired' ? ' · 需要重新确认' : ''}</span></div></details>${controls}</section>`
}
const agentPlayer = createObservableAgentPlayer({
  steps: agentPlaybackSteps,
  resolveTarget: (elementId) => document.querySelector(`[data-element-id="${elementId}"]`),
  readViewport: () => ({ width: window.innerWidth, height: window.innerHeight, scroll_x: Math.round(window.scrollX), scroll_y: Math.round(window.scrollY) }),
  execute: async (step) => {
    if (state.route !== step.route) throw new Error('route-mismatch')
    const target = document.querySelector(`[data-element-id="${step.element_id}"]`)
    if (!target || target.disabled) throw new Error('target-unavailable')
    const beforeStateId = `agent-before-${step.seq}-${state.route.slice(1)}`
    target.click()
    return { before_state_id: beforeStateId, after_state_id: `agent-after-${step.seq}-${state.route.slice(1)}` }
  },
  onChange: (playerState) => { state.agentPlayer = playerState; render() },
  previewMs: agentPreviewMs,
})
function startAgentWalkthrough() {
  if (!active()) return
  state.agentReplayIndex = null
  state.route = '/brief'
  state.prototype = { template: 'landing', generation: 'idle', concept: null, plan: 'starter', sensitive_email: '' }
  render()
  agentPlayer.start()
}
function agentPanel() {
  const player = state.agentPlayer
  const statusLabels = { idle: '待命', previewing: '预览目标', executing: '正在执行', paused: '已暂停', 'taken-over': '人工已接管', completed: '演示完成', failed: '演示失败' }
  const replay = state.agentReplayIndex === null ? null : player.receipt[state.agentReplayIndex]
  const canReplay = player.status === 'completed' && player.receipt.length > 0 && player.receipt.every((item) => item.status === 'completed')
  const canStart = active() && state.agentReplayIndex === null && ['idle', 'completed', 'failed'].includes(player.status)
  const canInterrupt = ['previewing', 'executing'].includes(player.status)
  const canResume = ['paused', 'taken-over'].includes(player.status)
  const detail = player.failure ? ' · 操作未完成' : ''
  const replayPanel = replay
    ? `<div class="agent-replay" data-agent-replay><strong>正在回放 · ${state.agentReplayIndex + 1}/${player.receipt.length}</strong><span>查看 AI 当时点了哪里、页面发生了什么变化。</span><div class="agent-controls"><button class="button" data-action="agent-replay-prev" ${state.agentReplayIndex === 0 ? 'disabled' : ''}>上一步</button><button class="button" data-action="agent-replay-next" ${state.agentReplayIndex === player.receipt.length - 1 ? 'disabled' : ''}>下一步</button><button class="button quiet" data-action="agent-replay-exit">退出回放</button></div></div>`
    : ''
  const lineage = state.agentLineage
  const lineageReceipt = lineage
    ? `<details class="technical-details agent-lineage" data-agent-lineage-receipt><summary>查看本轮技术记录</summary><span class="mono">${lineage.binding_id} · ${lineage.authority.kind}:${lineage.authority.id}<br>source_sha256=${lineage.source.identity_value.slice(0, 12)}… · routes=${lineage.route_scope.join(',')}<br>human_observer_required=true · execution_authorized=false</span></details>`
    : ''
  return `<section class="agent-player" data-agent-player data-status="${player.status}"><div><span class="eyebrow">AI 可见演示</span><strong>让 AI 走一遍 · ${statusLabels[player.status]}${detail}</strong><small>你会看到 AI 的光标和每一步操作，也可以随时暂停或自己接着操作。</small></div><div class="agent-controls"><button class="button primary" data-action="agent-start" data-element-id="agent-walkthrough-start" ${canStart ? '' : 'disabled'}>让 AI 开始演示</button><button class="button" data-action="agent-pause" ${canInterrupt ? '' : 'disabled'}>暂停</button><button class="button" data-action="agent-takeover" ${canInterrupt || player.status === 'paused' ? '' : 'disabled'}>我来操作</button><button class="button" data-action="agent-resume" ${canResume ? '' : 'disabled'}>让 AI 继续</button><button class="button" data-action="agent-replay-start" ${canReplay && state.agentReplayIndex === null ? '' : 'disabled'}>重新看一遍</button></div>${lineageReceipt}${replayPanel}</section>`
}
function agentOverlay() {
  const cursor = state.agentPlayer.cursor
  if (!cursor?.visible) return ''
  return `<div class="agent-cursor" data-agent-cursor style="--agent-x:${cursor.x}px;--agent-y:${cursor.y}px" aria-hidden="true"><i></i><span>Agent</span></div>`
}
function applyAgentVisuals() {
  const replayTarget = state.agentReplayIndex === null ? null : state.agentPlayer.receipt[state.agentReplayIndex]?.element_id
  const elementId = replayTarget ?? state.agentPlayer.target_element_id
  if (!elementId) return
  const target = document.querySelector(`[data-element-id="${elementId}"]`)
  target?.classList.add('agent-target-preview')
  if (replayTarget) target?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' })
}

function showAgentReplay(index) {
  const receipt = state.agentPlayer.receipt[index]
  if (state.agentPlayer.status !== 'completed' || !receipt || receipt.status !== 'completed' || !receipt.route || !receipt.element_id) return
  state.agentReplayIndex = index
  agentReplayScrollGuardUntil = Date.now() + 600
  state.route = receipt.route
  render()
}
function exitAgentReplay() { agentReplayScrollGuardUntil = Date.now() + 600; state.agentReplayIndex = null; render() }
function rail() { const isActive = active(); const completed = Boolean(state.session?.ended_at); return `<aside class="review-rail"><div class="rail-title"><h2>体验反馈</h2><span class="feedback-count">${state.feedback.length} 条</span></div><p class="rail-intro">操作到哪里，直接写下问题。系统会把反馈和你刚才的步骤放在一起。</p><p class="status ${isActive ? 'good' : ''}">${isActive ? '正在记录本轮体验。' : completed ? '本轮体验已结束，反馈已保留在当前页面。' : '开始体验后即可记录反馈。'}</p><div class="rail-section feedback"><h3>哪里需要改？</h3><label class="field"><textarea data-feedback placeholder="例如：点击生成后不知道系统在做什么，希望显示进度。">${state.feedbackText}</textarea></label><details class="feedback-more"><summary>需要更精确地指出位置？</summary><label class="field">关联到哪一步<select data-anchor>${feedbackAnchorOptions()}</select></label><label class="checkbox"><input type="checkbox" data-ambiguous ${state.feedbackAmbiguous ? 'checked' : ''}>我只能指出大概区域，需要 AI 再问我</label></details><button class="button primary full-button" data-action="feedback" data-element-id="feedback-submit" ${isActive ? '' : 'disabled'}>记录这条反馈</button></div><div class="rail-section"><h3>AI 对你的理解</h3><div class="proposal-list">${proposalList()}</div></div>${completed ? `<div class="rail-section completion-card"><h3>本轮已完成</h3><p>你可以导出本轮记录，交给 AI 继续处理。</p><button class="button primary full-button" data-action="download" data-element-id="package-download">导出本轮记录</button></div>` : ''}<details class="rail-section technical-details"><summary>查看技术记录</summary><div class="event-list">${eventList()}</div><div class="evidence-viewer">${evidenceViewer()}</div><p class="status ${state.packageStatus.startsWith('结构校验通过') ? 'good' : ''}">${state.packageStatus || '结束后可生成本地结构化记录。'}</p><button class="button" data-action="package" data-element-id="package-verify" ${state.session ? '' : 'disabled'}>校验记录</button><textarea class="package-view" readonly placeholder="结构化记录将在这里显示。">${state.packageText}</textarea><div data-retention-controls>${retentionControls(isActive)}</div></details></aside>` }
function render() { const isActive = active(); const hasSession = Boolean(state.session); app.innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><span class="eyebrow">canvas_prompt_</span><strong>交互原型审阅</strong></div><div class="topbar-actions"><a class="button quiet back-link" href="/?artifact-review-spike=1">返回交互审阅</a><div class="session ${isActive ? '' : 'idle'}"><i class="dot"></i><span>${isActive ? '正在记录' : state.session?.ended_at ? '本轮已结束' : '尚未开始'}</span>${isActive ? `<button class="button stop" data-action="end" data-element-id="review-session-end">结束审阅</button>` : ''}</div></div></header><div class="layout ${hasSession ? '' : 'layout-welcome'}"><section class="stage">${hasSession ? `${agentPanel()}<nav class="route-nav">${routes.map(([route, label]) => `<button data-action="navigate" data-route="${route}" data-element-id="nav-${route.slice(1)}" class="${state.route === route ? 'active' : ''}">${label}</button>`).join('')}</nav>${page()}${agentOverlay()}` : launchGatePanel()}</section>${hasSession ? rail() : ''}</div></div>`; applyAgentVisuals() }

app.addEventListener('click', (event) => { const control = event.target.closest('[data-action]'); if (!control || control.disabled) return; const action = control.dataset.action; if (action === 'experience-start') startHumanExperience(); else if (action === 'launch-approve') approveSyntheticLaunch(); else if (action === 'launch-decline') declineSyntheticLaunch(); else if (action === 'launch-reset') resetSyntheticLaunch(); else if (action === 'start') beginSession(); else if (action === 'end') endSession(); else if (action === 'agent-start') startAgentWalkthrough(); else if (action === 'agent-pause') agentPlayer.pause(); else if (action === 'agent-takeover') agentPlayer.takeOver(); else if (action === 'agent-resume') agentPlayer.resume({ confirmed: true }); else if (action === 'agent-replay-start') showAgentReplay(0); else if (action === 'agent-replay-prev') showAgentReplay(state.agentReplayIndex - 1); else if (action === 'agent-replay-next') showAgentReplay(state.agentReplayIndex + 1); else if (action === 'agent-replay-exit') exitAgentReplay(); else if (action === 'navigate') navigate(control.dataset.route, control.dataset.elementId); else if (action === 'template') capture('click', control.dataset.elementId, () => { state.prototype.template = control.dataset.template }); else if (action === 'generate') capture('click', control.dataset.elementId, () => { state.prototype.generation = 'complete'; state.route = '/gallery' }, { transition: 'idle→complete' }); else if (action === 'concept') capture('click', control.dataset.elementId, () => { state.prototype.concept = control.dataset.concept }); else if (action === 'complete') capture('click', control.dataset.elementId, null, { result: 'synthetic-flow-complete' }); else if (action === 'feedback') addFeedback(); else if (action === 'proposal') setProposal(control.dataset.proposal, control.dataset.status); else if (action === 'evidence') viewEvidence(control.dataset.event); else if (action === 'package') void makePackage(false); else if (action === 'download') void makePackage(true); else if (action === 'prepare-discard') { state.discardConfirm = true; render() } else if (action === 'cancel-discard') { state.discardConfirm = false; render() } else if (action === 'discard') void discardCurrentSession() })
app.addEventListener('input', (event) => { const target = event.target; if (target.matches('[data-feedback]')) { state.feedbackText = target.value; return } if (target.matches('[data-input]')) setInput(target.dataset.input, target.value, target.dataset.sensitive === 'true', target.dataset.elementId) })
app.addEventListener('change', (event) => { const target = event.target; if (target.matches('[data-anchor]')) { state.feedbackAnchor = target.value; return } if (target.matches('[data-ambiguous]')) { state.feedbackAmbiguous = target.checked } })
render()
