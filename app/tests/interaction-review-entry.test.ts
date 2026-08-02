import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Interactive prototype review entry', () => {
  const reviewSource = readFileSync(new URL('../src/PdfReviewSpike.tsx', import.meta.url), 'utf8')
  const publicRoot = new URL('../public/interaction-review-i0/', import.meta.url)

  it('places the controlled prototype entry after the PDF/PPTX entry', () => {
    const documentEntry = reviewSource.indexOf("entryTitle: 'PDF / PPTX 审阅'")
    const prototypeEntry = reviewSource.indexOf("prototypeTitle: '交互原型审阅'")
    expect(documentEntry).toBeGreaterThan(-1)
    expect(prototypeEntry).toBeGreaterThan(documentEntry)
    expect(reviewSource).toContain('href="/interaction-review-i0/index.html"')
    expect(reviewSource).toContain("prototypeBadge: '实验功能'")
  })

  it('ships the complete controlled I0 browser runtime with the app', () => {
    for (const file of [
      'index.html',
      'styles.css',
      'app.js',
      'adapter-contract.mjs',
      'core.mjs',
      'local-web-launch-gate.mjs',
      'local-web-preflight.mjs',
      'local-web-source-contract.mjs',
      'observable-agent-lineage.mjs',
      'observable-agent-player.mjs',
      'observable-agent-session.mjs',
      'remote-web-authorization.mjs',
    ]) expect(existsSync(new URL(file, publicRoot))).toBe(true)

    const prototypeSource = readFileSync(new URL('app.js', publicRoot), 'utf8')
    expect(prototypeSource).toContain("allowed_routes: ['/brief', '/generate', '/gallery', '/review']")
    expect(prototypeSource).toContain("network_policy: 'deny-all'")
    expect(prototypeSource).toContain('execution_authorized: false')
    expect(prototypeSource).toContain('href="/?artifact-review-spike=1"')
    expect(prototypeSource).toContain('开始体验')
    expect(prototypeSource).toContain('让 AI 开始演示')
    expect(prototypeSource).toContain('体验反馈')
    expect(prototypeSource).toContain('隐私与技术详情')
    expect(prototypeSource).toContain('查看技术记录')
  })
})
