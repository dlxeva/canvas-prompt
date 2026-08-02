import { describe, expect, it } from 'vitest'
import { isInteractionReviewPackage } from '../src/interaction-review-contract'

const valid = () => ({
  schema_version: 'interaction-review/0.1-draft', package_id: 'irp_contract_1',
  source: { kind: 'local-static-html', name: 'index.html', entry_path: 'index.html', sha256: 'a'.repeat(64), source_bytes_in_export: false },
  session: { started_at: new Date(0).toISOString(), duration_ms: 100, capture_scope: 'explicit-session-only' },
  events: [{ id: 'evt_1', kind: 'click', at_ms: 10, route: '/', viewport: { width: 390, height: 844, scroll_x: 0, scroll_y: 0 }, target: { element_id: 'save', tag: 'button', role: null, label: '保存', rect: { x: 1, y: 2, width: 3, height: 4 } }, state: { route: '/', title: 'Demo', scroll_x: 0, scroll_y: 0 }, detail: {} }],
  annotations: [{ id: 'ann_1', kind: 'circle', created_at_ms: 20, points: [{ x: .1, y: .2 }, { x: .3, y: .4 }] }],
  transcript: [{ segment_id: 'voice_1', start_ms: 20, end_ms: 40, text: '这里需要改', confidence: .9 }],
  privacy: { processing: 'local_only', sensitive_input_values: 'excluded', external_network: 'blocked-by-frame-policy', full_screen_video: false },
  execution_authorized: false,
})

describe('Interaction Review package contract', () => {
  it('accepts element-level events, annotations, and transcript without source bytes', () => expect(isInteractionReviewPackage(valid())).toBe(true))
  it('rejects raw input values and execution authorization', () => {
    const rawValue = valid(); rawValue.events[0].detail = { value: 'secret' }
    expect(isInteractionReviewPackage(rawValue)).toBe(false)
    const authorized = valid(); authorized.execution_authorized = true
    expect(isInteractionReviewPackage(authorized)).toBe(false)
  })
})
