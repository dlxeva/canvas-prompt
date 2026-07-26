const TOKEN_HEADER = 'x-canvas-prompt-token'

let runtimeTokenPromise: Promise<string> | null = null

async function requestRuntimeToken() {
  const response = await fetch('/api/runtime-session', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
  })
  if (!response.ok) throw new Error('无法建立本地 Canvas Prompt 会话')
  const payload = await response.json() as { token?: unknown }
  if (typeof payload.token !== 'string' || payload.token.length < 32) {
    throw new Error('本地 Canvas Prompt 会话无效')
  }
  return payload.token
}

function getRuntimeToken() {
  if (!runtimeTokenPromise) {
    runtimeTokenPromise = requestRuntimeToken().catch((error) => {
      runtimeTokenPromise = null
      throw error
    })
  }
  return runtimeTokenPromise
}

async function fetchWithToken(input: RequestInfo | URL, init: RequestInit, token: string) {
  const headers = new Headers(init.headers)
  headers.set(TOKEN_HEADER, token)
  return fetch(input, { ...init, headers })
}

export async function protectedLocalApiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const response = await fetchWithToken(input, init, await getRuntimeToken())
  if (response.status !== 403) return response

  // Vite can restart while the Canvas page stays alive under HMR. Refresh the
  // short-lived runtime token once, then preserve the real second response.
  runtimeTokenPromise = null
  return fetchWithToken(input, init, await getRuntimeToken())
}

export function resetProtectedLocalApiSessionForTests() {
  runtimeTokenPromise = null
}
