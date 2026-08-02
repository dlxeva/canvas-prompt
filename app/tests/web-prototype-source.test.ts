import { afterEach, describe, expect, it, vi } from 'vitest'
import { interactionCaptureRuntime, MAX_WEB_PROTOTYPE_BYTES, prepareWebPrototypeSource, releaseWebPrototypeSource } from '../src/web-prototype-source'

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

describe('web prototype source', () => {
  it('injects element-level capture without raw input values or network access', () => {
    const runtime = interactionCaptureRuntime()
    expect(runtime).toContain("addEventListener('click'")
    expect(runtime).toContain("addEventListener('input'")
    expect(runtime).toContain("element_id")
    expect(runtime).toContain("value_length")
    expect(runtime).toContain("excluded_reason: 'sensitive-field'")
    expect(runtime).not.toContain('detail: { value:')
  })

  it('prepares a standalone HTML document with a sandbox capture runtime', async () => {
    const file = new File(['<!doctype html><html><head><title>Demo</title></head><body><button data-element-id="save">Save</button></body></html>'], 'index.html', { type: 'text/html' })
    const source = await prepareWebPrototypeSource([file])
    expect(source.entryPath).toBe('index.html')
    expect(source.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(source.srcDoc).toContain('Content-Security-Policy')
    expect(source.srcDoc).toContain("connect-src 'none'")
    expect(source.srcDoc).toContain('canvas-prompt-interaction-review-v1')
    expect(source.srcDoc).toContain('data-element-id="save"')
  })

  it('rewrites direct static folder assets and releases their object URLs', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:asset-style')
    URL.revokeObjectURL = vi.fn()
    const html = new File(['<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>'], 'index.html', { type: 'text/html' })
    const css = new File(['body { color: black }'], 'style.css', { type: 'text/css' })
    Object.defineProperty(html, 'webkitRelativePath', { value: 'demo/index.html' })
    Object.defineProperty(css, 'webkitRelativePath', { value: 'demo/style.css' })
    const source = await prepareWebPrototypeSource([html, css])
    expect(source.srcDoc).toContain('href="blob:asset-style"')
    releaseWebPrototypeSource(source)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:asset-style')
  })

  it('rejects a bundle without HTML or above the bounded first-slice limit', async () => {
    await expect(prepareWebPrototypeSource([new File(['text'], 'readme.txt')])).rejects.toThrow('HTML')
    const large = new File([new Uint8Array(MAX_WEB_PROTOTYPE_BYTES + 1)], 'index.html', { type: 'text/html' })
    await expect(prepareWebPrototypeSource([large])).rejects.toThrow('32MB')
  })
})
