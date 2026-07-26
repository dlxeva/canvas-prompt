import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  protectedLocalApiFetch,
  resetProtectedLocalApiSessionForTests,
} from '../src/protected-local-api'

afterEach(() => {
  resetProtectedLocalApiSessionForTests()
  vi.unstubAllGlobals()
})

describe('protected local API client', () => {
  it('obtains a same-origin runtime token and attaches it to protected writes', async () => {
    const token = 'token-a'.repeat(8)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    const response = await protectedLocalApiFetch('/api/prompt-package', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/runtime-session')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', cache: 'no-store' })

    const protectedInit = fetchMock.mock.calls[1][1] as RequestInit
    expect(new Headers(protectedInit.headers).get('x-canvas-prompt-token')).toBe(token)
    expect(new Headers(protectedInit.headers).get('content-type')).toBe('application/json')
  })

  it('refreshes a token once after a Vite restart returns 403', async () => {
    const firstToken = 'first-token'.repeat(4)
    const secondToken = 'second-token'.repeat(4)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: firstToken }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: secondToken }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    const response = await protectedLocalApiFetch('/api/native-pasteboard-image?board=general', { method: 'POST' })

    expect(response.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const firstProtected = new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers)
    const secondProtected = new Headers((fetchMock.mock.calls[3][1] as RequestInit).headers)
    expect(firstProtected.get('x-canvas-prompt-token')).toBe(firstToken)
    expect(secondProtected.get('x-canvas-prompt-token')).toBe(secondToken)
  })
})
