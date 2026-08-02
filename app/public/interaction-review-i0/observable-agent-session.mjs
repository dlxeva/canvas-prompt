export const OBSERVABLE_AGENT_SESSION_SCHEMA = 'interaction-review-observable-agent-session/0.1'

const MODES = new Set(['human-demonstrates', 'agent-walkthrough', 'co-review'])
const ACTORS_BY_MODE = {
  'human-demonstrates': new Set(['human', 'system']),
  'agent-walkthrough': new Set(['agent', 'system']),
  'co-review': new Set(['human', 'agent', 'system']),
}
const ACTION_KINDS = new Set(['click', 'input', 'navigate', 'scroll', 'wait'])
const PROHIBITED_EFFECTS = ['send-message', 'purchase', 'publish', 'delete', 'production-mutation']
const SENSITIVE_KEYS = new Set(['value', 'input_value', 'text', 'content', 'payload', 'secret'])

export function buildObservableAgentSession({ sessionId, mode, adapter, actions }) {
  const normalizedActions = actions.map((action, index) => ({
    action_id: action.action_id,
    seq: index + 1,
    actor: action.actor,
    kind: action.kind,
    route: action.route,
    ...(action.element_id ? { element_id: action.element_id } : {}),
    before_state_id: action.before_state_id,
    after_state_id: action.after_state_id,
    cursor: {
      visible: true,
      x_normalized: action.cursor.x_normalized,
      y_normalized: action.cursor.y_normalized,
    },
    viewport: {
      width: action.viewport.width,
      height: action.viewport.height,
      scroll_x: action.viewport.scroll_x,
      scroll_y: action.viewport.scroll_y,
    },
    step_status: action.step_status ?? 'completed',
    execution_authorized: false,
  }))

  return {
    schema: OBSERVABLE_AGENT_SESSION_SCHEMA,
    session_id: sessionId,
    mode,
    artifact: {
      adapter_id: adapter.adapter_id,
      source_version: adapter.source_version,
      allowed_routes: [...adapter.allowed_routes],
    },
    consent: {
      explicit_session: true,
      human_observer_present: true,
      sensitive_input: 'excluded-by-default',
      allowed_action_kinds: [...ACTION_KINDS],
      prohibited_effects: [...PROHIBITED_EFFECTS],
    },
    visibility: {
      live_view: true,
      agent_cursor: 'visible',
      target_highlight: 'before-action',
      step_status: 'visible',
      action_preview: 'required',
    },
    control: {
      initial_controller: mode === 'human-demonstrates' ? 'human' : 'agent',
      human_can_pause: true,
      human_can_take_over: true,
      agent_resumes_only_after: 'explicit-human-resume',
    },
    actions: normalizedActions,
    replay: {
      ordered: true,
      source: 'sanitized-events',
      raw_video: false,
      receipt: {
        status: 'available',
        action_count: normalizedActions.length,
        first_seq: normalizedActions.length ? 1 : 0,
        last_seq: normalizedActions.length,
      },
    },
    execution_authorized: false,
  }
}

function inspectSensitiveKeys(value, path, errors) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) errors.push(`${path}.${key} 不得保存原始输入或敏感内容`)
    inspectSensitiveKeys(child, `${path}.${key}`, errors)
  }
}

