import { access, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { convertPptxForReview } from '../pptx-review-converter'

function syntheticPptx({
  marker = 'default',
  encrypted = false,
  includePresentation = true,
  includeSlide = true,
}: {
  marker?: string
  encrypted?: boolean
  includePresentation?: boolean
  includeSlide?: boolean
} = {}) {
  const names = [
    '[Content_Types].xml',
    ...(includePresentation ? ['ppt/presentation.xml'] : []),
    ...(includeSlide ? ['ppt/slides/slide1.xml'] : []),
    `custom/${marker}`,
  ]
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const name of names) {
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(encrypted ? 1 : 0, 6)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(encrypted ? 1 : 0, 8)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, nameBytes)
    localOffset += local.length + nameBytes.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(names.length, 8)
  eocd.writeUInt16LE(names.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

async function fakeSoffice(root: string, mode: 'success' | 'no-output' | 'failure' | 'slow' | 'echo-source' = 'success') {
  const script = join(root, `fake-soffice-${mode}.mjs`)
  await writeFile(script, `#!/usr/bin/env node
import { copyFile, readFile, writeFile } from 'node:fs/promises'
const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('LibreOffice test-renderer')
  process.exit(0)
}
${mode === 'success' ? `
const outputDir = args[args.indexOf('--outdir') + 1]
await copyFile(new URL('./fixture.pdf', import.meta.url), outputDir + '/source.pdf')
` : mode === 'failure' ? `
process.stderr.write('damaged presentation')
process.exit(7)
` : mode === 'slow' ? `
await new Promise((resolve) => setTimeout(resolve, 500))
` : mode === 'echo-source' ? `
const outputDir = args[args.indexOf('--outdir') + 1]
const source = await readFile(args.at(-1))
await writeFile(outputDir + '/source.pdf', Buffer.concat([Buffer.from('%PDF-1.4\\n'), source, Buffer.from('\\n%%EOF\\n')]))
` : ''}
`)
  await writeFile(join(root, 'fixture.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n'))
  await import('node:fs/promises').then(({ chmod }) => chmod(script, 0o755))
  return script
}

describe('PPTX review converter', () => {
  it('converts inside an isolated directory and removes all temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pptx-converter-test-'))
    const sofficePath = await fakeSoffice(root)
    const source = syntheticPptx()

    const result = await convertPptxForReview(source, { sofficePath, temporaryRoot: root })

    expect(result.pdfBytes.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.renderSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.renderer).toEqual({ name: 'LibreOffice', version: 'LibreOffice test-renderer' })
    expect((await readdir(root)).filter((name) => name.startsWith('canvas-prompt-pptx-'))).toEqual([])
    await expect(access(join(root, 'source.pptx'))).rejects.toThrow()
  })

  it('rejects empty, oversized and non-ZIP inputs before running the renderer', async () => {
    await expect(convertPptxForReview(new Uint8Array())).rejects.toThrow('PPTX 文件为空')
    await expect(convertPptxForReview(syntheticPptx(), { maxBytes: 4 })).rejects.toThrow('PPTX 文件超过')
    await expect(convertPptxForReview(Buffer.from('not-pptx'))).rejects.toThrow('文件不是有效的 PPTX 容器')
  })

  it('rejects damaged OOXML, encrypted decks and zero-slide decks before rendering', async () => {
    await expect(convertPptxForReview(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).rejects.toThrow('PPTX ZIP 目录损坏')
    await expect(convertPptxForReview(syntheticPptx({ includePresentation: false }))).rejects.toThrow('不包含有效的 PPTX 结构')
    await expect(convertPptxForReview(syntheticPptx({ encrypted: true }))).rejects.toThrow('PPTX 文件已加密')
    await expect(convertPptxForReview(syntheticPptx({ includeSlide: false }))).rejects.toThrow('PPTX 不包含可批阅页面')
  })

  it('cleans the isolated directory when the renderer produces no PDF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pptx-converter-test-'))
    const sofficePath = await fakeSoffice(root, 'no-output')

    await expect(convertPptxForReview(
      syntheticPptx(),
      { sofficePath, temporaryRoot: root },
    )).rejects.toThrow('PPTX 转换未生成 source.pdf')
    expect((await readdir(root)).filter((name) => name.startsWith('canvas-prompt-pptx-'))).toEqual([])
  })

  it('reports a damaged presentation and removes its isolated directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pptx-converter-test-'))
    const sofficePath = await fakeSoffice(root, 'failure')

    await expect(convertPptxForReview(
      syntheticPptx(),
      { sofficePath, temporaryRoot: root },
    )).rejects.toThrow('PPTX 本地转换失败')
    expect((await readdir(root)).filter((name) => name.startsWith('canvas-prompt-pptx-'))).toEqual([])
  })

  it('reports an unavailable renderer and removes its isolated directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pptx-converter-test-'))

    await expect(convertPptxForReview(
      syntheticPptx(),
      { sofficePath: join(root, 'missing-soffice'), temporaryRoot: root },
    )).rejects.toThrow('PPTX 本地渲染器不可用')
    expect((await readdir(root)).filter((name) => name.startsWith('canvas-prompt-pptx-'))).toEqual([])
  })

  it('times out a stalled renderer and removes its isolated directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pptx-converter-test-'))
    const sofficePath = await fakeSoffice(root, 'slow')

    await expect(convertPptxForReview(
      syntheticPptx(),
      { sofficePath, temporaryRoot: root, timeoutMs: 40 },
    )).rejects.toThrow('PPTX 本地转换超时')
    expect((await readdir(root)).filter((name) => name.startsWith('canvas-prompt-pptx-'))).toEqual([])
  })

  it('isolates concurrent conversions and cleans both working directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pptx-converter-test-'))
    const sofficePath = await fakeSoffice(root, 'echo-source')
    const sourceA = syntheticPptx({ marker: 'A' })
    const sourceB = syntheticPptx({ marker: 'B' })

    const [resultA, resultB] = await Promise.all([
      convertPptxForReview(sourceA, { sofficePath, temporaryRoot: root }),
      convertPptxForReview(sourceB, { sofficePath, temporaryRoot: root }),
    ])

    expect(resultA.sourceSha256).not.toBe(resultB.sourceSha256)
    expect(resultA.renderSha256).not.toBe(resultB.renderSha256)
    expect(resultA.pdfBytes.includes(sourceA)).toBe(true)
    expect(resultA.pdfBytes.includes(sourceB)).toBe(false)
    expect(resultB.pdfBytes.includes(sourceB)).toBe(true)
    expect(resultB.pdfBytes.includes(sourceA)).toBe(false)
    expect((await readdir(root)).filter((name) => name.startsWith('canvas-prompt-pptx-'))).toEqual([])
  })
})
