import React from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import '@excalidraw/excalidraw/index.css'

// Development-only regression surface. No import from the product entry point.
let api: Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['excalidrawAPI']>>[0]
createRoot(document.getElementById('root')!).render(React.createElement(Excalidraw, {
  excalidrawAPI: (value) => { api = value },
}))

Object.assign(window, {
  async testMermaidImport(definition: string) {
    if (!api) throw new Error('Excalidraw API is not ready')
    const parsed = await parseMermaidToExcalidraw(definition)
    const elements = convertToExcalidrawElements(parsed.elements)
    if (parsed.files) api.addFiles(Object.values(parsed.files))
    api.updateScene({ elements })
    const imported = api.getSceneElements()
    if (!imported.length || new Set(imported.map((element) => element.id)).size !== imported.length) {
      throw new Error('Imported objects are empty or have duplicate IDs')
    }
    const ids = new Set(imported.map((element) => element.id))
    for (const element of imported) {
      for (const binding of element.boundElements ?? []) {
        if (!ids.has(binding.id)) throw new Error('Dangling imported binding')
      }
    }
    const first = imported[0]
    api.updateScene({ elements: imported.map((element, index) => index ? element : { ...element, x: element.x + 15, version: element.version + 1 }) })
    const edited = api.getSceneElements().find((element) => element.id === first.id)
    if (!edited || edited.x !== first.x + 15) throw new Error('Imported objects cannot be edited')
    return { count: imported.length, ids: [...ids], edited: true, types: [...new Set(imported.map((element) => element.type))] }
  },
  mermaidReady: () => Boolean(api),
})
