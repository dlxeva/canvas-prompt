import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

export const LOCAL_API_TOKEN_HEADER = 'x-canvas-prompt-token'

export type LocalApiSecurity = {
  expectedHost: string
  expectedOrigin: string
  token: string
}

type AccessDecision =
  | { ok: true }
  | { ok: false; status: 403; error: string }

function singleHeader(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function sameToken(expected: string, actual: string | undefined) {
  if (!actual) return false
  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes)
}

function validateBrowserBoundary(headers: IncomingHttpHeaders, security: LocalApiSecurity): AccessDecision {
  if (singleHeader(headers, 'host') !== security.expectedHost) {
    return { ok: false, status: 403, error: 'Invalid local API host.' }
  }
  if (singleHeader(headers, 'origin') !== security.expectedOrigin) {
    return { ok: false, status: 403, error: 'Local API requires the Canvas Prompt origin.' }
  }
  if (singleHeader(headers, 'sec-fetch-site') !== 'same-origin') {
    return { ok: false, status: 403, error: 'Local API requires a same-origin browser request.' }
  }
  return { ok: true }
}

export function authorizeRuntimeSession(headers: IncomingHttpHeaders, security: LocalApiSecurity): AccessDecision {
  return validateBrowserBoundary(headers, security)
}

export function authorizeProtectedLocalApi(headers: IncomingHttpHeaders, security: LocalApiSecurity): AccessDecision {
  const browserBoundary = validateBrowserBoundary(headers, security)
  if (!browserBoundary.ok) return browserBoundary
  if (!sameToken(security.token, singleHeader(headers, LOCAL_API_TOKEN_HEADER))) {
    return { ok: false, status: 403, error: 'Invalid local API session.' }
  }
  return { ok: true }
}

export function normalizedMediaType(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value
  return String(raw ?? '').split(';', 1)[0].trim().toLowerCase()
}

export function isJsonRequest(headers: IncomingHttpHeaders) {
  return normalizedMediaType(headers['content-type']) === 'application/json'
}

export function isSupportedAudioRequest(headers: IncomingHttpHeaders) {
  return new Set(['audio/webm', 'audio/ogg', 'audio/mp4']).has(normalizedMediaType(headers['content-type']))
}

export function rejectLocalApiRequest(res: ServerResponse, status: number, error: string) {
  res.statusCode = status
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify({ ok: false, error }))
}

export function enforceProtectedLocalApi(req: IncomingMessage, res: ServerResponse, security: LocalApiSecurity) {
  const decision = authorizeProtectedLocalApi(req.headers, security)
  if (decision.ok) return true
  rejectLocalApiRequest(res, decision.status, decision.error)
  return false
}

export function enforceRuntimeSession(req: IncomingMessage, res: ServerResponse, security: LocalApiSecurity) {
  const decision = authorizeRuntimeSession(req.headers, security)
  if (decision.ok) return true
  rejectLocalApiRequest(res, decision.status, decision.error)
  return false
}