export function validateObservableAgentSession(session) {
  const errors = []
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return { valid: false, errors: ['会话必须为对象'] }
  }
  if (session.schema !== OBSERVABLE_AGENT_SESSION_SCHEMA) errors.push('schema 不受支持')
  if (typeof session.session_id !== 'string' || !session.session_id.trim()) errors.push('session_id 必须非空')
  if (!MODES.has(session.mode)) errors.push('mode 必须区分人类演示、Agent 代走或共同审阅')

  const routes = session.artifact?.allowed_routes
  if (!Array.isArray(routes) || routes.length === 0) errors.push('artifact.allowed_routes 必须是非空白名单')
  else {
    if (new Set(routes).size !== routes.length) errors.push('artifact.allowed_routes 不能重复')
    for (const route of routes) {
      if (typeof route !== 'string' || !/^\/[A-Za-z0-9/_-]*$/.test(route) || route.includes('*')) {
        errors.push(`路由 ${String(route)} 不是受控路径`)
      }
    }
  }

  if (session.consent?.explicit_session !== true) errors.push('必须由明确会话启动')
  if (session.consent?.human_observer_present !== true) errors.push('必须有人类观察者在场')
  if (session.consent?.sensitive_input !== 'excluded-by-default') errors.push('敏感输入必须默认排除')
  const declaredActionKinds = session.consent?.allowed_action_kinds
  if (!Array.isArray(declaredActionKinds) || declaredActionKinds.length !== ACTION_KINDS.size || declaredActionKinds.some((kind) => !ACTION_KINDS.has(kind))) {
    errors.push('allowed_action_kinds 必须保持完整受控动作白名单')
  }
  for (const effect of PROHIBITED_EFFECTS) {
    if (!session.consent?.prohibited_effects?.includes(effect)) errors.push(`必须 fail closed：${effect}`)
  }

  if (session.visibility?.live_view !== true) errors.push('人的实时可见视图必须开启')
  if (session.visibility?.agent_cursor !== 'visible') errors.push('Agent 光标必须可见')
  if (session.visibility?.target_highlight !== 'before-action') errors.push('动作前必须高亮目标')
  if (session.visibility?.step_status !== 'visible') errors.push('步骤状态必须可见')
  if (session.visibility?.action_preview !== 'required') errors.push('Agent 动作必须先预览')

  if (session.control?.human_can_pause !== true) errors.push('人必须能暂停')
  if (session.control?.human_can_take_over !== true) errors.push('人必须能接管')
  if (session.control?.agent_resumes_only_after !== 'explicit-human-resume') errors.push('Agent 只能经人明确恢复后继续')
  const expectedController = session.mode === 'human-demonstrates' ? 'human' : 'agent'
  if (session.control?.initial_controller !== expectedController) errors.push('initial_controller 与 mode 不匹配')

  const actions = session.actions
  if (!Array.isArray(actions) || actions.length === 0) errors.push('actions 必须为非空有序轨迹')
  else {
    const actionIds = new Set()
    actions.forEach((action, index) => {
      const path = `actions[${index}]`
      if (action.seq !== index + 1) errors.push(`${path}.seq 必须从 1 连续递增`)
      if (!action.action_id || actionIds.has(action.action_id)) errors.push(`${path}.action_id 必须非空且唯一`)
      actionIds.add(action.action_id)
      if (!ACTORS_BY_MODE[session.mode]?.has(action.actor)) errors.push(`${path}.actor 与 mode 不匹配`)
      if (!ACTION_KINDS.has(action.kind)) errors.push(`${path}.kind 不在受控动作白名单`)
      if (!routes?.includes(action.route)) errors.push(`${path}.route 不在路由白名单`)
      if (['click', 'input'].includes(action.kind) && !action.element_id) errors.push(`${path}.element_id 是稳定锚点，不能为空`)
      if (typeof action.before_state_id !== 'string' || typeof action.after_state_id !== 'string') errors.push(`${path} 必须记录动作前后状态`)
      if (action.cursor?.visible !== true) errors.push(`${path}.cursor 必须可见`)
      if (!Number.isFinite(action.cursor?.x_normalized) || action.cursor.x_normalized < 0 || action.cursor.x_normalized > 1) errors.push(`${path}.cursor.x_normalized 越界`)
      if (!Number.isFinite(action.cursor?.y_normalized) || action.cursor.y_normalized < 0 || action.cursor.y_normalized > 1) errors.push(`${path}.cursor.y_normalized 越界`)
      if (!Number.isInteger(action.viewport?.width) || action.viewport.width < 1) errors.push(`${path}.viewport.width 必须为正整数`)
      if (!Number.isInteger(action.viewport?.height) || action.viewport.height < 1) errors.push(`${path}.viewport.height 必须为正整数`)
      if (!Number.isInteger(action.viewport?.scroll_x) || action.viewport.scroll_x < 0) errors.push(`${path}.viewport.scroll_x 必须为非负整数`)
      if (!Number.isInteger(action.viewport?.scroll_y) || action.viewport.scroll_y < 0) errors.push(`${path}.viewport.scroll_y 必须为非负整数`)
      if (!['previewed', 'completed', 'failed', 'paused', 'taken-over'].includes(action.step_status)) errors.push(`${path}.step_status 不受支持`)
      if (action.execution_authorized !== false) errors.push(`${path}.execution_authorized 必须为 false`)
      inspectSensitiveKeys(action, path, errors)
    })
  }

  if (session.replay?.ordered !== true) errors.push('重放必须保持动作顺序')
  if (session.replay?.source !== 'sanitized-events') errors.push('重放只能来自脱敏事件')
  if (session.replay?.raw_video !== false) errors.push('不得保存原始全屏视频')
  const receipt = session.replay?.receipt
  if (receipt?.status !== 'available') errors.push('必须生成可用的重放回执')
  if (receipt?.action_count !== actions?.length) errors.push('重放回执动作数不匹配')
  if (actions?.length && (receipt?.first_seq !== 1 || receipt?.last_seq !== actions.length)) errors.push('重放回执序号范围不匹配')
  if (session.execution_authorized !== false) errors.push('顶层 execution_authorized 必须为 false')
  inspectSensitiveKeys(session, 'session', errors)

  return { valid: errors.length === 0, errors }
}
