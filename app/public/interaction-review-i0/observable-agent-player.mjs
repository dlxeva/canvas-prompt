const PLAYER_STATUSES = new Set(['idle', 'previewing', 'executing', 'paused', 'taken-over', 'completed', 'failed'])

const clone = (value) => JSON.parse(JSON.stringify(value))

export function createObservableAgentPlayer({ steps, resolveTarget, readViewport, execute, onChange = () => {}, previewMs = 600 }) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps 必须是非空受控动作列表')
  const state = {
    status: 'idle', current_step: 0, target_element_id: null, cursor: null,
    viewport: null, receipt: [], failure: null, explicit_resume_required: false,
  }
  let runToken = 0

  const snapshot = () => clone(state)
  const publish = () => onChange(snapshot())
  const setStatus = (status) => {
    if (!PLAYER_STATUSES.has(status)) throw new Error(`不支持的播放器状态：${status}`)
    state.status = status
    publish()
  }
  const clearVisuals = () => {
    state.target_element_id = null
    state.cursor = null
  }
  const fail = (step, reason) => {
    clearVisuals()
    state.failure = { step_id: step.step_id, reason }
    state.receipt.push({ step_id: step.step_id, seq: step.seq, status: 'failed', reason, execution_authorized: false })
    setStatus('failed')
  }

  async function runFromCurrent(token) {
    while (state.current_step < steps.length && token === runToken) {
      const step = steps[state.current_step]
      const target = resolveTarget(step.element_id)
      if (!target) return fail(step, 'target-not-found')
      target.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'auto' })
      const rect = target.getBoundingClientRect()
      state.viewport = readViewport()
      state.target_element_id = step.element_id
      state.cursor = {
        visible: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      }
      state.failure = null
      setStatus('previewing')
      await new Promise((resolve) => setTimeout(resolve, previewMs))
      if (token !== runToken || ['paused', 'taken-over'].includes(state.status)) return

      setStatus('executing')
      try {
        const result = await execute(step)
        state.receipt.push({
          step_id: step.step_id,
          seq: step.seq,
          status: 'completed',
          route: step.route,
          element_id: step.element_id,
          before_state_id: result.before_state_id,
          after_state_id: result.after_state_id,
          viewport: clone(state.viewport),
          cursor: clone(state.cursor),
          execution_authorized: false,
        })
      } catch (error) {
        return fail(step, error instanceof Error ? error.message : 'execution-failed')
      }
      state.current_step += 1
      clearVisuals()
      publish()
    }
    if (token === runToken && state.current_step === steps.length) setStatus('completed')
  }

  return {
    getState: snapshot,
    start() {
      if (!['idle', 'completed', 'failed'].includes(state.status)) return false
      runToken += 1
      state.status = 'idle'
      state.current_step = 0
      state.receipt = []
      state.failure = null
      state.explicit_resume_required = false
      void runFromCurrent(runToken)
      return true
    },
    pause() {
      if (!['previewing', 'executing'].includes(state.status)) return false
      runToken += 1
      clearVisuals()
      state.explicit_resume_required = true
      setStatus('paused')
      return true
    },
    takeOver() {
      if (!['previewing', 'executing', 'paused'].includes(state.status)) return false
      runToken += 1
      clearVisuals()
      state.explicit_resume_required = true
      setStatus('taken-over')
      return true
    },
    resume({ confirmed = false } = {}) {
      if (!['paused', 'taken-over'].includes(state.status) || !confirmed) return false
      runToken += 1
      state.explicit_resume_required = false
      void runFromCurrent(runToken)
      return true
    },
  }
}
