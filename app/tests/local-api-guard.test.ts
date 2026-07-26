import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  authorizeProtectedLocalApi,
  authorizeRuntimeSession,
  enforceProtectedLocalApi,
  isJsonRequest,
  isSupportedAudioRequest,
  normalizedMediaType,
  type LocalApiSecurity,
} from '../local-api-guard'

const security: LocalApiSecurity = {
  expectedHost: '127.0.0.1:43227',
  expectedOrigin: 'http://127.0.0.1:43227',
  token: 'a'.repeat(43),
}

function browserHeaders(overrides: IncomingHttpHeaders = {}): IncomingHttpHeaders {
  return {
    host: security.expectedHost,
    origin: security.expectedOrigin,
    'sec-fetch-site': 'same-origin',
    'x-canvas-prompt-token': security.token,
    ...overrides,
  }
}

describe('local Canvas API browser boundary', () => {
  it('only issues the runtime session to the exact same-origin browser request', () => {
    expect(authorizeRuntimeSession(browserHeaders(), security)).toEqual({ ok: true })
    expect(authorizeRuntimeSession(browserHeaders({ origin: 'https://attacker.example' }), security).ok).toBe(false)
    expect(authorizeRuntimeSession(browserHeaders({ host: 'localhost:43227' }), security).ok).toBe(false)
    expect(authorizeRuntimeSession(browserHeaders({ 'sec-fetch-site': 'cross-site' }), security).ok).toBe(false)
    expect(authorizeRuntimeSession(browserHeaders({ origin: undefined }), security).ok).toBe(false)
  })

  it('requires the per-process token after the same-origin checks', () => {
    expect(authorizeProtectedLocalApi(browserHeaders(), security)).toEqual({ ok: true })
    expect(authorizeProtectedLocalApi(browserHeaders({ 'x-canvas-prompt-token': undefined }), security).ok).toBe(false)
    expect(authorizeProtectedLocalApi(browserHeaders({ 'x-canvas-prompt-token': 'wrong' }), security).ok).toBe(false)
    expect(authorizeProtectedLocalApi(browserHeaders({ origin: 'null' }), security).ok).toBe(false)
  })

  it('stops rejected requests before a route can perform any side effect', () => {
    const end = vi.fn()
    const setHeader = vi.fn()
    const req = { headers: browserHeaders({ 'x-canvas-prompt-token': 'wrong' }) } as IncomingMessage
    const res = { statusCode: 200, setHeader, end } as unknown as ServerResponse
    let sideEffects = 0

    if (enforceProtectedLocalApi(req, res, security)) sideEffects += 1

    expect(sideEffects).toBe(0)
    expect(res.statusCode).toBe(403)
    expect(setHeader).toHaveBeenCalledWith('cache-control', 'no-store')
    expect(end).toHaveBeenCalledOnce()
  })
})

describe('local Canvas API route ordering', () => {
  it('applies authentication and media checks before every protected side effect', async () => {
    const source = await readFile(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8')
    const nativeRoute = source.slice(
      source.indexOf("server.middlewares.use('/api/native-pasteboard-image'"),
      source.indexOf("server.middlewares.use('/api/round-audio/'"),
    )
    const audioRoute = source.slice(
      source.indexOf("server.middlewares.use('/api/round-audio/'"),
      source.indexOf("server.middlewares.use('/api/rounds'"),
    )
    const roundsRoute = source.slice(
      source.indexOf("server.middlewares.use('/api/rounds'"),
      source.indexOf("server.middlewares.use('/api/prompt-package'"),
    )
    const promptRoute = source.slice(
      source.indexOf("server.middlewares.use('/api/prompt-package'"),
      source.indexOf('    },\n  }\n}'),
    )

    expect(nativeRoute.indexOf('enforceProtectedLocalApi')).toBeLessThan(nativeRoute.indexOf('readMacPasteboardPng'))
    expect(audioRoute.indexOf('enforceProtectedLocalApi')).toBeLessThan(audioRoute.indexOf("req.on('data'"))
    expect(audioRoute.indexOf('isSupportedAudioRequest')).toBeLessThan(audioRoute.indexOf("req.on('data'"))
    expect(roundsRoute.indexOf('enforceProtectedLocalApi')).toBeLessThan(roundsRoute.indexOf('deleteRoundAndUpdateLatest'))
    expect(promptRoute.indexOf('enforceProtectedLocalApi')).toBeLessThan(promptRoute.indexOf("req.on('data'"))
    expect(promptRoute.indexOf('isJsonRequest')).toBeLessThan(promptRoute.indexOf("req.on('data'"))
    expect(promptRoute.indexOf("req.on('data'")).toBeLessThan(promptRoute.indexOf('submitImmutableRound'))
    expect(promptRoute.indexOf('submitImmutableRound')).toBeLessThan(promptRoute.indexOf('handoffToMainThread'))
  })
})

describe('local Canvas API media contracts', () => {
  it('accepts Prompt Packages only as JSON', () => {
    expect(isJsonRequest({ 'content-type': 'application/json' })).toBe(true)
    expect(isJsonRequest({ 'content-type': 'Application/JSON; charset=utf-8' })).toBe(true)
    expect(isJsonRequest({ 'content-type': 'text/plain' })).toBe(false)
    expect(isJsonRequest({})).toBe(false)
  })

  it('accepts the supported recorder formats, including codec parameters', () => {
    expect(isSupportedAudioRequest({ 'content-type': 'audio/webm;codecs=opus' })).toBe(true)
    expect(isSupportedAudioRequest({ 'content-type': 'audio/ogg; codecs=opus' })).toBe(true)
    expect(isSupportedAudioRequest({ 'content-type': 'audio/mp4; codecs=mp4a.40.2' })).toBe(true)
    expect(isSupportedAudioRequest({ 'content-type': 'audio/mpeg' })).toBe(false)
    expect(isSupportedAudioRequest({ 'content-type': 'application/octet-stream' })).toBe(false)
    expect(normalizedMediaType(' Audio/WebM ; codecs=opus')).toBe('audio/webm')
  })
})
