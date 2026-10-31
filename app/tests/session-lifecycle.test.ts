import { describe, expect, it } from 'vitest'
import { SessionLifecycle } from '../src/session-lifecycle'

describe('session lifecycle', () => {
  it('rejects an asynchronous import when the capture boundary has changed', () => {
    const session = new SessionLifecycle()
    const idleImport = session.getSnapshot()
    expect(session.canImport(idleImport)).toBe(true)
    const token = session.begin()!
    expect(session.canImport()).toBe(false)
    session.record(token, 123)
    expect(session.canImport(idleImport)).toBe(false)
    const recordingImport = session.getSnapshot()
    expect(session.canImport(recordingImport)).toBe(true)
    session.finish()
    expect(session.canImport(recordingImport)).toBe(false)
    expect(session.canImport()).toBe(false)
    session.settle(token, 'ready')
    expect(session.canImport()).toBe(true)
    expect(session.canImport(recordingImport)).toBe(false)
  })
  it('serializes preparation, capture and compilation without React timing', () => {
    const session = new SessionLifecycle()
    const token = session.begin()!
    expect(session.begin()).toBeNull()
    expect(session.finish()).toBeNull()
    expect(session.reset()).toBe(false)
    expect(session.record(token, 123)).toBe(true)
    expect(session.getSnapshot().startedAt).toBe(123)
    expect(session.begin()).toBeNull()
    expect(session.finish()).toBe(token)
    expect(session.finish()).toBeNull()
    expect(session.begin()).toBeNull()
    expect(session.reset()).toBe(false)
    expect(session.settle(token, 'ready')).toBe(true)
    expect(session.begin()).toBe(token + 1)
  })
  it('rejects old async completion after reset and next round', () => {
    const session = new SessionLifecycle()
    const old = session.begin()!
    expect(session.settle(old, 'error')).toBe(true)
    expect(session.reset()).toBe(true)
    const current = session.begin()!
    expect(session.record(old, 10)).toBe(false)
    expect(session.settle(old, 'ready')).toBe(false)
    expect(session.record(current, 20)).toBe(true)
    expect(session.settle(current, 'ready')).toBe(false)
    session.finish()
    expect(session.settle(current, 'ready')).toBe(true)
  })
  it('publishes stable snapshots only for accepted transitions', () => {
    const session = new SessionLifecycle()
    let calls = 0
    const unsubscribe = session.subscribe(() => calls++)
    const snapshot = session.getSnapshot()
    expect(session.getSnapshot()).toBe(snapshot)
    session.finish()
    expect(calls).toBe(0)
    session.begin()
    expect(calls).toBe(1)
    unsubscribe()
    session.settle(1, 'error')
    expect(calls).toBe(1)
  })
})
