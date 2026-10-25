export type SessionStage = 'idle' | 'starting' | 'recording' | 'compiling' | 'ready' | 'error'
export type SessionState = Readonly<{ stage: SessionStage; generation: number; startedAt: number | null }>

/** Synchronous transition guards also cover clicks before React has rendered. */
export class SessionLifecycle {
  private state: SessionState = { stage: 'idle', generation: 0, startedAt: null }
  private listeners = new Set<() => void>()
  getSnapshot = () => this.state
  canImport(origin: SessionState = this.state): boolean {
    return origin === this.state && !['starting', 'compiling'].includes(this.state.stage)
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(state: SessionState) {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  begin(): number | null {
    if (['starting', 'recording', 'compiling'].includes(this.state.stage)) return null
    const generation = this.state.generation + 1
    this.publish({ stage: 'starting', generation, startedAt: null })
    return generation
  }
  record(generation: number, startedAt: number): boolean {
    if (generation !== this.state.generation || this.state.stage !== 'starting') return false
    this.publish({ ...this.state, stage: 'recording', startedAt })
    return true
  }
  finish(): number | null {
    if (this.state.stage !== 'recording') return null
    this.publish({ ...this.state, stage: 'compiling' })
    return this.state.generation
  }
  settle(generation: number, stage: 'ready' | 'error'): boolean {
    if (generation !== this.state.generation || !['starting', 'compiling'].includes(this.state.stage)) return false
    this.publish({ ...this.state, stage })
    return true
  }
  reset(): boolean {
    if (['starting', 'recording', 'compiling'].includes(this.state.stage)) return false
    this.publish({ stage: 'idle', generation: this.state.generation + 1, startedAt: null })
    return true
  }
}
