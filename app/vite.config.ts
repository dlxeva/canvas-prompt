import { randomBytes } from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { registerCanvasApi } from './canvas-api'

function canvasApiPlugin(): Plugin {
  const token = randomBytes(32).toString('base64url')
  const security = (port: number) => ({
    expectedHost: `127.0.0.1:${port}`,
    expectedOrigin: `http://127.0.0.1:${port}`,
    token,
  })
  return {
    name: 'canvas-prompt-persistence',
    configureServer(server) {
      registerCanvasApi(server, security(Number(server.config.server.port ?? 43223)))
    },
    configurePreviewServer(server) {
      registerCanvasApi(server, security(Number(server.config.preview.port ?? 4173)))
    },
  }
}

export default defineConfig({
  plugins: [react(), canvasApiPlugin()],
  server: { host: '127.0.0.1', port: 43223, strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
})
