import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appSourceUrl = new URL('../src/App.tsx', import.meta.url)
const viteSourceUrl = new URL('../vite.config.ts', import.meta.url)

describe('image paste round-trip contract', () => {
  it('claims one paste event and falls back to the protected native macOS pasteboard bridge', async () => {
    const appSource = await readFile(fileURLToPath(appSourceUrl), 'utf8')
    const pasteHandler = appSource.slice(
      appSource.indexOf('const handleExternalPaste'),
      appSource.indexOf('const handleCanvasContextMenu'),
    )

    expect(appSource).toContain('onPasteCapture={handleExternalPaste}')
    expect(pasteHandler).toContain('event.preventDefault()')
    expect(pasteHandler).toContain('event.stopPropagation()')
    expect(pasteHandler).toContain('event.clipboardData.files')
    expect(pasteHandler).toContain("importNativeMacImage('general')")
  })

  it('keeps the native pasteboard endpoint behind the local API guard', async () => {
    const viteSource = await readFile(fileURLToPath(viteSourceUrl), 'utf8')
    const nativeRoute = viteSource.slice(
      viteSource.indexOf("server.middlewares.use('/api/native-pasteboard-image'"),
      viteSource.indexOf("server.middlewares.use('/api/round-audio/'"),
    )

    expect(nativeRoute).toContain('if (!enforceProtectedLocalApi(req, res, security)) return')
    expect(nativeRoute).toContain('readMacPasteboardPng(board)')
    expect(nativeRoute).toContain("res.setHeader('content-type', 'image/png')")
  })
})
